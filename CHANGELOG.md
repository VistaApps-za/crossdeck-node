# Changelog

All notable changes to `@cross-deck/node` will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.12.1] — 2026-07-23

- **Reliability telemetry re-pointed to the live project.** The internal `crossdeck.contract_failed` self-check channel used a retired reliability-workspace key that had begun returning `401 invalid_api_key`, silently dropping failures; it now targets the live "Crossdeck Health Check" project. Internal SDK-health only — never touches your dashboard or your app. (No API changes; the anonymous-`reset()` hardening in the other SDKs does not apply — the Node SDK has no persistent device identity to churn.)

## [1.12.0] — 2026-07-01

**Added — `blockEventId`: the Crossdeck-hosted block page (v2 preview).**
On a block, `resolve()` and `gate()` now return `blockEventId` — the id of the
canonical block interstitial Crossdeck hosts for that exact verdict. The
recommended dead-end becomes one line:

```ts
if (blocked && blockEventId) {
  res.redirect(`https://api.cross-deck.com/v1/trust/page/${blockEventId}`);
}
```

Crossdeck serves the branded "Access paused" page — a verification receipt
(application name, timestamp, the quotable `reference`) and a **Contact
support** action that mails the project owner's real recorded email — so you
never hand-build, fork, or drift the block screen. The id is opaque
(`cd_blk_…`, no PII in the URL) and present only on an explicit block;
fail-open behaviour is unchanged (never redirect on error/timeout).
`ResolveResult` and `GateVerdict` carry the new optional field — additive,
non-breaking. Still `@experimental` until the Crossdeck v2 launch.

## [1.11.0] — 2026-06-30

**Added — block `reference` and `supportEmail` on the trust surface (still v2 preview).**
`resolve()` and `gate()` now surface two fields on a block:

- `reference` — a short, opaque, human-quotable support handle (the "Ray ID", `xxxx-xxxx`).
  Show it on your suspended screen; Crossdeck stores the same string on the block event, so
  support resolves a quoted reference to the exact block in the admin Caught feed.
- `supportEmail` — the email you registered with Crossdeck at signup, so your suspended
  screen's "Contact support" reaches the real operator by default instead of a placeholder.

Both were typed on `ResolveResult` / `GateVerdict` but the client previously **dropped**
them when building the result object — now passed through. Additive, non-breaking. Opaque +
non-PII (never the score or rule logic).

## [1.10.1] — 2026-06-30

**Fixed — the blocking surface now works for the documented paths (still v2 preview).**

- `resolve()` / `isBlocked()` now accept a **bare `userId`** — the server-trusted
  recognition path the backend honours (rides the identity backbone, matches on the email
  Crossdeck already holds). 1.10.0's guard rejected it and fail-opened *without calling the
  API*, so a known-user block silently never fired.
- **Added `gate({ email, ip })`** — the brand-new-signup door (`POST /v1/trust/gate`), the
  only path that catches a farm Crossdeck has never seen. Fail-open by contract. New
  `GateInput` / `GateVerdict` types.
- README now documents the blocking surface (the three doors + the verify-locally pattern).

Still `@experimental` — Crossdeck Trust ships with Crossdeck v2.


## [1.10.0] — 2026-06-30

**Added — the blocking surface (Crossdeck Trust, v2 preview).** Blocking is
"entitlements, inverted": `getEntitlements()` answers *can they access Pro?*; the new
methods answer *should they be here at all?* — the same `/v1/resolve` plumbing, read for
`blocked`. Additive and non-breaking.

- **`resolve(input)`** → `ResolveResult` — the block verdict plus identity/entitlement
  context in one call. **Fail-open by contract:** never throws for the verdict and never
  returns `blocked: true` on uncertainty; any error → `{ blocked: false, degraded: true }`,
  so a glitch can never lock out a real user (the mirror of entitlements, which fail
  closed). Forward the end-user's `ip` (server-to-server callers otherwise expose only
  their own server IP, so ip-rules can't match) and the verified identity
  (`userId` + `idToken`) so domain/email rules can match.
- **`isBlocked(input)`** → `boolean` — convenience over `resolve()`; same fail-open.
- **`getOwnerStatus(input)`** → `BlockVerdict` — the public-page path: *"is the owner of
  this page blocked?"*, no session token, for cache invalidation on link-in-bio / content
  platforms (Pattern B).

New exported types: `ResolveInput`, `ResolveResult`, `BlockVerdict`, `OwnerStatusInput`.
All marked `@experimental` — Crossdeck Trust ships with Crossdeck v2; the shape is stable,
the surface is not yet GA.

## [1.9.1] — 2026-06-30

**Docs — knowledge-backbone governance release.** No runtime API change. This
patch republishes the SDK with the Markdoc-backed README/version-control surface
so npm, the public GitHub mirror, and the Crossdeck knowledge backbone all carry
the same governed installation and contract documentation.

## [1.9.0] — 2026-06-24

**Added — read-cost cross-match (the Buckets bridge).** When
[`@cross-deck/buckets`](https://www.npmjs.com/package/@cross-deck/buckets) is
installed alongside this SDK, the auto-events adapters now tell it **who** and
**what** each request is, so every database read inside the request attributes to
the identified user *and* the operation that spent it — the cross-match no
standalone read profiler can do.

- `crossdeckExpress` stamps the request's `developerUserId` (from your
  `getIdentity`) as the read-cost **actor** at request entry, before the route
  handler issues a single read.
- `wrapLambdaHandler` stamps the **actor** *and* the **function name** as the
  operation (the function is the unit on serverless).

Decoupled and zero-dependency: the SDK never imports Buckets — it drives a global
bridge (`__crossdeckBucketsBridge__`). With no collector installed, every call is
a silent no-op, so this is safe whether a customer runs the SDK alone, Buckets
alone, or both. WHAT on the server is otherwise named by your own `bucket()` tags.

## [1.8.2] — 2026-06-22

**Docs.** Reverted the read-cost dashboard preview 1.8.1 added to the README —
it belongs on Buckets (the read-cost product), not on this telemetry SDK. No
code change; behaviour is identical to 1.8.0 and 1.8.1.

## [1.8.1] — 2026-06-21

**Docs.** The README now opens with the Buckets preview — "where your reads go,
before and after a fix" — so you can see what Crossdeck reports back before you
read a line of API. No code change; SDK behaviour is identical to 1.8.0.

## [1.8.0] — 2026-06-21

**Self-defends against re-instantiation (Next.js / serverless).** Constructing
`new CrossdeckServer()` at module top-level is the documented pattern, but
frameworks like Next.js re-evaluate module scope (HMR, per-route isolation, chunk
splitting), so it could run many times in one process — each time firing another
boot heartbeat, starting another flush timer, stacking another set of process
listeners (`beforeExit` / `SIGTERM` / `uncaughtException` / `unhandledRejection`),
and re-wrapping global `fetch`. That produced a storm of duplicate phone-homes and
an `EventEmitter` max-listeners warning. The SDK now guards against it — minor,
backwards-compatible.

**Fixed:**

- **Singleton guard.** The constructor now returns the EXISTING instance for the
  same credentials (secretKey + appId + baseUrl) instead of building a second one,
  so re-evaluation never re-boots. Same defence Prisma / Firebase Admin ship for
  the same reason. New `CrossdeckServer.clearSingletonCache()` static for tests /
  bespoke hot-reload teardown.
- **Idempotent `fetch` wrap.** The error-capture fetch wrapper tags itself and
  skips wrapping an already-wrapped `fetch`, so a double-install can't
  double-capture every request.

## [1.7.0] — 2026-06-11

**PARK on version-rejection — events are held, never dropped.** A third
event-queue outcome for the day the server stops accepting an outdated event
format. Purely additive; no public API change.

**Added:**

- **PARK (HTTP `426` / `sdk_version_unsupported`).** A version-rejection is now
  recognised as its own outcome — distinct from retry (transient) and drop
  (invalid): the data is good, only the wire dialect is stale. The queue
  **holds** the events (folded to the buffer front, FIFO-capped at 1000),
  **hushes** (stops flushing a known-too-old payload), **signals** once (one
  `console.warn` + a typed `sdk.parked` debug event), and delivers on restart
  after you upgrade. Node's queue is in-memory, so a process restart *before*
  upgrade clears the held events — an opt-in disk-backed queue is on the
  roadmap; the messaging says exactly this, never more.
- **`sdk_version_unsupported`** added to the error-codes catalogue with
  remediation, and `version_error` to `CrossdeckErrorType`. `CrossdeckError`
  carries `minVersion` / `surface` from the 426 body. New `onParked` callback.

**Fixed (no public API change):**

- The empty-input contract is now codified cross-SDK as
  `invalid-input-rejected-natively`: `track("")` / `aliasIdentity` with a
  missing `userId` reject at the call site by throwing a typed `CrossdeckError`
  (`missing_event_name` / `missing_user_id`) and never reach the wire — the
  Node/JS idiom of the invariant *"invalid input never crashes the app."* No
  behaviour change; the guarantee is now documented and bundled.
- Standalone-build fix: the `contract-failed` schema-lock test now reads the
  bundled contract (`_contracts-bundled.ts`) instead of the monorepo
  `contracts/` path, so the published-mirror release build no longer fails.

See https://cross-deck.com/docs/sdk-event-durability/ for the durability contract.

## [1.6.0] — 2026-06-10

Event Envelope v1 conformance — server-enforced contract (spec
`backend/docs/event-envelope-spec-v1.md`).

**Added:**

- **`envelopeVersion: 1`** (integer) on every batch POST body. Both the
  queue-flush path (`EventQueue.flush()`) and the direct `ingest()` path
  now emit this field. The server will reject payloads missing this field
  once ingest enforcement lands.
- **`seq`** (number) on every wire event — per-session monotonic sequence
  number. Captured synchronously with the event's `timestamp` at
  `track()` / enqueue time. Counter starts at 0 when the `CrossdeckServer`
  instance is constructed (session start) and increments once per event.
  Matches spec §3: monotonic within a session, never reset between
  background/foreground (Node has no such lifecycle; the instance lifetime
  IS the session).
- **`context`** (object) on every wire event — standardized device/platform
  context (spec §4), promoted out of `properties`. Common fields: `os`,
  `osVersion`, `appVersion`, `sdkName`, `sdkVersion`, `locale`, `timezone`.
  Node-specific: `nodeVersion`, `host`, `region` (the existing
  `runtime.*` props, promoted).

**Changed:**

- `track()` no longer merges `runtime.*` keys into `properties`. Those
  facts now live in the top-level `context` object on the wire event.
  Super-properties registered via `server.register()` continue to appear
  in `properties` unchanged (caller-supplied values are unaffected).

## [1.5.1] — 2026-05-27

`crossdeck.contract_failed` is now single-fire to a dedicated
reliability endpoint instead of the customer's `track()` pipeline.
Independent-controller flow per Privacy Policy §6; schema-locked by
`contracts/diagnostics/contract-failed-payload-schema-lock.json`.
`ContractFailureInput.extra` removed (schema-lock forbids unbounded
fields); `ContractFailureInput.deviceClass` added.

## [1.5.0] — 2026-05-26

Minor — `CrossdeckContracts` + `reportContractFailure(...)` ship as a
new public surface on every SDK simultaneously. Additive only; no
behavioural change to existing APIs.

**Added:**

- **`CrossdeckContracts` namespace** — typed access to the bank-grade
  contract registry. Methods: `all()`, `allIncludingHistorical()`,
  `byId(id)`, `byPillar(pillar)`, `withStatus(status)`,
  `findByTestName(name)`. Properties: `sdkVersion`, `bundledIn`
  (e.g. `"@cross-deck/node@1.5.0"`).
- **`Contract` type + `ContractPillar` / `ContractStatus` /
  `ContractAppliesTo` unions + `ContractTestRef` + `ContractFailureInput`
  interfaces** exported from the top-level entry. Treated as
  binary-stable.
- **`CrossdeckServer.reportContractFailure(input)` method** — fires a
  typed `crossdeck.contract_failed` server event through the standard
  `track()` pipeline. Wire properties: `contract_id`, `sdk_version`
  (auto-stamped), `sdk_platform` (auto-stamped to `"node"`),
  `failure_reason`, `run_context` (`ci` | `dogfood` | `customer-app`),
  `run_id`, plus optional `test_file` / `test_name` from `input.testRef`.

**Fixed:**

- `shutdownSync()` now emits the `sdk.shutdown` EventEmitter signal
  with the correct reason — previously only the async `shutdown()`
  path emitted, leaving consumers of `Symbol.dispose` /
  `shutdownSync()` direct-callers blind. Async path is unchanged
  thanks to a private dedup gate so listeners still fire exactly
  once per teardown.
- Test infrastructure: shutdown-flush + track-PII-scrub tests were
  reading `body.data` from captured fetch payloads but the wire
  shape uses `body.events` (matching backend + Web/RN SDKs). Tests
  fixed to read the correct field; behaviour was already correct.

**Changed:**

- Contract registry source files migrated to camelCase keys
  (`appliesTo`, `codeRef`, `testRef`, `registeredAt`,
  `firstRegisteredIn`). The bundled `contracts.json` sidecar uses
  the new keys; `bundledIn` is build-stamped, never in source.

## [1.4.2] — 2026-05-26

Patch — fix `tests/shutdown-flush.test.ts` compile error under
strict tsc. The five `s.track("name", { props })` calls used the
web/RN positional-args shape; Node SDK's track takes a single
`ServerEvent` object. Switched to `s.track({ name, properties })`.
Plus a non-null assertion on `sent[0].length` for
`noUncheckedIndexedAccess`. v1.4.1 was tagged on the public
crossdeck-node repo but its publish workflow aborted on these
errors. v1.4.2 is the first 1.4.x line to land on the npm
registry. **No SDK code changes vs v1.4.0 / v1.4.1**.

## [1.4.1] — 2026-05-26

Patch — add automated npm publish workflow to the public
`crossdeck-node` repo so future `vX.Y.Z` tag pushes auto-publish
to npm via OIDC Trusted Publishing (matches the existing
`crossdeck-web` pattern). Also strips `test:e2e` from
`prepublishOnly` — the publish workflow runs lint + unit tests +
build which covers the release gate. No SDK code changes vs
v1.4.0.

**Operator note:** npmjs.com Trusted Publisher rule must be
configured for `crossdeck-node` (owner: VistaApps-za,
workflow: publish.yml) before the OIDC publish succeeds. First
publish after this lands will fail with an auth error if the
rule is missing — that's the prompt to configure it.

## [1.4.0] — 2026-05-26

**Bank-grade reconciliation release.** 6-pillar KPMG-style audit closed across SDK + backend. Every behavioural guarantee registered in the monorepo's `contracts/` directory with a CI-enforced audit job.

### Added

- **PII scrubber applied on `track()` enqueue path** — parity with Web/RN/Swift. Pre-1.4.0 Node was the ONLY SDK that skipped this, shipping payloads UNREDACTED. New `scrubPii?: boolean` option (default true); explicit false opt-out preserves raw payloads for regulator-required audit trails.
- **Deterministic `Idempotency-Key` on `syncPurchases()`** — same JWS/purchaseToken → same key. New `options.idempotencyKey` override for outer orchestrators.
- **`PurchaseResult.idempotent_replay?: boolean`** — true when the backend replayed a cached response.
- **`purchase.completed` event on every successful `syncPurchases()`** — funnel parity with Swift/Android auto-track.
- **Distinguishable webhook verifier error codes** — pre-1.4.0 collapsed everything into `webhook_invalid_signature`. New: `webhook_signature_mismatch` (wrong-secret signal), `webhook_timestamp_outside_tolerance` (replay-attack signal — alert separately), `webhook_timestamp_missing`, `webhook_payload_not_json`, `webhook_invalid_tolerance`. Legacy codes deprecated with migration notes.
- **Webhook verifier rejects footgun tolerances** — `Infinity` / `NaN` / negative / above-24h-cap now throw `webhook_invalid_tolerance` instead of silently disabling replay protection.
- **15 backend-emitted error codes** added to the `crossdeck-error-codes.json` catalogue with Stripe-style remediation guidance.

### Changed (breaking)

- **`shutdown()` signature changed from `(reason) => void` to `(reason) => Promise<void>`.** Awaits `flush()` before tearing down the queue. Pre-1.4.0 it called `eventQueue.reset()` synchronously — every event between the last flush and shutdown was silently dropped. New `shutdownSync()` for callers that genuinely cannot await (signal handlers); it logs `console.warn` with the dropped-event count if the buffer is non-empty.
- **Default event-queue flush interval is now 2000ms** (was 1500ms) — cross-SDK parity.
- **`[Symbol.dispose]` now warns when dropping queued events.** Use `await using` + `[Symbol.asyncDispose]` (or `await server.shutdown()`) for proper drainage.

## [1.3.1] — 2026-05-24

Patch fix for the 1.3.0 dist-load contract. Mirrors the
`@cross-deck/web@1.3.1` patch — `SDK_VERSION` is now sourced from a
generated `src/_version.ts` file (produced by
`scripts/sync-sdk-versions.mjs` from `package.json`) instead of a
runtime `import { version } from "../package.json"` that needs a
`with { type: "json" }` assertion to load as ESM. Wire contract is
unchanged. 1.3.0 was never published to npm; 1.3.1 is the first
1.3.x line to reach npm.

## [1.3.0] — 2026-05-24

KPMG bank-grade audit closure. Six review batches landed five SDK PRs
and a backend wiring fix that closes every P0 plus 12 of 13 P1 findings.
No public method renames; one internal contract change
(`ErrorTracker.beforeSend` is now a getter) that also removes the
`Object.defineProperty` workaround the node SDK shipped to compensate
for the same broken contract on web. Behavioural changes to the queue
and the PII scrub strictly improve correctness. The wire
`Crossdeck-Sdk-Version` header now reads from `package.json` so it
cannot drift from the published bundle.

### Fixed (P0)

- **PII scrub sentinel tokens aligned with the backend.** `[email]` /
  `[card]` → `<email>` / `<card>`, matching `backend/src/api/lib/scrub.ts`.
  The same event scrubbed by SDK + backend now carries the same
  sentinel — dashboard aggregation works again.
- **`setErrorBeforeSend` contract cleaned up.** The
  `ErrorTracker.beforeSend` field is now a getter
  (`() => fn | null`). Removed the `Object.defineProperty` hack on
  `tracker.opts` that worked around the old captured-by-value bug —
  cleaner contract, lockstep with web.
- **Event queue drops 4xx batches.** Pre-fix every `catch` triggered
  `scheduleRetry` with the same `Idempotency-Key`. A 401 (key revoked),
  400/422 (malformed batch), 403 (permission), 404 (wrong baseUrl)
  spun the retry timer indefinitely while the backlog grew silently.
  New `isPermanent4xx()` helper hard-stops on any 4xx EXCEPT 408 / 429
  (transient by spec). On permanent failure: drop the batch, increment
  `dropped`, fire `onPermanentFailure(info)`, emit
  `queue.permanent_failure` on the EventEmitter, log via
  `console.error` regardless of debug mode.
- **Error-capture self-skip derived from `baseUrl`.** Pre-fix hardcoded
  to `api.cross-deck.com`; customers on staging / regional / self-hosted
  base URLs recursed (5xx → captureHttp → enqueue → /events →
  captureHttp → ∞). Now strict-hostname compare against `selfHostname`
  extracted from constructor `baseUrl`. Closes the substring-match
  bypass (`api.cross-deck.com.attacker.example` would have matched).

### Added

- **`onPermanentFailure` callback** on `EventQueueConfig`, surfaced
  via `CrossdeckServer.on("queue.permanent_failure", …)` for host-app
  paging.
- **`sdk.flush_permanent_failure` debug signal** in the
  `DebugSignal` vocabulary.

### Changed

- **`SDK_VERSION` is now imported from `package.json`.** The
  `Crossdeck-Sdk-Version` header always matches the published bundle.
  Single source of truth.
- **Event ingest envelope now ships `environment`.** Pre-fix web sent
  it and node didn't; backend `v1-events.ts` cross-checks it against
  the API-key-derived env and rejects mismatches loudly
  (`env_mismatch`). Defence-in-depth so a "live key, env: sandbox"
  misconfig fails fast instead of polluting the wrong dashboard.
- **`syncPurchases` body spread bug.** Pre-fix
  `{ rail: input.rail ?? "apple", ...input }` — the `...input` ran
  LAST and overrode the default when the caller passed
  `rail: undefined` explicitly. Reversed: `{ ...input, rail }`.
- **PII scrub regex uses `.replace()` unconditionally.** Dropped the
  `.test()`-gating that carried `lastIndex` state between calls.
- **`bootHeartbeat: false` no longer silences the
  `sdk.no_durable_store` warning.** Pre-fix the warning lived inside
  `emitBootTelemetry()` which sat inside the `bootHeartbeat` gate, so
  the opt-out silenced the entire reason `entitlementStore` exists.
  Split into two methods: `emitDurabilityWarning()` (local-only,
  unconditional) and `emitBootTelemetryEvent()` (phone-home, still
  gated).
- **`isEntitled(string)` requires the `cdcust_` prefix** for canonical-
  path resolution. Pre-fix any string with a cache entry resolved
  through the canonical path — a small cross-tenant primitive if a
  tenant's userId collided with another tenant's `crossdeckCustomerId`.
  Non-prefixed strings now drop to alias lookup only.
- **Self-skip applies to breadcrumbs too**, not just `captureHttp`.
  Error reports no longer carry noisy `POST https://api.cross-deck.com/v1/events`
  crumb entries.

