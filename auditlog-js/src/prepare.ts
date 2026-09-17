// createEvent: assign stable IDs and time once, validate locally,
// canonicalize, and freeze — mirroring audit-service-api's Prepare
// pipeline (internal/core/auditrecord/prepare.go), minus the parts only
// the server can do (registry lookup, duplicate-key/unknown-field
// rejection of raw wire bytes it did not author itself).
import { AuditError } from "./errors";
import { buildCanonicalObject, canonicalStringify } from "./canonical";
import { newULID } from "./ulid";
import { validateEventInput } from "./validate";
import type { AuditEventInput, PreparedAuditEvent } from "./types";

// The contract's canonical record size ceiling (audit-service-api's
// auditrecord.MaxCanonicalRecordBytes) — checked against canonical
// bytes, not the caller's original (possibly larger, pre-canonicalized)
// input shape.
export const MAX_CANONICAL_RECORD_BYTES = 32 * 1024;

export interface CreateEventDeps {
    now: () => Date;
    random: () => number;
}

/**
 * Deep-freezes a defensive structural clone of `value` so a caller
 * mutating their original input object after createEvent returns can
 * never change the bytes a later retry sends under the same record_id.
 */
function freezeClone<T>(value: T): T {
    if (Array.isArray(value)) {
        return Object.freeze(value.map((item) => freezeClone(item))) as unknown as T;
    }
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
        const clone: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            clone[key] = freezeClone(val);
        }
        return Object.freeze(clone) as unknown as T;
    }
    return value;
}

export function createEvent(input: AuditEventInput, deps: CreateEventDeps): PreparedAuditEvent {
    const frozenInput = freezeClone(input);
    validateEventInput(frozenInput);

    const now = deps.now();
    const recordId = frozenInput.record_id ?? newULID(now, deps.random);
    const eventId = frozenInput.event_id ?? newULID(now, deps.random);

    const withIds = { ...frozenInput, record_id: recordId, event_id: eventId };
    const canonicalObject = buildCanonicalObject(withIds);
    const payload = canonicalStringify(canonicalObject);

    const byteLength = new TextEncoder().encode(payload).length;
    if (byteLength > MAX_CANONICAL_RECORD_BYTES) {
        throw AuditError.validation(`canonical record of ${byteLength} bytes exceeds the ${MAX_CANONICAL_RECORD_BYTES}-byte contract limit`);
    }

    return Object.freeze({
        recordId,
        eventId,
        occurredAt: canonicalObject["occurred_at"] as string,
        payload,
    });
}
