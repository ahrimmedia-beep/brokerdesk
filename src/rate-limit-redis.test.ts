// Redis-backed path of lib/rate-limit.ts, exercised against a stub that speaks the
// Upstash REST protocol (POST <url> with the command as a JSON array).
//
// Separate file because `node --test` runs each file in its own process and the Redis
// client is memoized on first use — the env has to be set before that happens.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";

type Command = string[];
type StubReply = { status?: number; body: unknown };

const received: Command[] = [];
let reply: (command: Command) => StubReply = () => ({ body: { result: 1 } });
// When set, the stub takes the request and never answers it — an Upstash that hangs.
let hang: ((res: ServerResponse) => void) | null = null;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString()) as unknown[];
    // One command per request. A nested array would mean the client batched commands
    // into a pipeline, which is exactly what `enableAutoPipelining: false` prevents —
    // fail loudly rather than let the isolation regress unnoticed.
    assert.ok(
      parsed.every((part) => typeof part !== "object"),
      `expected a single flat command, got a pipeline: ${JSON.stringify(parsed)}`,
    );
    const command = parsed.map(String);
    received.push(command);
    if (hang) {
      hang(res);
      return;
    }
    const { status = 200, body } = reply(command);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const { rateLimit } = await import("./rate-limit.ts");

after(() => server.close());
beforeEach(() => {
  received.length = 0;
  hang = null;
});

// Every line the module logs during this file's run, so the PDPL check at the bottom
// can look at all of them and not just the ones a single test triggered.
const logged: string[] = [];
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

const verb = (command: Command) => command[0]?.toLowerCase() ?? "";
const verbs = () => received.map(verb);
const HOUR = 60 * 60_000;

test("one hit is one atomic EVAL carrying our bucket key and the window", async () => {
  // The whole hit is a single server-side script now. The app used to do INCR + PTTL
  // + PEXPIRE as a read-modify-write, which raced and cost up to 3 commands.
  reply = () => ({ body: { result: 1 } });
  await rateLimit("demo-chat:203.0.113.7", { limit: 5, windowMs: HOUR, onError: "closed" });

  assert.deepEqual(verbs(), ["eval"], "exactly one command per request");
  const [, script, numKeys, key, windowMs] = received[0];
  assert.equal(numKeys, "1");
  assert.equal(key, "rl:demo-chat:203.0.113.7", "no epoch window number in the key");
  assert.equal(windowMs, String(HOUR));

  // The script must count first, then anchor the window only when there is no TTL
  // (PTTL is -1 without an expiry, -2 when the key is gone).
  assert.match(script, /redis\.call\('INCR', KEYS\[1\]\)/);
  assert.match(script, /redis\.call\('PTTL', KEYS\[1\]\) < 0/);
  assert.match(script, /redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[1\]\)/);
});

test("counts the first hit, the hits up to the limit, the hit on it and the ones past it", async () => {
  // The stub keeps the counter, so this walks a real bucket end to end.
  let counter = 0;
  reply = () => ({ body: { result: ++counter } });
  const opts = { limit: 3, windowMs: HOUR, onError: "closed" as const };
  const hit = () => rateLimit("demo-chat:203.0.113.7", opts);

  assert.deepEqual(await hit(), { ok: true, remaining: 2 }, "first hit");
  assert.deepEqual(await hit(), { ok: true, remaining: 1 }, "below the limit");
  assert.deepEqual(await hit(), { ok: true, remaining: 0 }, "on the limit");
  assert.deepEqual(await hit(), { ok: false, remaining: 0 }, "first hit past the limit");
  assert.deepEqual(await hit(), { ok: false, remaining: 0 }, "still past the limit");

  assert.equal(counter, 5, "every hit reached Redis");
});