### Wiring (backend, paired)

- **`v1-events` ingest now honours the per-project `piiAllowList`.**
  The admin management surface (`v1-pii-allow-list.ts`) was persisted +
  audit-logged but the hot ingest path never read it. The new
  `backend/src/api/lib/pii-allow-list-cache.ts` (60s TTL,
  single-flight) feeds the project's allow-list to `scrubProperties()`
  on every batch. `HARD_LOCKED_PATTERNS` are always stripped from the
  effective list regardless of what's in storage. (Backend-only —
  listed here so server-SDK consumers know defence-in-depth is fully
  closed.)

## [1.2.0] — 2026-05-18

### Added

- **Pluggable durable entitlement store (`entitlementStore`).** A new
  constructor option taking an async `EntitlementStore` (a `load` /
  `save` pair) — back it with Redis, your own database, or a KV. Every
  successful `getEntitlements()` persists the result to it, and on a
  network failure the SDK falls back to the stored snapshot. This is
  what gives serverless deployments (Cloud Run / Lambda) cold-start
  durability that an in-memory cache alone cannot. `EntitlementStore`
  and `StoredEntitlements` are exported.
- **Staleness fields in `diagnostics()`.** `entitlements.staleCustomers`,
  `isStale`, `durableStore`, and `coldStartDurable` — so serving
  last-known-good through a Crossdeck outage is observable, not silent.
