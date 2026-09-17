// The Audit Transaction retry/transport loop: same shape as retry.ts's
// sendPrepared, reusing its exported helpers directly (combineSignals,
// computeDelayMs, parseJsonBody, parseRetryAfterMs) rather than
// duplicating them, per AS-0504's "reuse existing transport/retry
// helpers" requirement.
import { AuditError } from "./errors";
import { combineSignals, computeDelayMs, parseJsonBody, parseRetryAfterMs } from "./retry";
import type { RetryConfigResolved } from "./retry";
import type { AuditTransport, RequestOptions, TransactionStartReceipt, TransactionTerminalReceipt } from "./types";
import type { PreparedTransactionStart, PreparedTransactionTerminal } from "./transactionPrepare";

export interface SendTransactionDeps {
    transport: AuditTransport;
    baseUrl: string;
    resolveApiKey: () => Promise<string>;
    userAgent: string;
    retry: RetryConfigResolved;
    defaultTimeoutMs: number;
    random: () => number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    newRequestId: () => string;
}

async function attemptOnce(
    url: string,
    payload: string,
    requestId: string,
    timeoutMs: number,
    options: RequestOptions,
    deps: SendTransactionDeps,
    recordId: string,
): Promise<{ status: number; parsed: Record<string, unknown> | undefined; retryAfterMs: number | undefined; text: string }> {
    const combined = combineSignals(options.signal, timeoutMs);
    try {
        const apiKey = await deps.resolveApiKey();
        const response = await deps.transport.send(url, {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                "x-request-id": requestId,
                "user-agent": deps.userAgent,
            },
            body: payload,
            signal: combined.signal,
        });
        const bodyText = await response.text();
        const parsed = parseJsonBody(bodyText);
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), new Date());
        return { status: response.status, parsed: parsed.value, retryAfterMs, text: bodyText };
    } catch (error: unknown) {
        throw error instanceof AuditError
            ? error
            : AuditError.fromNetworkFailure({ error, timedOut: combined.timedOut(), aborted: !combined.timedOut() && !!options.signal?.aborted, recordId, requestId });
    } finally {
        combined.cleanup();
    }
}

export async function sendTransactionStart(prepared: PreparedTransactionStart, options: RequestOptions, deps: SendTransactionDeps): Promise<TransactionStartReceipt> {
    if (options.signal?.aborted) {
        throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, recordId: prepared.recordId, eventId: prepared.eventId });
    }
    const requestId = options.requestId ?? deps.newRequestId();
    const url = `${deps.baseUrl.replace(/\/$/, "")}/api/v1/audit-transactions`;
    const timeoutMs = options.timeoutMs ?? deps.defaultTimeoutMs;

    let lastError: AuditError | undefined;
    for (let attempt = 1; attempt <= deps.retry.maxAttempts; attempt += 1) {
        try {
            const result = await attemptOnce(url, prepared.payload, requestId, timeoutMs, options, deps, prepared.recordId);
            if (result.status >= 200 && result.status < 300) {
                if (!result.parsed) {
                    throw AuditError.malformedResponse({ httpStatus: result.status, requestId, recordId: prepared.recordId, eventId: prepared.eventId, cause: undefined });
                }
                const status = result.parsed["status"];
                if (status !== "ACCEPTED" && status !== "DUPLICATE") {
                    throw AuditError.malformedResponse({ httpStatus: result.status, requestId, recordId: prepared.recordId, eventId: prepared.eventId, cause: new Error(`unexpected status field: ${String(status)}`) });
                }
                return {
                    auditTransactionId: typeof result.parsed["audit_transaction_id"] === "string" ? (result.parsed["audit_transaction_id"] as string) : prepared.auditTransactionId,
                    eventId: typeof result.parsed["event_id"] === "string" ? (result.parsed["event_id"] as string) : prepared.eventId,
                    recordId: typeof result.parsed["record_id"] === "string" ? (result.parsed["record_id"] as string) : prepared.recordId,
                    lifecycleState: typeof result.parsed["lifecycle_state"] === "string" ? (result.parsed["lifecycle_state"] as string) : "STARTED",
                    lifecyclePosition: typeof result.parsed["lifecycle_position"] === "number" ? (result.parsed["lifecycle_position"] as number) : 1,
                    status,
                    acceptedAt: typeof result.parsed["accepted_at"] === "string" ? (result.parsed["accepted_at"] as string) : prepared.occurredAt,
                    requestId,
                };
            }
            const errorCode = result.parsed && typeof result.parsed["error_code"] === "string" ? (result.parsed["error_code"] as string) : undefined;
            const message = result.parsed && typeof result.parsed["message"] === "string" ? (result.parsed["message"] as string) : undefined;
            const retryable = result.parsed && typeof result.parsed["retryable"] === "boolean" ? (result.parsed["retryable"] as boolean) : undefined;
            throw AuditError.fromServerResponse({ httpStatus: result.status, errorCode, message, requestId, recordId: prepared.recordId, eventId: prepared.eventId, retryAfterMs: result.retryAfterMs, retryable });
        } catch (error: unknown) {
            const auditError = error instanceof AuditError ? error : AuditError.fromNetworkFailure({ error, timedOut: false, aborted: false, recordId: prepared.recordId, eventId: prepared.eventId, requestId });
            lastError = auditError;
            const attemptsRemain = attempt < deps.retry.maxAttempts;
            if (!auditError.retryable || !attemptsRemain) throw auditError;
            await deps.sleep(computeDelayMs(attempt, deps.retry, auditError.retryAfterMs, deps.random), options.signal);
            if (options.signal?.aborted) {
                throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, recordId: prepared.recordId, eventId: prepared.eventId, requestId });
            }
        }
    }
    throw lastError ?? AuditError.config("sendTransactionStart: retry loop exited without a result");
}

