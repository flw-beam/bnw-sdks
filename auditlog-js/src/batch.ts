// createBatch: assign stable IDs/canonicalize every input once (via
// createEvent), then split the result into network-ready chunks bounded
// by MAX_BATCH_RECORDS — the Go SDK's twin (sdks/go/batch.go) does the
// exact same thing, so both SDKs produce byte-identical chunk payloads
// for the same inputs.
import { AuditError } from "./errors";
import { createEvent } from "./prepare";
import type { CreateEventDeps } from "./prepare";
import type { AuditEventInput, PreparedAuditBatch, PreparedAuditEvent } from "./types";

/** The contract's per-batch item ceiling, matching audit-service-api's DecodeBatch default (internal/core/auditrecord/batchdecode.go). */
export const MAX_BATCH_RECORDS = 500;

/**
 * Prepares every input once, then splits into one or more network-ready
 * chunks bounded by MAX_BATCH_RECORDS, preserving input order across
 * chunk boundaries. Performs no network I/O. Fails closed: if any input
 * fails to prepare, no chunk is returned at all — a batch call must not
 * partially construct itself around a caller bug in one item.
 */
export function createBatch(inputs: readonly AuditEventInput[], deps: CreateEventDeps): PreparedAuditBatch[] {
    if (inputs.length === 0) {
        throw AuditError.validation("batch must contain at least one record");
    }

    const prepared: PreparedAuditEvent[] = inputs.map((input, index) => {
        try {
            return createEvent(input, deps);
        } catch (error) {
            if (error instanceof AuditError) {
                throw AuditError.validation(`batch item ${index}: ${error.message}`, error);
            }
            throw error;
        }
    });

    return chunkPrepared(prepared);
}

function chunkPrepared(items: readonly PreparedAuditEvent[]): PreparedAuditBatch[] {
    const batches: PreparedAuditBatch[] = [];
    for (let start = 0; start < items.length; start += MAX_BATCH_RECORDS) {
        const chunk = items.slice(start, start + MAX_BATCH_RECORDS);
        batches.push(Object.freeze({ items: Object.freeze(chunk), payload: buildBatchPayload(chunk) }));
    }
    return batches;
}

function buildBatchPayload(items: readonly PreparedAuditEvent[]): string {
    return `{"records":[${items.map((item) => item.payload).join(",")}]}`;
}
