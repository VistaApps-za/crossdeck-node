/**
 * Public wire types for @cross-deck/node.
 *
 * These mirror the v1 backend API (see backend/src/api/v1-types.ts) so the
 * Node SDK speaks the same JSON shape the Web SDK + dashboard + workers do.
 * Per-module types (Breadcrumb, CapturedError, StackFrame, RuntimeInfo,
 * DebugSignal) live in the module that defines them — types.ts only carries
 * the shared / wire-level surface.
 *
 * Keep in lockstep with `sdks/web/src/types.ts`. Same field names, same
 * nullability. Where Node intentionally diverges from the web wire shape
 * (no anonymousId-by-default, env implied by secret key prefix), the
 * comment explains why.
 */

import type { ErrorCaptureConfig } from "./error-capture";
import type { RuntimeHost } from "./runtime-info";
import type { HttpRequestInfo, HttpResponseInfo, HttpRetriesConfig } from "./http";

export type Environment = "production" | "sandbox";
export type AuditRail = "apple" | "stripe" | "google" | "manual";

export interface PublicEntitlement {
  object: "entitlement";
  key: string;
  isActive: boolean;
  validUntil?: number | null;
  source: {
    rail: AuditRail;
    productId: string;
    subscriptionId: string;
  };
  updatedAt: number;
}

export interface EntitlementsListResponse {
  object: "list";
  data: PublicEntitlement[];
  crossdeckCustomerId: string;
  env: Environment;
}

/**
 * Identity for {@link CrossdeckServer.resolve} / {@link CrossdeckServer.isBlocked}.
 * Send the END USER's identity, not your server's.
 *
 * @experimental Preview — Crossdeck Trust ships with Crossdeck v2. Shape is stable; the
 * surface is not yet GA.
 */
export interface ResolveInput {
  /** Your signed-in user id. */
  userId?: string;
  /** A SIGNED proof of that user (e.g. their Firebase ID token). Required alongside `userId` for the verified path. */
  idToken?: string;
  /** Anonymous device id (the Web SDK's `getAnonymousId()`). Folds a pre-login device. */
  anonymousId?: string;
  /**
   * The END USER's IP. Forward it — you call resolve server-to-server, so without it
   * Crossdeck sees YOUR server's IP and an ip-rule can't match the visitor.
   */
  ip?: string;
}

/**
 * The block verdict. Fail-open: on any error these come back `{ blocked: false }`,
 * never an exception — a glitch can never lock out a real user (the mirror of
 * entitlements, which fail closed).
 *
 * @experimental Preview — see {@link ResolveInput}.
 */
export interface BlockVerdict {
  /** True ONLY when Crossdeck holds an explicit block on this identity. */
  blocked: boolean;
  /** Why, when blocked: e.g. `"blocklist:domain"` | `"blocklist:ip"` | `"blocked"`. */
  blockReason: string | null;
  /** The exact rule that fired: `"domain:spartan.net"` | `"ip:1.2.3.4"` | `"manual"` | null. */
  blockedKey: string | null;
  /**
   * Human-quotable support handle for this verdict (the "Ray ID"), formatted `xxxx-xxxx`.
   * Show it on your suspended screen ("reference: blocklist:domain · a1f9-7c2e"); Crossdeck
   * stores the same string on the block event, so support resolves it in the Caught feed.
   */
  reference?: string | null;
  /**
   * The recorded support contact (the project owner's signup email), present only when
   * blocked — render it as the suspended screen's "Contact support" so appeals reach the
   * real operator by default. Override with a dedicated address if you have one.
   */
  supportEmail?: string | null;
  /**
   * The id of the CD-hosted block interstitial minted for THIS verdict — present only when
   * blocked. The recommended dead-end is one line:
   * `redirect(\`https://api.cross-deck.com/v1/trust/page/${blockEventId}\`)` — Crossdeck
   * serves the canonical branded page (receipt + reference + faithful support contact), so
   * you never hand-build or fork the block screen. Opaque (`cd_blk_…`), no PII in the URL.
   */
  blockEventId?: string | null;
  /**
   * True when this is the fail-open default (Crossdeck unreachable / identity unresolved).
   * `blocked` is `false`; log it for observability, never treat it as a real "not blocked".
   */
  degraded?: boolean;
}