- **`sdk.no_durable_store` debug signal**, emitted once on a serverless
  runtime with no `entitlementStore` configured, alongside a
  `durability` fact on the boot telemetry event — so the cold-start gap
  is measurable rather than a surprise in production.

### Changed

- **The entitlement cache is now durable last-known-good.**
  `isEntitled()` and `list()` no longer expire to `false` / `[]` when
  `entitlementCacheTtlMs` elapses — they keep serving the last
  successfully-fetched entitlements. The TTL is now a refresh hint, not
  an invalidation. Each entitlement is still honoured against its own
  `validUntil`. A brief Crossdeck outage can no longer fail a paying
  customer down to free 60 seconds after a warm.

## [1.1.1] — 2026-05-14

### Changed

- Ported the "never silently surface an `Unknown` error" hardening to
  `@cross-deck/node` — a captured error with no usable type or message
  is now labelled precisely instead of collapsing to `Unknown error`.

## [1.1.0] — 2026-05-13

### Added

- **Auto-heartbeat on construction.** `new CrossdeckServer({...})` now
  fires a heartbeat in the background the moment the SDK is
  constructed, fire-and-forget. The dashboard's row flips LIVE within
  ~200 ms of the customer's process boot — no explicit `.heartbeat()`
  call required in the bootstrap. Solves the cold-start serverless
  verification problem at its root (function boot triggers SDK
  construction triggers heartbeat; the install-verifier's URL probe
  doubles as a cold-start waker).
