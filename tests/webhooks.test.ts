import { describe, expect, it } from "vitest";

import { CrossdeckError } from "../src/errors";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  constructEvent,
  webhooks,
} from "../src/webhooks";

const SECRET = "whsec_test_001";
/** Fixed reference time so timestamp assertions are deterministic. */
const NOW = 1_717_891_200_000; // 2024-06-09T00:00:00Z

function makeHeader(payload: string, secret: string, timestampMs: number): string {
  const ts = Math.floor(timestampMs / 1000);
  const sig = signWebhookPayload(payload, secret, ts);
  return `t=${ts},v1=${sig}`;
}

describe("verifyWebhookSignature — happy path", () => {
  it("valid HMAC-SHA256 signature verifies and returns the parsed payload", () => {
    const payload = JSON.stringify({ object: "event.entitlement.granted", customerId: "cdcust_x" });
    const header = makeHeader(payload, SECRET, NOW);
    const result = verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
    expect(result).toEqual({ object: "event.entitlement.granted", customerId: "cdcust_x" });
  });

  it("supports the Stripe-style 't=<unix>,v1=<hex>' header format", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() => verifyWebhookSignature(payload, header, SECRET, { now: () => NOW })).not.toThrow();
  });

  it("header field order is irrelevant (v1 before t works equally)", () => {
    const payload = '{"x":1}';
    const ts = Math.floor(NOW / 1000);
    const sig = signWebhookPayload(payload, SECRET, ts);
    const header = `v1=${sig},t=${ts}`;
    expect(() => verifyWebhookSignature(payload, header, SECRET, { now: () => NOW })).not.toThrow();
  });

  it("accepts header passed as a single-element string[] (Node http.IncomingMessage shape)", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() => verifyWebhookSignature(payload, [header], SECRET, { now: () => NOW })).not.toThrow();
  });
});

describe("verifyWebhookSignature — rejections", () => {
  it("tampered payload throws CrossdeckError({ code: 'webhook_signature_mismatch' })", () => {
    const orig = '{"x":1}';
    const header = makeHeader(orig, SECRET, NOW);
    try {
      verifyWebhookSignature('{"x":2}', header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).code).toBe("webhook_signature_mismatch");
    }
  });

  it("tampered signature throws webhook_signature_mismatch", () => {
    const payload = '{"x":1}';
    const ts = Math.floor(NOW / 1000);
    const header = `t=${ts},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_signature_mismatch");
    }
  });

  it("missing secret throws webhook_missing_secret", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, undefined, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_missing_secret");
    }
  });

  it("empty-string secret throws webhook_missing_secret", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, "", { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_missing_secret");
    }
  });

  it("timestamp older than replayToleranceMs (default 5 min) throws webhook_timestamp_outside_tolerance", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW - 10 * 60_000);
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_timestamp_outside_tolerance");
    }
  });

  it("malformed header (no t= or no v1=) throws webhook_timestamp_missing", () => {
    // v1.4.0 — split from webhook_invalid_signature. A header
    // missing the timestamp segment can't be replay-checked at
    // all, so the failure mode is distinct from a signature
    // mismatch (which presumes a parseable header + timestamp).
    for (const header of ["bogus", "t=123", "v1=abc"]) {
      try {
        verifyWebhookSignature('{"x":1}', header, SECRET, { now: () => NOW });
        throw new Error(`expected to throw for header: ${header}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CrossdeckError);
        expect((err as CrossdeckError).code).toBe("webhook_timestamp_missing");
      }
    }
  });

  it("future-dated timestamp beyond tolerance throws (clock-skew defence)", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW + 10 * 60_000);
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_timestamp_outside_tolerance");
    }
  });

  it("valid signature but non-JSON payload throws webhook_payload_not_json", () => {
    // v1.4.0 — split from webhook_invalid_signature. The signature
    // DID verify (HMAC matched), so the failure is downstream of
    // the auth gate — distinct code so the customer can branch on
    // "tampered post-signing" vs "wrong secret".
    const payload = "not json {";
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_payload_not_json");
    }
  });
});

describe("verifyWebhookSignature — knobs", () => {
  it("custom replayToleranceMs overrides the 5-min default", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW - 30 * 60_000);
    expect(() =>
      verifyWebhookSignature(payload, header, SECRET, {
        now: () => NOW,
        replayToleranceMs: 60 * 60_000,
      }),
    ).not.toThrow();
  });

  it("tolerance of 0 still enforces the replay window (v1.4.0 — cannot disable)", () => {
    // v1.4.0 Phase 7.2 — pre-v1.4.0 tolerance=0 silently disabled
    // replay protection (`if (tolerance > 0)` skipped the check).
    // v1.4.0 contract: timestamp validation is MANDATORY; the
    // only knob is window width, never off. tolerance=0 means
    // "require exact-second match" — effectively unreachable, so
    // any non-trivial drift throws.
    const payload = '{"x":1}';
    const ancient = NOW - 365 * 24 * 60 * 60_000;
    const header = makeHeader(payload, SECRET, ancient);
    expect(() =>
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW, replayToleranceMs: 0 }),
    ).toThrowError(/webhook_timestamp_outside_tolerance|outside the 0ms/);
  });

  it("supports multiple secrets for rotation — any match wins", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() =>
      verifyWebhookSignature(payload, header, ["whsec_old_stale", SECRET], { now: () => NOW }),
    ).not.toThrow();
  });
});