/**
 * The full {@link CrossdeckServer.resolve} result — the block verdict plus the identity /
 * entitlement context, so one call answers "should they be here?" and "what can they
 * access?" together.
 *
 * @experimental Preview — see {@link ResolveInput}.
 */
export interface ResolveResult extends BlockVerdict {
  /** `"active"` | `"anonymous"` | … the resolved identity status. */
  status: string;
  /** Active entitlement keys for this identity (e.g. `["pro"]`). */
  entitlements: string[];
  /** The canonical Crossdeck customer id, when resolved. */
  crossdeckCustomerId: string | null;
  /** The anonymous id Crossdeck resolved / assigned. */
  anonymousId: string | null;
  /**
   * Set when a verified identity was sent but couldn't be checked (e.g. the auth issuer
   * isn't registered). If you sent `userId`+`idToken` and `status` is `"anonymous"`, read this.
   */
  identityError: { reason: string } | null;
}

/**
 * Owner identifiers for {@link CrossdeckServer.getOwnerStatus} — the public-page path.
 * Pass any subset; for a page-offline check the `ip` is the owner's CREATION ip.
 *
 * @experimental Preview — see {@link ResolveInput}.
 */
export interface OwnerStatusInput {
  userId?: string;
  email?: string;
  domain?: string;
  ip?: string;
}

/**
 * Input for {@link CrossdeckServer.gate} — the brand-new-signup door. Pass the two strings
 * you have at signup: `email` and `ip`. (Optional `domain`/`fingerprint` sharpen the score.)
 *
 * @experimental Preview — see {@link ResolveInput}.
 */
export interface GateInput {
  /** The signing-up user's email. Matched against email + domain blocklist rules. */
  email?: string;
  /** The signing-up request's IP. Matched against ip rules + datacenter/velocity signals. */
  ip?: string;
  /** Optional explicit domain (defaults to the email's domain). */
  domain?: string;
  /** Optional device fingerprint — sharpens the composite signup score. */
  fingerprint?: string;
  /**
   * The human-proof attestation minted by the Crossdeck Trust panel in the browser
   * (`Crossdeck.trust.panel(...)` / `<CrossdeckTrust>` in @cross-deck/web). Forward
   * whatever the client delivered. A real browser carries one; a server-to-server
   * bot has none — that absence is scored, and in strict mode (`requireHumanProof`)
   * a tokenless + suspicious attempt is the confident block. Optional and fail-open:
   * omitting it never blocks on its own.
   */
  token?: string;
}

/**
 * The signup-gate verdict from {@link CrossdeckServer.gate}. Fail-open: on any error these
 * come back `{ action: "allow", allow: true, degraded: true }` — a glitch never rejects a
 * real signup.
 *
 * @experimental Preview — see {@link ResolveInput}.
 */
export interface GateVerdict {
  /** `"allow"` | `"review"` | `"block"`. Reject the account only on `"block"`. */
  action: "allow" | "review" | "block";
  /** Convenience: `false` only when `action` is `"block"`. */
  allow: boolean;
  /** Why, when blocked: e.g. `"disposable_domain"` | `"blocklist:ip"` | `"blocklist:domain"`. */
  blockReason: string | null;
  /** The exact rule/key that fired, when blocked. */
  blockedKey: string | null;
  /** Human-quotable support handle (the "Ray ID"), formatted `xxxx-xxxx` — show it on the blocked screen. */
  reference?: string | null;
  /** Recorded support contact (project owner's signup email), present only on `block` — the blocked screen's "Contact support" default. */
  supportEmail?: string | null;
  /** CD-hosted block-page id (`cd_blk_…`), present only on `block` — redirect the rejected signup to `https://api.cross-deck.com/v1/trust/page/${blockEventId}` and Crossdeck serves the canonical branded dead-end. */
  blockEventId?: string | null;
  /** True when this is the fail-open default (Crossdeck unreachable). `allow` is `true`. */
  degraded?: boolean;
}

