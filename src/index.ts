/**
 * @cross-deck/node — public entry point.
 *
 * Three USPs land on the server in v1.0.0:
 *
 *   1. Errors — `captureError` / `captureMessage` / `setTag` /
 *      `setContext` / `addBreadcrumb` / `setErrorBeforeSend` +
 *      auto-wired `uncaughtException` + `unhandledRejection` +
 *      `globalThis.fetch` wrap for 5xx + network failures.
 *
 *   2. Analytics — `track()` / `ingest()` / `flush()`, durable queue
 *      with retry + `Idempotency-Key`, flush-on-exit drain.
 *      Super-properties (`register` / `unregister`) and group
 *      analytics (`group`) for Mixpanel-style enrichment. Framework
 *      adapters (Express / Lambda / Firebase) via the
 *      `@cross-deck/node/auto-events` subpath.
 *
 *   3. Entitlements — `getEntitlements()` / `getCustomerEntitlements()`
 *      with a per-customer TTL cache so `isEntitled()` is a memory
 *      read after first warm. Webhook signature verification via
 *      `verifyWebhookSignature()`.
 *
 * Cross-cutting: runtime enrichment (Node version, OS, region,
 * function name, instance ID) auto-attached to every event + error.
 * Lifecycle: `flush-on-exit` drains the queue on `beforeExit` +
 * SIGTERM + SIGINT so Cloud Functions cold-fires don't lose events.
 */

export { CrossdeckServer } from "./crossdeck-server";
export {
  CrossdeckError,
  CrossdeckAuthenticationError,
  CrossdeckPermissionError,
  CrossdeckValidationError,
  CrossdeckRateLimitError,
  CrossdeckNetworkError,
  CrossdeckInternalError,
  CrossdeckConfigurationError,
  makeCrossdeckError,
} from "./errors";
export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  SDK_NAME,
  SDK_VERSION,
  CROSSDECK_API_VERSION,
} from "./http";
export { CROSSDECK_ERROR_CODES, getErrorCode, isCrossdeckErrorCode } from "./error-codes";
export { verifyWebhookSignature, signWebhookPayload } from "./webhooks";
export { scrubPii, scrubPiiFromProperties } from "./consent";
export { CrossdeckContracts } from "./contracts";
export type {
  Contract,
  ContractPillar,
  ContractStatus,
  ContractAppliesTo,
  ContractTestRef,
  ContractFailureInput,
} from "./contracts";

export type {
  AliasIdentityInput,
  AliasResult,
  AuditDecision,
  AuditEntry,
  BlockVerdict,
  CampaignLinkInput,
  CampaignLinkResult,
  CrossdeckServerOptions,
  Diagnostics,
  EntitlementMutationResult,
  EntitlementsListResponse,
  EntitlementStore,
  Environment,
  EventProperties,
  ForgetResult,
  GrantDuration,
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
  ErrorLevel,
} from "./types";
export type { HttpRequestInfo, HttpResponseInfo, HttpRetriesConfig } from "./http";
export type { CrossdeckErrorPayload, CrossdeckErrorType } from "./errors";
export type { ErrorCodeEntry, CrossdeckErrorCode } from "./error-codes";
export type { Breadcrumb, BreadcrumbCategory, BreadcrumbLevel } from "./breadcrumbs";
export type { CapturedError, ErrorCaptureConfig } from "./error-capture";
export type { StackFrame } from "./stack-parser";
export type { RuntimeHost, RuntimeInfo } from "./runtime-info";
export type { GroupMembership } from "./super-properties";
export type { EntitlementsListener, EntitlementCacheOptions } from "./entitlement-cache";
export type { DebugSignal, DebugLogger, DebugContext } from "./debug";
export type { VerifyWebhookOptions } from "./webhooks";
