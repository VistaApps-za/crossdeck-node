# @cross-deck/node

The Crossdeck server SDK for Node.js — one install, three pillars: **errors**, **analytics**, **entitlements**.

```bash
npm install @cross-deck/node
```

## Quick start

```ts
import { CrossdeckServer } from "@cross-deck/node";

const crossdeck = new CrossdeckServer({
  secretKey: process.env.CROSSDECK_SECRET_KEY!,
  appId: "app_node_xxxxxxxxxxxx",
  // env is inferred from the key prefix: cd_sk_test_… → sandbox, cd_sk_live_… → production
});

// Optional: validate the key at boot (recommended for serverless cold-starts)
await crossdeck.heartbeat();

// USP 1 — manual error capture
try {
  await processOrder(orderId);
} catch (err) {
  crossdeck.captureError(err, { context: { orderId } });
  throw err;
}

// USP 2 — analytics
crossdeck.track({
  name: "checkout.completed",
  developerUserId: "user_847",
  properties: { plan: "pro", revenue: 9_900 },
});

// USP 3 — entitlement gating (synchronous after first warm)
await crossdeck.getEntitlements({ userId: "user_847" });
if (crossdeck.isEntitled({ userId: "user_847" }, "pro")) {
  // grant access
}
```

Construct the client **once** at module scope and import it where you need it. This is safe even under frameworks that re-evaluate modules (Next.js HMR, per-route isolation, React Server Components): for a given secret key the SDK returns the same instance every time, so you never get a duplicate client. _(Single-instance guard added in 1.8.0.)_

## Three USPs, one SDK

### USP 1 — Errors

Auto-wired by default: `process.on('uncaughtException')`, `process.on('unhandledRejection')`, and `globalThis.fetch` wrap (5xx + network failures). Plus the full manual surface:

```ts
// Manual capture from try/catch
crossdeck.captureError(err, {
  context: { jobId },
  tags: { flow: "checkout" },
  level: "error", // "error" | "warning" | "info"
});

// Non-error signals (Sentry pattern)
crossdeck.captureMessage("deprecated path hit", "warning");

// Pin tags + context to all subsequent errors
crossdeck.setTag("release", process.env.K_REVISION);
crossdeck.setContext("region", { az: "us-east-1a" });

// Add breadcrumbs (last 50 attached to every error report)
crossdeck.addBreadcrumb({
  timestamp: Date.now(),
  category: "custom",
  message: "user.opened_paywall",
});

// Pre-send hook for app-specific PII scrubbing
crossdeck.setErrorBeforeSend((err) => {
  if (err.message.includes("auth-token=")) return null;
  return err;
});
```

Stack frames are parsed (V8 + Firefox/Safari formats), fingerprinted via djb2 over message + top-3 in-app frames, attached with the breadcrumb buffer + your context + tags. Rate-limited per fingerprint (default 5/min), session-capped (default 100/process). Frames inside `node_modules/`, `node:`, `internal/`, or `@cross-deck/node` are marked not-in-app and excluded from fingerprints.

To opt out (e.g. if you have a separate error tracker):

```ts
new CrossdeckServer({ secretKey, errorCapture: false });
```

### USP 2 — Analytics

`track()` enqueues synchronously into a durable retry-with-jitter queue with per-batch `Idempotency-Key` reuse on retry. Flush-on-exit drains before the process terminates — critical for Cloud Functions / Lambda where the runtime freezes the process and any pending events would otherwise vanish.

```ts
crossdeck.track({
  name: "paywall_shown",
  developerUserId: "user_847",
  properties: { variant: "v3" },
});

// Super-properties (Mixpanel pattern) — carried on every subsequent event
crossdeck.register({ serviceVersion: process.env.K_REVISION });
crossdeck.unregister("oldField");

// Group analytics — attach $groups.<type> for B2B dashboard pivots
crossdeck.group("org", "acme_inc");
crossdeck.group("team", "design", { headcount: 12 });

// Bulk imports — synchronous POST, returns IngestResponse
await crossdeck.ingest([
  { name: "job.completed", crossdeckCustomerId: "cdcust_x", properties: { durationMs: 1200 } },
  { name: "job.completed", crossdeckCustomerId: "cdcust_y", properties: { durationMs: 950 } },
]);

// Drain the queue (call at end of Lambda/CF invocations)
await crossdeck.flush();
```