/**
 * Snapshot of one customer's last-known-good entitlements, as written
 * to / read from a durable `EntitlementStore`. Versioned for forward-
 * compat — a future SDK can refuse a blob whose `v` it doesn't know.
 *
 * Carries enough to fully reconstruct an `EntitlementsListResponse` on
 * a cold start (the durable read path in `getEntitlements()` rebuilds
 * the response from this), plus `savedAt` so staleness is measurable
 * after a process restart.
 */
export interface StoredEntitlements {
  v: 1;
  /** Canonical Crossdeck customer ID this snapshot belongs to. */
  crossdeckCustomerId: string;
  /** The entitlement set exactly as the server last returned it. */
  entitlements: PublicEntitlement[];
  env: Environment;
  /** Epoch ms of the successful server fetch that produced this snapshot. */
  savedAt: number;
}

/**
 * Pluggable async durable store for last-known-good entitlements.
 *
 * The Node SDK's entitlement cache is an in-memory per-customer `Map`.
 * On serverless (Cloud Run / AWS Lambda) a cold start is an empty Map,
 * and a brief Crossdeck outage during that window would otherwise read
 * a paying customer as un-entitled. An `EntitlementStore` is the
 * developer-supplied durability layer — Redis, their primary DB, a KV —
 * that survives both a cold start and an outage.
 *
 * Contract:
 *   - `load` returns the most recent snapshot for a customer, or `null`
 *     if none exists. It MUST NOT throw for a missing key — return
 *     `null`. (The SDK additionally guards every call in a try/catch,
 *     but a well-behaved store returns `null`.)
 *   - `save` persists a snapshot. Called only after a SUCCESSFUL server
 *     fetch, so the store never holds anything but server-confirmed
 *     truth.
 *   - Both are awaited inside `getEntitlements()` (already async). They
 *     are NEVER called from the synchronous `isEntitled()` — that stays
 *     a pure in-memory `Map` read with zero I/O.
 *   - The SDK swallows store errors: a failed `save` never fails a
 *     successful fetch, a failed `load` degrades to "no durable copy".
 *     A broken store weakens durability; it never breaks the SDK.
 *
 * The `key` passed to `load` / `save` is whatever identity string the
 * caller used — a canonical `crossdeckCustomerId`, or a developer
 * `userId` / `anonymousId` hint. The SDK saves a snapshot under every
 * identity it knows for a customer so a cold-start `load` succeeds even
 * before the in-memory alias map is populated.
 */
export interface EntitlementStore {
  /** Resolve a customer's last-known-good snapshot, or `null` if none. */
  load(key: string): Promise<StoredEntitlements | null>;
  /** Persist a customer's last-known-good snapshot. */
  save(key: string, value: StoredEntitlements): Promise<void>;
}

export interface AliasResult {
  object: "alias_result";
  crossdeckCustomerId: string;
  linked: Array<
    | { type: "developer"; id: string }
    | { type: "anonymous"; id: string }
  >;
  mergePending: boolean;
  env: Environment;
}

/** Input to `campaignLink` — stamp an outbound email link with an identity-bind ticket. */
export interface CampaignLinkInput {
  /** The recipient's email address. The person is resolved from it once, at stamp time.
   *  Rides the request body only — never a URL/query (it is PII). */
  email: string;
  /** The absolute http(s) destination the recipient should land on. */
  url: string;
  /** Optional provenance for later enrichment (e.g. "resend", "hubspot"). Never required. */
  rail?: string;
}

