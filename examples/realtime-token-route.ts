// Excerpt from the BrokerDesk Next.js app: POST /api/realtime-token.
// Shows how the modules in src/ work together. The voice personas, their prompts
// and the tool definitions live in a private module and are not published here.
// This file is not compiled in this repository (it needs the full Next.js app).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, rateLimit } from "../src/rate-limit.ts";
import {
  MAX_BODY_BYTES,
  buildClientSecretRequest,
  realtimeTokenBodySchema,
} from "../src/realtime-session.ts";
import { getPersona } from "./personas"; // private: instructions, greeting, voice, tools

export const runtime = "nodejs";

// Fail closed: an ephemeral key is paid OpenAI Realtime minutes, so a Redis outage
// must never hand them out unmetered.
const VOICE_DAILY_LIMIT = {
  limit: 30,
  windowMs: 24 * 60 * 60_000,
  onError: "closed",
} as const;

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[realtime-token] OPENAI_API_KEY is not configured");
    return NextResponse.json({ error: "Voice demo is temporarily unavailable" }, { status: 503 });
  }

  const ip = getClientIp(req.headers);
  if (!(await rateLimit(`realtime-token:${ip}`, VOICE_DAILY_LIMIT)).ok) {
    return NextResponse.json({ error: "Daily demo call limit reached" }, { status: 429 });
  }

  // Refuse an oversized body before parsing it, then measure the real size:
  // a forged or missing content-length is caught by the second check.
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let json: unknown = {};
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
  }
  const parsed = realtimeTokenBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const persona = getPersona(parsed.data.bot, parsed.data.lang);

  let res: Response;
  try {
    // The browser never sees OPENAI_API_KEY: it gets a short-lived key for one session.
    res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        buildClientSecretRequest({
          model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-mini",
          instructions: persona.instructions,
          voice: persona.voice,
          tools: persona.tools,
        }),
      ),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[realtime-token] fetch failed:", err);
    return NextResponse.json({ error: "Voice demo is temporarily unavailable" }, { status: 503 });
  }

  if (!res.ok) {
    console.error("[realtime-token] OpenAI error:", res.status);
    return NextResponse.json({ error: "Could not create session" }, { status: 502 });
  }

  const session = (await res.json()) as { value: string };
  return NextResponse.json({ clientSecret: session.value, greeting: persona.greeting, bot: parsed.data.bot });
}
