// PDPL: nothing that identifies a lead may reach the server log. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDroppedLead, describeError, redactPii } from "./lead-log.ts";

// One lead, used by every case below, so the backstop at the bottom has a single
// list of values to hunt for.
const LEAD = {
  name: "Fatima Al Mansoori",
  email: "fatima.almansoori@example.ae",
  phoneE164: "+971501234567",
  phoneTyped: "050 123 45 67",
  company: "Marina Heights Realty",
};
const SECRETS = Object.values(LEAD);

// Everything the module returned during this file's run.
const produced: string[] = [];
const record = <T>(value: T): T => {
  produced.push(typeof value === "string" ? value : JSON.stringify(value));
  return value;
};

test("describeDroppedLead reports the failure, never the person", () => {
  const line = record(
    describeDroppedLead({
      source: "final_cta",
      site: "EN",
      phone: true,
      email: true,
      telegramConfigured: true,
      hubspotConfigured: false,
    }),
  );

  // Actionable: which form, which site, what the person left, what was broken.
  assert.equal(line.source, "final_cta");
  assert.equal(line.site, "EN");
  assert.equal(line.hasPhone, true);
  assert.equal(line.hasEmail, true);
  assert.equal(line.telegram, "configured, failed");
  assert.equal(line.hubspot, "not configured");
  assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T/);

  // And nothing else: the key set is closed, so a later field cannot smuggle a
  // value in without this test being updated on purpose.
  assert.deepEqual(Object.keys(line).sort(), [
    "at",
    "hasEmail",
    "hasPhone",
    "hubspot",
    "site",
    "source",
    "telegram",
  ]);
});

test("describeDroppedLead does not echo a client-supplied source verbatim", () => {
  // `source` is a free string from the browser, length-capped and nothing else,
  // so it is a ready-made channel for putting an email into the log.
  const line = record(
    describeDroppedLead({
      source: LEAD.email,
      site: "RU",
      phone: false,
      email: true,
      telegramConfigured: false,
      hubspotConfigured: true,
    }),
  );
  assert.equal(line.source, "other");
});

test("redactPii scrubs the HubSpot body that quotes back what we sent", () => {
  // Real shape of a HubSpot 400: it repeats the offending property value.
  const body =
    `{"status":"error","message":"Property values were not valid: [{\\"isValid\\":false,` +
    `\\"message\\":\\"Email address ${LEAD.email} is invalid\\",\\"name\\":\\"email\\"},` +
    `{\\"message\\":\\"${LEAD.phoneE164} is not a valid phone number\\",\\"name\\":\\"phone\\"}]",` +
    `"correlationId":"c0ffee00-1234-4321-9999-abcdefabcdef"}`;

  const safe = record(redactPii(body, [LEAD.name, LEAD.email, LEAD.phoneE164, LEAD.company]));

  assert.ok(!safe.includes(LEAD.email));
  assert.ok(!safe.includes(LEAD.phoneE164));
  // Still diagnosable.
  assert.ok(safe.includes("Property values were not valid"));
  assert.ok(safe.includes("c0ffee00-1234-4321-9999-abcdefabcdef"), "correlation id survives");
});

test("redactPii scrubs the phone out of a WhatsApp deep link", () => {
  // Telegram rejects a message over one bad inline button and quotes the URL —
  // and our button is https://wa.me/<the lead's number>.
  const body =
    `{"ok":false,"error_code":400,"description":"Bad Request: BUTTON_URL_INVALID ` +
    `https://wa.me/971501234567?text=Hi%20Fatima"}`;
  const safe = record(redactPii(body));

  assert.ok(!safe.includes("971501234567"), `number leaked: ${safe}`);
  assert.ok(safe.includes("BUTTON_URL_INVALID"));
});

test("redactPii removes a value even when upstream reformats it", () => {
  const safe = record(
    redactPii(`rejected contact ${LEAD.name} <${LEAD.email}> tel ${LEAD.phoneTyped}`, [
      LEAD.name,
      LEAD.email,
      LEAD.phoneTyped,
    ]),
  );
  assert.ok(!safe.includes(LEAD.name));
  assert.ok(!safe.includes(LEAD.phoneTyped));
});