/** Result of `campaignLink` — the same destination with the arrival ticket appended. */
export interface CampaignLinkResult {
  object: "campaign_link";
  /** The stamped URL to put in the email. Carries only an opaque `cd_ref` ticket. */
  url: string;
  /** How long the ticket stays live (a campaign's useful life). */
  expiresInDays: number;
  env: Environment;
}

export interface IngestResponse {
  object: "list";
  received: number;
  env: Environment;
  throttled?: {
    dropped: number;
    sampleRate: number;
    retryAfterMs: number;
  };
}

export interface PurchaseResult {
  object: "purchase_result";
  crossdeckCustomerId: string;
  env: Environment;
  entitlements: PublicEntitlement[];
  /** True when the response came from the backend's idempotency
   * cache instead of fresh processing. Backend also returns
   * `Idempotent-Replayed: true` as a response header (v1.4.0). */
  idempotent_replay?: boolean;
}

/**
 * Response shape from `GET /v1/sdk/heartbeat`. Used by
 * `server.heartbeat()` to validate the secret key at boot and surface
 * the backend's view of which project + app the key maps to. Clock
 * skew between client + server can be detected from `serverTime`.
 */
export interface HeartbeatResponse {
  object: "heartbeat";
  ok: true;
  projectId: string;
  appId: string;
  platform: "node" | "web" | "ios" | "android";
  env: Environment;
  /** Server's view of `Date.now()` at the moment the response was sent. */
  serverTime: number;
}

export interface ForgetResult {
  object: "forgot";
  crossdeckCustomerId: string | null;
  queuedAt: number;
  env: Environment;
}

/**
 * Options for `new CrossdeckServer(...)`. The trio of `secretKey` (required)
 * + a sensible set of opt-in knobs covers the v1.0.0 surface.
 *
 * Defaults are tuned for serverless deployment (the dominant Node deployment
 * shape today): flush-on-exit ON, error capture ON, entitlement TTL 60s,
 * idempotent retried event queue, generous timeouts.
 */
export interface CrossdeckServerOptions {
  /** Secret API key. MUST start with `cd_sk_test_` or `cd_sk_live_`. Required. */
  secretKey: string;
  /** Override the API base URL. Default `https://api.cross-deck.com/v1`. */
  baseUrl?: string;
  /**
   * Per-request abort timeout (ms). Default 15_000.
   *
   * On expiry: `CrossdeckError({ type: "network_error", code: "request_timeout" })`.
   * Pass `0` to disable; per-call overrides allowed via the HTTP layer. A
   * captive portal or hung connection would otherwise inherit the runtime's
   * default and lock up the queue.
   */
  timeoutMs?: number;
  /** Override the SDK version reported on the wire. Default: package version. */
  sdkVersion?: string;
  /**
   * Optional informational appId stamped onto event batches. The server
   * trusts the API key's resolved app routing — this is best-effort metadata,
   * not the source of truth.
   */
  appId?: string;

  /**
   * Apply Crossdeck's PII scrubber to every `track()` payload before
   * enqueue. Default `true` (parity with Web / RN / Swift SDKs — Node
   * pre-v1.4.0 was the odd one out and SHIPPED EMAILS UNREDACTED, a
   * privacy contract drift versus the README claim).
   *
   * The scrubber rewrites email-shaped and card-number-shaped
   * substrings to `<email>` / `<card>` sentinels recursively across
   * nested maps + arrays. See `scrubPii` / `scrubPiiFromProperties`.
   *
   * **Blast radius of setting `false`:** every `track()` payload —
   * including event names with embedded emails ("user wes@example.com
   * upgraded"), trait values, group memberships, error context blobs
   * — ships verbatim to Crossdeck and downstream warehouses /
   * analytics exports. Disable only for explicit compliance use
   * cases (regulator-required audit trails where the raw value MUST
   * be preserved) and document the decision at the call site.
   */
  scrubPii?: boolean;