> **Multi-tenant servers:** `register()` is **process-scoped**, not per-request. In a single Node process handling requests for many tenants, registering `{ tenant: "acme" }` taints every subsequent event from that process — including ones serving other tenants. For per-request properties, pass them on the `track()` call itself.

#### Framework adapters (`@cross-deck/node/auto-events`)

Plug Crossdeck into your existing framework with a single middleware/wrap call. Auto-emits `request.handled` / `function.invoked` / `function.completed` / `function.failed` events, captures uncaught errors with request context, and (on Lambda + Firebase) awaits `flush()` before the handler returns.

```ts
import {
  crossdeckExpress,
  crossdeckExpressErrorHandler,
  wrapLambdaHandler,
  wrapFunction,
} from "@cross-deck/node/auto-events";

// Express 4 + 5
app.use(crossdeckExpress(crossdeck, {
  getIdentity: (req) => ({ developerUserId: req.user?.id }),
}));
// ... routes ...
app.use(crossdeckExpressErrorHandler(crossdeck)); // register LAST

// AWS Lambda + Vercel Functions (which run on Lambda underneath)
export const handler = wrapLambdaHandler(crossdeck, async (event, ctx) => {
  return { statusCode: 200, body: "ok" };
});

// Firebase Functions v1 + v2, Cloud Run (generic shape-preserving wrap)
export const myFunction = onRequest(
  wrapFunction(crossdeck, async (req, res) => {
    res.send("ok");
  }),
);
```

### USP 3 — Entitlements

Per-customer TTL cache (default 60s). Hot-path entitlement gates become synchronous memory reads after the first warm. Bounded by `maxCustomers` (default 10,000) with LRU eviction for long-running multi-tenant servers.

```ts
// Warm the cache (records userId → customerId alias)
await crossdeck.getEntitlements({ userId: "user_847" });

// Synchronous gate — memory read within TTL, no HTTP
if (crossdeck.isEntitled({ userId: "user_847" }, "pro")) {
  // grant access
}

// Full snapshot for callers needing source / validUntil
const ents = crossdeck.listEntitlements({ userId: "user_847" });

// Subscribe to cache mutations (e.g. push to connected clients)
const unsubscribe = crossdeck.onEntitlementsChange((customerId, ents) => {
  // ...
});

// Server-side manual overrides
await crossdeck.grantEntitlement({
  customerId: "cdcust_123",
  entitlementKey: "pro",
  duration: "P30D",
  reason: "Support recovery after billing incident",
});
await crossdeck.revokeEntitlement({
  customerId: "cdcust_123",
  entitlementKey: "pro",
  reason: "Chargeback",
});
```

#### Receiving webhooks — `webhooks.constructEvent()`

Crossdeck sends signed, retried, at-least-once outbound webhooks to endpoints you register (`trust.rule.added` / `trust.rule.removed` today; more ride the same spine). Verify each one in one line — Stripe-compatible HMAC-SHA256, constant-time comparison, mandatory replay window, multi-secret rotation. `constructEvent` returns the **typed** `WebhookEvent` envelope; a throw means "do not act."

```ts
import { webhooks } from "@cross-deck/node";
import express from "express";

app.post("/crossdeck-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = webhooks.constructEvent(
      req.body.toString("utf8"),                 // the RAW bytes, unparsed
      req.headers["crossdeck-signature"],
      [process.env.CROSSDECK_WEBHOOK_SECRET, process.env.CROSSDECK_WEBHOOK_SECRET_OLD],
    );
  } catch (err) {
    return res.sendStatus(401);                  // bad signature / replay — reject
  }

  res.sendStatus(200);                           // ACK fast, then reconcile out of band:
  const truth = await fetch(event.reconcile.url).then((r) => r.json());
  enforceFrom(truth);                            // a webhook is a NUDGE — read the truth it points at
});
```

