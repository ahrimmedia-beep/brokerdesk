// Run with `npm test` (node:test, no extra framework — Node strips the types itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UNKNOWN_IP,
  getClientIp,
  memoryRateLimit,
  resolveClientIp,
} from "./rate-limit.ts";

const headers = (init: Record<string, string>) => new Headers(init);

test("getClientIp takes the FIRST entry of a forged x-forwarded-for chain", () => {
  // An attacker prepends junk hoping we read the last element; the real client is
  // always the first entry, everything after it was appended by proxies.
  const ip = getClientIp(
    headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.1, 192.0.2.9" }),
  );
  assert.equal(ip, "203.0.113.7");
  assert.notEqual(ip, "192.0.2.9");
});

test("getClientIp prefers x-vercel-forwarded-for over the client-settable headers", () => {
  const ip = getClientIp(
    headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "198.51.100.1",
      "x-real-ip": "192.0.2.9",
    }),
  );
  assert.equal(ip, "203.0.113.7");
});

test("getClientIp takes the first entry of x-vercel-forwarded-for too", () => {
  assert.equal(
    getClientIp(headers({ "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.1" })),
    "203.0.113.7",
  );
});

test("getClientIp falls back x-forwarded-for -> x-real-ip -> unknown", () => {
  assert.equal(
    getClientIp(headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "192.0.2.9" })),
    "203.0.113.7",
  );
  assert.equal(getClientIp(headers({ "x-real-ip": "192.0.2.9" })), "192.0.2.9");
  assert.equal(getClientIp(headers({})), UNKNOWN_IP);
});

test("getClientIp ignores cf-connecting-ip (nothing strips it on our stack)", () => {
  assert.equal(getClientIp(headers({ "cf-connecting-ip": "203.0.113.7" })), UNKNOWN_IP);
  // Two requests differing only in cf-connecting-ip land in the same bucket.
  const a = getClientIp(headers({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "192.0.2.9" }));
  const b = getClientIp(headers({ "cf-connecting-ip": "2.2.2.2", "x-real-ip": "192.0.2.9" }));
  assert.equal(a, b);
});

test("getClientIp strips ports and brackets", () => {
  assert.equal(getClientIp(headers({ "x-forwarded-for": "203.0.113.7:51234" })), "203.0.113.7");
  assert.equal(getClientIp(headers({ "x-forwarded-for": "[2001:db8::1]:443" })), "2001:db8::1");
  assert.equal(getClientIp(headers({ "x-forwarded-for": "2001:db8::1" })), "2001:db8::1");
});

test("getClientIp rejects junk so it cannot pollute the key space", () => {
  assert.equal(getClientIp(headers({ "x-forwarded-for": "not-an-ip" })), UNKNOWN_IP);
  assert.equal(getClientIp(headers({ "x-forwarded-for": "x".repeat(4000) })), UNKNOWN_IP);
  assert.equal(getClientIp(headers({ "x-forwarded-for": "  , , " })), UNKNOWN_IP);
  // Junk in front of a real address does not hide the real one.
  assert.equal(
    getClientIp(headers({ "x-forwarded-for": "unknown, 203.0.113.7" })),
    "203.0.113.7",
  );
});

test("resolveClientIp returns null instead of the unknown placeholder", () => {
  assert.equal(resolveClientIp(headers({})), null);
  assert.equal(resolveClientIp(headers({ "x-real-ip": "192.0.2.9" })), "192.0.2.9");
});

test("memoryRateLimit allows exactly `limit` hits per window", () => {
  const key = `test:${Math.random()}`;
  const opts = { limit: 3, windowMs: 60_000 };
  assert.deepEqual(memoryRateLimit(key, opts), { ok: true, remaining: 2 });
  assert.deepEqual(memoryRateLimit(key, opts), { ok: true, remaining: 1 });
  assert.deepEqual(memoryRateLimit(key, opts), { ok: true, remaining: 0 });
  assert.deepEqual(memoryRateLimit(key, opts), { ok: false, remaining: 0 });
});

test("memoryRateLimit anchors the window on the first hit, not on a clock boundary", async () => {
  // Same contract as the Redis path: the bucket must reopen `windowMs` after the
  // FIRST hit. An epoch-aligned window would reopen at a shared wall-clock moment,
  // letting one IP spend a full window on each side of the boundary back to back.
  const key = `test:${Math.random()}`;
  const opts = { limit: 1, windowMs: 120 };
  const openedAt = Date.now();
  assert.equal(memoryRateLimit(key, opts).ok, true);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  await sleep(60);
  assert.equal(memoryRateLimit(key, opts).ok, false, "still inside the first window");

  await sleep(100); // ~160 ms after the first hit
  assert.equal(memoryRateLimit(key, opts).ok, true, "window elapsed since the first hit");
  assert.ok(Date.now() - openedAt >= opts.windowMs);
});

test("memoryRateLimit keeps separate keys apart and reopens after the window", () => {
  const a = `test:a:${Math.random()}`;
  const b = `test:b:${Math.random()}`;
  const opts = { limit: 1, windowMs: 1 };
  assert.equal(memoryRateLimit(a, opts).ok, true);
  assert.equal(memoryRateLimit(a, opts).ok, false);
  assert.equal(memoryRateLimit(b, opts).ok, true);
  // The 1 ms window has elapsed by the time the event loop comes back around.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(memoryRateLimit(a, opts).ok, true);
      resolve();
    }, 5);
  });
});