- New option `bootHeartbeat?: boolean` (default `true`). Set `false`
  for latency-sensitive cold paths that want the prior v1.0.0
  caller-controlled behaviour. Implicitly disabled in `testMode`.

### Why this is non-breaking

The boot heartbeat is fire-and-forget and swallows its own errors —
the caller's code never blocks on it, never throws, and a failure
(bad key, network blip, firewall) has zero effect on subsequent
event flushes. Equivalent to Sentry's `Sentry.init()` boot session.

## [1.0.0] — 2026-05-13

Full three-USP server SDK release. Version-aligned with `@cross-deck/web@1.0.0`. Bank-grade quality bar — Stripe + Apple + Google VP-level QA review across two passes. 6,796 LOC of source / 6,230 LOC of tests / 398 unit tests + 19 e2e todos passing / Gate 3 fixture verifying the snippet against the built bundle. Web-SDK parity at the capability level: every Web SDK guarantee that has a server-side analogue ships here.

### Added — USP 1 (errors)

- `server.captureError(err, options?)` — manual try/catch capture.
- `server.captureMessage(msg, level?)` — non-error signals (Sentry pattern).
- `server.setTag(key, value)` / `setTags(tags)` / `setContext(name, data)` / `addBreadcrumb(crumb)` / `setErrorBeforeSend(hook)`.
- Auto-wired `process.on('uncaughtException')` + `process.on('unhandledRejection')` + `globalThis.fetch` wrap (5xx + network failures).
- Stack-frame parsing (V8 + Firefox/Safari) with Node `in_app` heuristics for `node_modules/`, `node:`, `internal/`, `@cross-deck/node`.
- Breadcrumb ring buffer (default 50 entries) attached to every error report.
- djb2-fingerprinted grouping + per-fingerprint rate limit (default 5/min) + per-session cap (default 100). Fingerprint Map bounded at 4,096 with dead-entry prune + FIFO eviction.

