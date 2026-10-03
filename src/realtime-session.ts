// Server-side guards for the voice demo's ephemeral OpenAI key.
//
// Lives here rather than in app/api/realtime-token/route.ts so the request
// validation and the outgoing session payload can be unit-tested without
// pulling in next/server (see lib/realtime-session.test.ts).
import { z } from "zod";

/**
 * The body the browser hook (lib/useWebRTCVoice.ts) sends.
 *
 * `bot` and `lang` are the exact enums the route used to coerce values into.
 * Unknown keys are stripped, unknown VALUES are rejected: a request is either
 * one of the six supported persona/language combinations or a 400.
 */
export const realtimeTokenBodySchema = z.object({
  bot: z.enum(["outbound", "inbound"]).default("outbound"),
  lang: z.enum(["en", "ar", "ru"]).default("en"),
});

export type RealtimeTokenBody = z.infer<typeof realtimeTokenBodySchema>;

/** The voice agent's spoken language — not the page locale (see lib/useWebRTCVoice.ts). */
export type VoiceLang = RealtimeTokenBody["lang"];

/**
 * Longest legitimate body is `{"bot":"outbound","lang":"en"}` — 30 bytes.
 * Anything past this is refused before it is parsed, so a multi-megabyte POST
 * cannot burn lambda time and memory on JSON.parse.
 */
export const MAX_BODY_BYTES = 512;

/**
 * How long the minted client secret may be used to START Realtime sessions.
 *
 * OpenAI, POST /v1/realtime/client_secrets → `expires_after`:
 * "Client secret expiration specifies the duration during which a secret can be
 *  used to create Realtime sessions, configurable from 10 to 7200 seconds
 *  (defaulting to 600 seconds). A secret can initialize multiple sessions before
 *  it expires, and active sessions continue to operate uninterrupted even after
 *  the secret reaches its expiration time."
 *
 * So this is a mint→connect window, NOT a session length cap — a session that is
 * already up keeps running. That is exactly why the value is small: the hook asks
 * for the microphone BEFORE it calls this endpoint and then posts the SDP offer
 * straight away under a 15s timeout (lib/useWebRTCVoice.ts), so the honest path
 * needs well under 30 seconds. 120s leaves an 8x margin for a slow mobile network
 * while cutting the 600s default by 80% — the window in which a scraped secret can
 * spawn extra concurrent sessions on our bill.
 */
export const CLIENT_SECRET_TTL_SECONDS = 120;

/**
 * Ceiling on a single assistant response, tool calls included (OpenAI allows
 * 1..4096 or "inf"; the default is "inf").
 *
 * Realtime audio output runs at roughly 20 tokens per second of speech, so 1024
 * is about 50 seconds of talking in one turn. The personas are told to answer in
 * one or two sentences, which is 5-10 seconds — this only stops a runaway
 * monologue (a jailbroken "read me a novel") from billing us for it.
 */
export const MAX_OUTPUT_TOKENS = 1024;

export type ClientSecretRequest = {
  model: string;
  instructions: string;
  voice: string;
  tools: readonly unknown[];
};

/** The exact JSON posted to https://api.openai.com/v1/realtime/client_secrets. */
export function buildClientSecretRequest({
  model,
  instructions,
  voice,
  tools,
}: ClientSecretRequest) {
  return {
    // Top-level, a sibling of `session` — not a session field.
    expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_SECONDS },
    session: {
      type: "realtime",
      model,
      instructions,
      output_modalities: ["audio"],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      audio: {
        input: {
          transcription: { model: "gpt-4o-transcribe" },
          noise_reduction: { type: "near_field" },
          turn_detection: null,
        },
        output: { voice },
      },
      tools,
      tool_choice: "auto",
    },
  } as const;
}