test("a short name does not eat the words around it (Ali, Sam)", () => {
  // Regression. The value pass used to be a bare substring replace, so a lead
  // called Ali - an everyday first name in the UAE - rewrote HubSpot's diagnosis
  // into "Property values were not v<redacted>d ... V<redacted>DATION_ERROR",
  // and Sam ate "sample rate". Nothing leaked, but the line stopped being worth
  // logging. The earlier cases all used "Fatima Al Mansoori", long enough that no
  // upstream word happens to contain it.
  const hubspot =
    "{status:error, message:Property values were not valid: " +
    "[{isValid:false, message:Email address ali@example.ae is invalid}], " +
    "category:VALIDATION_ERROR, context:{owner:Ali}}";
  const safe = record(redactPii(hubspot, ["Ali", "ali@example.ae", "+971501234567"]));

  // The lead is gone: the whole address (not just its local part - the longest
  // value is applied first) and the name where it stands on its own.
  assert.ok(!safe.includes("ali@example.ae"), `email leaked: ${safe}`);
  assert.ok(!safe.includes("@example.ae"), `only the local part was cut: ${safe}`);
  assert.ok(!safe.includes("owner:Ali"), `standalone name survived: ${safe}`);
  assert.ok(safe.includes("owner:<redacted>"), `name was not redacted: ${safe}`);

  // The diagnosis is intact. Every one of these contains "ali" as a fragment.
  assert.ok(safe.includes("Property values were not valid"), safe);
  assert.ok(safe.includes("isValid:false"), safe);
  assert.ok(safe.includes("VALIDATION_ERROR"), safe);
  assert.ok(safe.includes("is invalid"), safe);

  const telegram = record(
    redactPii("Sample rate exceeded for the Sam Lee record; sample window 60s", [
      "Sam Lee",
      "Sam",
    ]),
  );
  assert.ok(!telegram.includes("Sam Lee"), `name leaked: ${telegram}`);
  assert.ok(telegram.includes("Sample rate exceeded"), telegram);
  assert.ok(telegram.includes("sample window 60s"), telegram);
});

test("a contact detail is removed at any length, a name is not chopped to bits", () => {
  // Two-letter initials and the like are skipped by the length guard, but an
  // address or a number is identifying on its own and always goes.
  const safe = record(
    redactPii('field "id" = 7; wrote a@b.co and +97150 000 1122 for J', [
      "J",
      "a@b.co",
      "+97150 000 1122",
    ]),
  );
  assert.ok(!safe.includes("a@b.co"));
  assert.ok(!safe.includes("+97150 000 1122"));
  assert.ok(safe.includes('field "id" = 7'), `one-letter value wrecked the line: ${safe}`);
});

test("redactPii keeps short, non-identifying fragments intact", () => {
  // Over-scrubbing costs the owner the diagnosis, so the value pass ignores
  // anything under 3 characters and the phone pattern needs an explicit "+".
  const safe = record(redactPii("HTTP 502 after 8000 ms, attempt 2 of 2 at 2026-09-23T18:04:11Z", ["EN"]));
  assert.equal(safe, "HTTP 502 after 8000 ms, attempt 2 of 2 at 2026-09-23T18:04:11Z");
});

test("describeError takes the message and redacts it, never the stack", () => {
  const err = new Error(`upstream refused ${LEAD.email} / ${LEAD.phoneE164}`);
  const safe = record(describeError(err, [LEAD.email, LEAD.phoneE164]));
  assert.ok(!safe.includes(LEAD.email));
  assert.ok(!safe.includes(LEAD.phoneE164));
  assert.ok(safe.includes("upstream refused"));
  assert.ok(!safe.includes("at Object"), "no stack frames");
});

test("no string this module produced in the whole suite contains lead data", () => {
  // Backstop, mirroring lib/rate-limit-redis.test.ts: catches a future path that
  // forwards a raw value instead of going through redactPii().
  assert.ok(produced.length > 0, "the suite must have produced strings to check");
  const leaking = produced.filter((line) =>
    SECRETS.some((secret) => line.includes(secret)) ||
    /[^\s"'<>(),;:\\]+@[^\s"'<>(),;:\\]+\.[A-Za-z]{2,}/.test(line) ||
    /\+\d[\d\s()-]{6,}\d/.test(line) ||
    /\b\d{9,15}\b/.test(line),
  );
  assert.deepEqual(leaking, [], `lead data found in output: ${leaking.join(" | ")}`);
});
