// Universal local validation, mirroring the client-checkable subset of
// audit-service-api's internal/core/auditrecord/validate.go. Registry-
// specific rules (event_type registration, category/action pairing,
// per-field metadata schema review) are deliberately NOT enforced here —
// this SDK ships no bundled registry snapshot, and the server remains
// authoritative for those; see contracts.md#16.4: "Local SDK validation
// improves feedback but never replaces server validation."
import { AuditError } from "./errors";
import { isValidULID } from "./ulid";
import type { AuditEventInput } from "./types";

// Exported so transactionValidate.ts (AS-0504) can enforce the exact same
// universal rules without duplicating them.
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_BYTES = 8 * 1024;
export const MAX_METADATA_DEPTH = 3;
export const MAX_ARRAY_ELEMENTS = 100;
export const MAX_OPAQUE_ID_LEN = 255;

export const ACTOR_TYPES = new Set(["ADMIN", "SERVICE", "SYSTEM", "USER"]);
const RESULTS = new Set(["SUCCESS", "FAILURE", "DENIED"]);

// Mirrors auditrecord.prohibitedMetadataKeys exactly — a field-name
// substring match, case-insensitive, at any nesting depth.
const PROHIBITED_METADATA_KEY_PATTERNS = [
    "password", "passwd", "secret", "token", "api_key", "apikey", "private_key",
    "cvv", "card_number", "card_num", "pan", "stack_trace", "stacktrace", "full_body",
];

// Mirrors ParseProducerRecord's allowedTopLevelFields exactly. Anything
// else — including a caller's attempt to set tenant_id/producer_id/
// environment/accepted_at — is rejected here, before a network call is
// ever attempted.
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
    "record_id", "event_id", "occurred_at", "event_type", "category", "action", "result",
    "actor", "resource", "context", "outcome", "policy_hints", "metadata",
]);

const SERVER_OWNED_FIELD_HINTS: Record<string, string> = {
    tenant_id: "tenant_id is attached from your producer credential; a producer can never set it directly",
    producer_id: "producer_id is attached from your producer credential; a producer can never set it directly",
    environment: "environment is attached from your producer credential; a producer can never set it directly",
    accepted_at: "accepted_at is stamped by the server at the durable Kafka acknowledgement; a producer can never set it",
};

export function validateEventInput(input: AuditEventInput): void {
    for (const key of Object.keys(input)) {
        if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
            const hint = SERVER_OWNED_FIELD_HINTS[key];
            throw AuditError.validation(hint ? `unknown top-level field "${key}": ${hint}` : `unknown top-level field "${key}"`);
        }
    }

    requireNonEmptyString(input, "event_type");
    requireNonEmptyString(input, "category");
    requireNonEmptyString(input, "action");
    requireNonEmptyString(input, "result");
    if (input.occurred_at === undefined || input.occurred_at === null || input.occurred_at === "") {
        throw AuditError.validation("occurred_at is required");
    }

    if (!RESULTS.has(input.result)) {
        throw AuditError.validation(`result must be one of ${[...RESULTS].join(", ")}`);
    }

    const eventType = input.event_type;
    if (eventType.length < 3 || eventType.length > 120 || !EVENT_TYPE_PATTERN.test(eventType)) {
        throw AuditError.validation("event_type must be a lowercase dotted name of 3-120 characters");
    }

    if (input.record_id !== undefined && !isValidULID(input.record_id)) {
        throw AuditError.validation("record_id is not a valid ULID");
    }
    if (input.event_id !== undefined && !isValidULID(input.event_id)) {
        throw AuditError.validation("event_id is not a valid ULID");
    }

    if (!input.actor) throw AuditError.validation("actor is required");
    validateOpaqueId("actor.id", input.actor.id);
    if (input.actor.id.includes("@")) {
        throw AuditError.validation("actor.id must not be an email address");
    }
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
    if (input.resource.attributes !== undefined) {
        validateProhibitedContent(input.resource.attributes, "resource.attributes");
    }
}

function requireNonEmptyString(input: AuditEventInput, field: "event_type" | "category" | "action" | "result"): void {
    const value = input[field];
    if (!value) throw AuditError.validation(`${field} is required`);
}

export function validateOpaqueId(field: string, id: string | undefined): void {
    if (!id || id.length > MAX_OPAQUE_ID_LEN) {
        throw AuditError.validation(`${field} must be 1-255 characters`);
    }
}

export function validateMetadataBounds(metadata: Record<string, unknown>, field: string): void {
    if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
        throw AuditError.validation(`${field} has more than ${MAX_METADATA_KEYS} keys`);
    }
    if (valueDepth(metadata, 0) > MAX_METADATA_DEPTH) {
        throw AuditError.validation(`${field} exceeds the maximum nesting depth of ${MAX_METADATA_DEPTH}`);
    }
    validateArrayBounds(metadata, field);
    const byteLength = new TextEncoder().encode(JSON.stringify(metadata)).length;
    if (byteLength > MAX_METADATA_BYTES) {
        throw AuditError.validation(`${field} exceeds ${MAX_METADATA_BYTES} bytes`);
    }
}

function valueDepth(value: unknown, current: number): number {
    if (Array.isArray(value)) {
        return value.reduce((max, item) => Math.max(max, valueDepth(item, current + 1)), current);
    }
    if (value !== null && typeof value === "object") {
        return Object.values(value as Record<string, unknown>).reduce<number>((max, item) => Math.max(max, valueDepth(item, current + 1)), current);
    }
    return current;
}

function validateArrayBounds(value: unknown, field: string): void {
    if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_ELEMENTS) {
            throw AuditError.validation(`${field} contains an array exceeding ${MAX_ARRAY_ELEMENTS} elements`);
        }
        for (const item of value) validateArrayBounds(item, field);
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) validateArrayBounds(item, field);
    }
}

export function validateProhibitedContent(value: Record<string, unknown>, path: string): void {
    for (const [key, val] of Object.entries(value)) {
        const lower = key.toLowerCase();
        for (const blocked of PROHIBITED_METADATA_KEY_PATTERNS) {
            if (lower.includes(blocked)) {
                throw AuditError.validation(`field name "${path}.${key}" matches a prohibited secret-shaped pattern`);
            }
        }
        if (val !== null && typeof val === "object" && !Array.isArray(val)) {
            validateProhibitedContent(val as Record<string, unknown>, `${path}.${key}`);
        }
    }
}
