/**
 * @cross-deck/node — `CrossdeckServer`, the orchestrator.
 *
 * v1.0.0 expands beyond the v0.1.0 thin HTTP client to ship the three
 * Crossdeck USPs on the server:
 *
 *   1. Errors — `captureError`, `captureMessage`, auto-wired
 *      `process.on('uncaughtException')` + `process.on('unhandledRejection')`,
 *      `globalThis.fetch` wrap, stack-frame parsing, breadcrumb
 *      attachment, fingerprint dedup, rate-limit per fingerprint.
 *      [USP 1 — landed v1.0.0]
 *
 *   2. Analytics — `track()` switches from sync-HTTP-per-event to
 *      enqueue-and-batch via `EventQueue` (durable, retried, idempotent
 *      per batch). `flush-on-exit` drains before Cloud Function / Lambda
 *      teardown so events don't vanish silently.
 *      [USP 1 ships queue + flush-on-exit; super-props + auto-events
 *       arrive in USP 2]
 *
 *   3. Entitlements — TTL-cached `isEntitled()` so hot-path gates are
 *      memory reads after first warm.
 *      [USP 3 — pending]
 *
 * Cross-cutting: every event + error carries `runtime.*` enrichment
 * (Node version, OS, host, region, function name, instance ID) auto-
 * attached via `collectRuntimeInfo()`.
 *
 * The non-event endpoints (identify / aliasIdentity / forget /
 * getEntitlements / getCustomerEntitlements / syncPurchases /
 * grantEntitlement / revokeEntitlement / getAuditEntry) stay as direct
 * HTTP — they're transactional, not telemetry. Only `track()` changed
 * to queue-based.
 */

import { EventEmitter } from "node:events";

import { CrossdeckError } from "./errors";
import { validateEventProperties } from "./event-validation";
import type { ContractFailureInput } from "./contracts";
import { sendDiagnosticTelemetry } from "./_diagnostic-telemetry";
import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  SDK_NAME,
  SDK_VERSION,
} from "./http";
import { EventQueue, type BatchEnvelope, type QueuedEvent } from "./event-queue";
import { BreadcrumbBuffer, type Breadcrumb, type BreadcrumbCategory } from "./breadcrumbs";
import {
  DEFAULT_ERROR_CAPTURE,
  ErrorTracker,
  extractSelfHostname,
  type CapturedError,
  type ErrorCaptureConfig,
} from "./error-capture";
import { buildEventContext, collectRuntimeInfo, runtimeInfoToProperties, type RuntimeInfo } from "./runtime-info";
import { FlushOnExit } from "./flush-on-exit";
import { SuperPropertyStore, type GroupMembership } from "./super-properties";
import { EntitlementCache, type EntitlementsListener } from "./entitlement-cache";
import { webhooks as webhooksNamespace } from "./webhooks";
import { scrubPiiFromProperties } from "./consent";
import { deriveIdempotencyKeyForPurchase } from "./idempotency-key";
import { ConsoleDebugLogger, NullDebugLogger, findSensitivePropertyKeys, type DebugLogger } from "./debug";
import { mintId } from "./_rand";
import type {
  AliasIdentityInput,
  AliasResult,
  AuditEntry,
  AuditEntryResponse,
  BlockVerdict,
  CampaignLinkInput,
  CampaignLinkResult,
  CrossdeckServerOptions,
  Diagnostics,
  EntitlementMutationResult,
  EntitlementsListResponse,
  EntitlementStore,
  Environment,
  ErrorLevel,
  EventProperties,
  ForgetResult,
  GrantEntitlementInput,
  HeartbeatResponse,
  IdentityHints,
  IdentifyOptions,
  GateInput,
  GateVerdict,
  IngestOptions,
  IngestResponse,
  OwnerStatusInput,
  PublicEntitlement,
  PurchaseResult,
  RequestOptions,
  ResolveInput,
  ResolveResult,
  RevokeEntitlementInput,
  ServerEvent,
  StoredEntitlements,
  SyncPurchaseInput,
} from "./types";

/**
 * Typed event names + payloads emitted by `CrossdeckServer`. Caller
 * subscribes via the standard EventEmitter API:
 *
 *   server.on("queue.flush_failed", ({ error, attempt }) => { ... });
 *   server.once("sdk.shutdown", () => { ... });
 *
 * The typed `on` / `off` / `emit` overloads narrow the listener
 * arguments to the right shape. Untyped event names still work for
 * forward compat with any backend-side additions.
 */
export interface CrossdeckServerEvents {
  /** Fired once per batch on successful flush. */
  "queue.flush_succeeded": [info: { batchSize: number; durationMs: number }];
  /** Fired on every failed flush attempt. */
  "queue.flush_failed": [info: { error: CrossdeckError | string; attempt: number; nextRetryMs: number }];
  /** Fired when the queue drops oldest events due to HARD_BUFFER_CAP. */
  "queue.dropped": [info: { count: number }];
  /** Fired when the buffer changes size — used by callers wanting backpressure-aware tracking. */
  "queue.buffer_changed": [info: { size: number }];
  /** Fired when an error is captured (manual or auto). */
  "error.captured": [info: { fingerprint: string; kind: string; message: string }];
  /** Fired once after `getEntitlements()` warms the cache for a customer. */
  "entitlements.warmed": [info: { customerId: string; count: number }];
  /** Fired on `shutdown()` / `[Symbol.dispose]` / `[Symbol.asyncDispose]`. */
  "sdk.shutdown": [info: { reason: "shutdown" | "dispose" | "asyncDispose" }];
}

export class CrossdeckServer extends EventEmitter {
  // `!` (definite assignment): these are assigned on the real construction path,
  // but the singleton guard in the constructor can `return` an existing instance
  // before reaching them — that early return is the only path that skips them.
  private readonly http!: HttpClient;
  /**
   * Stripe-shaped webhook namespace — `crossdeck.webhooks.constructEvent(...)`.
   * Pure functions (no client state), so it's the same object as the standalone
   * `webhooks` export; mounted here for the Stripe-parity call site. Assigned as
   * a field initialiser so it's present even on the singleton-guard early return.
   */
  public readonly webhooks = webhooksNamespace;
  private readonly sdkVersion: string;
  private readonly baseUrl: string;
  private readonly appId: string | undefined;
  private readonly env: Environment;
  /** PII scrubber toggle. Default true — parity with Web/RN/Swift.
   * Pre-v1.4.0 the Node SDK shipped track() payloads UNREDACTED,
   * a privacy contract drift versus the README. */
  private readonly scrubPii!: boolean;
  private readonly secretKeyPrefix!: string;

  /**
   * Process-stable pseudo-anonymous ID. Used as the default identity
   * for `track()` / `captureError()` calls where the caller doesn't
   * supply one (e.g. an `uncaughtException` handler has no per-request
   * context). Stable for the SDK instance's lifetime so events from
   * the same process correlate.
   */
  private readonly processAnonymousId!: string;

  private readonly runtime!: RuntimeInfo;
  private readonly runtimeProperties!: Record<string, unknown>;
  /** Envelope v1 §4 context object — built once at SDK init, reused on every event. */
  private readonly eventContext!: Record<string, string | null>;
  private readonly breadcrumbs!: BreadcrumbBuffer;
  private readonly eventQueue!: EventQueue;
  private readonly errorTracker!: ErrorTracker | null;
  private readonly flushOnExit!: FlushOnExit | null;
  private readonly superProps!: SuperPropertyStore;
  private readonly entitlementCache!: EntitlementCache;
  /**
   * Optional developer-supplied durable store for last-known-good
   * entitlements (Redis / their DB / a KV). `undefined` when not
   * configured — the SDK then has no cold-start durability on
   * serverless, which it states explicitly at boot.
   *
   * Touched ONLY from the async `getEntitlements()` — never from the
   * synchronous `isEntitled()`.
   */
  private readonly entitlementStore!: EntitlementStore | null;
  private readonly debug!: DebugLogger;

  /**
   * Event Envelope v1 §3 — per-session monotonic sequence counter.
   *
   * Node has no mobile "session" lifecycle (no app launch / background /
   * foreground). We model a session as the SDK instance lifetime: the
   * counter starts at 0 on construction and increments once per
   * `track()` call. `session.started` is the boot-telemetry event
   * (the first `track()` called from `emitBootTelemetryEvent()`), so
   * the seq will be 0 for that event, matching the spec's "reset to 0
   * at session.started" clause — by construction, it's the zeroth event
   * of this instance's lifecycle.
   *
   * The counter persists for the entire process lifetime of the SDK
   * instance (spec §3 clause 1: background/foreground does not reset).
   * A new `CrossdeckServer` construction is the only reset (new session).
   */
  private sessionSeq = 0;

  /**
   * Alias map — `developerUserId` / `anonymousId` → canonical
   * `crossdeckCustomerId`. Populated by `getEntitlements()` so a
   * subsequent `isEntitled({ userId }, "pro")` resolves to the same
   * cache entry the prior `getEntitlements({ userId })` populated.
   *
   * Bounded by `MAX_CUSTOMER_ID_ALIASES` (matches the entitlement
   * cache's default max-customers for symmetry — if the underlying
   * cache entry was evicted, a stale alias is dead weight anyway).
   * Long-running multi-tenant servers handling a long tail of customers
   * are the failure mode this bound defends against.
   */
  private customerIdAliases = new Map<string, string>();

  /** Mutable error-state — modified by setTag / setContext / setErrorBeforeSend. */
  private errorContext: Record<string, unknown> = {};
  private errorTags: Record<string, string> = {};
  private errorBeforeSend: ((err: CapturedError) => CapturedError | null) | null = null;

  /**
   * Dedup gate for `sdk.shutdown`. Both `shutdown()` (async) and
   * `shutdownSync()` need to emit so direct callers of EITHER see
   * the event (the async path's listener guarantees pre-launch
   * tests, the sync path covers `Symbol.dispose` + tests that call
   * `shutdownSync()` directly). Without this flag, `shutdown()`'s
   * tail call into `shutdownSync()` would emit twice.
   */
  private didEmitShutdown = false;