### Added — USP 2 (analytics)

- Durable event queue: exponential backoff with full jitter, `Retry-After` honoured, **`Idempotency-Key` reused on retry of the same batch** (Stripe pattern).
- `flush-on-exit` — `process.on('beforeExit')` + SIGTERM + SIGINT drain bounded by `flushOnExitTimeoutMs`. Critical for Lambda / Cloud Functions where the runtime freezes between invocations.
- `server.register(properties)` / `server.unregister(key)` / `server.group(type, id, traits?)` — Mixpanel-style super-properties + group analytics.
- `@cross-deck/node/auto-events` subpath:
  - `crossdeckExpress(server, opts?)` + `crossdeckExpressErrorHandler(server, opts?)` (Express 4 + 5) — emits `request.handled` with route + method + statusCode + durationMs + userAgent + responseBytes. Captures uncaught route errors with request context.
  - `wrapLambdaHandler(server, handler, opts?)` — emits `function.invoked` / `function.completed` / `function.failed` with cold-start detection, awaits `flush()` before return. Extracts `statusCode` + `responseBytes` for HTTP-style returns.
  - `wrapFunction(server, handler, opts?)` — generic Firebase v1/v2 / Cloud Run wrap, shape-preserving.

### Added — USP 3 (entitlements)

- Per-customer TTL cache (default 60s) with **LRU eviction bounded at `maxCustomers` (default 10,000)** for long-running multi-tenant servers.
- `server.isEntitled(hint, key)` — synchronous lookup after first warm. Accepts canonical `customerId` OR `IdentityHints` ({customerId, userId, anonymousId}).
- `server.listEntitlements(hint)` — full snapshot.
- `server.onEntitlementsChange(listener)` — subscribe to cache mutations.
- `userId` / `anonymousId` → `crossdeckCustomerId` alias map (bounded at 10,000 with FIFO eviction).
- `verifyWebhookSignature(payload, header, secret, options?)` — HMAC-SHA256 + constant-time compare + 5-min replay window + multi-secret rotation.
- `signWebhookPayload(payload, secret, timestampSec)` — pure helper for fixture authors.

