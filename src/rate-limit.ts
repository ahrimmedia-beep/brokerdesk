// Rate limiting and the single source of truth for the client IP.
//
// Backend: Upstash Redis when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// are both set. This is the only honest option on Vercel: every lambda instance has
// its own memory, a cold start wipes it, and instances scale out under load — so an
// in-process counter can be bypassed by sending requests in parallel.
//
// Without those variables the limiter falls back to an in-process counter and warns
// once. The fallback is fine for `next dev` and for a single long-lived server; it is
// not a production limit.
import { Redis } from "@upstash/redis";

// --- Client IP ------------------------------------------------------------------

export const UNKNOWN_IP = "unknown";

// Longest textual IPv6 address ("0000:...:255.255.255.255%eth0" style) is ~45 chars.
// Anything longer is a forged header, not an address.
const MAX_IP_LENGTH = 45;
// IPv4 and IPv6 use only hex digits, dots and colons.
const IP_CHARS = /^[0-9a-fA-F.:]+$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;

// Proxies write either a bare address or "addr:port" / "[v6addr]:port".
function sanitizeIp(value: string): string | null {
  let ip = value.trim();
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end === -1) return null;
    ip = ip.slice(1, end);
  } else {
    ip = ip.replace(IPV4_WITH_PORT, "$1");
  }
  if (!ip || ip.length > MAX_IP_LENGTH || !IP_CHARS.test(ip)) return null;
  return ip;
}

// Forwarding headers carry a comma-separated chain "client, proxy1, proxy2".
// The CLIENT is the first entry; everything after it was appended by proxies.
// Taking the last entry (a `.pop()`) hands the attacker a fresh bucket per request.
function firstAddress(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const ip = sanitizeIp(part);
    if (ip) return ip;
  }
  return null;
}

/**
 * The one place in the project that resolves a client IP.
 *
 * Order (Vercel-specific, no Cloudflare in front of us):
 * 1. `x-vercel-forwarded-for`,
 * 2. first entry of `x-forwarded-for`,
 * 3. `x-real-ip`,
 * 4. `UNKNOWN_IP`.
 *
 * Why this is safe on Vercel, per https://vercel.com/docs/headers/request-headers:
 * - `x-forwarded-for` — "The public IP address of the client that made the request.
 *   If you are trying to use Vercel behind a proxy, we currently overwrite the
 *   X-Forwarded-For header and do not forward external IPs. This restriction is in
 *   place to prevent IP spoofing." So the platform OVERWRITES it, it is not a chain
 *   a client can prepend to, and a forged value never reaches this code in prod.
 * - `x-vercel-forwarded-for` — "This header is identical to the x-forwarded-for
 *   header. However, x-forwarded-for could be overwritten if you're using a proxy on
 *   top of Vercel." That is exactly why it is checked first.
 * - `x-real-ip` — "This header is identical to the x-forwarded-for header."
 *
 * Off Vercel (local dev, or any host that does not overwrite the header) these are
 * client-settable, so the first entry is only as trustworthy as the proxy in front.
 * Taking the FIRST entry is still the right call: the last one is appended by the
 * nearest proxy and a client can pad the chain to mint a new bucket per request.
 *
 * `cf-connecting-ip` is deliberately absent: there is no Cloudflare in front of us,
 * nothing strips it, so a client could set it freely.
 */
export function getClientIp(headers: Headers): string {
  return resolveClientIp(headers) ?? UNKNOWN_IP;
}

/** Same resolution as {@link getClientIp}, but `null` when no address is present. */
export function resolveClientIp(headers: Headers): string | null {
  return (
    firstAddress(headers.get("x-vercel-forwarded-for")) ??
    firstAddress(headers.get("x-forwarded-for")) ??
    firstAddress(headers.get("x-real-ip"))
  );
}

// --- Rate limit -----------------------------------------------------------------

/**
 * What to do when Redis is configured but does not answer.
 * - `"closed"` — refuse the request. For endpoints where abuse costs us money
 *   (OpenAI minutes): a Redis hiccup must not become an open door.
 * - `"open"`   — keep serving, but fall back to the in-process counter (and log it).
 *   For endpoints where refusing costs more than abuse does (a real lead lost under
 *   paid traffic). The fallback is per-instance, so it is a flood ceiling rather than
 *   a real limit — but an unmetered door would let a flood saturate Telegram and
 *   HubSpot and drop the very leads this mode exists to protect.
 */
