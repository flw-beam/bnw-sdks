// AuditError never carries the API key or the event payload — only safe
// identifiers and a classification. Every catch path in this SDK must
// normalize through AuditError.from rather than let a raw fetch/parse
// error escape to the caller.

/** Stable server-issued error codes this SDK recognizes (httperr.HTTPErrorKind in audit-service-api). */
export type ServerErrorCode =
    | "BAD_REQUEST_ERROR"
    | "UNAUTHORIZED_ERROR"
    | "FORBIDDEN_ERROR"
    | "INSUFFICIENT_PERMISSION"
    | "INVALID_JSON"
    | "INVALID_SCHEMA"
    | "INVALID_LIFECYCLE"
    | "TRANSACTION_ALREADY_TERMINAL"
    | "IDEMPOTENCY_CONFLICT"
    | "PAYLOAD_TOO_LARGE"
    | "RATE_LIMIT_ERROR"
    | "INGESTION_UNAVAILABLE"
    | "SERVICE_UNAVAILABLE_ERROR"
    | "INTERNAL_SERVER_ERROR"
    | "UNHANDLED_SERVER_ERROR";

/** Local classifications for failures that never reached a server response. */
export type LocalErrorCode =
    | "CONFIG_ERROR"
    | "VALIDATION_ERROR"
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "ABORTED"
    | "MALFORMED_RESPONSE"
    | "UNKNOWN_ERROR";

export type AuditErrorCode = ServerErrorCode | LocalErrorCode;

// Server error codes that are never retried, even though their HTTP
// status might otherwise suggest a transient condition. Kept as an
// explicit table (not "everything except 429/5xx") so a change to the
// server's catalogue is a deliberate edit here, not a status-code guess.
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 409, 413]);

export interface AuditErrorInit {
    message: string;
    code: AuditErrorCode;
    httpStatus?: number;
    requestId?: string;
    recordId?: string;
    eventId?: string;
    retryable: boolean;
    retryAfterMs?: number;
    cause?: unknown;
}

export class AuditError extends Error {
    override readonly name = "AuditError";
    readonly code: AuditErrorCode;
    readonly httpStatus?: number;
    readonly requestId?: string;
    readonly recordId?: string;
    readonly eventId?: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;

    constructor(init: AuditErrorInit) {
        super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
        this.code = init.code;
        this.httpStatus = init.httpStatus;
        this.requestId = init.requestId;
        this.recordId = init.recordId;
        this.eventId = init.eventId;
        this.retryable = init.retryable;
        this.retryAfterMs = init.retryAfterMs;
        Object.setPrototypeOf(this, AuditError.prototype);
    }

    /**
     * Never includes the API key or the request payload in the returned
     * error's own fields — callers that log/inspect this object only ever
     * see identifiers and a classification, matching the constructor's
     * own promise for AuditClientConfig.apiKey.
     */
    static fromServerResponse(args: {
        httpStatus: number;
        errorCode?: string;
        message?: string;
        requestId?: string;
        recordId?: string;
        eventId?: string;
        retryAfterMs?: number;
        // The server's own `retryable` field from the error response body,
        // when present. undefined means the field was absent or not a
        // boolean (an older server or a malformed body); the status-derived
        // fallback below is used only in that case, so the server's own
        // answer always wins once it is present.
        retryable?: boolean;
    }): AuditError {
        const retryable = args.retryable ?? (!NON_RETRYABLE_STATUSES.has(args.httpStatus) && (args.httpStatus === 429 || args.httpStatus >= 500));
        const code = (args.errorCode as ServerErrorCode | undefined) ?? "UNHANDLED_SERVER_ERROR";
        return new AuditError({
            message: args.message ?? `audit-api responded with ${args.httpStatus}`,
            code,
            httpStatus: args.httpStatus,
            requestId: args.requestId,
            recordId: args.recordId,
            eventId: args.eventId,
            retryable,
            retryAfterMs: args.retryAfterMs,
        });
    }

    static malformedResponse(args: { httpStatus: number; requestId?: string; recordId?: string; eventId?: string; cause: unknown }): AuditError {
        return new AuditError({
            message: "audit-api response could not be parsed",
            code: "MALFORMED_RESPONSE",
            httpStatus: args.httpStatus,
            requestId: args.requestId,
            recordId: args.recordId,
            eventId: args.eventId,
            // A malformed body on an otherwise 2xx-looking response is
            // ambiguous, not a known permanent rejection — safe to retry
            // because retries reuse the same record_id idempotently.
            retryable: args.httpStatus >= 200 && args.httpStatus < 300,
            cause: args.cause,
        });
    }

    /** Classifies a network-level failure (fetch rejection, abort, timeout) that never produced an HTTP response. */
    static fromNetworkFailure(args: { error: unknown; timedOut: boolean; aborted: boolean; recordId?: string; eventId?: string; requestId?: string }): AuditError {
        if (args.aborted) {
            return new AuditError({
                message: "the request was aborted",
                code: "ABORTED",
                requestId: args.requestId,
                recordId: args.recordId,
                eventId: args.eventId,
                retryable: false,
                cause: args.error,
            });
        }
        if (args.timedOut) {
            return new AuditError({
                message: "the request timed out",
                code: "TIMEOUT",
                requestId: args.requestId,
                recordId: args.recordId,
                eventId: args.eventId,
                retryable: true,
                cause: args.error,
            });
        }
        return new AuditError({
            message: errorMessage(args.error) ?? "a network error occurred",
            code: "NETWORK_ERROR",
            requestId: args.requestId,
            recordId: args.recordId,
            eventId: args.eventId,
            retryable: true,
            cause: args.error,
        });
    }

    static validation(message: string, cause?: unknown): AuditError {
        return new AuditError({ message, code: "VALIDATION_ERROR", retryable: false, cause });
    }

    static config(message: string): AuditError {
        return new AuditError({ message, code: "CONFIG_ERROR", retryable: false });
    }
}

function errorMessage(error: unknown): string | undefined {
    if (error instanceof Error) return error.message;
    return undefined;
}