  // ============================================================
  // USP 1 — Error capture (v1.0.0+)
  // ============================================================

  /**
   * Error capture configuration. Default: ON with `onUncaughtException` +
   * `onUnhandledRejection` + `wrapFetch` all enabled.
   *
   * Pass `false` to disable error capture entirely (the SDK still ships
   * the manual `captureError(err)` API, it just doesn't auto-wire process
   * handlers). Pass a partial object to override individual defaults.
   *
   * Setting `false` is the right call if you have a separate error tracker
   * (Sentry, Datadog) and don't want duplicates. Setting `true` (the
   * default) is the right call for everyone else — that's why you installed
   * a backend SDK.
   */
  errorCapture?: boolean | Partial<ErrorCaptureConfig>;

  // ============================================================
  // USP 2 — Analytics infrastructure (v1.0.0+)
  // ============================================================

  /** Maximum events buffered before forced flush. Default 20. Parity with web SDK. */
  eventFlushBatchSize?: number;
  /** Idle ms after the last track() before flushing. Default 1500. Parity with web SDK. */
  eventFlushIntervalMs?: number;
  /**
   * Install `process.on('beforeExit')` + `SIGTERM` + `SIGINT` handlers that
   * synchronously drain the event queue before exit. Default `true`.
   *
   * **Critical for Cloud Functions / Lambda.** Without this, a function
   * cold-starts, fires 3 events, and exits before the HTTP POSTs complete —
   * the events vanish silently. With it, the queue drains bounded by
   * `flushOnExitTimeoutMs` before the process is allowed to terminate.
   *
   * Set `false` only if your runtime already manages SDK shutdown
   * explicitly (some test harnesses, custom signal handlers).
   */
  flushOnExit?: boolean;
  /**
   * Bounded timeout for the on-exit drain (ms). Default 2000.
   *
   * Two seconds is enough to flush a handful of events over a healthy
   * network without holding up the function teardown so long that the
   * platform's own SIGKILL (typically 5-10s after SIGTERM) preempts us.
   */
  flushOnExitTimeoutMs?: number;

  /**
   * Fire a heartbeat in the background the moment the SDK is
   * constructed. Default `true`.
   *
   * This is what makes the dashboard's "Verify install" surface
   * actually work in cold-start serverless: the moment the customer's
   * process boots and runs `new CrossdeckServer({...})`, we phone
   * home, the dashboard row flips LIVE, and the caller doesn't have
   * to add an explicit `await server.heartbeat()` to their bootstrap.
   *
   * Fire-and-forget. Failures are swallowed (the SDK still works for
   * events even if this boot ping can't reach the backend). The
   * caller's process never blocks on this.
   *
   * Set `false` if you want the prior v1.0.0 behaviour where the
   * caller controlled when (or whether) the first network ping fired
   * — e.g., very latency-sensitive cold paths, or environments where
   * the very first request must not race with an SDK-initiated call.
   * `testMode: true` also disables this implicitly.
   */
  bootHeartbeat?: boolean;

  // ============================================================
  // USP 3 — Entitlement caching (v1.0.0+)
  // ============================================================

  /**
   * TTL for the entitlement cache (ms). Default 60_000 (60s).
   *
   * Once `getEntitlements()` has warmed the cache, subsequent
   * `isEntitled(key)` calls are memory reads for the next `ttlMs` — no
   * HTTP round-trip. Without this, a hot-path entitlement gate adds
   * 50-200ms per request. Stripe + Mixpanel ship the same TTL pattern
   * server-side for the same reason.
   *
   * Pass `0` to disable caching (every `isEntitled` requires a fresh
   * `getEntitlements()` call to populate the cache — useful for tests).
   *
   * NOTE: the TTL is a REFRESH HINT, not an invalidation. Once a
   * customer is warm, `isEntitled()` keeps serving last-known-good past
   * the TTL — a brief Crossdeck outage can never flip a paying customer
   * to `false`. The TTL only tells `needsRefresh()` when a re-fetch is
   * due, and (with no failed refresh) when the cache is flagged stale.
   * Each entitlement's own `validUntil` is still honoured at read time.
   */
  entitlementCacheTtlMs?: number;