test("every request costs exactly one command, blocked ones included", async () => {
  // Regression: the missing-TTL guard used to fire on each request over the limit, so
  // a flood burned 3x the Upstash command quota — and an exhausted quota returns
  // errors, which the fail-closed demo endpoints turn into a hard outage. Cheap
  // flooding of the lead form must not be able to take the voice demo down.
  reply = () => ({ body: { result: 99 } }); // far past any limit
  for (let i = 0; i < 4; i++) {
    const result = await rateLimit("submit-lead:203.0.113.7", {
      limit: 5,
      windowMs: HOUR,
      onError: "open",
    });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(verbs(), ["eval", "eval", "eval", "eval"]);
});

test("a Redis error is logged without the client IP (PDPL)", async () => {
  // Regression: @upstash/redis appends the failing command to its error message
  // (`..., command was: ["eval", ..., "rl:submit-lead:198.51.100.77", ...]`) and the
  // bucket key holds the caller's IP, so the raw driver message used to put it in the
  // log. This is the first redaction rubric: cut that tail.
  const ip = "198.51.100.77";
  const before = logged.length;

  const fail = (scope: string) => ({
    status: 500,
    body: { error: `ERR down, command was: ["eval","...","1","rl:${scope}:${ip}","3600000"]` },
  });

  reply = () => fail("submit-lead");
  await rateLimit(`submit-lead:${ip}`, { limit: 5, windowMs: HOUR, onError: "open" });

  reply = () => fail("realtime-token");
  await rateLimit(`realtime-token:${ip}`, { limit: 5, windowMs: HOUR, onError: "closed" });

  const lines = logged.slice(before);
  assert.equal(lines.length, 3, `expected two Redis lines and one let-through: ${lines}`);
  for (const line of lines) {
    assert.ok(!line.includes(ip), `client IP leaked into the log: ${line}`);
    assert.ok(!line.includes("command was:"), `raw driver command leaked: ${line}`);
  }
  // Still actionable: the endpoint scope survives, only the IP is gone.
  assert.ok(lines.some((line) => line.includes("submit-lead")));
  assert.ok(lines.some((line) => line.includes("realtime-token")));
});

test("an error that names the bucket key without the driver's tail is still redacted", async () => {
  // Second rubric of the redaction: `describe()` cuts the ", command was: [...]" tail
  // that @upstash/redis appends, AND scrubs any surviving `rl:` key. Only the second
  // one catches an error whose text names the key in its own words — which is what a
  // Lua/EVAL error looks like, and what a non-JSON error body degrades to.
  const ip = "203.0.113.201";
  const before = logged.length;

  reply = () => ({
    status: 500,
    body: { error: `ERR Error running script: user_script:1: bad key rl:demo-chat:${ip}` },
  });
  await rateLimit(`demo-chat:${ip}`, { limit: 5, windowMs: HOUR, onError: "closed" });

  const lines = logged.slice(before);
  assert.equal(lines.length, 1, `expected one Redis line: ${lines}`);
  assert.ok(!lines[0].includes(ip), `client IP leaked into the log: ${lines[0]}`);
  assert.ok(lines[0].includes("rl:<redacted>"), `key was not redacted: ${lines[0]}`);
  // The diagnosis still survives — only the key is gone.
  assert.ok(lines[0].includes("Error running script"));
});

test("onError closed refuses the request when Redis fails", async () => {
  reply = () => ({ status: 500, body: { error: "ERR upstream is down" } });

  const result = await rateLimit("realtime-token:203.0.113.7", {
    limit: 20,
    windowMs: 24 * HOUR,
    onError: "closed",
  });
  assert.deepEqual(result, { ok: false, remaining: 0 });
});

test("onError open lets the request through when Redis fails", async () => {
  reply = () => ({ status: 500, body: { error: "ERR upstream is down" } });

  const result = await rateLimit("submit-lead:203.0.113.7", {
    limit: 5,
    windowMs: HOUR,
    onError: "open",
  });
  assert.equal(result.ok, true);
});

test("onError open degrades to the in-process counter instead of an open door", async () => {
  // Regression: a Redis outage used to wave EVERY submit-lead through unmetered, so a
  // flooding script bought itself one Telegram sendMessage plus two or three HubSpot
  // calls per request. Telegram throttles a bot at ~20 messages/minute into one chat,
  // so the delivery path saturates and the genuine leads arriving mid-flood are the
  // ones that get dropped — exactly what fail-open is supposed to prevent. Serving the
  // visitor is still the priority; it just has a ceiling now.
  reply = () => ({ status: 500, body: { error: "ERR upstream is down" } });
  const opts = { limit: 3, windowMs: HOUR, onError: "open" as const };
  // A fresh IP: the in-process bucket for it has not been touched by another test.
  const key = "submit-lead:198.51.100.5";

  assert.equal((await rateLimit(key, opts)).ok, true, "hit 1 is served");
  assert.equal((await rateLimit(key, opts)).ok, true, "hit 2 is served");
  assert.equal((await rateLimit(key, opts)).ok, true, "hit 3 is served");
  assert.equal((await rateLimit(key, opts)).ok, false, "hit 4 meets the fallback ceiling");

  assert.equal(received.length, 4, "Redis is still tried on every request");
});

test("a hung Redis is aborted, not just abandoned", async () => {
  // Rejecting on the timeout is not enough: without an AbortSignal the HTTP request
  // keeps running after we have already answered, holding a socket (and on Vercel the
  // lambda) open until the platform kills it.
  const disconnected = new Promise<true>((resolve) => {
    hang = (res) => res.on("close", () => resolve(true));
  });

  const started = Date.now();
  const result = await rateLimit("demo-chat:198.51.100.9", {
    limit: 5,
    windowMs: HOUR,
    onError: "closed",
  });
  assert.deepEqual(result, { ok: false, remaining: 0 }, "the timeout answers, fail closed");
  assert.ok(Date.now() - started < 5_000, "the caller is not held for the platform timeout");

  const sawDisconnect = await Promise.race([
    disconnected,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000).unref()),
  ]);
  assert.equal(sawDisconnect, true, "the socket outlived the timeout — nothing aborted it");
});

test("no line logged anywhere in this suite contains an IP address", () => {
  // Backstop for the check above: catches any future log path that forwards a raw
  // driver message instead of going through describe().
  assert.ok(logged.length > 0, "the suite must have produced log lines to check");
  const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
  // Any run of hex groups joined by colons, i.e. "2001:db8::1" and its compressed
  // forms. Two colons minimum so plain "scope: message" punctuation does not match.
  const IPV6 = /\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/;
  const leaking = logged.filter((line) => IPV4.test(line) || IPV6.test(line));
  assert.deepEqual(leaking, [], `IP address found in the log: ${leaking.join(" | ")}`);
});
