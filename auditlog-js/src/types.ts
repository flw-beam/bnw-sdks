// Public wire-shaped input types. Field names are snake_case and mirror
// audit-service-api's OneShotEventRequest (internal/http/schemas/events.go)
// exactly, minus the server-owned fields a producer can never set
// (tenant_id, producer_id, environment, accepted_at) — there is no
// camelCase mapping layer to keep in sync with the wire contract.

/** Closed actor-kind enum, mirrored from domain.ActorType. */
export type AuditActorType = "ADMIN" | "SERVICE" | "SYSTEM" | "USER";

/** Closed one-shot result enum, mirrored from domain.AuditResult. */
export type AuditResult = "SUCCESS" | "FAILURE" | "DENIED";

/** Closed data-classification enum, mirrored from domain.DataClassification. */
export type AuditDataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export interface AuditActorInput {
    type: AuditActorType;
    /** Opaque, stable principal ID in the tenant's identity domain. Never an email address. */
    id: string;
}

export interface AuditResourceInput {
    type: string;
    id: string;
    /** Small immutable audit-snapshot facts, not a live resource representation. */
    attributes?: Record<string, unknown>;
}

export interface AuditContextInput {
    request_id?: string;
    correlation_id?: string;
    job_id?: string;
    trace_id?: string;
    span_id?: string;
    /** A distinct earlier audit event that directly caused this event. Must be a valid ULID if set. */
    causation_event_id?: string;
}

export interface AuditOutcomeInput {
    reason_code?: string;
    reason_safe?: string;
    http_status_code?: number;
}

export interface AuditPolicyHintsInput {
    regulatory_tags?: string[];
    data_classification?: AuditDataClassification;
}

/**
 * The producer-authored one-shot event. `record_id`/`event_id` are
 * normally omitted so the SDK generates and reuses stable ULIDs; supply
 * them only when re-preparing an event you already generated IDs for
 * (e.g. deserializing a previously prepared event from an outbox row).
 */
export interface AuditEventInput {
    record_id?: string;
    event_id?: string;
    /** When the action occurred, in UTC. Accepts an ISO 8601 string or a Date. */
    occurred_at: string | Date;
    /** Lowercase dotted semantic name, e.g. "order.created". Registration in the event-type registry is optional enrichment, not a precondition for ingestion. */
    event_type: string;
    /** Uppercase reporting/policy family, e.g. "ORDER". */
    category: string;
    /** Uppercase verb attempted, e.g. "CREATE". */
    action: string;
    result: AuditResult;
    actor: AuditActorInput;
    resource: AuditResourceInput;
    context?: AuditContextInput;
    outcome?: AuditOutcomeInput;
    policy_hints?: AuditPolicyHintsInput;
    /** Event-type-specific details. At most 20 keys, 8KB canonical bytes, depth 3. */
    metadata?: Record<string, unknown>;
}

/**
 * The immutable, already-canonicalized outcome of `createEvent`. `payload`
 * is the exact canonical JSON string sent as the request body — every
 * retry of the same logical call reuses these exact bytes.
 */
export interface PreparedAuditEvent {
    readonly recordId: string;
    readonly eventId: string;
    readonly occurredAt: string;
    readonly payload: string;
}

/** One resolved delivery outcome. ACCEPTED and DUPLICATE are both success. */
export interface RecordReceipt {
    recordId: string;
    eventId: string;
    status: "ACCEPTED" | "DUPLICATE";
    acceptedAt: string;
    requestId: string;
}

export interface RequestOptions {
    signal?: AbortSignal;
    requestId?: string;
    timeoutMs?: number;
}

/**
 * The immutable, network-ready outcome of `createBatch`: up to
 * `MAX_BATCH_RECORDS` prepared items, in original order, plus the exact
 * canonical JSON envelope body (`{"records":[...]}`). `payload` is built
 * by concatenating each item's own canonical bytes verbatim, never
 * reserializing an item — the server hashes each item independently
 * from its own bytes, so this is byte-for-byte what a one-shot `record`
 * call of that same item would have sent.
 */
export interface PreparedAuditBatch {
    readonly items: readonly PreparedAuditEvent[];
    readonly payload: string;
}

/** One item's safe, stable rejection reason, mirroring audit-service-api's schemas.BatchItemError. */
export interface BatchItemError {
    code: string;
    message: string;
    retryable: boolean;
}

/**
 * One input record's independent resolved outcome. `index` is relative
 * to the original input array passed to `sendBatch`/`createBatch`, not
 * to whichever chunk the item landed in.
 */
export interface BatchItemResult {
    index: number;
    recordId?: string;
    eventId?: string;
    status: "ACCEPTED" | "DUPLICATE" | "REJECTED";
    acceptedAt?: string;
    error?: BatchItemError;
}

/** Aggregates every chunk's item results, in original input order. */
export interface BatchResult {
    acceptedCount: number;
    duplicateCount: number;
    rejectedCount: number;
    results: BatchItemResult[];
}