export async function sendTransactionTerminal(
    auditTransactionId: string,
    kind: "complete" | "abort",
    prepared: PreparedTransactionTerminal,
    options: RequestOptions,
    deps: SendTransactionDeps,
): Promise<TransactionTerminalReceipt> {
    if (options.signal?.aborted) {
        throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, recordId: prepared.recordId });
    }
    const requestId = options.requestId ?? deps.newRequestId();
    const url = `${deps.baseUrl.replace(/\/$/, "")}/api/v1/audit-transactions/${auditTransactionId}/${kind}`;
    const timeoutMs = options.timeoutMs ?? deps.defaultTimeoutMs;

    let lastError: AuditError | undefined;
    for (let attempt = 1; attempt <= deps.retry.maxAttempts; attempt += 1) {
        try {
            const result = await attemptOnce(url, prepared.payload, requestId, timeoutMs, options, deps, prepared.recordId);
            if (result.status >= 200 && result.status < 300) {
                if (!result.parsed) {
                    throw AuditError.malformedResponse({ httpStatus: result.status, requestId, recordId: prepared.recordId, cause: undefined });
                }
                const status = result.parsed["status"];
                if (status !== "ACCEPTED" && status !== "DUPLICATE") {
                    throw AuditError.malformedResponse({ httpStatus: result.status, requestId, recordId: prepared.recordId, cause: new Error(`unexpected status field: ${String(status)}`) });
                }
                return {
                    auditTransactionId: typeof result.parsed["audit_transaction_id"] === "string" ? (result.parsed["audit_transaction_id"] as string) : auditTransactionId,
                    eventId: typeof result.parsed["event_id"] === "string" ? (result.parsed["event_id"] as string) : "",
                    recordId: typeof result.parsed["record_id"] === "string" ? (result.parsed["record_id"] as string) : prepared.recordId,
                    referencesRecordId: typeof result.parsed["references_record_id"] === "string" ? (result.parsed["references_record_id"] as string) : prepared.referencesRecordId,
                    lifecycleState: typeof result.parsed["lifecycle_state"] === "string" ? (result.parsed["lifecycle_state"] as string) : "",
                    lifecyclePosition: typeof result.parsed["lifecycle_position"] === "number" ? (result.parsed["lifecycle_position"] as number) : 2,
                    result: typeof result.parsed["result"] === "string" ? (result.parsed["result"] as string) : prepared.result,
                    status,
                    acceptedAt: typeof result.parsed["accepted_at"] === "string" ? (result.parsed["accepted_at"] as string) : prepared.occurredAt,
                    requestId,
                };
            }
            const errorCode = result.parsed && typeof result.parsed["error_code"] === "string" ? (result.parsed["error_code"] as string) : undefined;
            const message = result.parsed && typeof result.parsed["message"] === "string" ? (result.parsed["message"] as string) : undefined;
            const retryable = result.parsed && typeof result.parsed["retryable"] === "boolean" ? (result.parsed["retryable"] as boolean) : undefined;
            throw AuditError.fromServerResponse({ httpStatus: result.status, errorCode, message, requestId, recordId: prepared.recordId, retryAfterMs: result.retryAfterMs, retryable });
        } catch (error: unknown) {
            const auditError = error instanceof AuditError ? error : AuditError.fromNetworkFailure({ error, timedOut: false, aborted: false, recordId: prepared.recordId, requestId });
            lastError = auditError;
            const attemptsRemain = attempt < deps.retry.maxAttempts;
            if (!auditError.retryable || !attemptsRemain) throw auditError;
            await deps.sleep(computeDelayMs(attempt, deps.retry, auditError.retryAfterMs, deps.random), options.signal);
            if (options.signal?.aborted) {
                throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, recordId: prepared.recordId, requestId });
            }
        }
    }
    throw lastError ?? AuditError.config("sendTransactionTerminal: retry loop exited without a result");
}