### Added — cross-cutting

- `runtime-info` detection for 13 platforms: AWS Lambda, Azure Functions, Google App Engine, Firebase Functions v1/v2, Cloud Run, Vercel, Netlify, Heroku, Render, Railway, Fly.io, generic Kubernetes, plain Node fallback. Auto-attached as `runtime.*` on every event + error.
- `server.heartbeat()` — boot validation: `GET /sdk/heartbeat` returns project + app metadata, throws on auth failure.
- `server.flush(): Promise<void>` — explicit drain.
- `server.diagnostics()` — stable shape with `runtime` + `events` + `errors` + `entitlements` blocks.
- `server.shutdown()` — teardown for tests + custom lifecycles. Clears super-properties, groups, cache, aliases, breadcrumbs, error state.
- `scrubPii(value)` + `scrubPiiFromProperties(obj)` — opt-in PII regex utilities (email + card-number shapes).
- `ConsoleDebugLogger` + `NullDebugLogger` — NorthStar §16 debug signal vocabulary.
- `CrossdeckErrorCode` literal union derived from `CROSSDECK_ERROR_CODES` + `isCrossdeckErrorCode()` type guard for type-safe code comparisons.
- `HeartbeatResponse` + `Diagnostics` + 30+ exported types.
- `/auto-events` subpath in `package.json` exports.