export type RateLimitFailureMode = "open" | "closed";

export type RateLimitWindow = { limit: number; windowMs: number };
export type RateLimitOptions = RateLimitWindow & { onError: RateLimitFailureMode };
export type RateLimitResult = { ok: boolean; remaining: number };

// A Redis round trip must never hold up a form submit.
const REDIS_TIMEOUT_MS = 1000;

// `undefined` = not resolved yet, `null` = no Upstash configured (memory fallback).
let redisClient: Redis | null | undefined;

// The abort signal belonging to the hit currently being issued (see withTimeout).
//
// The client is a module-level singleton, so the only way to hand it a per-request
// signal is the factory form of its `signal` option. @upstash/redis calls that
// factory synchronously inside `client.eval(...)`, before its first await — so this
// handoff is set and consumed within one synchronous stretch and cannot interleave
// with a concurrent request on the same instance. It is read once per call, before
// the retry loop, so a retry stays covered by the same signal.
let pendingAbortSignal: AbortSignal | null = null;

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // Once per process, not per request.
    console.warn(
      "[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — " +
        "using an in-process counter. On serverless this does not limit anything across " +
        "instances; set both variables in production.",
    );
    redisClient = null;
    return null;
  }

  redisClient = new Redis({
    url,
    token,
    retry: { retries: 1, backoff: () => 50 },
    // Per-request abort (see withTimeout): without it a hung Upstash leaves the
    // socket open until the platform kills it, holding the lambda alive long after
    // the timeout already answered the visitor.
    signal: () => pendingAbortSignal ?? new AbortController().signal,
    // Off on purpose (the client defaults it to true). Auto-pipelining is not unsafe
    // by itself: it batches the commands issued in one tick into a single request but
    // calls exec({ keepErrors: true }), so an error is reported only to the caller of
    // that command and its neighbours still get their results. We switch it off for
    // predictability, not for correctness: one rateLimit() call must stay one flat
    // command on the wire — a single EVAL — instead of a wire format that changes
    // with how requests happen to interleave. That is the shape the stub in
    // lib/rate-limit-redis.test.ts pins down: it rejects a nested (pipelined) body
    // and asserts the command verbs are exactly ["eval"]. The old FATAL coupling was
    // a manual pipeline.exec() WITHOUT keepErrors, which threw for every command in
    // the batch.
    enableAutoPipelining: false,
  });
  return redisClient;
}

/**
 * Runs `issue` with a deadline, and cancels the request itself when it expires.
 *
 * Rejecting alone is not enough: the HTTP request would keep running: on serverless
 * that keeps the lambda's socket (and the instance) busy after we have already
 * answered. The signal is handed to @upstash/redis so the underlying fetch is
 * aborted too.
 */