  /**
   * Age (ms) past which last-known-good entitlement data is flagged
   * STALE in `diagnostics()` even with no failed refresh. Default 24h.
   *
   * Staleness never changes what `isEntitled()` returns — the cache
   * keeps serving last-known-good. This window only makes "we have been
   * serving an un-refreshed answer for a long time" observable, so an
   * event-based revoke (chargeback / refund — which has no `validUntil`)
   * riding out a long outage is visible instead of silent.
   */
  entitlementStaleAfterMs?: number;

  /**
   * Durable last-known-good store for entitlements. Optional.
   *
   * The entitlement cache is in-memory. On serverless (Cloud Run /
   * Lambda) every cold start begins with an empty cache — and if
   * Crossdeck is briefly unreachable during that window, a paying
   * customer would read as un-entitled. Wiring an `EntitlementStore`
   * (Redis / your DB / a KV) closes that gap: every successful
   * `getEntitlements()` persists the result, and a network failure
   * falls back to the stored snapshot instead of throwing.
   *
   * Without a store on a serverless host the SDK has NO cold-start
   * durability — that is unavoidable and the SDK says so explicitly
   * (a `debug.emit` warning plus a `durability` fact on the boot
   * telemetry event). It is not hidden.
   *
   * `isEntitled()` stays synchronous regardless — the store is only
   * ever touched from the already-async `getEntitlements()`.
   */
  entitlementStore?: EntitlementStore;

  // ============================================================
  // Cross-cutting — runtime enrichment + debug (v1.0.0+)
  // ============================================================

  /**
   * Service name for runtime enrichment. Attached to every event + error
   * as `properties.serviceName`. Default: env-detected via
   * `K_SERVICE` (Cloud Run / Cloud Functions v2) /
   * `AWS_LAMBDA_FUNCTION_NAME` (Lambda) /
   * `FUNCTION_NAME` (Cloud Functions v1). Falls back to `process.pid` if
   * no env signal is present.
   */
  serviceName?: string;
  /**
   * Service version. Default: env-detected via `K_REVISION` /
   * `AWS_LAMBDA_FUNCTION_VERSION`. Surfaces in dashboards as the build
   * cohort the event/error originated from.
   */
  serviceVersion?: string;
  /**
   * App version attached as `appVersion` on every event/error. Parity
   * with `@cross-deck/web`'s `appVersion` option — same role.
   */
  appVersion?: string;
  /**
   * Enable verbose diagnostic logging via NorthStar §16 debug signal
   * vocabulary. Default `false`. Equivalent to `server.setDebugMode(true)`
   * after construction.
   */
  debug?: boolean;
  /**
   * Breadcrumb buffer size. Default 50 (parity with web SDK). The last
   * N tracked events + manual breadcrumbs are attached to every error
   * report — "what was the request doing right before it failed."
   */
  breadcrumbsMaxSize?: number;

  // ============================================================
  // Bank-grade SDK extras (QA-review v2)
  // ============================================================

