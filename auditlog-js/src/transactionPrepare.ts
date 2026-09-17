// createTransactionStart/createTransactionTerminal: assign stable IDs and
// time once, validate locally, canonicalize, and freeze — the Audit
// Transaction lifecycle's equivalent of prepare.ts's createEvent.
import { AuditError } from "./errors";
import { canonicalStringify } from "./canonical";
import { buildTransactionStartObject, buildTransactionTerminalObject } from "./transactionCanonical";
import { MAX_CANONICAL_RECORD_BYTES } from "./prepare";
import { newULID } from "./ulid";
import { validateTransactionStartInput, validateTransactionTerminalInput } from "./transactionValidate";
import type { AuditTransactionStartInput } from "./types";
import type { TransactionTerminalValidationInput } from "./transactionValidate";

export interface CreateTransactionDeps {
    now: () => Date;
    random: () => number;
}

/** The immutable, already-canonicalized outcome of createTransactionStart. */
export interface PreparedTransactionStart {
    readonly auditTransactionId: string;
    readonly eventId: string;
    readonly recordId: string;
    readonly occurredAt: string;
    readonly payload: string;
}

/** The immutable, already-canonicalized outcome of createTransactionTerminal. */
export interface PreparedTransactionTerminal {
    readonly recordId: string;
    readonly referencesRecordId: string;
    readonly occurredAt: string;
    readonly result: string;
    readonly payload: string;
}

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

function checkSize(payload: string): void {
    const byteLength = new TextEncoder().encode(payload).length;
    if (byteLength > MAX_CANONICAL_RECORD_BYTES) {
        throw AuditError.validation(`canonical record of ${byteLength} bytes exceeds the ${MAX_CANONICAL_RECORD_BYTES}-byte contract limit`);
    }
}

export function createTransactionStart(input: AuditTransactionStartInput, deps: CreateTransactionDeps): PreparedTransactionStart {
    const frozenInput = freezeClone(input);
    validateTransactionStartInput(frozenInput);

    const now = deps.now();
    const recordId = frozenInput.record_id ?? newULID(now, deps.random);
    const eventId = frozenInput.event_id ?? newULID(now, deps.random);
    const auditTransactionId = frozenInput.audit_transaction_id ?? newULID(now, deps.random);

    const withIds = { ...frozenInput, record_id: recordId, event_id: eventId, audit_transaction_id: auditTransactionId };
    const canonicalObject = buildTransactionStartObject(withIds);
    const payload = canonicalStringify(canonicalObject);
    checkSize(payload);

    return Object.freeze({
        auditTransactionId,
        eventId,
        recordId,
        occurredAt: canonicalObject["occurred_at"] as string,
        payload,
    });
}

export function createTransactionTerminal(input: TransactionTerminalValidationInput, deps: CreateTransactionDeps): PreparedTransactionTerminal {
    validateTransactionTerminalInput(input);

    const recordId = input.record_id ?? newULID(deps.now(), deps.random);
    const canonicalObject = buildTransactionTerminalObject({
        record_id: recordId,
        references_record_id: input.references_record_id,
        occurred_at: input.occurred_at,
        result: input.result,
        outcome: input.outcome,
        metadata: input.metadata,
    });
    const payload = canonicalStringify(canonicalObject);
    checkSize(payload);

    return Object.freeze({
        recordId,
        referencesRecordId: input.references_record_id,
        occurredAt: canonicalObject["occurred_at"] as string,
        result: input.result ?? "",
        payload,
    });
}