describe("verifyWebhookSignature — v1.4.0 Phase 7.2 footgun hardening", () => {
  function assertInvalidTolerance(value: unknown): void {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, SECRET, {
        now: () => NOW,
        // Intentionally pass through any-typed test inputs that
        // would normally be filtered by the TypeScript boundary —
        // simulates JS callers + accidental misuse.
        replayToleranceMs: value as number,
      });
      throw new Error(`expected to throw for tolerance: ${String(value)}`);
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).code).toBe("webhook_invalid_tolerance");
    }
  }

  it("rejects Infinity tolerance (would silently disable replay protection)", () => {
    assertInvalidTolerance(Infinity);
  });

  it("rejects NaN tolerance", () => {
    assertInvalidTolerance(NaN);
  });

  it("rejects negative tolerance", () => {
    assertInvalidTolerance(-1);
    assertInvalidTolerance(-60_000);
  });

  it("rejects tolerance above the 24h cap", () => {
    const overCap = 24 * 60 * 60 * 1000 + 1;
    assertInvalidTolerance(overCap);
    assertInvalidTolerance(Number.MAX_SAFE_INTEGER);
  });

  it("rejects non-number tolerance (null / string)", () => {
    assertInvalidTolerance(null);
    assertInvalidTolerance("5000");
  });

  it("accepts tolerance exactly at the 24h cap", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() =>
      verifyWebhookSignature(payload, header, SECRET, {
        now: () => NOW,
        replayToleranceMs: 24 * 60 * 60 * 1000,
      }),
    ).not.toThrow();
  });
});

describe("signWebhookPayload (exported for fixture authors)", () => {
  it("produces deterministic 64-char hex for the same input", () => {
    const a = signWebhookPayload('{"x":1}', SECRET, 1_700_000_000);
    const b = signWebhookPayload('{"x":1}', SECRET, 1_700_000_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different payload yields different signature", () => {
    const a = signWebhookPayload('{"x":1}', SECRET, 1_700_000_000);
    const b = signWebhookPayload('{"x":2}', SECRET, 1_700_000_000);
    expect(a).not.toBe(b);
  });
});

describe("webhooks.constructEvent — Stripe-exact typed API (CD-145)", () => {
  const ENVELOPE = {
    id: "evt_abc123",
    object: "event" as const,
    type: "trust.rule.added",
    api_version: "2026-07-01",
    created: Math.floor(NOW / 1000),
    livemode: true,
    data: { ruleId: "rul_1" },
    reconcile: { method: "GET", url: "https://api.cross-deck.com/v1/trust/blocklist" },
  };
  const BODY = JSON.stringify(ENVELOPE);

  it("returns the parsed, typed envelope on a valid signature", () => {
    const header = makeHeader(BODY, SECRET, NOW);
    const event = constructEvent(BODY, header, SECRET, { now: () => NOW });
    expect(event).toEqual(ENVELOPE);
    // Typed access compiles + resolves at runtime:
    expect(event.type).toBe("trust.rule.added");
    expect(event.id).toBe("evt_abc123");
    expect(event.reconcile.url).toContain("/v1/trust/blocklist");
    expect(event.livemode).toBe(true);
  });

  it("throws on a tampered body (signature mismatch) — never returns a value", () => {
    const header = makeHeader(BODY, SECRET, NOW);
    const tampered = BODY.replace("rul_1", "rul_HACKED");
    try {
      constructEvent(tampered, header, SECRET, { now: () => NOW });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).code).toBe("webhook_signature_mismatch");
    }
  });

  it("throws on a replayed (stale) timestamp", () => {
    const stale = NOW - 10 * 60 * 1000; // 10 min old, past the 5 min window
    const header = makeHeader(BODY, SECRET, stale);
    try {
      constructEvent(BODY, header, SECRET, { now: () => NOW });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_timestamp_outside_tolerance");
    }
  });

  it("accepts a rotated secret array (any match)", () => {
    const header = makeHeader(BODY, SECRET, NOW);
    const event = constructEvent(BODY, header, ["whsec_old", SECRET], { now: () => NOW });
    expect(event.type).toBe("trust.rule.added");
  });

  it("the webhooks namespace exposes the three pure helpers, mount-agnostic", () => {
    expect(webhooks.constructEvent).toBe(constructEvent);
    expect(webhooks.verifyWebhookSignature).toBe(verifyWebhookSignature);
    expect(webhooks.signWebhookPayload).toBe(signWebhookPayload);
  });
});
