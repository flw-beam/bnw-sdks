// The batch retry/transport loop — the batch analog of retry.ts's
// sendPrepared. Resolves the API key immediately before each chunk
// attempt, sends the exact prepared chunk bytes, and — for a retryable
// whole-chunk outcome with attempts remaining — waits the greater of the
// server's Retry-After and exponential backoff, plus bounded jitter,
// before trying again. A per-item REJECTED outcome inside an otherwise-
// successful (2xx) response is never retried by this loop: it is
// surfaced to the caller as that item's own result.
import { AuditError } from "./errors";
import { combineSignals, computeDelayMs, parseJsonBody, parseRetryAfterMs } from "./retry";
import type { RetryConfigResolved } from "./retry";
import type { AuditTransport, BatchItemResult, BatchOptions, BatchResult, PreparedAuditBatch } from "./types";

export interface SendBatchesDeps {
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

/**
 * Delivers every chunk in batches, in order, aggregating per-item
 * results with `index` remapped back to the original input position. If
 * a chunk fails irrecoverably, this throws with the results already
 * obtained from prior, fully-resolved chunks discarded — unlike the Go
 * SDK's SendBatch (which returns a partial BatchResult alongside the
 * error), a thrown JS exception cannot also carry a return value; a
 * caller that needs partial progress should call sendPreparedBatch per
 * chunk itself instead of sendBatch across a multi-chunk input.
 */
export async function sendBatches(batches: readonly PreparedAuditBatch[], options: BatchOptions, deps: SendBatchesDeps): Promise<BatchResult> {
    if (options.signal?.aborted) {
        throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true });
    }

    const aggregate: BatchResult = { acceptedCount: 0, duplicateCount: 0, rejectedCount: 0, results: [] };
    const singleChunk = batches.length === 1;
    let offset = 0;

    for (const batch of batches) {
        if (options.signal?.aborted) {
            throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true });
        }
        // See BatchOptions.requestId's doc comment: a caller-supplied ID
        // is only meaningful for a single underlying request.
        const chunkOptions: BatchOptions = singleChunk ? options : { ...options, requestId: undefined };

        const results = await sendBatchChunk(batch, chunkOptions, deps);
        for (const result of results) {
            const remapped: BatchItemResult = { ...result, index: result.index + offset };
            aggregate.results.push(remapped);
            if (remapped.status === "ACCEPTED") aggregate.acceptedCount += 1;
            else if (remapped.status === "DUPLICATE") aggregate.duplicateCount += 1;
            else if (remapped.status === "REJECTED") aggregate.rejectedCount += 1;
        }
        offset += batch.items.length;
    }

    return aggregate;
}

async function sendBatchChunk(batch: PreparedAuditBatch, options: BatchOptions, deps: SendBatchesDeps): Promise<BatchItemResult[]> {
    const requestId = options.requestId ?? deps.newRequestId();
    const url = `${deps.baseUrl.replace(/\/$/, "")}/api/v1/events:batch`;
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
                body: batch.payload,
                signal: combined.signal,
            });

            const bodyText = await response.text();
            const parsed = parseJsonBody(bodyText);

            if (response.status >= 200 && response.status < 300) {
                const results = extractBatchResults(parsed.value);
                if (!results) {
                    throw AuditError.malformedResponse({ httpStatus: response.status, requestId, cause: undefined });
                }
                return results;
            }

            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), new Date());
            const errorCode = parsed.value && typeof parsed.value["error_code"] === "string" ? (parsed.value["error_code"] as string) : undefined;
            const message = parsed.value && typeof parsed.value["message"] === "string" ? (parsed.value["message"] as string) : undefined;
            const retryable = parsed.value && typeof parsed.value["retryable"] === "boolean" ? (parsed.value["retryable"] as boolean) : undefined;
            throw AuditError.fromServerResponse({ httpStatus: response.status, errorCode, message, requestId, retryAfterMs, retryable });
        } catch (error: unknown) {
            const auditError = error instanceof AuditError
                ? error
                : AuditError.fromNetworkFailure({
                    error,
                    timedOut: combined.timedOut(),
                    aborted: !combined.timedOut() && !!options.signal?.aborted,
                    requestId,
                });

            lastError = auditError;
            const attemptsRemain = attempt < deps.retry.maxAttempts;
            if (!auditError.retryable || !attemptsRemain) {
                throw auditError;
            }
            await deps.sleep(computeDelayMs(attempt, deps.retry, auditError.retryAfterMs, deps.random), options.signal);
            if (options.signal?.aborted) {
                throw AuditError.fromNetworkFailure({ error: options.signal.reason, timedOut: false, aborted: true, requestId });
            }
        } finally {
            combined.cleanup();
        }
    }

    // Unreachable: the loop above always either returns or throws before
    // exhausting attempts. Kept as a typed internal assertion, matching
    // retry.ts's own equivalent guard.
    throw lastError ?? AuditError.config("sendBatchChunk: retry loop exited without a result");
}

// batchResponseEnvelope mirrors schemas.SuccessBody[schemas.BatchAcceptedResponse]
// — the batch route wraps its payload under "data", unlike the one-shot
// route's flat body.
function extractBatchResults(value: Record<string, unknown> | undefined): BatchItemResult[] | undefined {
    if (!value) return undefined;
    const data = value["data"];
    if (!data || typeof data !== "object") return undefined;
    const rawResults = (data as Record<string, unknown>)["results"];
    if (!Array.isArray(rawResults) || rawResults.length === 0) return undefined;

    return rawResults.map((raw): BatchItemResult => {
        const r = raw as Record<string, unknown>;
        const item: BatchItemResult = {
            index: typeof r["index"] === "number" ? r["index"] : 0,
            status: r["status"] as BatchItemResult["status"],
        };
        if (typeof r["record_id"] === "string") item.recordId = r["record_id"];
        if (typeof r["event_id"] === "string") item.eventId = r["event_id"];
        if (typeof r["accepted_at"] === "string") item.acceptedAt = r["accepted_at"];
        if (r["error"] && typeof r["error"] === "object") {
            const e = r["error"] as Record<string, unknown>;
            item.error = {
                code: typeof e["code"] === "string" ? e["code"] : "",
                message: typeof e["message"] === "string" ? e["message"] : "",
                retryable: Boolean(e["retryable"]),
            };
        }
        return item;
    });
}