### Changed

- **Breaking**: `track(event)` is now synchronous (returns `void`), enqueues for batched delivery, and auto-fills `anonymousId` with a process-stable `anon_node_…` when no identity hint is supplied. The old `await track(...)` shape is replaced by enqueue-and-flush.
- `ingest(events[])` retains immediate-POST behaviour for bulk-import callers (no auto-fill, returns `IngestResponse`).
- Secret key prefix in `diagnostics()` is now masked as `cd_sk_(test|live)_****<last4>` (Stripe pattern).

### Added — QA review v2 (bank-grade SDK extras)

- **Error subclass hierarchy** (Stripe pattern):
  `CrossdeckAuthenticationError`, `CrossdeckPermissionError`,
  `CrossdeckValidationError`, `CrossdeckRateLimitError`,
  `CrossdeckNetworkError`, `CrossdeckInternalError`,
  `CrossdeckConfigurationError`. All extend `CrossdeckError`. Pick the
  right subclass via `makeCrossdeckError(payload)`. Constructed
  automatically by `crossdeckErrorFromResponse()`.
- `CrossdeckError.toJSON()` — structured-logger compatible
  serialisation. Includes `type`, `code`, `requestId`, `status`,
  `retryAfterMs`, `stack`. Critical for production observability with
  Pino / Winston / DataDog.