async function withTimeout<T>(
  issue: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Redis timed out after ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    // Both promises get a handler here, so the aborted one never surfaces as an
    // unhandled rejection after the race has already settled.
    return await Promise.race([issue(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function bucketKeyFor(key: string): string {
  return `rl:${key}`;
}

// Increment the bucket and, whenever it has no expiry, anchor the window — as ONE
// atomic server-side operation.
//
// PTTL returns -1 for a key without an expiry and -2 for a missing one, so `< 0`
// covers both. The check runs on every hit and costs nothing, which is the point:
// there is no state in which a bucket can be left counting forever without a TTL.
//
// This replaces an INCR + PTTL + PEXPIRE read-modify-write done from the app. That
// version raced (an instance dying between the commands left a bucket with no expiry,
// blocking that IP until someone noticed), and the guard against the race had to run
// on requests that were already over the limit — which tripled the Upstash command
// cost of exactly the requests a flood produces most of.
const COUNT_HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * One hit against `key` in Redis: exactly one command on the wire, every time.
 *
 * The window is anchored on the FIRST hit and never extended, not on a slice of the
 * Unix epoch. An epoch-aligned window would reopen at a fixed wall-clock moment — 20
 * voice sessions at 23:59 plus 20 at 00:01 is 40 in two minutes from one IP.
 */
async function countHitInRedis(
  client: Redis,
  key: string,
  windowMs: number,
  signal: AbortSignal,
): Promise<number> {
  // `client.eval()` takes no per-call options, so the signal reaches the driver
  // through the module-level handoff it was constructed with (see pendingAbortSignal).
  pendingAbortSignal = signal;
  try {
    return await client.eval<[number], number>(
      COUNT_HIT_SCRIPT,
      [bucketKeyFor(key)],
      [windowMs],
    );
  } finally {
    pendingAbortSignal = null;
  }
}

// --- Logging (throttled: an outage must not turn into one log line per request) ---

const LOG_INTERVAL_MS = 60_000;
const lastLoggedAt = new Map<string, number>();

function shouldLog(kind: string): boolean {
  const now = Date.now();
  const previous = lastLoggedAt.get(kind) ?? 0;
  if (now - previous < LOG_INTERVAL_MS) return false;
  lastLoggedAt.set(kind, now);
  return true;
}

// @upstash/redis appends the failing command to its error text, e.g.
// `ERR ..., command was: ["incr","rl:submit-lead:203.0.113.42"]`. Our bucket keys
// carry the client IP, which is personal data under the PDPL, so a raw driver message
// must never reach the log: cut that tail, then redact any bucket key that survives.
const COMMAND_TAIL = /,\s*command was:[\s\S]*$/;
const BUCKET_KEY = /\brl:[^\s"',\]]+/g;

function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(COMMAND_TAIL, "").replace(BUCKET_KEY, "rl:<redacted>").trim();
}

// Rate-limit keys carry the client IP, which is personal data under the PDPL — log
// the endpoint scope ("submit-lead"), never the whole key.
function scopeOf(key: string): string {
  return key.split(":")[0] ?? "unknown";
}

function logRedisFailure(error: unknown, key: string): void {
  // Throttled per endpoint, not globally: an outage that only affects one endpoint
  // must not silence the first report from another.
  if (!shouldLog(`redis:${scopeOf(key)}`)) return;
  console.error(
    `[rate-limit] ${scopeOf(key)}: Redis is configured but unreachable:`,
    describe(error),
  );
}

/**
 * Count one hit against `key`.
 *
 * With Upstash configured the counter is shared by every instance. If Redis is
 * configured but unreachable (or slower than REDIS_TIMEOUT_MS), `opts.onError`
 * decides whether the request is refused or served off the in-process counter.
 */
export async function rateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const client = getRedis();
  if (!client) return memoryRateLimit(key, opts);

  try {
    const count = await withTimeout(
      (signal) => countHitInRedis(client, key, opts.windowMs, signal),
      REDIS_TIMEOUT_MS,
    );
    if (count > opts.limit) return { ok: false, remaining: 0 };
    return { ok: true, remaining: opts.limit - count };
  } catch (error) {
    logRedisFailure(error, key);
    if (opts.onError === "closed") return { ok: false, remaining: 0 };
    // Fail open, but NOT unmetered. Waving every request through during an Upstash
    // outage means a flooding script gets one Telegram sendMessage plus two or three
    // HubSpot calls per request. Telegram throttles a bot at roughly 20 messages a
    // minute into one chat and HubSpot has burst limits of its own, so the delivery
    // path saturates and the genuine leads arriving during the flood are the ones
    // that get dropped — the exact outcome fail-open exists to avoid.
    //
    // Degrading to the in-process counter keeps the intent (a lead is worth more
    // than a bit of spam: the visitor is still let through on a Redis hiccup) and
    // adds a ceiling. It does not limit across instances, but it caps what any one
    // instance will forward, which is what the downstream APIs actually feel.
    if (shouldLog(`degraded:${scopeOf(key)}`)) {
      console.warn(
        `[rate-limit] Redis unavailable — ${scopeOf(key)} is falling back to the ` +
          "in-process counter (per-instance, not a cross-instance limit).",
      );
    }
    return memoryRateLimit(key, opts);
  }
}

// --- In-process fallback ---------------------------------------------------------

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
// Keeps a long-lived process from growing a bucket per IP forever.
const MAX_BUCKETS = 10_000;

function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

/**
 * Exported for tests; production goes through {@link rateLimit}.
 *
 * Same window semantics as the Redis path: `resetAt` is anchored on the first hit,
 * so there is no shared wall-clock boundary where every bucket reopens at once.
 */
export function memoryRateLimit(key: string, opts: RateLimitWindow): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    if (buckets.size >= MAX_BUCKETS) pruneBuckets(now);
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.limit - 1 };
  }
  if (bucket.count >= opts.limit) return { ok: false, remaining: 0 };
  bucket.count += 1;
  return { ok: true, remaining: opts.limit - bucket.count };
}