  /**
   * **Test mode.** When `true`, every HTTP call short-circuits to a
   * synthetic success response — no network goes out. The synthetic
   * shape matches each endpoint's contract (e.g. `getEntitlements`
   * returns `{ object: "list", data: [], … }`). For caller test
   * suites that don't want to mock `globalThis.fetch` directly.
   *
   * `onRequest` / `onResponse` hooks still fire in test mode so
   * audit pipelines can observe synthetic traffic.
   *
   * Default `false`. Never enable in production.
   */
  testMode?: boolean;
  /**
   * Inspection hook fired BEFORE every HTTP request (including
   * retries). Use for debugging, audit logging, custom metrics.
   * Synchronous — errors thrown by the hook are swallowed, the
   * request continues.
   */
  onRequest?: (info: HttpRequestInfo) => void;
  /**
   * Inspection hook fired AFTER every HTTP response. Same contract
   * as `onRequest`. Carries `durationMs`, `attempt` number, and
   * `testMode` flag (true if the response was synthetic).
   */
  onResponse?: (info: HttpResponseInfo) => void;
  /**
   * Retry config for idempotent GET requests. Default: 3 attempts
   * with exponential backoff + full jitter, retrying on 408 + 5xx
   * (except 501) and on network failures. POST retries are handled
   * by the EventQueue separately (with batch-level Idempotency-Key
   * reuse). Set `maxAttempts: 1` to disable GET retries.
   */
  httpRetries?: HttpRetriesConfig;
  /**
   * Override the runtime token in the `User-Agent` header
   * (`@cross-deck/node/<sdk-version> <runtimeToken>`). Default
   * detects `node/<process.versions.node> <process.platform>`.
   * Override for custom builds (Bun, Deno-shim, electron) that want
   * to report a more specific runtime label.
   */
  runtimeToken?: string;
}

/**
 * Per-call options accepted by every async public method on
 * `CrossdeckServer`. Carries cancellation + per-call timeout
 * overrides. Inherits Stripe's pattern of "request options" as a
 * trailing arg.
 *
 *   const ctrl = new AbortController();
 *   const flight = server.heartbeat({ signal: ctrl.signal });
 *   setTimeout(() => ctrl.abort(), 100);
 *   await flight; // throws CrossdeckNetworkError({ code: "request_aborted" })
 */
export interface RequestOptions {
  /**
   * Caller-supplied AbortSignal. When aborted, the in-flight `fetch`
   * is cancelled and the call throws
   * `CrossdeckNetworkError({ code: "request_aborted" })`. Composes
   * with the per-request timeout — whichever fires first wins.
   */
  signal?: AbortSignal;
  /**
   * Per-call timeout override (ms). Defaults to the client's
   * `timeoutMs`. Pass `0` to disable.
   */
  timeoutMs?: number;
  /**
   * Override the deterministic Idempotency-Key derivation (v1.4.0).
   * The SDK derives a stable key from the request body so retries
   * collapse on the backend. Override only when an outer
   * orchestrator (job runner, retry harness) needs a different
   * idempotency window — and document why at the call site.
   */
  idempotencyKey?: string;
}

export interface IdentityHints {
  customerId?: string;
  userId?: string;
  anonymousId?: string;
}

export interface IdentifyOptions {
  email?: string;
  traits?: Record<string, unknown>;
}

export interface AliasIdentityInput extends IdentifyOptions {
  userId: string;
  anonymousId: string;
}

export type ErrorLevel = "error" | "warning" | "info";

/** Properties payload for `track()`. Arbitrary JSON-serialisable bag, ≤ 8 KB. */
export type EventProperties = Record<string, unknown>;

export interface ServerEvent {
  eventId?: string;
  name: string;
  timestamp?: number;
  properties?: EventProperties;
  developerUserId?: string;
  anonymousId?: string;
  crossdeckCustomerId?: string;
  level?: ErrorLevel;
  tags?: Record<string, string>;
  categoryTags?: string[];
}

export interface IngestOptions extends RequestOptions {
  idempotencyKey?: string;
}

export interface SyncPurchaseInput {
  rail?: "apple";
  signedTransactionInfo: string;
  signedRenewalInfo?: string;
  appAccountToken?: string;
}

export type GrantDuration = "P30D" | "P90D" | "P1Y" | "lifetime";

export interface GrantEntitlementInput {
  customerId: string;
  entitlementKey: string;
  duration: GrantDuration;
  reason: string;
}

