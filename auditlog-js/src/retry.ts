// The retry/transport loop: resolves the API key immediately before
// each attempt, sends the exact prepared bytes, classifies the outcome,
// and — for a retryable outcome with attempts remaining — waits the
// greater of the server's Retry-After and exponential backoff, plus
// bounded jitter, before trying again. Every attempt reuses the exact
// same prepared payload and (for the logical call) the same request ID.
import { AuditError } from "./errors";
import type { AuditTransport, PreparedAuditEvent, RecordReceipt, RequestOptions } from "./types";

export interface RetryConfigResolved {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfigResolved = {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 5_000,
};

export interface SendPreparedDeps {
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

/** Computes the delay before the next attempt: the greater of exponential backoff and any server Retry-After, plus a bounded (at most one base-delay unit) random addition. */
export function computeDelayMs(attempt: number, retry: RetryConfigResolved, retryAfterMs: number | undefined, random: () => number): number {
    const exponential = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
    const base = Math.max(exponential, retryAfterMs ?? 0);
    const jitter = random() * retry.baseDelayMs;
    return Math.round(base + jitter);
}

/** Parses a Retry-After header value (either whole seconds, or an HTTP-date) into a millisecond delay. Returns undefined for an absent or unparseable header. */
export function parseRetryAfterMs(value: string | null, now: Date): number | undefined {
    if (!value) return undefined;
    if (/^\d+$/.test(value.trim())) {
        return Number(value.trim()) * 1000;
    }
    const asDate = new Date(value);
    if (Number.isNaN(asDate.getTime())) return undefined;
    const deltaMs = asDate.getTime() - now.getTime();
    return deltaMs > 0 ? deltaMs : 0;
}

interface ParsedBody {
    ok: boolean;
    value: Record<string, unknown> | undefined;
}

// Exported so src/batchRetry.ts (AS-0403) can reuse the exact same body-
// parsing and signal-combination logic instead of duplicating it.
export function parseJsonBody(text: string): ParsedBody {
    if (!text) return { ok: true, value: undefined };
    try {
        const value = JSON.parse(text);
        return { ok: true, value: value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined };
    } catch {
        return { ok: false, value: undefined };
    }
}

export function combineSignals(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup: () => {
            clearTimeout(timer);
            callerSignal?.removeEventListener("abort", onCallerAbort);
        },
    };
}

export async function sendPrepared(prepared: PreparedAuditEvent, options: RequestOptions, deps: SendPreparedDeps): Promise<RecordReceipt> {
    if (options.signal?.aborted) {
        throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, recordId: prepared.recordId, eventId: prepared.eventId });
    }

    const requestId = options.requestId ?? deps.newRequestId();
    const url = `${deps.baseUrl.replace(/\/$/, "")}/api/v1/events`;
    const timeoutMs = options.timeoutMs ?? deps.defaultTimeoutMs;

    let lastError: AuditError | undefined;
    for (let attempt = 1; attempt <= deps.retry.maxAttempts; attempt += 1) {
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
                body: prepared.payload,
                signal: combined.signal,
            });

            const bodyText = await response.text();
            const parsed = parseJsonBody(bodyText);

            if (response.status >= 200 && response.status < 300) {
                if (!parsed.ok || !parsed.value) {
                    throw AuditError.malformedResponse({ httpStatus: response.status, requestId, recordId: prepared.recordId, eventId: prepared.eventId, cause: undefined });
                }
                const status = parsed.value["status"];
                if (status !== "ACCEPTED" && status !== "DUPLICATE") {
                    throw AuditError.malformedResponse({ httpStatus: response.status, requestId, recordId: prepared.recordId, eventId: prepared.eventId, cause: new Error(`unexpected status field: ${String(status)}`) });
                }
                return {
                    recordId: typeof parsed.value["record_id"] === "string" ? (parsed.value["record_id"] as string) : prepared.recordId,
                    eventId: typeof parsed.value["event_id"] === "string" ? (parsed.value["event_id"] as string) : prepared.eventId,
                    status,
                    acceptedAt: typeof parsed.value["accepted_at"] === "string" ? (parsed.value["accepted_at"] as string) : prepared.occurredAt,
                    requestId,
                };
            }

            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), new Date());
            const errorCode = parsed.value && typeof parsed.value["error_code"] === "string" ? (parsed.value["error_code"] as string) : undefined;
            const message = parsed.value && typeof parsed.value["message"] === "string" ? (parsed.value["message"] as string) : undefined;
            const retryable = parsed.value && typeof parsed.value["retryable"] === "boolean" ? (parsed.value["retryable"] as boolean) : undefined;
            throw AuditError.fromServerResponse({
                httpStatus: response.status,
                errorCode,
                message,
                requestId,
                recordId: prepared.recordId,
                eventId: prepared.eventId,
                retryAfterMs,
                retryable,
            });
        } catch (error: unknown) {
            const auditError = error instanceof AuditError
                ? error
                : AuditError.fromNetworkFailure({
                    error,
                    timedOut: combined.timedOut(),
                    aborted: !combined.timedOut() && !!options.signal?.aborted,
                    recordId: prepared.recordId,
                    eventId: prepared.eventId,
                    requestId,
                });

            lastError = auditError;
            const attemptsRemain = attempt < deps.retry.maxAttempts;
            if (!auditError.retryable || !attemptsRemain) {
                throw auditError;
            }
            await deps.sleep(computeDelayMs(attempt, deps.retry, auditError.retryAfterMs, deps.random), options.signal);
            if (options.signal?.aborted) {
                throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, recordId: prepared.recordId, eventId: prepared.eventId, requestId });
            }
        } finally {
            combined.cleanup();
        }
    }

    // Unreachable: the loop above always either returns or throws before
    // exhausting attempts (the last iteration's non-retryable-or-no-
    // attempts-left branch throws). Kept as a typed internal assertion
    // rather than a bare `throw new Error("unreachable")`, per AS-0307.3's
    // own guidance, so a lint/type-narrowing regression here fails loudly.
    throw lastError ?? AuditError.config("sendPrepared: retry loop exited without a result");
}
