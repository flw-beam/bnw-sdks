// Universal local validation for the Audit Transaction lifecycle
// (AS-0504), mirroring the client-checkable subset of audit-service-api's
// internal/core/audittransaction (ValidateStart/ValidateTerminalTransition).
// Reuses validate.ts's exported universal-rule helpers directly rather
// than duplicating them. Identity/reference/lifecycle-position
// invariants that depend on the visible start (which only the server can
// see) are the server's job, not this module's.
import { ACTOR_TYPES, EVENT_TYPE_PATTERN, validateMetadataBounds, validateOpaqueId, validateProhibitedContent } from "./validate";
import { AuditError } from "./errors";
import { isValidULID } from "./ulid";
import type { AuditTransactionAbortInput, AuditTransactionCompleteInput, AuditTransactionStartInput } from "./types";

// Mirrors internal/core/audittransaction's allowedStartFields exactly.
const ALLOWED_START_FIELDS = new Set([
    "record_id", "event_id", "audit_transaction_id", "occurred_at", "event_type", "category", "action",
    "actor", "resource", "context", "policy_hints", "metadata",
]);

// Mirrors allowedCompleteFields — no "result": a completed terminal's
// result is always server-set to SUCCESS.
const ALLOWED_COMPLETE_FIELDS = new Set(["record_id", "occurred_at", "outcome", "metadata"]);

// Mirrors allowedAbortFields — "result" is required here.
const ALLOWED_ABORT_FIELDS = new Set(["record_id", "occurred_at", "result", "outcome", "metadata"]);

function checkAllowedFields(input: object, allowed: Set<string>): void {
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) {
            throw AuditError.validation(`unknown top-level field "${key}"`);
        }
    }
}

export function validateTransactionStartInput(input: AuditTransactionStartInput): void {
    checkAllowedFields(input, ALLOWED_START_FIELDS);

    if (input.occurred_at === undefined || input.occurred_at === null || input.occurred_at === "") {
        throw AuditError.validation("occurred_at is required");
    }
    if (!input.event_type) throw AuditError.validation("event_type is required");
    if (!input.category) throw AuditError.validation("category is required");
    if (!input.action) throw AuditError.validation("action is required");

    if (input.event_type.length < 3 || input.event_type.length > 120 || !EVENT_TYPE_PATTERN.test(input.event_type)) {
        throw AuditError.validation("event_type must be a lowercase dotted name of 3-120 characters");
    }
    if (input.record_id !== undefined && !isValidULID(input.record_id)) {
        throw AuditError.validation("record_id is not a valid ULID");
    }
    if (input.event_id !== undefined && !isValidULID(input.event_id)) {
        throw AuditError.validation("event_id is not a valid ULID");
    }
    if (input.audit_transaction_id !== undefined && !isValidULID(input.audit_transaction_id)) {
        throw AuditError.validation("audit_transaction_id is not a valid ULID");
    }

    if (!input.actor) throw AuditError.validation("actor is required");
    validateOpaqueId("actor.id", input.actor.id);
    if (!ACTOR_TYPES.has(input.actor.type)) {
        throw AuditError.validation(`actor.type must be one of ${[...ACTOR_TYPES].join(", ")}`);
    }

    if (!input.resource) throw AuditError.validation("resource is required");
    if (!input.resource.type) throw AuditError.validation("resource.type is required");
    validateOpaqueId("resource.id", input.resource.id);

    if (input.context?.causation_event_id !== undefined && input.context.causation_event_id !== "" && !isValidULID(input.context.causation_event_id)) {
        throw AuditError.validation("context.causation_event_id is not a valid ULID");
    }

    if (input.metadata !== undefined) {
        validateMetadataBounds(input.metadata, "metadata");
        validateProhibitedContent(input.metadata, "metadata");
    }
}

/** Internal, kind-neutral shape both complete and abort validate through. */
export interface TransactionTerminalValidationInput {
    record_id?: string;
    references_record_id: string;
    occurred_at: string | Date;
    result?: string;
    outcome?: { reason_code?: string; reason_safe?: string; http_status_code?: number };
    metadata?: Record<string, unknown>;
}

export function validateTransactionTerminalInput(input: TransactionTerminalValidationInput): void {
    if (!input.references_record_id) throw AuditError.validation("references_record_id is required");
    if (!isValidULID(input.references_record_id)) throw AuditError.validation("references_record_id is not a valid ULID");
    if (input.occurred_at === undefined || input.occurred_at === null || input.occurred_at === "") {
        throw AuditError.validation("occurred_at is required");
    }
    if (input.record_id !== undefined && !isValidULID(input.record_id)) {
        throw AuditError.validation("record_id is not a valid ULID");
    }
    if (input.result !== undefined && input.result !== "SUCCESS" && input.result !== "FAILURE" && input.result !== "DENIED") {
        throw AuditError.validation("result must be one of SUCCESS, FAILURE, DENIED");
    }
    if (input.metadata !== undefined) {
        validateMetadataBounds(input.metadata, "metadata");
        validateProhibitedContent(input.metadata, "metadata");
    }
}

export function checkCompleteFields(input: AuditTransactionCompleteInput): void {
    checkAllowedFields(input, ALLOWED_COMPLETE_FIELDS);
}

export function checkAbortFields(input: AuditTransactionAbortInput): void {
    checkAllowedFields(input, ALLOWED_ABORT_FIELDS);
}
