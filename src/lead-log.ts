// What /api/submit-lead and lib/lead-delivery.ts are allowed to print.
//
// Vercel's logs sit in the US, keep their own retention and are readable by
// everyone on the project, so under the PDPL they are an unaccounted store of
// personal data. A lead's name, phone or email must never land there.
//
// Two rubrics, the same pair lib/rate-limit.ts uses for the client IP:
//
//  1. Never build a log line out of the lead's own fields. describeDroppedLead()
//     below reports the shape of the failure — where it came from, when, which
//     contact details existed, which channel was even configured — and nothing
//     that identifies the person.
//
//  2. Scrub what upstream hands back. This is the back door: HubSpot answers an
//     invalid contact with `Property values were not valid: [... "Email address
//     a@b.com is invalid" ...]`, i.e. it quotes the value we just sent, and
//     Telegram quotes the button URL (https://wa.me/9715…) when it rejects a
//     message. Forwarding a raw upstream body therefore logs the lead's email or
//     phone without anyone writing `email` in a console call.

/** Placeholder left in a log line where a value was removed. */
const REDACTED = "<redacted>";

// Anything that looks like an address. Deliberately greedy on the local part and
// strict on the TLD, so "Property values were not valid" survives untouched.
const EMAIL = /[^\s"'<>(),;:\\]+@[^\s"'<>(),;:\\]+\.[A-Za-z]{2,}/g;

// A number we sent somewhere: always E.164 by the time it leaves this app
// (lib/phone.ts), so the leading "+" is required. Without it the pattern would
// also eat timestamps, HTTP statuses and object ids out of the diagnosis.
const E164 = /\+\d[\d\s()-]{6,}\d/g;

// The WhatsApp deep link in a Telegram inline button carries the bare number.
const WA_LINK = /\b((?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?)\d{6,15}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A value is only removed where it stands on its own, never as a fragment of a
// longer word. Without this a lead called Ali — an ordinary first name here —
// turns HubSpot's diagnosis into
// `Property values were not v<redacted>d ... "isV<redacted>d":false ...
// "category":"V<redacted>DATION_ERROR"`, and Sam eats "sample rate exceeded".
// That leaks nothing, but it destroys the only reason this line is logged.
const LEFT_EDGE = "(?<![\\p{L}\\p{N}])";
const RIGHT_EDGE = "(?![\\p{L}\\p{N}])";

// An address or a number, i.e. the values that are identifying on their own and
// are removed at any length. Everything else (a name, a company) needs two
// characters, so a single initial cannot pepper the line with placeholders.
const CONTACT_SHAPED = /@|^\+?[\d\s()-]{6,}$/;

/**
 * Make an upstream message safe to log.
 *
 * `values` are the exact identifying strings this request sent upstream (name,
 * phone, email, company). They are removed first, as whole tokens, which is the
 * rubric that cannot be fooled by an unusual format; the patterns above are the
 * backstop for values that were reformatted on the way back.
 */
export function redactPii(text: string, values: Array<string | undefined | null> = []): string {
  const wanted = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.length >= 2 || CONTACT_SHAPED.test(value))
    // Longest first, so the whole value wins over a value contained in it. A lead
    // called Ali with the address ali@example.ae would otherwise have the name
    // eat the local part and leave `<redacted>@example.ae` standing.
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const value of wanted) {
    out = out.replace(
      new RegExp(`${LEFT_EDGE}${escapeRegExp(value)}${RIGHT_EDGE}`, "giu"),
      REDACTED,
    );
  }
  return out
    .replace(WA_LINK, `$1${REDACTED}`)
    .replace(EMAIL, REDACTED)
    .replace(E164, REDACTED);
}

/** An error's message, redacted. Never the stack: it can quote the request body. */
export function describeError(error: unknown, values: Array<string | undefined | null> = []): string {
  return redactPii(error instanceof Error ? error.message : String(error), values);
}

// The `source` field arrives from the browser and is only length-capped, so a
// bot (or a mistyped integration) can put anything in it — including an email.
// Only values the site itself sends are echoed back into a log line.
const KNOWN_SOURCES = new Set(["final_cta", "modal", "whatsapp-demo"]);

export type DroppedLead = {
  /** `lead.source` as received from the client. */
  source?: string;
  /** Which site the form sat on: "EN" | "RU". */
  site: string;
  phone: boolean;
  email: boolean;
  telegramConfigured: boolean;
  hubspotConfigured: boolean;
};

/**
 * The one line printed when every delivery channel failed and the lead is lost.
 *
 * Enough for the owner to act on: which form, on which site, at what time, what
 * contact details the person left (as booleans — they are recoverable from the
 * browser's own form state, not from us) and whether the channel was configured
 * at all or configured and broken. lib/lead-delivery.ts logs the upstream status
 * separately, already redacted.
 */
export function describeDroppedLead(lead: DroppedLead): Record<string, string | boolean> {
  return {
    at: new Date().toISOString(),
    source: lead.source && KNOWN_SOURCES.has(lead.source) ? lead.source : "other",
    site: lead.site,
    hasPhone: lead.phone,
    hasEmail: lead.email,
    telegram: lead.telegramConfigured ? "configured, failed" : "not configured",
    hubspot: lead.hubspotConfigured ? "configured, failed" : "not configured",
  };
}