`crossdeck.webhooks.constructEvent(...)` is the same function mounted on the client. The lower-level `verifyWebhookSignature()` (returns the parsed body as `unknown`) and `signWebhookPayload(payload, secret, timestampSec)` (mint signed bodies for test fixtures) are also exported. Full reference: [Receiving Crossdeck webhooks](https://cross-deck.com/docs/webhooks-receive/).

### Blocking (Crossdeck Trust) — <sup>v2 preview</sup>

> **Preview — not GA.** The blocking surface launches **end-to-end with Crossdeck v2.**
> The shape is stable and all methods are `@experimental`, so it's documented and usable
> now (dogfooding / early access) — but it is **not** a launched feature yet, and this is
> not a fourth shipped USP. Treat it as preview until the v2 launch.

Blocking is **entitlements, inverted**: `getEntitlements()` asks *"can this user access Pro?"*; these ask *"should this user be here at all?"* — the **same identity backbone**, read for `blocked`. Every method is **fail-open by contract**: it never throws and never returns blocked on uncertainty, so a glitch can never lock out a real user.

There are three doors. Pick by who's at it:

```ts
// The Crossdeck-hosted block page — the recommended dead-end for doors 1 + 2. One
// constant today; swaps to https://block.cross-deck.com when the alias goes live.
const BLOCK_PAGE = "https://api.cross-deck.com/v1/trust/page";

// 1. A user you ALREADY KNOW — a bare userId rides the backbone (no token, no setup).
//    Crossdeck matches on the email it already holds. The common case.
const { blocked, blockEventId } = await crossdeck.resolve({ userId, ip: req.ip });
if (blocked) {
  await signOut();
  return blockEventId
    ? res.redirect(`${BLOCK_PAGE}/${blockEventId}`) // Crossdeck serves the branded page
    : res.redirect("/suspended");                   // rare: mint unavailable → your fallback
}
// or just the boolean:  if (await crossdeck.isBlocked({ userId })) …

// 2. A BRAND-NEW signup Crossdeck has never seen — block by the two strings you have
//    at signup, their email + ip. Call it BEFORE you create the account.
const gate = await crossdeck.gate({ email, ip: req.ip });
if (gate.action === "block") {
  return gate.blockEventId
    ? res.redirect(`${BLOCK_PAGE}/${gate.blockEventId}`)
    : rejectSignup(gate.blockReason);
}

// 3. A PUBLIC PAGE — "is the owner of this page blocked?" (no session token). Poll on a
//    short TTL to invalidate your cache; the ip is the owner's CREATION ip.
const owner = await crossdeck.getOwnerStatus({ userId: ownerId });
if (owner.blocked) await takePageOffline(ownerId);
```

**Why redirect instead of building your own screen?** Crossdeck hosts the canonical block
interstitial — "Access paused", a verification receipt (application name, timestamp, an
opaque `reference` the person can quote to support), and a **Contact support** action that
mails the project owner's real recorded email. One page, centrally maintained, updated for
every integrator at once — you never fork it, restyle it, or let it drift. Redirect **only
on an explicit block** (`blocked === true` / `action === "block"`): on error or timeout the
SDK fails open and you let the user through — never send a real user to a block page over
a network blip.

**Recommended server pattern (no issuer registration):** if your backend runs Firebase
Admin, verify the ID token **locally** for the authoritative uid, then send that as a bare
`userId` — you keep the cryptographic proof on your side and Crossdeck needs zero setup:

```ts
const { uid } = await getAuth().verifyIdToken(idToken);     // your Firebase Admin
const { blocked } = await crossdeck.resolve({ userId: uid, ip: req.ip });
```

Send `userId` + `idToken` to Crossdeck instead only if you *can't* verify locally — that's
the verified Tier-3 path, and the only one that needs a one-time auth-issuer registration.
Setting *who* is blocked is a rule in your Crossdeck admin. Full integration guide
(suspension pages, public-content takedown, the backfill sweep): `CROSSDECK_BLOCKING_DEVELOPER_GUIDE.md`.

Types: `ResolveInput` / `ResolveResult`, `GateInput` / `GateVerdict`, `OwnerStatusInput` / `BlockVerdict`.

## Cross-cutting

### Read-cost cross-match (Buckets)

Install [`@cross-deck/buckets`](https://www.npmjs.com/package/@cross-deck/buckets)
alongside this SDK and the auto-events adapters wire the **cross-match** for you:
every database read inside a request attributes to the **user** who triggered it and
the **operation** that spent it — the thing a standalone query profiler can't tell
you, because it doesn't know your users.

- `crossdeckExpress` stamps the request's `developerUserId` (from your `getIdentity`)
  as the read-cost actor, at request entry — before the route handler runs.
- `wrapLambdaHandler` stamps the actor *and* the function name as the operation.

```ts
app.use(crossdeckExpress(server, {
  getIdentity: (req) => ({ developerUserId: req.user?.id }), // WHO — also drives reads
}));
```

No new dependency and no import of Buckets — the SDK drives a global bridge, so a
missing collector is a silent no-op. Name the heavy server operations with `bucket()`
from Buckets; read it all back with `npx @cross-deck/buckets` or in the dashboard.

### Runtime info

Auto-detected at construction. Attached to every event + error as `runtime.*` properties:

| Detected platform | Trigger env var | Surfaces as `runtime.host` |
|---|---|---|
| AWS Lambda + Vercel Functions | `AWS_LAMBDA_FUNCTION_NAME` | `aws-lambda` |
| Azure Functions | `FUNCTIONS_WORKER_RUNTIME` + `WEBSITE_INSTANCE_ID` | `azure-functions` |
| Google App Engine | `GAE_APPLICATION` | `google-app-engine` |
| Firebase Functions v2 / Cloud Functions Gen 2 | `K_SERVICE` + `FIREBASE_CONFIG` | `firebase-functions-v2` |
| Firebase Functions v1 | `FUNCTION_NAME` + `FUNCTION_REGION` | `firebase-functions-v1` |
| Google Cloud Run | `K_SERVICE` + `K_REVISION` (no Firebase) | `cloud-run` |
| Vercel | `VERCEL === "1"` | `vercel` |
| Netlify Functions | `NETLIFY === "true"` | `netlify` |
| Heroku | `DYNO` | `heroku` |
| Render | `RENDER === "true"` | `render` |
| Railway | `RAILWAY_ENVIRONMENT` | `railway` |
| Fly.io | `FLY_APP_NAME` | `fly` |
| Generic Kubernetes | `KUBERNETES_SERVICE_HOST` | `kubernetes` |
| Plain Node | (fallback) | `node` |

Every detected platform exposes `serviceName`, `serviceVersion`, `region`, `instanceId` where available. Override via constructor:

```ts
new CrossdeckServer({
  secretKey,
  serviceName: "my-fn",
  serviceVersion: process.env.K_REVISION,
  appVersion: "1.2.3", // attached to events as `appVersion`
});
```

### Diagnostics

```ts
const d = crossdeck.diagnostics();
// {
//   sdkVersion, baseUrl, secretKeyPrefix (masked), env,
//   runtime: { nodeVersion, platform, host, region, serviceName, ... },
//   events: { buffered, dropped, inFlight, consecutiveFailures, ... },
//   errors: { sessionCount, fingerprintsTracked, handlersInstalled },
//   entitlements: { count, ttlMs, lastUpdated, listenerErrors },
// }
```

Useful for `/health` and `/metrics` endpoints exposed to your platform.

### Debug mode

```ts
new CrossdeckServer({ secretKey, debug: true });
```

Emits NorthStar §16 debug signals to `console.info`:

- `sdk.configured` — boot confirmation
- `sdk.first_event_sent` — proves wire connectivity
- `sdk.flush_retry_scheduled` — surfaces flush failures + retry delay
- `sdk.flush_on_exit_started` / `sdk.flush_on_exit_completed` — drain lifecycle
- `sdk.entitlement_cache_warm` / `sdk.entitlement_cache_used` — cache observability
- `sdk.webhook_verified` — signature verification confirmation
- `sdk.sensitive_property_warning` — flagged property names on `track()`
- `sdk.runtime_detected` — host platform detection

### PII scrub utility

Opt-in regex-based scrub for email + card-number-shaped substrings. Use before forwarding caller-supplied properties:

```ts
import { scrubPiiFromProperties } from "@cross-deck/node";

crossdeck.track({
  name: "checkout.failed",
  developerUserId,
  properties: scrubPiiFromProperties({
    url: req.url, // /users/wes@example.com/ → /users/[email]/
    failedCardLast4: payload.card_number, // 4242 4242 4242 4242 → [card]
  }),
});
```

## Configuration

All options on `new CrossdeckServer({...})`:

```ts
{
  secretKey: string;            // required — `cd_sk_test_…` (sandbox) | `cd_sk_live_…` (production)
  baseUrl?: string;             // default "https://api.cross-deck.com/v1"
  timeoutMs?: number;           // default 15_000, 0 disables
  appId?: string;               // optional metadata on event envelope
  sdkVersion?: string;          // override the version reported on the wire

  // USP 1
  errorCapture?: boolean | Partial<ErrorCaptureConfig>;
    // false to disable; partial object to override specific hooks
    // (onUncaughtException, onUnhandledRejection, wrapFetch, etc.)

  // USP 2
  eventFlushBatchSize?: number; // default 20
  eventFlushIntervalMs?: number;// default 1500
  flushOnExit?: boolean;        // default true — beforeExit + SIGTERM + SIGINT drain
  flushOnExitTimeoutMs?: number;// default 2000

  // USP 3
  entitlementCacheTtlMs?: number; // default 60_000, 0 disables

  // Cross-cutting
  serviceName?: string;         // overrides env-detected
  serviceVersion?: string;      // overrides env-detected
  appVersion?: string;          // attached as `appVersion` on events
  debug?: boolean;              // default false
  breadcrumbsMaxSize?: number;  // default 50

  // Bank-grade SDK extras (QA-review v2)
  testMode?: boolean;           // default false — short-circuits HTTP to synthetic responses
  onRequest?: (info) => void;   // fires on every request (incl. retries)
  onResponse?: (info) => void;  // fires on every response
  httpRetries?: {               // idempotent GET retry policy
    maxAttempts?: number;       // default 3 (1 initial + 2 retries)
    retryableStatuses?: number[]; // default [408, 500, 502, 503, 504]
  };
  runtimeToken?: string;        // override the User-Agent runtime token
}
```

## Error model

Stripe-style subclass hierarchy. Use `instanceof` for typed narrowing in your `catch` blocks.

```ts
import {
  CrossdeckError,
  CrossdeckAuthenticationError,
  CrossdeckRateLimitError,
  CrossdeckNetworkError,
  isCrossdeckErrorCode,
} from "@cross-deck/node";

try {
  await crossdeck.heartbeat();
} catch (err) {
  if (err instanceof CrossdeckAuthenticationError) {
    // 401 path — bad/revoked secret key, or bad webhook signature
  } else if (err instanceof CrossdeckRateLimitError) {
    // 429 — back off for err.retryAfterMs
  } else if (err instanceof CrossdeckNetworkError) {
    // fetch failed / aborted / timed out — likely transient
  } else if (err instanceof CrossdeckError) {
    if (isCrossdeckErrorCode(err.code) && err.code === "invalid_secret_key") {
      // narrowed to the catalogue's literal union
    }
    console.error(err.type, err.code, err.requestId);
  }
}
```

Subclasses: `CrossdeckAuthenticationError`, `CrossdeckPermissionError`, `CrossdeckValidationError`, `CrossdeckRateLimitError`, `CrossdeckNetworkError`, `CrossdeckInternalError`, `CrossdeckConfigurationError`. All extend `CrossdeckError`. The `version_error` type (code `sdk_version_unsupported`, HTTP 426) carries `minVersion`/`surface` and routes to PARK — see "Outdated-version PARK" above. Constructed automatically by the SDK — you never need to instantiate them yourself.

`CrossdeckErrorCode` is the literal union of every documented code in `CROSSDECK_ERROR_CODES`. Use `isCrossdeckErrorCode` to narrow `string` to the union for type-safe comparisons (catches misspelled codes at compile time).

`err.toJSON()` is implemented — your structured logger sees `type`, `code`, `requestId`, `status`, `retryAfterMs`, and `stack` instead of just `name + message`:

```ts
logger.error({ err }, "crossdeck request failed");
// → { err: { name: "CrossdeckRateLimitError", type: "rate_limit_error",
//             code: "too_many_requests", retryAfterMs: 30000, ... } }
```

Every entry in `CROSSDECK_ERROR_CODES` carries `{ code, type, description, resolution, retryable }` — render-able in dashboards and AI assistants.

## Reliability + lifecycle

### Idempotent GET retry

Read methods (`getEntitlements`, `getCustomerEntitlements`, `getAuditEntry`, `heartbeat`) automatically retry on 408 + 5xx (except 501) and on network failures. Default 3 attempts with exponential backoff + full jitter. Honours server `Retry-After`. Configurable per-instance:

```ts
new CrossdeckServer({
  secretKey,
  httpRetries: { maxAttempts: 5 }, // up to 5 attempts
});
```

POST methods (`track`/`ingest`/`syncPurchases`/`grantEntitlement`/`revokeEntitlement`) DO NOT auto-retry at the HTTP layer. Retries happen via the event queue with per-batch `Idempotency-Key` reuse — the server can dedupe replays.

### Outdated-version PARK (v1.7.0)

If the server ever stops accepting this SDK version's event format, the rejection is machine-distinguishable — HTTP `426` with code `sdk_version_unsupported` — and the queue treats it as its own outcome, distinct from retry (transient) and drop (invalid): the events are **parked**. The queue holds them (FIFO-capped at 1,000), stops flushing a known-too-old payload, warns once on the console naming the exact version to update to, and fires the `onParked` callback + a typed `sdk.parked` debug event.

**Honest bound:** the Node queue is in-memory, so a process restart *before* you upgrade clears the held events — an opt-in disk-backed queue is on the roadmap. After you deploy the upgraded SDK, held events deliver on the next flush. Web/RN/Swift hold theirs durably across restarts. Full story: [the durability contract](https://cross-deck.com/docs/sdk-event-durability/).

**v1.4.0 — `syncPurchases` deterministic key.** The Idempotency-Key
on `syncPurchases` is derived from the request body (UUID-shaped
SHA-256 of `crossdeck:purchases/sync:<rail>:<jws|token>`). Two retries
of the same Apple transaction land on the same key, so the backend
short-circuits with `idempotent_replay: true` instead of
double-processing. Override via `options.idempotencyKey` only when
an outer orchestrator needs a different idempotency window.

### AbortSignal — caller-controlled cancellation

Every async method accepts a final `RequestOptions?` with `{ signal, timeoutMs }`:

```ts
const ctrl = new AbortController();
const flight = crossdeck.heartbeat({ signal: ctrl.signal });
setTimeout(() => ctrl.abort(), 100);
try {
  await flight;
} catch (err) {
  if (err instanceof CrossdeckNetworkError && err.code === "request_aborted") {
    // caller-cancelled
  }
}
```

### PII scrubber (v1.4.0 — parity with Web/RN/Swift)

Every `track()` payload runs through `scrubPiiFromProperties`
before enqueue — email-shaped and card-number-shaped substrings
are rewritten to `<email>` / `<card>` sentinels recursively
across nested objects + arrays. **Default: on.** Pre-v1.4.0 the
Node SDK was the only one that skipped this, shipping payloads
UNREDACTED despite the README promising parity.

Opt out only for regulator-required audit trails where the raw
value must be preserved:

```ts
new CrossdeckServer({ secretKey, scrubPii: false });
```

**Blast radius:** every `track()` payload — event names with
embedded emails, trait values, group memberships, error context
blobs — ships verbatim to Crossdeck and downstream warehouses /
analytics exports. Document the decision at the call site.

### Shutdown — flush before exit (v1.4.0 contract)

The server holds a buffered event queue. A clean teardown MUST
flush the buffer before dropping it, otherwise events queued
between the last flush and shutdown are silently lost.

**Three teardown paths, three contracts:**

| Method | Flushes? | Use when |
| ------ | -------- | -------- |
| `await server.shutdown()` | YES — awaits internal `flush()` then tears down | Default. Use this in graceful-shutdown handlers. |
| `await using server = ...` + `[Symbol.asyncDispose]` | YES — equivalent to `await server.shutdown()` | TC39 explicit-resource-management blocks. |
| `server.shutdownSync()` / `using` + `[Symbol.dispose]` | NO — drops the buffer | ONLY when the runtime cannot await (signal handlers, process.exit fallthrough). |

```ts
// Graceful shutdown (recommended)
process.on("SIGTERM", async () => {
  await server.shutdown();
  process.exit(0);
});

// Explicit-resource-management (Node 20+ / TS 5.2+)
{
  await using server = new CrossdeckServer({ secretKey });
  // ... use server ...
} // [Symbol.asyncDispose] fires here, awaits flush
```

`shutdownSync()` (and the sync `[Symbol.dispose]` that wraps it)
logs a `console.warn` with the dropped-event count whenever the
buffer is non-empty at sync-teardown time — silent loss is
incompatible with the bank-grade contract.

### EventEmitter — internal events

`CrossdeckServer extends EventEmitter`. Subscribe to internal lifecycle events with typed listeners:

```ts
crossdeck.on("queue.flush_failed", ({ error, attempt, nextRetryMs }) => {
  metrics.increment("crossdeck.flush_failed", { attempt });
});
crossdeck.on("error.captured", ({ fingerprint, kind, message }) => {
  // forward to your other observability tools
});
crossdeck.on("sdk.shutdown", ({ reason }) => {
  // last-chance cleanup
});
```

Events: `queue.flush_succeeded`, `queue.flush_failed`, `queue.dropped`, `queue.buffer_changed`, `error.captured`, `entitlements.warmed`, `sdk.shutdown`.

### Health probes — Kubernetes / load balancers

```ts
crossdeck.isReady();   // synchronous: false on sustained retry storm or buffer pressure
await crossdeck.awaitReady(2000); // backpressure-aware wait
crossdeck.getHealth(); // full snapshot

// Express health endpoint
app.get("/healthz", (_req, res) => {
  const h = crossdeck.getHealth();
  res.status(h.healthy ? 200 : 503).json(h);
});
```

### Explicit resource management

TC39 `using` / `await using` syntax (Node 20+, TS 5.2+):

```ts
{
  using crossdeck = new CrossdeckServer({ secretKey });
  // ... use crossdeck ...
} // crossdeck[Symbol.dispose]() runs — handlers cleaned up

async function lambdaHandler(event) {
  await using crossdeck = new CrossdeckServer({ secretKey });
  crossdeck.track({ name: "handler.invoked", developerUserId: event.userId });
  // ... do work ...
} // crossdeck[Symbol.asyncDispose]() runs — awaits flush() then cleans up
```

### testMode — caller tests without mocking fetch

```ts
const crossdeck = new CrossdeckServer({
  secretKey: "cd_sk_test_test",
  testMode: true,
});
// Every call returns a synthetic success shape — no network.
// Use crossdeck.on("entitlements.warmed", ...) etc. to assert behaviour.
```

### onRequest / onResponse hooks

```ts
new CrossdeckServer({
  secretKey,
  onRequest: (info) => debug.log({ method: info.method, url: info.url, attempt: info.attempt }),
  onResponse: (info) => metrics.histogram("crossdeck.request_ms", info.durationMs),
});
```

Synchronous, errors swallowed — telemetry must never break the request pipeline.

### Bulk entitlement ops

```ts
// Grant `pro_q1_bonus` to a list of customers, bounded concurrency
const results = await crossdeck.bulkGrantEntitlement(
  customerIds.map((customerId) => ({
    customerId,
    entitlementKey: "pro_q1_bonus",
    duration: "P30D",
    reason: "Q1 promo",
  })),
  { maxConcurrency: 10 },
);

const succeeded = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
// Partial failures preserved as { ok: false, error }
```

Symmetric `bulkRevokeEntitlement(revokes[], options?)`.

## Bank-grade contracts

The SDK ships its own contracts registry — every behavioural guarantee the SDK makes (per-user cache isolation, deterministic Idempotency-Key, queue durability, etc.) lives in `contracts/**/*.json` at the monorepo root and is **bundled into every release**. The customer's lockfile pins SDK code + contracts atomically — drift between what the SDK does and what it claims is structurally impossible. See [`contracts/README.md`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/README.md) for the full architecture.

### `CrossdeckContracts` — typed access to the bundled registry

```ts
import { CrossdeckContracts } from "@cross-deck/node";

CrossdeckContracts.all();                              // enforced contracts only
CrossdeckContracts.allIncludingHistorical();           // + proposed + retired
CrossdeckContracts.byId("idempotency-key-deterministic");
CrossdeckContracts.byPillar("revenue");
CrossdeckContracts.withStatus("proposed");
CrossdeckContracts.findByTestName("rail namespacing prevents cross-rail collisions");
CrossdeckContracts.sdkVersion;        // "1.10.0"
CrossdeckContracts.bundledIn;         // "@cross-deck/node@1.10.0"
```

The `Contract` type is exported alongside; the binary-stability promise is documented in [`contracts/README.md`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/README.md).

### `crossdeckServer.reportContractFailure(input)` — surface contract test failures

When a contract test asserts and fails — in your CI, a dogfood run, or a customer integration test — fire a typed `crossdeck.contract_failed` event over the **Crossdeck reliability channel**. This is one-way operational telemetry to the Crossdeck operations team (Privacy Policy §6, "Flow B"); it never enters your `track()` pipeline, never shows in your dashboard, never bills against your event quota. The wire shape is schema-locked at [`contracts/diagnostics/contract-failed-payload-schema-lock.json`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/diagnostics/contract-failed-payload-schema-lock.json):

```ts
import { CrossdeckServer } from "@cross-deck/node";

const cd = new CrossdeckServer({ secretKey: process.env.CROSSDECK_SECRET_KEY! });

cd.reportContractFailure({
  contractId: "idempotency-key-deterministic",
  failureReason: "expected cross-SDK oracle to match canonical vector, got drift",
  runContext: process.env.CI ? "ci" : "dogfood",
  runId: process.env.GITHUB_RUN_ID ?? crypto.randomUUID(),
  testRef: {
    file: "tests/idempotency-key.test.ts",
    name: "apple JWS produces the canonical pinned UUID across all 5 SDKs",
  },
});
```

No new endpoint, no special ingest path — the event lands in the same pipeline every other server-side `track()` call does. It surfaces immediately in the dashboard's live event feed, the breakdown chart (group by `contract_id`, `sdk_platform`), and any alert rule with `event = crossdeck.contract_failed`.

Properties stamped on the wire:

| Property | Source |
|----------|--------|
| `contract_id` | caller |
| `sdk_version`, `sdk_platform` | auto-stamped (`@cross-deck/node` ships `sdk_platform: "node"`) |
| `failure_reason`, `run_context`, `run_id` | caller |
| `test_file`, `test_name` | set when `testRef` is provided |
| `device_class` | optional, set by caller (categorical bucket — e.g. `"linux-server"`, `"container"`, `"lambda"`) |

The wire shape is schema-locked at [`contracts/diagnostics/contract-failed-payload-schema-lock.json`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/diagnostics/contract-failed-payload-schema-lock.json); per-SDK assertion tests gate it on every release. Free-form `extra` keys are not accepted — adding a field requires an amendment to the schema-lock contract first.

For per-test-framework hooks see [`contracts/README.md` § Reporting contract failures](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/README.md#reporting-contract-failures-back-to-crossdeck).

## Node version

Node 18+. Uses the platform `fetch` and `node:crypto` — zero runtime dependencies.

## Bundle

`dist/index.cjs` + `dist/index.mjs` (main entry) + `dist/auto-events/index.cjs` + `dist/auto-events/index.mjs` (framework adapters subpath). Strict TypeScript, full `.d.ts` for both entries, source maps included.

## License

MIT