export interface RevokeEntitlementInput {
  customerId: string;
  entitlementKey: string;
  reason: string;
}

export interface EntitlementMutationResult {
  object: "entitlement_mutation";
  action: "grant" | "revoke";
  crossdeckCustomerId: string;
  entitlement: PublicEntitlement;
  env: Environment;
}

export type AuditDecision = "applied" | "no_op" | "rejected";

export interface AuditEntry {
  eventId: string;
  rail: AuditRail;
  env: Environment;
  eventType: string;
  projectId: string;
  subscriptionId?: string;
  customerId?: string;
  fromState?: string;
  toState?: string;
  decision: AuditDecision;
  reason?: string;
  derivedSignal?: string;
  signatureVerified: boolean;
  reconciledWithProvider: boolean;
  rawEventReceivedAt: number;
  processedAt: number;
}

export interface AuditEntryResponse {
  object: "audit_entry";
  data: AuditEntry;
}

/**
 * Diagnostic snapshot returned by `server.diagnostics()`. Stable shape
 * regardless of init state — callers don't need to narrow.
 *
 * Differs from web SDK's Diagnostics in two ways:
 *   - No `anonymousId` / `crossdeckCustomerId` / `developerUserId` (Node
 *     SDK has no per-device identity — identity is per-request).
 *   - No `clock` block (no heartbeat round-trip — Node SDK doesn't ship
 *     one).
 *   - Adds `runtime` (Node version, OS, host, region, service) and
 *     `errors` (session count, fingerprints tracked).
 */
export interface Diagnostics {
  sdkVersion: string;
  baseUrl: string;
  /** First 12 chars of the secret key (incl. `cd_sk_test_` / `cd_sk_live_` prefix). For correlation in support tickets. */
  secretKeyPrefix: string;
  env: Environment;
  runtime: {
    nodeVersion: string;
    platform: string;
    hostname: string;
    /** Which serverless / hosting platform the SDK detected. "node" if no platform signal. */
    host: RuntimeHost;
    region: string | null;
    serviceName: string | null;
    serviceVersion: string | null;
    instanceId: string | null;
  };
  entitlements: {
    count: number;
    lastUpdated: number;
    ttlMs: number;
    /** Cumulative count of listener invocations that threw. Swallowed inside the cache; surfaced here. */
    listenerErrors: number;
    /**
     * Number of cached customers currently flagged STALE — their most
     * recent refresh attempt failed, or their data has aged past
     * `entitlementStaleAfterMs`. The cache keeps serving last-known-good
     * for them; this count makes "serving through an outage" observable.
     */
    staleCustomers: number;
    /**
     * Whether ANY cached customer is stale. Quick boolean for health
     * checks / alerting without inspecting `staleCustomers`.
     */
    isStale: boolean;
    /**
     * Most recent failed-refresh timestamp across all customers (epoch
     * ms), or 0 if every customer's last refresh succeeded.
     */
    lastRefreshFailedAt: number;
    /**
     * Durable-store posture. `durableStore` is true iff an
     * `EntitlementStore` is configured. `coldStartDurable` is true iff
     * the SDK has cold-start durability — which on a serverless host
     * requires a store, and on a long-lived host is inherently true
     * (the process, hence the in-memory cache, survives).
     */
    durableStore: boolean;
    coldStartDurable: boolean;
  };
  events: {
    buffered: number;
    dropped: number;
    inFlight: number;
    lastFlushAt: number;
    lastError: string | null;
    consecutiveFailures: number;
    nextRetryAt: number | null;
  };
  errors: {
    /** Total error reports captured in this process lifetime. */
    sessionCount: number;
    /** Number of distinct fingerprints currently inside the rate-limit window. */
    fingerprintsTracked: number;
    /** Whether the global handlers (uncaughtException / unhandledRejection) are installed. */
    handlersInstalled: boolean;
  };
}