- `Crossdeck-Api-Version` header on every request, pinned to
  `CROSSDECK_API_VERSION` constant. Forward-compat with backend
  evolution (Stripe `Stripe-Version` pattern).
- `User-Agent` header: `@cross-deck/node/<sdk> node/<node-version> <platform>`.
  HTTP best practice. Override the runtime token via
  `runtimeToken: "bun/1.0"` in options.
- **Idempotent retry on GET methods** — default 3 attempts with
  exponential backoff + full jitter, retrying on 408 + 5xx (except
  501) and on network failures. Honours server `Retry-After`. POST
  retries stay queue-driven (with batch-level `Idempotency-Key` reuse).
  Configurable via `httpRetries: { maxAttempts, retryableStatuses }`.
- `testMode: true` option — every HTTP call short-circuits to a
  synthetic success response, no network goes out. Path-aware (returns
  the right shape per endpoint). For caller test suites that don't
  want to mock `globalThis.fetch`.
- `onRequest` / `onResponse` hooks on `CrossdeckServerOptions`. Fire
  on every request (including retries), carrying method, URL, status,
  durationMs, attempt number. Synchronous, errors swallowed — telemetry
  must never break the request pipeline.
- **AbortSignal pass-through** on every async method. Final
  `RequestOptions` argument with `{ signal, timeoutMs }`. Caller-aborted
  requests throw `CrossdeckNetworkError({ code: "request_aborted" })`.
  Composes with the per-request timeout — whichever fires first wins.
- **CrossdeckServer extends EventEmitter** — typed `on` / `once` /
  `off` / `emit` overloads via `CrossdeckServerEvents`. Events:
  `queue.flush_succeeded`, `queue.flush_failed`, `queue.dropped`,
  `queue.buffer_changed`, `error.captured`, `entitlements.warmed`,
  `sdk.shutdown`.
- **`Symbol.dispose` + `Symbol.asyncDispose`** — TC39 explicit
  resource management. `using server = new CrossdeckServer(...)`
  shuts down on scope exit; `await using` flushes first.
- `server.isReady(): boolean` — synchronous readiness check.
  `false` on sustained retry storm (≥ 5 consecutive failures) or
  buffer pressure (≥ 80% of HARD_BUFFER_CAP).
- `server.awaitReady(timeoutMs?, pollIntervalMs?): Promise<boolean>` —
  backpressure-aware wait for ready state.
- `server.getHealth()` — k8s-friendly snapshot: `ready`, `healthy`,
  `bufferedEvents`, `inFlight`, `consecutiveFailures`, `lastFlushAt`,
  `lastError`, `errorHandlersInstalled`.
- `server.bulkGrantEntitlement(grants[])` + `bulkRevokeEntitlement(revokes[])` —
  bounded-concurrency fan-out (default 5). Returns settled array;
  partial failures preserved as `{ ok: false, error }` entries.

### Notes

- Bundle size: `dist/index.cjs` ~98 KB, `dist/auto-events/index.cjs` ~11 KB.
- Zero runtime dependencies (`fetch` + `node:crypto` + `node:events` only).
- 398 unit tests + 19 e2e todos passing. Source-to-test ratio ~100%.
- Deferred to later releases: Fastify adapter (v0.3.0), Cloudflare Workers / Vercel Edge / Bun / Deno (v0.4+), OpenTelemetry / Pino / Winston log-capture integration (roadmap), HTTP keep-alive agent, request compression, SDK-level sampling.

## [0.1.0] — 2026-05-12

Initial server SDK release.

### Added

- Separate `@cross-deck/node` package with no browser assumptions.
- `CrossdeckServer` constructor with secret-key validation.
- Secret-key HTTP transport with typed `CrossdeckError` handling.
- Web-parity sanitisation for traits and event properties, plus a transport
  backstop that converts serialization failures into stable `CrossdeckError`s.
- `identify()` / `aliasIdentity()` for server-side identity linking.
- `forget()` for server-side GDPR/CCPA deletion requests.
- `getEntitlements()` by `customerId`, `userId`, or `anonymousId`.
- `getCustomerEntitlements(customerId)` server-only direct lookup route.
- `track()` and `ingest()` for explicit server-side event ingest.
- `syncPurchases()` for Apple signed purchase forwarding.
- `grantEntitlement()` and `revokeEntitlement()` server-side manual overrides.
- `getAuditEntry()` for server-side audit-log reads.
- Dual ESM/CJS build.
- Strict TypeScript + Vitest coverage for transport and public method routing.