  constructor(options: CrossdeckServerOptions) {
    super();
    if (!options.secretKey || !options.secretKey.startsWith("cd_sk_")) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_secret_key",
        message: "CrossdeckServer requires a secret key starting with cd_sk_.",
      });
    }

    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.appId = options.appId;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.env = inferEnvFromKey(options.secretKey);

    // ── SINGLETON GUARD — the Next.js / serverless re-instantiation fix ──────────
    // Frameworks like Next.js re-evaluate module scope (HMR, per-route isolation,
    // chunk splitting), so `new CrossdeckServer({...})` at module top-level can run
    // MANY times in one process. Each run would otherwise fire another boot
    // heartbeat, start another flush timer, stack another set of process listeners
    // (beforeExit / SIGTERM / uncaughtException / unhandledRejection), and re-wrap
    // global fetch — a storm of duplicate phone-homes + an EventEmitter leak
    // warning. A constructor may legally return an existing object, so for the same
    // credentials we hand back the instance already built and skip ALL of it. Keyed
    // by secretKey + appId + baseUrl (env is derived from the key). Same defence
    // Prisma / Firebase Admin ship for exactly this reason. The recommended
    // "construct once in module scope" pattern is NOT single-evaluation under
    // Next.js, so this self-defence protects every customer who follows our docs.
    const _store = globalThis as typeof globalThis & {
      __crossdeckServers__?: Map<string, CrossdeckServer>;
    };
    const _singletonKey = `${options.secretKey}|${this.appId ?? ""}|${this.baseUrl}`;
    _store.__crossdeckServers__ ??= new Map<string, CrossdeckServer>();
    const _existing = _store.__crossdeckServers__.get(_singletonKey);
    if (_existing) {
      // `new CrossdeckServer()` yields THIS cached instance; the half-built `this`
      // (super() + a few field assignments, no side effects yet) is discarded.
      return _existing;
    }

    this.secretKeyPrefix = maskSecretKey(options.secretKey);
    // PII scrubber on by default — parity with Web/RN/Swift.
    // Explicit `false` opts out for regulator-required audit
    // trails (see CrossdeckServerOptions.scrubPii docstring for
    // blast-radius warning).
    this.scrubPii = options.scrubPii !== false;

    this.http = new HttpClient({
      secretKey: options.secretKey,
      baseUrl: this.baseUrl,
      sdkVersion: this.sdkVersion,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      testMode: options.testMode,
      onRequest: options.onRequest,
      onResponse: options.onResponse,
      httpRetries: options.httpRetries,
      runtimeToken: options.runtimeToken,
    });

    this.processAnonymousId = mintId("anon_node");

    this.runtime = collectRuntimeInfo({
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion,
      appVersion: options.appVersion,
    });
    this.runtimeProperties = runtimeInfoToProperties(this.runtime);
    // Build the Envelope v1 §4 context object once — it's process-stable
    // (runtime info is frozen at boot) and reused on every event.
    this.eventContext = buildEventContext(this.runtime, SDK_NAME, this.sdkVersion);

    this.breadcrumbs = new BreadcrumbBuffer(options.breadcrumbsMaxSize ?? 50);
    this.superProps = new SuperPropertyStore();
    this.entitlementCache = new EntitlementCache({
      ttlMs: options.entitlementCacheTtlMs ?? 60_000,
      staleAfterMs: options.entitlementStaleAfterMs,
    });
    this.entitlementStore = options.entitlementStore ?? null;
    this.debug = options.debug === true ? new ConsoleDebugLogger() : new NullDebugLogger();
    if (options.debug === true) this.debug.enabled = true;

    this.debug.emit(
      "sdk.configured",
      `Crossdeck server SDK connected. env=${this.env}, host=${this.runtime?.host ?? "node"}`,
      {
        env: this.env,
        sdkVersion: this.sdkVersion,
        secretKeyPrefix: this.secretKeyPrefix,
      },
    );

    this.eventQueue = new EventQueue({
      http: this.http,
      batchSize: options.eventFlushBatchSize ?? 20,
      // v1.4.0 Phase 3.3 — flush interval default parity at 2000ms
      // across every SDK. Per-instance override stays.
      intervalMs: options.eventFlushIntervalMs ?? 2000,
      envelope: (): BatchEnvelope => ({
        appId: this.appId,
        // Ship env on every batch so the backend can cross-check
        // against the API-key-derived env and reject mismatches
        // loudly (env_mismatch). Web has always done this; node now
        // matches so defence-in-depth is symmetric across SDKs.
        environment: this.env,
        sdk: { name: SDK_NAME, version: this.sdkVersion },
      }),
      onDrop: (count) => {
        this.emit("queue.dropped", { count });
      },
      onBufferChange: (size) => {
        this.emit("queue.buffer_changed", { size });
      },
      onRetryScheduled: (info) => {
        this.emit("queue.flush_failed", {
          error: info.lastError,
          attempt: info.consecutiveFailures,
          nextRetryMs: info.delayMs,
        });
      },
      onPermanentFailure: (info) => {
        // Bank-grade rule: a permanent 4xx that's dropping events MUST
        // be loud regardless of debug mode. Pre-fix the queue retried
        // 4xx forever silently and the customer never knew their key
        // was revoked. console.error fires unconditionally; the debug
        // signal lets ops dashboards detect + surface the problem too;
        // the event-emitter signal lets host-app code listen and page.
        const headline = `[crossdeck] Event batch DROPPED (status ${info.status}): ${info.lastError}. ${info.droppedCount} event(s) lost — check your secret key + app config.`;
        // eslint-disable-next-line no-console
        console.error(headline);
        this.debug.emit(
          "sdk.flush_permanent_failure",
          headline,
          { ...info },
        );
        this.emit("queue.permanent_failure", {
          status: info.status,
          droppedCount: info.droppedCount,
          error: info.lastError,
        });
      },
      onParked: (info) => {
        // Second signal channel (the queue already logged ONE console line).
        // PARK is NOT a drop: events are held (in-memory on Node — see the
        // opt-in disk-queue follow-up) and resume on upgrade. The dashboard
        // reads sdk.parked to render the calm amber "update to resume" advisory.
        this.debug.emit(
          "sdk.parked",
          `[crossdeck] SDK parked — server no longer accepts this version's event format. Events held (paused, not lost); update @cross-deck/node${info.minVersion ? ` to >= ${info.minVersion}` : ""} and restart to resume.`,
          { ...info },
        );
      },
      onFirstFlushSuccess: () => {
        this.debug.emit("sdk.first_event_sent", "First batch landed.");
      },
    });

    // Error capture. Default: enabled. Caller can opt out with `false`,
    // or override individual knobs with a partial object.
    if (options.errorCapture === false) {
      this.errorTracker = null;
    } else {
      const config: ErrorCaptureConfig =
        options.errorCapture && typeof options.errorCapture === "object"
          ? { ...DEFAULT_ERROR_CAPTURE, ...options.errorCapture }
          : { ...DEFAULT_ERROR_CAPTURE };
      this.errorTracker = new ErrorTracker({
        config,
        breadcrumbs: this.breadcrumbs,
        report: (err) => this.reportCapturedError(err),
        getContext: () => ({ ...this.errorContext }),
        getTags: () => ({ ...this.errorTags }),
        // GETTER, not a captured value — `setErrorBeforeSend()` mutates
        // `this.errorBeforeSend` after init() and the tracker MUST pick
        // up the new hook on the next error. Pre-fix we worked around
        // a captured-by-value field with `Object.defineProperty` on the
        // tracker's private opts; the contract is now a real getter so
        // we just hand it the closure and the hack is gone.
        beforeSend: () => this.errorBeforeSend,
        isConsented: () => true,
        // Derived from the configured baseUrl at construction time.
        // Used by the fetch wrapper to skip captureHttp on Crossdeck's
        // own requests — pre-fix the skip was hardcoded to
        // `api.cross-deck.com` and broke for customers on staging /
        // regional / self-hosted base URLs (recursive capture loop).
        selfHostname: extractSelfHostname(this.baseUrl),
      });
      this.errorTracker.install();
    }

    // Flush-on-exit. Default: enabled. Critical for serverless — without
    // this, Cloud Functions / Lambda exit before HTTP completes and events
    // vanish silently.
    if (options.flushOnExit === false) {
      this.flushOnExit = null;
    } else {
      this.flushOnExit = new FlushOnExit({
        drain: () => this.eventQueue.flush().then(() => undefined),
        timeoutMs: options.flushOnExitTimeoutMs,
      });
      this.flushOnExit.install();
    }

    // Boot heartbeat. Fire-and-forget. Solves the cold-start
    // verification problem: the moment the customer's process boots
    // and constructs the SDK, we phone home — the dashboard row flips
    // LIVE within ~200ms without the caller having to add an explicit
    // `.heartbeat()` call. Serverless functions cold-start, construct
    // the SDK, fire the boot heartbeat, and the verification surface
    // can confirm install end-to-end on the very first inbound request.
    //
    // Side benefit: the secret key is validated at process boot rather
    // than at first event flush, so misconfigurations surface in logs
    // immediately rather than minutes later when the queue first drains.
    //
    // Opt-out via testMode (unit tests don't want network) or by
    // setting bootHeartbeat=false explicitly. Errors are swallowed so
    // a broken backend / bad key / firewall never crashes the caller's
    // process — heartbeat is diagnostic-grade, not load-bearing.
    // Durability warning fires UNCONDITIONALLY (regardless of
    // bootHeartbeat / testMode opt-outs) because it is a local-only
    // debug signal — no network call, no phone-home. Pre-fix it sat
    // inside `emitBootTelemetry()` which sat inside the bootHeartbeat
    // gate, so a developer who set `bootHeartbeat: false` (common in
    // serverless-test setups, CI scripts, and customers who don't want
    // the boot phone-home) silently disabled the entire reason
    // `entitlementStore` exists. Audit P1 #9: warning must surface
    // independently of the heartbeat opt-out.
    this.emitDurabilityWarning();

    if (options.testMode !== true && options.bootHeartbeat !== false) {
      // setImmediate lets the constructor return first so the caller's
      // code reaches the next statement before we kick off the network
      // call. Mirrors how Sentry's `Sentry.init()` schedules its boot
      // session.
      setImmediate(() => {
        void this.heartbeat().catch((err) => {
          this.debug.emit(
            "sdk.boot_heartbeat_failed",
            "Boot heartbeat failed (non-fatal — events will still flush).",
            { message: err instanceof Error ? err.message : String(err) },
          );
        });

        // Boot telemetry phone-home — the aggregatable `sdk.boot`
        // event. Stays inside the bootHeartbeat gate (the durability
        // WARNING above is local; this is a track() that hits the
        // wire). Same `testMode` / `bootHeartbeat` opt-out as the
        // heartbeat itself.
        this.emitBootTelemetryEvent();
      });
    }

    // Register the singleton LAST (fully constructed) so a re-evaluated module
    // returns THIS instance instead of building a second one (the storm fix above).
    _store.__crossdeckServers__.set(_singletonKey, this);
  }

  /**
   * Clear the process-wide singleton cache. The SDK hands back the SAME instance
   * for the same credentials (the Next.js / serverless re-instantiation guard in
   * the constructor); this resets that so the next `new CrossdeckServer()` builds a
   * fresh instance. For TESTS (per-test isolation) and bespoke hot-reload teardown
   * only — production code never needs it.
   */
  static clearSingletonCache(): void {
    (globalThis as { __crossdeckServers__?: Map<string, unknown> }).__crossdeckServers__?.clear();
  }

  /**
   * Emit the honest "no cold-start durability" warning when the runtime
   * is serverless AND no `entitlementStore` is wired. Local-only debug
   * signal — no network call, no phone-home. Safe to fire from the
   * constructor before `setImmediate` because there is no I/O on this
   * path.
   *
   * `isServerless` AND no store is the gap: a cold start begins with an
   * empty in-memory cache and a brief Crossdeck outage in that window
   * would read a paying customer as un-entitled. That gap is
   * unavoidable without a store — so the SDK STATES it (a
   * `sdk.no_durable_store` debug warning) rather than hiding it.
   *
   * Audit P1 #9: this used to live INSIDE `emitBootTelemetry()` which
   * itself sat inside the `bootHeartbeat` gate, so any developer who
   * set `bootHeartbeat: false` silently disabled the entire reason
   * `entitlementStore` exists. Now split: warning fires
   * unconditionally; the boot phone-home stays gated.
   */
  private emitDurabilityWarning(): void {
    const isServerless = this.runtime.isServerless;
    const hasStore = this.entitlementStore !== null;
    if (isServerless && !hasStore) {
      this.debug.emit(
        "sdk.no_durable_store",
        `Running on a serverless host (${this.runtime.host}) with no entitlementStore. ` +
          "The entitlement cache is in-memory only, so a cold start begins empty: " +
          "if Crossdeck is briefly unreachable during that window, isEntitled() can " +
          "read a paying customer as un-entitled. Wire `entitlementStore` (Redis / " +
          "your DB / a KV) to close this gap.",
        { host: this.runtime.host, isServerless, durableStore: false },
      );
    }
  }

  /**
   * Emit the one-time `sdk.boot` telemetry event — the aggregatable
   * fact the backend pivots on (compute fleet-wide
   * "% serverless-with-no-durable-store"). Rides the batched + retried
   * + idempotent queue and is drained by flush-on-exit, so it survives
   * a serverless teardown.
   *
   * Why a `track()` event and not the heartbeat: `GET /v1/sdk/heartbeat`
   * carries no request body, so it cannot transport a structured
   * `durability` fact.
   *
   * Gated by `bootHeartbeat` (and `testMode`) because it IS a phone-
   * home — the unconditional surface is `emitDurabilityWarning()`,
   * which has no network call.
   */
  private emitBootTelemetryEvent(): void {
    const isServerless = this.runtime.isServerless;
    const hasStore = this.entitlementStore !== null;
    // coldStartDurable: a long-lived host keeps the process (hence the
    // in-memory cache) warm between requests, so it is durable across a
    // brief outage without a store. A serverless host is durable across
    // a cold start ONLY with a store wired.
    const coldStartDurable = hasStore || !isServerless;

    // One-time boot telemetry event. Fire-and-forget through track() —
    // best-effort, never throws into the constructor.
    try {
      this.track({
        name: "sdk.boot",
        anonymousId: this.processAnonymousId,
        properties: {
          "durability.entitlementStore": hasStore,
          "durability.coldStartDurable": coldStartDurable,
          "durability.runtimeIsServerless": isServerless,
          "durability.runtimeHost": this.runtime.host,
          "durability.entitlementCacheTtlMs": this.entitlementCache.ttl,
        },
      });
    } catch {
      // track() only throws on a missing event name — which cannot
      // happen here. Defensive: boot telemetry must never crash boot.
    }
  }

  // ============================================================
  // Identity — direct HTTP (transactional, not telemetry)
  // ============================================================

  async identify(
    userId: string,
    anonymousId: string,
    options?: IdentifyOptions & RequestOptions,
  ): Promise<AliasResult> {
    const { signal, timeoutMs, ...identifyOpts } = options ?? {};
    return this.aliasIdentity(
      { userId, anonymousId, ...identifyOpts },
      { signal, timeoutMs },
    );
  }

  async aliasIdentity(
    input: AliasIdentityInput,
    options?: RequestOptions,
  ): Promise<AliasResult> {
    if (!input.userId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_user_id",
        message: "aliasIdentity requires a non-empty userId.",
      });
    }
    if (!input.anonymousId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_anonymous_id",
        message: "aliasIdentity requires a non-empty anonymousId.",
      });
    }

    const traits = sanitizePropertyBag(input.traits, "traits");
    const body: Record<string, unknown> = {
      userId: input.userId,
      anonymousId: input.anonymousId,
    };
    if (input.email) body.email = input.email;
    if (traits && Object.keys(traits).length > 0) body.traits = traits;

    return this.http.request<AliasResult>("POST", "/identity/alias", {
      body,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  async forget(hints: IdentityHints, options?: RequestOptions): Promise<ForgetResult> {
    const body = this.identityPayload(hints);
    return this.http.request<ForgetResult>("POST", "/identity/forget", {
      body,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * Stamp an outbound email link so its click binds to the recipient on landing.
   *
   * You know the recipient's email at send time; pass it with the link's destination
   * and Crossdeck returns the same URL carrying a one-time arrival ticket (`cd_ref`).
   * Put the returned URL in the email. When the recipient clicks and lands on a page
   * running `@cross-deck/web`, the SDK reads the ticket automatically and binds that
   * session to the person — the post-click journey then joins their identity.
   *
   * Rail-agnostic: works for Resend, HubSpot, your own SMTP, anything. Server-side
   * only (it mints an identity bind, so a secret key is required). If the landing page
   * has no Crossdeck web SDK, the deep session stitch softens but the server-side
   * email funnel (via the rail adapter) still lands by identity.
   */
  async campaignLink(
    input: CampaignLinkInput,
    options?: RequestOptions,
  ): Promise<CampaignLinkResult> {
    if (!input.email) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_email",
        message: "campaignLink requires the recipient's email.",
      });
    }
    if (!input.url) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_url",
        message: "campaignLink requires the link's destination url.",
      });
    }
    const body: Record<string, unknown> = { email: input.email, url: input.url };
    if (input.rail) body.rail = input.rail;

    return this.http.request<CampaignLinkResult>("POST", "/campaign/email-link", {
      body,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  // ============================================================
  // Entitlements — direct HTTP + TTL cache (v1.0.0+)
  //
  // `getEntitlements()` POSTs over the wire and populates the cache
  // under the response's canonical `crossdeckCustomerId`. Any
  // `userId` / `anonymousId` supplied as a hint is recorded as an
  // alias so a subsequent `isEntitled({ userId }, "pro")` resolves
  // to the same cache entry.
  // ============================================================

  /**
   * Fetch a customer's entitlements from Crossdeck and warm the cache.
   *
   * Durability — this is where last-known-good lives, NOT in the
   * synchronous `isEntitled()`:
   *   - On a SUCCESSFUL fetch: the entitlement cache is populated and,
   *     if an `entitlementStore` is configured, the result is persisted
   *     to it (`await store.save(...)`). The cache + store now hold
   *     server-confirmed truth.
   *   - On a network FAILURE: the cache is marked refresh-failed for the
   *     customer (so `diagnostics()` shows the staleness), then — if a
   *     store is configured — last-known-good is loaded back from it
   *     (`await store.load(...)`). If the store yields a snapshot, the
   *     cache is populated from it and that snapshot is RETURNED as a
   *     normal `EntitlementsListResponse` — a cold-start / outage no
   *     longer fails a paying customer. If there is no store, or the
   *     store is empty, the network error is rethrown unchanged so the
   *     caller still sees the failure.
   *
   * The store is touched only here, inside the `await` that already
   * existed. `isEntitled()` remains a pure synchronous `Map` read.
   */
  async getEntitlements(
    hints: IdentityHints,
    options?: RequestOptions,
  ): Promise<EntitlementsListResponse> {
    let response: EntitlementsListResponse;
    try {
      response = await this.http.request<EntitlementsListResponse>("GET", "/entitlements", {
        query: this.identityPayload(hints),
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
    } catch (err) {
      // The refresh failed (Crossdeck unreachable / transient error).
      // Mark the customer stale so the staleness is visible via
      // diagnostics(), never a silent unbounded window.
      const failedCustomerId = this.resolveFailedRefreshCustomerId(hints);
      if (failedCustomerId) {
        this.entitlementCache.markRefreshFailed(failedCustomerId);
      }
      // Cold-start / outage fallback: try the durable store for last-
      // known-good. A hit repopulates the cache and is returned as a
      // normal response — the paying customer keeps access.
      const recovered = await this.loadEntitlementsFromStore(hints);
      if (recovered) {
        const recoveredResponse: EntitlementsListResponse = {
          object: "list",
          data: recovered.entitlements,
          crossdeckCustomerId: recovered.crossdeckCustomerId,
          env: recovered.env,
        };
        this.populateEntitlementCache(hints, recoveredResponse);
        // populateEntitlementCache → setForCustomer CLEARS the stale
        // flag (it treats a populate as a successful refresh). But this
        // was an OUTAGE fallback, not a fresh server read — Crossdeck is
        // still down. Re-mark the customer stale so diagnostics() keeps
        // showing the outage; the next genuinely-successful
        // getEntitlements() clears it for real.
        this.entitlementCache.markRefreshFailed(recovered.crossdeckCustomerId);
        this.debug.emit(
          "sdk.entitlement_store_recovered",
          `Crossdeck unreachable — served ${recovered.crossdeckCustomerId} from the durable store ` +
            `(${recovered.entitlements.length} entitlement(s), last refreshed ` +
            `${new Date(recovered.savedAt).toISOString()}).`,
          {
            customerId: recovered.crossdeckCustomerId,
            savedAt: recovered.savedAt,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return recoveredResponse;
      }
      // No store, or the store had nothing — the caller still sees the
      // failure. If the cache was previously warm for this customer it
      // keeps serving its own last-known-good via the synchronous
      // isEntitled(); the customer is now flagged stale (visible in
      // diagnostics()), which this signal makes explicit too.
      if (failedCustomerId && this.entitlementCache.isStale(failedCustomerId)) {
        this.debug.emit(
          "sdk.entitlement_cache_stale",
          `Crossdeck unreachable — entitlement cache for ${failedCustomerId} is now stale. ` +
            (this.entitlementStore
              ? "No durable snapshot was available to recover from."
              : "No entitlementStore is configured, so there is no durable fallback.") +
            " isEntitled() keeps serving last-known-good; staleness is visible in diagnostics().",
          {
            customerId: failedCustomerId,
            durableStore: this.entitlementStore !== null,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
      throw err;
    }
    this.populateEntitlementCache(hints, response);
    // Persist the fresh result so a future cold start / outage can
    // recover it. Best-effort — a store write failure must not fail an
    // otherwise-successful fetch.
    await this.saveEntitlementsToStore(hints, response);
    return response;
  }

  async getCustomerEntitlements(
    customerId: string,
    options?: RequestOptions,
  ): Promise<EntitlementsListResponse> {
    if (!customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "getCustomerEntitlements requires a customerId.",
      });
    }
    const response = await this.http.request<EntitlementsListResponse>(
      "GET",
      `/server/customers/${encodeURIComponent(customerId)}/entitlements`,
      {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
    this.populateEntitlementCache({ customerId }, response);
    return response;
  }

  // ── Blocking — "entitlements, inverted" (Crossdeck Trust, v2 preview) ───────
  //
  // getEntitlements() answers "can they access Pro?"; resolve() answers "should
  // they be here at all?". Same call, opposite question. Both read Crossdeck live.
  // The safety inversion: entitlements fail CLOSED (protect revenue); blocking
  // fails OPEN (protect real users) — these methods NEVER throw for the verdict
  // and NEVER return blocked:true on uncertainty.

  /**
   * Resolve a user's BLOCK verdict (plus identity / entitlement context) — the same
   * `/v1/resolve` you'd call for entitlements, read for `blocked`. Wire it into signup
   * and every visit; on `blocked`, sign the user out (and, for public content, take
   * their pages offline — see the Blocking developer guide, Pattern B).
   *
   * **Fail-open is the contract.** This never throws for the block decision and never
   * returns `blocked: true` on uncertainty. Any error — Crossdeck unreachable, timeout,
   * unresolved identity — yields `{ blocked: false, degraded: true }`, so a glitch can
   * never lock out a real user.
   *
   * Forward the END USER's `ip` (you call this server-to-server, so otherwise Crossdeck
   * sees your server's IP and an ip-rule can't match the visitor), and the verified
   * identity (`userId` + `idToken`) so a `domain`/`email` rule can match the email.
   *
   * @experimental Preview — Crossdeck Trust ships with Crossdeck v2. Stable shape, not yet GA.
   */
  async resolve(input: ResolveInput, options?: RequestOptions): Promise<ResolveResult> {
    const failOpen = (): ResolveResult => ({
      blocked: false,
      blockReason: null,
      blockedKey: null,
      degraded: true,
      status: "anonymous",
      entitlements: [],
      crossdeckCustomerId: null,
      anonymousId: input?.anonymousId ?? null,
      identityError: null,
    });
    // A `CrossdeckServer` is always secret-keyed (a trusted server), so a bare `userId`
    // is the server-trusted recognition path the backend honours — it rides the identity
    // backbone and matches on the email Crossdeck already holds, no idToken required. So
    // we require SOME identity (anonymousId or userId), NOT specifically userId+idToken.
    // (`idToken` stays optional — send it for the verified Tier-3 path.)
    if (!input || (!input.anonymousId && !input.userId)) {
      this.debug.emit(
        "sdk.resolve_missing_identity",
        "resolve() needs an anonymousId or a userId; returning fail-open blocked:false.",
      );
      return failOpen();
    }
    try {
      const raw = await this.http.request<{
        status?: string;
        blocked?: boolean;
        blockReason?: string | null;
        blockedKey?: string | null;
        entitlements?: unknown;
        crossdeckCustomerId?: string | null;
        anonymousId?: string | null;
        reference?: string | null;
        supportEmail?: string | null;
        blockEventId?: string | null;
        user?: { id?: string | null } | null;
        identityError?: { reason: string } | null;
      }>("POST", "/resolve", {
        body: {
          ...(input.userId ? { userId: input.userId } : {}),
          ...(input.idToken ? { idToken: input.idToken } : {}),
          ...(input.anonymousId ? { anonymousId: input.anonymousId } : {}),
          ...(input.ip ? { ip: input.ip } : {}),
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      return {
        blocked: raw.blocked === true,
        blockReason: raw.blockReason ?? null,
        blockedKey: raw.blockedKey ?? null,
        reference: raw.reference ?? null,
        supportEmail: raw.supportEmail ?? null,
        blockEventId: raw.blockEventId ?? null,
        status: typeof raw.status === "string" ? raw.status : "active",
        entitlements: Array.isArray(raw.entitlements)
          ? raw.entitlements.filter((e): e is string => typeof e === "string")
          : [],
        crossdeckCustomerId: raw.crossdeckCustomerId ?? raw.user?.id ?? null,
        anonymousId: raw.anonymousId ?? input.anonymousId ?? null,
        identityError: raw.identityError ?? null,
      };
    } catch (err) {
      this.debug.emit(
        "sdk.resolve_failed",
        `resolve() failed — fail-open blocked:false. ${err instanceof Error ? err.message : String(err)}`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return failOpen();
    }
  }

  /**
   * Convenience over {@link resolve}: just the boolean. Fail-open (false on any error).
   *
   * @experimental Preview — see {@link resolve}.
   */
  async isBlocked(input: ResolveInput, options?: RequestOptions): Promise<boolean> {
    return (await this.resolve(input, options)).blocked;
  }

  /**
   * The OWNER's block verdict for the public-page path (Pattern B / §5b of the Blocking
   * developer guide) — "is the owner of this page blocked?", no session token required.
   * Pass the owner's recorded identifiers (`userId`/`email`/`domain`/`ip`; the `ip` is
   * their CREATION ip, not a live visitor's). Poll on a short TTL to invalidate your
   * public-page cache. Fail-open — any error → `{ blocked: false, degraded: true }`.
   *
   * @experimental Preview — see {@link resolve}.
   */
  async getOwnerStatus(input: OwnerStatusInput, options?: RequestOptions): Promise<BlockVerdict> {
    const query: Record<string, string | undefined> = {
      userId: input?.userId || undefined,
      email: input?.email || undefined,
      domain: input?.domain || undefined,
      ip: input?.ip || undefined,
    };
    if (!query.userId && !query.email && !query.domain && !query.ip) {
      this.debug.emit(
        "sdk.owner_status_missing_identity",
        "getOwnerStatus() needs at least one of userId/email/domain/ip; returning fail-open blocked:false.",
      );
      return { blocked: false, blockReason: null, blockedKey: null, degraded: true };
    }
    try {
      const raw = await this.http.request<{
        blocked?: boolean;
        blockReason?: string | null;
        blockedKey?: string | null;
      }>("GET", "/trust/status", {
        query,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      return {
        blocked: raw.blocked === true,
        blockReason: raw.blockReason ?? null,
        blockedKey: raw.blockedKey ?? null,
      };
    } catch (err) {
      this.debug.emit(
        "sdk.owner_status_failed",
        `getOwnerStatus() failed — fail-open blocked:false. ${err instanceof Error ? err.message : String(err)}`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return { blocked: false, blockReason: null, blockedKey: null, degraded: true };
    }
  }

  /**
   * The brand-new-signup door (§3 of the Blocking developer guide). Block a user Crossdeck
   * has **never seen** — at the instant they sign up — by the two strings you have then:
   * their `email` and `ip`. There's no identity to ride yet, so {@link resolve} can't catch
   * them; this matches `email` / domain / `ip` blocklist rules directly. Call it BEFORE you
   * create the account; on `action: "block"`, reject the signup.
   *
   * **Fail-open by contract** — never throws, never blocks on uncertainty: any error →
   * `{ action: "allow", allow: true, degraded: true }`, so a glitch can't reject a real signup.
   *
   * @experimental Preview — Crossdeck Trust ships with Crossdeck v2.
   */
  async gate(input: GateInput, options?: RequestOptions): Promise<GateVerdict> {
    const failOpen = (): GateVerdict => ({
      action: "allow",
      allow: true,
      blockReason: null,
      blockedKey: null,
      degraded: true,
    });
    if (!input || (!input.email && !input.ip && !input.domain)) {
      this.debug.emit(
        "sdk.gate_missing_input",
        "gate() needs at least one of email / ip / domain; returning fail-open allow:true.",
      );
      return failOpen();
    }
    try {
      const raw = await this.http.request<{
        action?: string;
        allow?: boolean;
        blockReason?: string | null;
        blockedKey?: string | null;
        reference?: string | null;
        supportEmail?: string | null;
        blockEventId?: string | null;
        band?: string | null;
      }>("POST", "/trust/gate", {
        body: {
          ...(input.email ? { email: input.email } : {}),
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
          // The human-proof attestation from the Crossdeck Trust browser panel.
          // Verified server-side at the gate; its absence is scored, never a hard
          // block on its own (fail-open). Only sent when the client supplied one.
          ...(input.token ? { challengeToken: input.token } : {}),
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      const action =
        raw.action === "block" || raw.action === "review" ? raw.action : "allow";
      return {
        action,
        allow: raw.allow !== false && action !== "block",
        blockReason: raw.blockReason ?? null,
        blockedKey: raw.blockedKey ?? null,
        reference: raw.reference ?? null,
        supportEmail: raw.supportEmail ?? null,
        blockEventId: raw.blockEventId ?? null,
      };
    } catch (err) {
      this.debug.emit(
        "sdk.gate_failed",
        `gate() failed — fail-open allow:true. ${err instanceof Error ? err.message : String(err)}`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return failOpen();
    }
  }

  /**
   * Synchronous entitlement check. Returns `true` iff the customer
   * has the entitlement AND the cache entry is fresh (within
   * `entitlementCacheTtlMs`, default 60s). Returns `false` when the
   * cache is cold or expired.
   *
   * The hint can be any combination of `customerId` / `userId` /
   * `anonymousId`. After `getEntitlements({ userId })` populates the
   * cache, subsequent `isEntitled({ userId }, "pro")` calls within
   * TTL are memory reads (no HTTP). The "warm cache" pattern that
   * makes hot-path entitlement gates cheap.
   *
   *   await server.getEntitlements({ userId });    // warm
   *   if (server.isEntitled({ userId }, "pro")) {  // synchronous
   *     // ...
   *   }
   *
   * Caller is responsible for re-warming after TTL elapses. The cache
   * does NOT auto-refresh on read (would block the hot path).
   */
  isEntitled(hint: IdentityHints | string, key: string): boolean {
    const customerId = this.resolveCacheCustomerId(hint);
    if (!customerId) return false;
    const result = this.entitlementCache.isEntitled(customerId, key);
    if (result) {
      this.debug.emit("sdk.entitlement_cache_used", `Cache hit for ${customerId}/${key}.`);
    }
    return result;
  }

  /**
   * Snapshot of the customer's cached entitlements. Returns `[]` when
   * the cache is cold or expired. Same hint resolution as
   * `isEntitled()`.
   */
  listEntitlements(hint: IdentityHints | string): PublicEntitlement[] {
    const customerId = this.resolveCacheCustomerId(hint);
    if (!customerId) return [];
    return this.entitlementCache.list(customerId);
  }

  /**
   * Subscribe to entitlement-cache mutations. Listener fires after
   * `getEntitlements()` populates the cache or `shutdown()` clears
   * it. Returns an idempotent unsubscribe function.
   *
   * Used by callers that want to react to entitlement changes (e.g.
   * a websocket layer notifying connected clients of plan upgrades).
   * Listener errors are swallowed — surfaced via
   * `diagnostics().entitlements.listenerErrors`.
   */
  onEntitlementsChange(listener: EntitlementsListener): () => void {
    return this.entitlementCache.subscribe(listener);
  }

  // ============================================================
  // Events — queue-based track(); immediate ingest() for bulk imports
  // ============================================================

  /**
   * Queue an event for batched delivery. Returns synchronously — the
   * HTTP round-trip happens in the background.
   *
   * Behaviour parity with `@cross-deck/web`'s `track()`:
   *   - Synchronous return, void.
   *   - Throws sync on `missing_event_name`.
   *   - Property bag sanitised through `validateEventProperties`.
   *   - Runtime info (`runtime.*`) auto-merged into every event's
   *     properties. Caller-supplied properties win on key collision.
   *   - Breadcrumb auto-emitted (unless the name starts with `error.`,
   *     which would cause a cycle).
   *
   * Differences from `@cross-deck/web`:
   *   - Single-argument signature `track(event)` instead of
   *     `track(name, properties)` — the Node wire shape needs the full
   *     `ServerEvent` (identity hint, optional level + tags + categoryTags).
   *   - Auto-fills `anonymousId` with `this.processAnonymousId` when no
   *     identity hint is supplied. A captureError from
   *     `uncaughtException` has no per-request context; without the
   *     auto-fill, the event would be rejected at queue enqueue.
   */
  /**
   * Emit `crossdeck.contract_failed` to the Crossdeck reliability
   * endpoint — single-fire, one-way, never visible in the customer's
   * dashboard. Goes over a dedicated HTTP path with the reliability
   * publishable key embedded at build time; the customer's track()
   * pipeline never carries `crossdeck.*` events. This is the
   * independent-controller flow described in Privacy Policy §6
   * ("Flow B"). The wire shape is fixed by the schema-lock contract
   * at `contracts/diagnostics/contract-failed-payload-schema-lock.json`.
   */
  reportContractFailure(input: ContractFailureInput): void {
    const payload: Record<string, string> = {
      contract_id: input.contractId,
      sdk_version: SDK_VERSION,
      sdk_platform: "node",
      failure_reason: input.failureReason,
      run_context: input.runContext,
      run_id: input.runId,
    };
    if (input.testRef) {
      payload.test_file = input.testRef.file;
      payload.test_name = input.testRef.name;
    }
    if (input.deviceClass) {
      payload.device_class = input.deviceClass;
    }
    sendDiagnosticTelemetry(payload);
  }

  track(event: ServerEvent): void {
    if (!event.name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "track(event) requires a non-empty event.name.",
      });
    }

    const validated = sanitizePropertyBag(event.properties, "event properties") ?? {};
    // v1.4.0 Phase 3.1 — apply the PII scrubber. Pre-v1.4.0 the
    // Node SDK was the ONLY one that skipped this, despite the
    // README promising parity with Web/RN/Swift. The scrubber
    // walks nested maps + arrays and rewrites email- and card-
    // number-shaped substrings to `<email>` / `<card>` sentinels.
    const sanitized = this.scrubPii
      ? (scrubPiiFromProperties(validated) as EventProperties)
      : validated;

    if (this.debug.enabled) {
      const flagged = findSensitivePropertyKeys(sanitized);
      if (flagged.length > 0) {
        this.debug.emit(
          "sdk.sensitive_property_warning",
          `Event "${event.name}" has potentially sensitive property names: ${flagged.join(", ")}. Crossdeck is privacy-first — avoid sending PII unless intentional.`,
          { eventName: event.name, flagged },
        );
      }
    }

    // Enrichment order (parity with web SDK):
    //   1. Super-properties (registered via server.register(...))
    //   2. Group memberships → `$groups.<type>: id` (server.group(...))
    //   3. Caller-supplied properties (sanitised — most authoritative)
    //
    // NOTE: runtime.* props are no longer merged into `properties` here.
    // They are promoted into the Envelope v1 §4 `context` object on the
    // wire event (see `eventContext` field). Super-properties may still
    // carry runtime.* keys if the caller registered them explicitly —
    // that is intentional (caller wins on key collision).
    //
    // Caller wins on key collision so a developer-set value overrides
    // anything the SDK auto-attached.
    const properties: EventProperties = {
      ...this.superProps.getSuperProperties(),
      ...sanitized,
    };
    const groupIds = this.superProps.getGroupIds();
    if (Object.keys(groupIds).length > 0 && properties.$groups === undefined) {
      properties.$groups = groupIds;
    }

    const identity = this.resolveIdentity(event);

    // Capture seq and timestamp atomically — spec §3 requires seq to be
    // captured synchronously with the event's timestamp so both reflect
    // the same enqueue moment. Post-increment: the event gets the current
    // value, then the counter advances for the next event.
    const seq = this.sessionSeq++;
    const timestamp = event.timestamp ?? Date.now();

    const queued: QueuedEvent = {
      eventId: event.eventId ?? mintId("evt", 8),
      name: event.name,
      timestamp,
      seq,
      context: this.eventContext,
      properties,
      ...identity,
    };
    if (event.level !== undefined) queued.level = event.level;
    if (event.tags !== undefined) queued.tags = event.tags;
    if (event.categoryTags !== undefined) queued.categoryTags = event.categoryTags;

    this.eventQueue.enqueue(queued);

    if (!event.name.startsWith("error.")) {
      this.breadcrumbs.add({
        timestamp: queued.timestamp,
        category: categoryFor(event.name),
        message: event.name,
        data: sanitized,
      });
    }
  }

  /**
   * Immediate POST of one or more events. For bulk imports / replay
   * scenarios where the caller wants synchronous confirmation. Bypasses
   * the queue — no batching, no auto-fill of identity, no
   * runtime-enrichment.
   *
   * Use `track()` for the standard fire-and-forget telemetry path.
   * Use `ingest()` when you need:
   *   - The IngestResponse synchronously.
   *   - Strict per-event identity validation (no auto-fill).
   *   - Caller-controlled idempotency key.
   */
  async ingest(events: ServerEvent[], options: IngestOptions = {}): Promise<IngestResponse> {
    if (!Array.isArray(events) || events.length === 0) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_events",
        message: "ingest requires at least one event.",
      });
    }

    const normalized = events.map((event) => this.normalizeIngestEvent(event));
    const body: Record<string, unknown> = {
      // Event Envelope v1 §1 — wire version (parity with the queue path).
      envelopeVersion: 1,
      events: normalized,
      sdk: { name: SDK_NAME, version: this.sdkVersion },
      // Match the queue's batch envelope (see event-queue.ts) — backend
      // cross-checks `environment` against the API-key-derived env and
      // rejects mismatches loudly (env_mismatch). Pre-fix this direct
      // ingest path skipped env, so a "live key, env: sandbox"
      // misconfig fell through silently for the bulk-import path.
      environment: this.env,
    };
    if (this.appId) body.appId = this.appId;

    return this.http.request<IngestResponse>("POST", "/events", {
      body,
      idempotencyKey: options.idempotencyKey ?? mintId("batch"),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Validate the secret key against the Crossdeck API and return the
   * resolved project + app metadata. Useful at boot to fail fast on a
   * misconfigured deployment — without this, a wrong secret key only
   * surfaces on the first event flush attempt, which may be minutes
   * after process start.
   *
   *   const { projectId, appId, env, serverTime } = await server.heartbeat();
   *
   * Throws `CrossdeckError` on:
   *   - `authentication_error` — secret key invalid / revoked
   *   - `network_error` — couldn't reach the backend
   *   - `request_timeout` — backend slow / unreachable
   *
   * Side effect: success records `(serverTime, clientTime)` for clock-
   * skew detection in `diagnostics().clock` (Phase 2 — not yet exposed
   * in this SDK release but the data is captured).
   *
   * Not auto-called. Caller decides whether the trade-off (one extra
   * boot request + ~50ms p50 latency) is worth the early-failure
   * signal. For serverless cold-starts, it usually is — cheap
   * compared to the cost of a silent broken secret in production.
   */
  async heartbeat(options?: RequestOptions): Promise<HeartbeatResponse> {
    const result = await this.http.request<HeartbeatResponse>("GET", "/sdk/heartbeat", {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    return result;
  }

  /**
   * Drain the event queue. Resolves when the in-flight batch completes
   * (success or failure). On failure, events stay queued for the next
   * scheduled retry — the resolved promise does NOT throw.
   *
   * Typical callers:
   *   - End of a Lambda handler: `await server.flush()` before return
   *     so events land before the platform freezes the process.
   *   - Express server shutdown: `await server.flush()` inside the
   *     SIGTERM handler.
   *   - Tests: drain between assertions.
   *
   * Idempotent — flush on an empty queue is a no-op.
   */
  async flush(): Promise<void> {
    await this.eventQueue.flush();
  }

  async syncPurchases(
    input: SyncPurchaseInput,
    options?: RequestOptions,
  ): Promise<PurchaseResult> {
    if (!input.signedTransactionInfo) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_signed_transaction_info",
        message: "syncPurchases requires a signedTransactionInfo string.",
      });
    }
    // Spread input FIRST so the explicit `rail` default below WINS.
    // Pre-fix order was `{ rail: input.rail ?? "apple", ...input }`
    // — but `...input` runs LAST and overrides the default with the
    // caller's literal `rail` key, including the case where the
    // caller passes `rail: undefined` explicitly (TypeScript treats
    // an undefined-typed property as "key present"). Reversing the
    // order so the default sits last fixes both the explicit-undefined
    // case AND the omitted-key case in one line.
    const rail = input.rail ?? "apple";
    const body = { ...input, rail };
    // Phase 2.2 bank-grade contract: deterministic Idempotency-Key
    // from the body. Same input → same key → backend short-circuits
    // with idempotent_replay: true on retry. Caller can override
    // via options.idempotencyKey for advanced use cases (custom
    // idempotency window inside a job runner, etc).
    const idempotencyKey =
      options?.idempotencyKey ?? deriveIdempotencyKeyForPurchase(body);
    const result = await this.http.request<PurchaseResult>("POST", "/purchases/sync", {
      body,
      idempotencyKey,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    // Phase 3.5 (v1.4.0) — emit purchase.completed so server-side
    // syncPurchases callers show up on the same funnel as the
    // Swift/Android auto-track path. Schema mirrors the native
    // auto-track shape on event name + rail/productId.
    try {
      const sourceProductId = result.entitlements[0]?.source.productId;
      const sourceSubscriptionId = result.entitlements[0]?.source.subscriptionId;
      const props: Record<string, unknown> = { rail };
      if (sourceProductId) props.productId = sourceProductId;
      if (sourceSubscriptionId) props.subscriptionId = sourceSubscriptionId;
      if (result.idempotent_replay) props.idempotent_replay = true;
      this.track({ name: "purchase.completed", properties: props });
    } catch {
      // track() validates name; we control the literal, so this
      // catch is defensive against future validation drift.
    }
    return result;
  }

  // ============================================================
  // Manual entitlement controls + audit — direct HTTP
  // ============================================================

  async grantEntitlement(
    input: GrantEntitlementInput,
    options?: RequestOptions,
  ): Promise<EntitlementMutationResult> {
    if (!input.customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "grantEntitlement requires a customerId.",
      });
    }

    return this.http.request<EntitlementMutationResult>(
      "POST",
      `/server/customers/${encodeURIComponent(input.customerId)}/grant`,
      {
        body: {
          entitlementKey: input.entitlementKey,
          duration: input.duration,
          reason: input.reason,
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
  }

  /**
   * Grant multiple entitlements in one logical call. Backend lacks a
   * bulk endpoint today, so this is a client-side fan-out — each
   * grant fires a separate request. Results return as a
   * settled-promise array so partial failures don't drop the rest:
   * the caller decides how to handle each `{ ok, value }` /
   * `{ ok: false, error }` entry.
   *
   * Use for ops sweeps (e.g. "grant the entire `pro` tier a one-time
   * `pro_q1_bonus` entitlement"). The bounded concurrency (default
   * `maxConcurrency: 5`) avoids hammering the backend; the rate-
   * limit policy on the server still kicks in if needed.
   */
  async bulkGrantEntitlement(
    grants: GrantEntitlementInput[],
    options?: RequestOptions & { maxConcurrency?: number },
  ): Promise<Array<{ input: GrantEntitlementInput; ok: true; value: EntitlementMutationResult } | { input: GrantEntitlementInput; ok: false; error: CrossdeckError }>> {
    return runBulkOperation(grants, options?.maxConcurrency ?? 5, (input) =>
      this.grantEntitlement(input, { signal: options?.signal, timeoutMs: options?.timeoutMs }),
    );
  }

  async revokeEntitlement(
    input: RevokeEntitlementInput,
    options?: RequestOptions,
  ): Promise<EntitlementMutationResult> {
    if (!input.customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "revokeEntitlement requires a customerId.",
      });
    }

    return this.http.request<EntitlementMutationResult>(
      "POST",
      `/server/customers/${encodeURIComponent(input.customerId)}/revoke`,
      {
        body: {
          entitlementKey: input.entitlementKey,
          reason: input.reason,
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
  }

  /**
   * Revoke multiple entitlements in one logical call. Same
   * settled-array contract as `bulkGrantEntitlement` — see that
   * doc for behaviour notes.
   */
  async bulkRevokeEntitlement(
    revokes: RevokeEntitlementInput[],
    options?: RequestOptions & { maxConcurrency?: number },
  ): Promise<Array<{ input: RevokeEntitlementInput; ok: true; value: EntitlementMutationResult } | { input: RevokeEntitlementInput; ok: false; error: CrossdeckError }>> {
    return runBulkOperation(revokes, options?.maxConcurrency ?? 5, (input) =>
      this.revokeEntitlement(input, { signal: options?.signal, timeoutMs: options?.timeoutMs }),
    );
  }

  async getAuditEntry(eventId: string, options?: RequestOptions): Promise<AuditEntry> {
    if (!eventId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_id",
        message: "getAuditEntry requires an eventId.",
      });
    }

    const result = await this.http.request<AuditEntryResponse>(
      "GET",
      `/server/audit/${encodeURIComponent(eventId)}`,
      {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
    return result.data;
  }

  // ============================================================
  // USP 1 — Error capture public surface
  // ============================================================

  /**
   * Manually capture an error from a try/catch block.
   *
   *   try { … } catch (err) {
   *     server.captureError(err, { context: { jobId }, tags: { flow: "checkout" } });
   *   }
   *
   * The error ships through the same event queue analytics rides on
   * (retried, idempotent, runtime-enriched). Returns silently — never
   * throws, even if error capture is disabled.
   */
  captureError(
    error: unknown,
    options?: { context?: Record<string, unknown>; tags?: Record<string, string>; level?: ErrorLevel },
  ): void {
    if (!this.errorTracker) return;
    this.errorTracker.captureError(error, options);
  }

  /**
   * Capture a non-error signal as an issue. Sentry's `captureMessage`
   * pattern — for "we hit the deprecated code path" / "soft-warning
   * triggered" signals where there's no Error to throw.
   */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.errorTracker) return;
    this.errorTracker.captureMessage(message, level);
  }

  /**
   * Attach a tag to every subsequent error report. Sentry pattern.
   * Tags are flat string key/value (queryable in the dashboard);
   * use `setContext()` for structured blobs.
   */
  setTag(key: string, value: string): void {
    this.errorTags[key] = value;
  }

  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags: Record<string, string>): void {
    Object.assign(this.errorTags, tags);
  }

  /**
   * Attach a structured context blob to every subsequent error report.
   * Unlike tags (flat key/value), context is a named bag of arbitrary
   * JSON-serialisable data.
   *
   *   server.setContext("cart", { items: 3, total: 42.99 });
   */
  setContext(name: string, data: Record<string, unknown>): void {
    this.errorContext[name] = data;
  }

  /**
   * Add a custom breadcrumb to the rolling buffer. The last 50
   * breadcrumbs are attached to every subsequent error report —
   * "what was the request doing right before things broke."
   */
  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.add(crumb);
  }

  /**
   * Install a pre-send hook for errors. Return null to drop the report,
   * or a modified `CapturedError` to scrub fields. Sentry's
   * `beforeSend` pattern — the only place to add app-specific PII
   * redaction (auth tokens in URLs, etc.) before the report leaves the
   * process.
   *
   * The hook is called LAST, after rate-limit + sampling + path gates
   * already passed. A throwing hook falls back to the original error.
   */
  setErrorBeforeSend(hook: ((err: CapturedError) => CapturedError | null) | null): void {
    this.errorBeforeSend = hook;
  }

  // ============================================================
  // USP 2 — Super-properties + groups (Mixpanel pattern)
  // ============================================================

  /**
   * Register super-properties — every subsequent event carries these
   * keys on its `properties` bag automatically. Mixpanel pattern.
   *
   *   server.register({ tenant: "acme", plan: "pro" });
   *   server.track({ name: "paywall_shown", developerUserId: userId });
   *   //          ^ event carries `tenant` + `plan` in properties
   *
   * Values that are `null` are deleted (the explicit "stop tracking
   * this key" idiom). Sanitised through `validateEventProperties` so
   * a `{ avatar: <Buffer> }` payload can't poison the queue.
   *
   * Returns a defensive snapshot of the resulting bag.
   *
   * **Multi-tenant servers — read carefully.** Super-properties are
   * PROCESS-SCOPED. In a single Node process handling requests for
   * many tenants (the common multi-tenant SaaS shape), calling
   * `server.register({ tenant: "acme" })` taints EVERY subsequent
   * event from that process — including ones serving tenant "beta".
   * That's almost never what you want.
   *
   * The right pattern for per-request properties is to pass them on
   * the `track()` call itself:
   *
   *   server.track({
   *     name: "paywall_shown",
   *     developerUserId: req.user.id,
   *     properties: { tenant: req.tenantId, plan: req.user.plan },
   *   });
   *
   * Reserve `register()` for properties that genuinely apply to every
   * event from this process — e.g. service version, region, build
   * commit. For those, `runtime-info` already provides
   * `runtime.serviceVersion` etc. automatically.
   */
  register(properties: Record<string, unknown>): Record<string, unknown> {
    const validation = validateEventProperties(properties);
    const result = this.superProps.register(validation.properties);
    this.debug.emit(
      "sdk.super_property_registered",
      `Super-properties updated. ${Object.keys(validation.properties).length} key(s) merged.`,
    );
    return result;
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    this.superProps.unregister(key);
  }

  /** Snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    return this.superProps.getSuperProperties();
  }

  /**
   * Associate the current SDK instance with a group (org, team,
   * account, plan). Mixpanel / Segment Group Analytics pattern.
   *
   *   server.group("org", "acme_inc");
   *   server.group("team", "design", { headcount: 12 });
   *
   * Once set, every subsequent event carries `$groups.<type>: id` on
   * its `properties` bag, enabling B2B dashboard pivots. Pass
   * `id: null` to clear a group membership.
   *
   * Group traits are sanitised through `validateEventProperties`.
   */
  group(type: string, id: string | null, traits?: Record<string, unknown>): void {
    if (!type) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_group_type",
        message: "group(type, id) requires a non-empty type.",
      });
    }
    const sanitisedTraits = traits ? validateEventProperties(traits).properties : undefined;
    this.superProps.setGroup(type, id, sanitisedTraits);
  }

  /** Snapshot of current group memberships keyed by type. */
  getGroups(): Record<string, GroupMembership> {
    return this.superProps.getGroups();
  }

  // ============================================================
  // Diagnostics — for debugging + the dashboard's heartbeat row
  // ============================================================

  diagnostics(): Diagnostics {
    return {
      sdkVersion: this.sdkVersion,
      baseUrl: this.baseUrl,
      secretKeyPrefix: this.secretKeyPrefix,
      env: this.env,
      runtime: {
        nodeVersion: this.runtime.nodeVersion,
        platform: this.runtime.platform,
        hostname: this.runtime.hostname,
        host: this.runtime.host,
        region: this.runtime.region,
        serviceName: this.runtime.serviceName,
        serviceVersion: this.runtime.serviceVersion,
        instanceId: this.runtime.instanceId,
      },
      entitlements: {
        count: this.entitlementCache.customerCount,
        lastUpdated: this.entitlementCache.lastUpdated,
        ttlMs: this.entitlementCache.ttl,
        listenerErrors: this.entitlementCache.listenerErrors,
        staleCustomers: this.entitlementCache.staleCustomerCount,
        isStale: this.entitlementCache.isAnyStale,
        lastRefreshFailedAt: this.entitlementCache.lastRefreshFailedAt,
        durableStore: this.entitlementStore !== null,
        // Cold-start durable iff a store is wired, OR the host is
        // long-lived (the process, hence the in-memory cache, survives).
        coldStartDurable:
          this.entitlementStore !== null || !this.runtime.isServerless,
      },
      events: this.eventQueue.getStats(),
      errors: {
        sessionCount: this.errorTracker?.reportedCount ?? 0,
        fingerprintsTracked: this.errorTracker?.fingerprintsTracked ?? 0,
        handlersInstalled: this.errorTracker?.handlersInstalled ?? false,
      },
    };
  }

  /**
   * Tear down handlers and clear in-memory state.
   *
   * **v1.4.0 bank-grade contract:** `shutdown()` AWAITS `flush()`
   * before dropping the queue, so callers don't silently lose
   * every queued event on a clean shutdown. The pre-v1.4.0
   * behaviour (sync `eventQueue.reset()` with no flush) was the
   * default for both `shutdown()` and `[Symbol.dispose]`; only
   * `await using` + `[Symbol.asyncDispose]` flushed correctly.
   *
   * Production servers should still prefer `await server.flush()`
   * (visible) followed by `server.shutdown()` so the flush
   * outcome is observable — `shutdown()`'s internal flush swallows
   * errors as a best-effort drain.
   *
   * Use [[shutdownSync]] only when the runtime cannot await
   * (e.g. inside `Symbol.dispose` — see below).
   */
  async shutdown(
    reason: "shutdown" | "dispose" | "asyncDispose" = "shutdown",
  ): Promise<void> {
    if (!this.didEmitShutdown) {
      this.emit("sdk.shutdown", { reason });
      this.didEmitShutdown = true;
    }
    try {
      await this.flush();
    } catch {
      // Best-effort drain — a failed flush during shutdown still
      // proceeds to teardown so the process can exit. The flush's
      // own observability (events.batch_failed) already surfaced
      // the error to whatever consumer cared.
    }
    this.shutdownSync(reason);
  }

  /**
   * Synchronous teardown — drops the in-memory queue WITHOUT
   * flushing, then clears all in-memory state. Used by
   * `[Symbol.dispose]` (which has no await) and tests that need
   * an unconditional sync wipe. Production code should use
   * [[shutdown]] (async) instead so queued events are flushed.
   *
   * A queue with items at sync-shutdown logs a warning recommending
   * `[Symbol.asyncDispose]` or `await server.shutdown()` — silent
   * loss is incompatible with the bank-grade contract.
   */
  shutdownSync(reason: "shutdown" | "dispose" | "asyncDispose" = "shutdown"): void {
    if (!this.didEmitShutdown) {
      this.emit("sdk.shutdown", { reason });
      this.didEmitShutdown = true;
    }
    const queuedCount = this.eventQueue.getStats().buffered;
    if (queuedCount > 0 && reason !== "asyncDispose") {
      // eslint-disable-next-line no-console
      console.warn(
        `[crossdeck] shutdownSync() dropped ${queuedCount} queued event(s) without flushing. ` +
          `Use \`await server.shutdown()\` or \`await using server = ...\` ` +
          `with \`[Symbol.asyncDispose]\` to drain the buffer before teardown.`,
      );
    }
    this.errorTracker?.uninstall();
    this.flushOnExit?.uninstall();
    this.eventQueue.reset();
    this.breadcrumbs.clear();
    this.superProps.clear();
    this.entitlementCache.clear();
    this.customerIdAliases.clear();
    this.errorContext = {};
    this.errorTags = {};
    this.errorBeforeSend = null;
    // Drop all event listeners last — caller's `sdk.shutdown` listeners
    // had a chance to run above.
    this.removeAllListeners();
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Convert a `CapturedError` into a `ServerEvent` and push through
   * `track()`. Goes through the same queue / enrichment / breadcrumb
   * pipeline analytics events do.
   */
  // ============================================================
  // Typed EventEmitter overloads — narrowing for the common methods
  // ============================================================

  override on<K extends keyof CrossdeckServerEvents>(
    event: K,
    listener: (...args: CrossdeckServerEvents[K]) => void,
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends keyof CrossdeckServerEvents>(
    event: K,
    listener: (...args: CrossdeckServerEvents[K]) => void,
  ): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off<K extends keyof CrossdeckServerEvents>(
    event: K,
    listener: (...args: CrossdeckServerEvents[K]) => void,
  ): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof CrossdeckServerEvents>(
    event: K,
    ...args: CrossdeckServerEvents[K]
  ): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  // ============================================================
  // Health + readiness + lifecycle
  // ============================================================

  /**
   * Synchronous readiness check — "is the SDK in a state where it
   * should accept new traffic?". Used by Kubernetes readiness probes
   * and backpressure-aware callers.
   *
   * Returns `false` if:
   *   - The event queue is in a sustained retry storm
   *     (`consecutiveFailures >= 5`).
   *   - The event queue's buffered count is at >= 80% of HARD_BUFFER_CAP.
   *
   * Otherwise `true`. The default isn't "perfectly healthy" — the
   * SDK is happy to enqueue events even during transient flush
   * failures because the queue's retry path handles them. Only
   * sustained failure flips this to `false`.
   */
  isReady(): boolean {
    const stats = this.eventQueue.getStats();
    if (stats.consecutiveFailures >= 5) return false;
    if (stats.buffered >= 800) return false; // 80% of HARD_BUFFER_CAP
    return true;
  }

  /**
   * Async wait until `isReady()` returns true OR the timeout elapses.
   * Resolves `true` on ready, `false` on timeout. Polls every 50ms by
   * default — backpressure for callers writing high-volume servers.
   *
   *   if (!(await server.awaitReady(2000))) {
   *     // shed load — SDK is in a retry storm, don't queue more
   *   }
   */
  async awaitReady(timeoutMs = 5000, pollIntervalMs = 50): Promise<boolean> {
    if (this.isReady()) return true;
    const start = Date.now();
    return new Promise<boolean>((resolve) => {
      const tick = (): void => {
        if (this.isReady()) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        const t = setTimeout(tick, pollIntervalMs);
        if (typeof t.unref === "function") {
          try {
            t.unref();
          } catch {
            // ignore
          }
        }
      };
      tick();
    });
  }

  /**
   * Snapshot for Kubernetes liveness + readiness probes. `healthy`
   * stays true unless the SDK is in a catastrophic state (which
   * currently can't happen without crashing the process). `ready`
   * matches `isReady()`.
   *
   *   app.get("/healthz", (_req, res) => {
   *     const h = server.getHealth();
   *     res.status(h.healthy ? 200 : 503).json(h);
   *   });
   */
  getHealth(): {
    ready: boolean;
    healthy: boolean;
    bufferedEvents: number;
    inFlight: number;
    consecutiveFailures: number;
    lastFlushAt: number;
    lastError: string | null;
    errorHandlersInstalled: boolean;
  } {
    const stats = this.eventQueue.getStats();
    return {
      ready: this.isReady(),
      healthy: true,
      bufferedEvents: stats.buffered,
      inFlight: stats.inFlight,
      consecutiveFailures: stats.consecutiveFailures,
      lastFlushAt: stats.lastFlushAt,
      lastError: stats.lastError,
      errorHandlersInstalled: this.errorTracker?.handlersInstalled ?? false,
    };
  }

  /**
   * Sync disposal hook — runs when a `using` declaration exits scope
   * (TC39 explicit-resource-management, Node 20+ / TS 5.2+).
   *
   *   using server = new CrossdeckServer({ ... });
   *   // ... use server ...
   *   // at end of block, server[Symbol.dispose]() runs automatically
   *
   * **`Symbol.dispose` is synchronous so it CANNOT await the queue
   * flush.** A queue with pending events at sync-dispose time will
   * be DROPPED — `shutdownSync` warns to the console when this
   * happens. For the common case of "drain the queue before
   * exit", switch to `await using` + `[Symbol.asyncDispose]` (or
   * call `await server.shutdown()` explicitly before the variable
   * goes out of scope).
   */
  [Symbol.dispose](): void {
    this.shutdownSync("dispose");
  }

  /**
   * Async disposal hook — runs when an `await using` declaration
   * exits scope. Awaits the bank-grade `shutdown()` which flushes
   * the queue THEN tears down. Use this variant for any code path
   * that owns queued events at exit (serverless handlers,
   * background workers, end-of-request hooks).
   *
   *   await using server = new CrossdeckServer({ ... });
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown("asyncDispose");
  }

  // ============================================================

  private reportCapturedError(captured: CapturedError): void {
    try {
      this.emit("error.captured", {
        fingerprint: captured.fingerprint,
        kind: captured.kind,
        message: captured.message,
      });
    } catch {
      // listener errors don't break the report
    }
    const properties: EventProperties = {
      fingerprint: captured.fingerprint,
      level: captured.level,
      errorType: captured.errorType,
      message: captured.message,
      stack: captured.rawStack ?? undefined,
      frames: captured.frames,
      tags: captured.tags,
      context: captured.context,
      breadcrumbs: captured.breadcrumbs,
      http: captured.http,
    };
    for (const k of Object.keys(properties)) {
      if (properties[k] === undefined) delete properties[k];
    }
    this.track({
      name: captured.kind,
      timestamp: captured.timestamp,
      properties,
      level: captured.level,
      tags: captured.tags,
    });
  }

  /**
   * Populate the entitlement cache from a fresh server response.
   * Records aliases so `userId` / `anonymousId` hints supplied to
   * `getEntitlements()` resolve to the same cache entry on subsequent
   * `isEntitled({ userId }, ...)` calls.
   *
   * Bounds the alias map at MAX_CUSTOMER_ID_ALIASES — once full, the
   * oldest aliases (by insertion order) are evicted FIFO. Symmetric
   * with the entitlement cache's max-customers cap.
   */
  private populateEntitlementCache(
    hints: IdentityHints,
    response: EntitlementsListResponse,
  ): void {
    const customerId = response.crossdeckCustomerId;
    if (!customerId) return;
    this.entitlementCache.setForCustomer(customerId, response.data);
    if (hints.userId) this.touchAlias(hints.userId, customerId);
    if (hints.anonymousId) this.touchAlias(hints.anonymousId, customerId);
    this.debug.emit(
      "sdk.entitlement_cache_warm",
      `Entitlement cache warmed for ${customerId} (${response.data.length} entitlement(s)).`,
    );
    try {
      this.emit("entitlements.warmed", {
        customerId,
        count: response.data.length,
      });
    } catch {
      // listener errors don't break the response path
    }
  }

  /**
   * Persist a successful entitlements fetch to the durable store, if
   * one is configured. No-op when there is no store.
   *
   * Saved under EVERY identity the caller might later look up by — the
   * canonical `crossdeckCustomerId` plus any `userId` / `anonymousId`
   * hint. The Node cache resolves a hint to a canonical ID via an
   * in-memory alias map; on a cold start that map is empty, so a
   * failure-path `load()` must be able to hit the store with the raw
   * hint the caller passed. Saving under all keys makes that work.
   *
   * Best-effort: a store `save()` that throws is swallowed (logged in
   * debug) — it weakens durability for that customer but must never
   * fail an otherwise-successful `getEntitlements()`.
   */
  private async saveEntitlementsToStore(
    hints: IdentityHints,
    response: EntitlementsListResponse,
  ): Promise<void> {
    if (!this.entitlementStore) return;
    const customerId = response.crossdeckCustomerId;
    if (!customerId) return;
    const snapshot: StoredEntitlements = {
      v: 1,
      crossdeckCustomerId: customerId,
      entitlements: response.data,
      env: response.env,
      savedAt: Date.now(),
    };
    // Distinct keys only — dedupe so we don't write the same blob twice
    // when e.g. the caller passed customerId === crossdeckCustomerId.
    const keys = new Set<string>([customerId]);
    if (hints.customerId) keys.add(hints.customerId);
    if (hints.userId) keys.add(hints.userId);
    if (hints.anonymousId) keys.add(hints.anonymousId);
    for (const key of keys) {
      try {
        await this.entitlementStore.save(key, snapshot);
      } catch (err) {
        this.debug.emit(
          "sdk.entitlement_store_recovered",
          `entitlementStore.save failed for key ${key} — durability weakened for this customer.`,
          { key, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  /**
   * Load last-known-good entitlements from the durable store on a
   * network-failure path. Returns the first snapshot found across the
   * caller's identity keys, or `null` if there is no store / no stored
   * snapshot / every read failed.
   *
   * Tries the canonical `customerId` hint first, then `userId`, then
   * `anonymousId` — the order callers most commonly key by. A corrupt
   * or wrong-shaped blob is treated as a miss (the store is developer-
   * supplied; the SDK validates rather than trusts).
   */
  private async loadEntitlementsFromStore(
    hints: IdentityHints,
  ): Promise<StoredEntitlements | null> {
    if (!this.entitlementStore) return null;
    const keys: string[] = [];
    if (hints.customerId) keys.push(hints.customerId);
    if (hints.userId) keys.push(hints.userId);
    if (hints.anonymousId) keys.push(hints.anonymousId);
    for (const key of keys) {
      let loaded: StoredEntitlements | null = null;
      try {
        loaded = await this.entitlementStore.load(key);
      } catch {
        // A throwing load() degrades to "no durable copy for this key".
        continue;
      }
      if (isValidStoredEntitlements(loaded)) return loaded;
    }
    return null;
  }

  /**
   * Resolve the customer ID to stamp a failed-refresh marker against.
   *
   * Prefers a canonical ID the cache already knows (so the marker lands
   * on the existing warm entry), then falls back to whatever raw hint
   * the caller supplied — on a true cold-start failure there is no
   * cache entry yet, and marking under the hint still makes "we tried
   * for this customer and Crossdeck was down" observable.
   */
  private resolveFailedRefreshCustomerId(hints: IdentityHints): string | null {
    const known = this.resolveCacheCustomerId(hints);
    if (known) return known;
    return hints.customerId ?? hints.userId ?? hints.anonymousId ?? null;
  }

  private touchAlias(alias: string, customerId: string): void {
    // Delete-and-reinsert so the alias moves to the end of insertion
    // order (LRU "touch").
    this.customerIdAliases.delete(alias);
    this.customerIdAliases.set(alias, customerId);
    while (this.customerIdAliases.size > MAX_CUSTOMER_ID_ALIASES) {
      const oldest = this.customerIdAliases.keys().next().value;
      if (oldest === undefined) break;
      this.customerIdAliases.delete(oldest);
    }
  }

  /**
   * Resolve any hint shape (canonical customerId / userId hint /
   * anonymousId hint / raw string) to a `crossdeckCustomerId` if we
   * have a cache entry for it.
   *
   * String overload is STRICT on the canonical-id shape. Pre-fix
   * `isFresh(raw)` treated any string with a cache entry as a valid
   * canonical id — if tenant A's userId happened to collide with
   * tenant B's crossdeckCustomerId, A's call would resolve to B's
   * cached entitlements. Bounded by the `cdcust_` prefix convention
   * (which both SDKs and the backend mint, see
   * backend/src/lib/customers.ts) — anything else is treated purely
   * as an alias lookup, never as a canonical id. Audit P1 #19.
   */
  private resolveCacheCustomerId(hint: IdentityHints | string): string | null {
    if (typeof hint === "string") {
      // Canonical-shape check FIRST: only `cdcust_…`-prefixed strings
      // are eligible to be returned as-is. Non-prefixed strings drop
      // straight to the alias map — no cross-tenant primitive even if
      // a stray cache entry exists for the same string under a
      // different prefix family.
      if (hint.startsWith("cdcust_") && this.entitlementCache.isFresh(hint)) {
        return hint;
      }
      return this.customerIdAliases.get(hint) ?? null;
    }
    if (hint.customerId) return hint.customerId;
    if (hint.userId) return this.customerIdAliases.get(hint.userId) ?? null;
    if (hint.anonymousId) return this.customerIdAliases.get(hint.anonymousId) ?? null;
    return null;
  }

  private identityPayload(hints: IdentityHints): Record<string, string> {
    const payload: Record<string, string> = {};
    if (typeof hints.customerId === "string" && hints.customerId) {
      payload.customerId = hints.customerId;
    }
    if (typeof hints.userId === "string" && hints.userId) {
      payload.userId = hints.userId;
    }
    if (typeof hints.anonymousId === "string" && hints.anonymousId) {
      payload.anonymousId = hints.anonymousId;
    }
    if (Object.keys(payload).length === 0) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_identity",
        message: "Provide at least one of customerId, userId, or anonymousId.",
      });
    }
    return payload;
  }

  /**
   * Resolve event identity. Caller-supplied wins; falls back to
   * `processAnonymousId` so events from `captureError` /
   * uncaughtException always have at least one identity hint.
   */
  private resolveIdentity(event: ServerEvent): {
    developerUserId?: string;
    anonymousId?: string;
    crossdeckCustomerId?: string;
  } {
    const out: { developerUserId?: string; anonymousId?: string; crossdeckCustomerId?: string } = {};
    if (event.developerUserId) out.developerUserId = event.developerUserId;
    if (event.anonymousId) out.anonymousId = event.anonymousId;
    if (event.crossdeckCustomerId) out.crossdeckCustomerId = event.crossdeckCustomerId;
    if (!out.developerUserId && !out.anonymousId && !out.crossdeckCustomerId) {
      out.anonymousId = this.processAnonymousId;
    }
    return out;
  }

  /**
   * Strict normalisation for `ingest()` — no auto-fill of identity,
   * caller must supply at least one hint per event. Matches v0.1.0
   * behaviour for backward compatibility with bulk-import callers.
   */
  private normalizeIngestEvent(event: ServerEvent): ServerEvent {
    if (!event.name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "Each event requires a non-empty name.",
      });
    }
    const hasIdentity =
      Boolean(event.developerUserId) ||
      Boolean(event.anonymousId) ||
      Boolean(event.crossdeckCustomerId);
    if (!hasIdentity) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_identity",
        message:
          "Each event requires at least one of developerUserId, anonymousId, or crossdeckCustomerId.",
      });
    }
    const properties = sanitizePropertyBag(event.properties, "event properties");
    return {
      ...event,
      properties,
      eventId: event.eventId ?? mintId("evt", 8),
      timestamp: event.timestamp ?? Date.now(),
    };
  }
}

function sanitizePropertyBag(
  input: Record<string, unknown> | undefined,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  try {
    return validateEventProperties(input).properties;
  } catch {
    throw new CrossdeckError({
      type: "invalid_request_error",
      code: "serialization_failed",
      message: `${fieldName} could not be serialized.`,
    });
  }
}

/**
 * Validate a value read back from a developer-supplied
 * `EntitlementStore`. The store is external (Redis / a DB / a KV) and
 * may return a corrupt, partial, stale-schema or attacker-influenced
 * blob — the SDK validates the shape rather than trusting it. Anything
 * that fails is treated as a cache miss (the SDK then rethrows the
 * original network error), never a crash.
 *
 * Narrows to `StoredEntitlements`: a versioned blob with a non-empty
 * `crossdeckCustomerId`, an `entitlements` array, and a known `env`.
 * Individual entitlement objects are not deep-validated here — the
 * cache + `isEntitled()` already tolerate odd entries (a missing `key`
 * simply never matches), and `validUntil` is honoured at read time.
 */
function isValidStoredEntitlements(value: unknown): value is StoredEntitlements {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.crossdeckCustomerId === "string" &&
    v.crossdeckCustomerId.length > 0 &&
    Array.isArray(v.entitlements) &&
    (v.env === "production" || v.env === "sandbox") &&
    typeof v.savedAt === "number"
  );
}

/**
 * Map an event name to a breadcrumb category. Mirrors the web SDK's
 * mapping so breadcrumb timelines in error reports look the same
 * regardless of which SDK emitted them.
 */
function categoryFor(name: string): BreadcrumbCategory {
  if (name.startsWith("page.") || name.startsWith("navigation.")) return "navigation";
  if (name.startsWith("element.") || name.startsWith("ui.click")) return "ui.click";
  if (name.startsWith("http.") || name === "request.handled") return "http";
  return "custom";
}

/**
 * Maximum number of `userId` / `anonymousId` → `crossdeckCustomerId`
 * aliases we track. Matches the entitlement cache's default
 * max-customers for symmetry.
 */
const MAX_CUSTOMER_ID_ALIASES = 10_000;

/**
 * Infer environment from the secret-key prefix. Stripe pattern —
 * `cd_sk_live_*` means production, anything else is treated as sandbox
 * (fixture / test keys typically use `cd_sk_test_*` but bare
 * `cd_sk_*` from test fixtures also falls here).
 */
function inferEnvFromKey(secretKey: string): Environment {
  return secretKey.startsWith("cd_sk_live_") ? "production" : "sandbox";
}

/**
 * Bounded-concurrency promise-settle helper for bulk operations.
 * Returns one entry per input, in input order. Each entry is either
 * `{ ok: true, value }` or `{ ok: false, error }`. Never rejects —
 * partial failures don't drop the rest of the batch.
 */
async function runBulkOperation<TInput, TResult>(
  inputs: TInput[],
  maxConcurrency: number,
  op: (input: TInput) => Promise<TResult>,
): Promise<Array<{ input: TInput; ok: true; value: TResult } | { input: TInput; ok: false; error: CrossdeckError }>> {
  const results: Array<
    | { input: TInput; ok: true; value: TResult }
    | { input: TInput; ok: false; error: CrossdeckError }
  > = new Array(inputs.length);
  let cursor = 0;
  const workers = new Array(Math.min(maxConcurrency, Math.max(1, inputs.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= inputs.length) return;
        const input = inputs[index]!;
        try {
          const value = await op(input);
          results[index] = { input, ok: true, value };
        } catch (err) {
          results[index] = {
            input,
            ok: false,
            error:
              err instanceof CrossdeckError
                ? err
                : new CrossdeckError({
                    type: "internal_error",
                    code: "bulk_operation_failed",
                    message: err instanceof Error ? err.message : String(err),
                  }),
          };
        }
      }
    });
  await Promise.all(workers);
  return results;
}

/**
 * Mask the secret key for safe display in diagnostics + logs. Stripe
 * pattern: keep the env-revealing prefix (`cd_sk_test_` / `cd_sk_live_`),
 * replace the middle with `****`, append the last 4 chars when the key
 * is long enough that those 4 chars don't overlap the prefix. Test
 * fixtures with short keys degrade gracefully to `prefix + ****` with
 * no tail.
 */
function maskSecretKey(secretKey: string): string {
  const m = secretKey.match(/^cd_sk_(test|live)_/);
  const prefix = m ? m[0] : secretKey.slice(0, 11);
  const tail = secretKey.length > prefix.length + 4 ? secretKey.slice(-4) : "";
  return `${prefix}****${tail}`;
}