/**
 * Per-call knobs `sendBatch`/`sendPreparedBatch` accept. `requestId`, if
 * set, is only honored when the call resolves to exactly one underlying
 * HTTP request (a single chunk) — a multi-chunk call needs one distinct
 * request ID per request, so this SDK generates one per chunk in that
 * case instead of silently reusing a caller-supplied value across
 * unrelated requests.
 */
export type BatchOptions = RequestOptions;

export interface RetryConfig {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
}

/** A transport-neutral response, decoupled from any specific HTTP client. */
export interface AuditTransportResponse {
    status: number;
    headers: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
}

/**
 * The one seam between the SDK and the network. The default
 * implementation (src/transport.ts) wraps global `fetch`; tests and
 * embedders may inject their own for deterministic, offline behavior.
 */
export interface AuditTransport {
    send(url: string, init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal: AbortSignal;
    }): Promise<AuditTransportResponse>;
}

// ---------------------------------------------------------------------------
// Audit Transaction lifecycle types (AS-0504)
// ---------------------------------------------------------------------------

/**
 * The closed set of states a `Transaction` helper moves through:
 * `NEW -> START_IN_FLIGHT -> STARTED`, then `STARTED -> COMPLETE_IN_FLIGHT
 * -> COMPLETED` or `STARTED -> ABORT_IN_FLIGHT -> ABORTED`. Never persisted
 * or resumed across a process restart.
 */
export type TransactionState =
    | "NEW"
    | "START_IN_FLIGHT"
    | "STARTED"
    | "COMPLETE_IN_FLIGHT"
    | "ABORT_IN_FLIGHT"
    | "COMPLETED"
    | "ABORTED";

/**
 * The producer-authored payload opening one Audit Transaction.
 * `record_id`/`event_id`/`audit_transaction_id` are normally omitted so
 * the SDK generates and reuses stable ULIDs. There is no field for
 * tenant_id/producer_id/environment/result — a caller cannot even
 * attempt to set a server-owned field, because this type has no such
 * field to set.
 */
export interface AuditTransactionStartInput {
    record_id?: string;
    event_id?: string;
    audit_transaction_id?: string;
    occurred_at: string | Date;
    event_type: string;
    category: string;
    action: string;
    actor: AuditActorInput;
    resource: AuditResourceInput;
    context?: AuditContextInput;
    policy_hints?: AuditPolicyHintsInput;
    metadata?: Record<string, unknown>;
}

/** The resolved outcome of a start call. `status` may be ACCEPTED or DUPLICATE — both are success. */
export interface TransactionStartReceipt {
    auditTransactionId: string;
    eventId: string;
    recordId: string;
    lifecycleState: string;
    lifecyclePosition: number;
    status: "ACCEPTED" | "DUPLICATE";
    acceptedAt: string;
    requestId: string;
}

/**
 * The producer-authored delta completing a previously started Audit
 * Transaction. `record_id` is normally omitted so `complete` generates
 * and reuses a stable ULID. There is no field for event ID, actor,
 * resource, event type, category, action, result, producer, environment,
 * or tenant — the API/processor inherits immutable start identity, and a
 * completed result is always server-set to SUCCESS.
 */
export interface AuditTransactionCompleteInput {
    record_id?: string;
    occurred_at: string | Date;
    outcome?: AuditOutcomeInput;
    metadata?: Record<string, unknown>;
}

/**
 * The producer-authored delta aborting a previously started Audit
 * Transaction. `result` defaults to `"FAILURE"` when omitted; it must be
 * `"FAILURE"` or `"DENIED"`.
 */
export interface AuditTransactionAbortInput {
    record_id?: string;
    occurred_at: string | Date;
    result?: "FAILURE" | "DENIED";
    outcome?: AuditOutcomeInput;
    metadata?: Record<string, unknown>;
}

/** The resolved outcome of a complete/abort call. `status` may be ACCEPTED or DUPLICATE — both are success. */
export interface TransactionTerminalReceipt {
    auditTransactionId: string;
    eventId: string;
    recordId: string;
    referencesRecordId: string;
    lifecycleState: string;
    lifecyclePosition: number;
    result: string;
    status: "ACCEPTED" | "DUPLICATE";
    acceptedAt: string;
    requestId: string;
}

export interface AuditClientConfig {
    /** A static key, or an (async) provider so a caller can rotate credentials without a process restart. */
    apiKey: string | (() => string | Promise<string>);
    /** e.g. "https://audit.example.com". Must be HTTPS outside of an explicit local-development opt-out. */
    baseUrl: string;
    timeoutMs?: number;
    retry?: RetryConfig;
    transport?: AuditTransport;
    /** Injectable clock, primarily for deterministic tests. Defaults to `() => new Date()`. */
    now?: () => Date;
    /** Injectable RNG in [0, 1), primarily for deterministic ULID/jitter tests. Defaults to `Math.random`. */
    random?: () => number;
    /** Injectable delay function, primarily for deterministic retry-backoff tests. Defaults to a real `setTimeout`-based sleep. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /**
     * Allows a non-HTTPS baseUrl (e.g. http://localhost:4000 in local
     * development). Never set this against a real deployment.
     */
    allowInsecureHttp?: boolean;
}
