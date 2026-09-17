// Deterministic canonical-bytes builder, mirroring audit-service-api's
// internal/core/auditrecord/canonicalize.go (CanonicalBytes) and
// internal/core/canonicaljson.Marshal field for field:
//   - object keys sorted by UTF-8 byte order at every nesting level;
//   - compact separators (no whitespace), matching Go's default
//     encoding/json.Marshal output;
//   - "<", ">", "&" are never escaped (Go disables HTML-escaping for
//     this path via SetEscapeHTML(false));
//   - the Unicode line separator (U+2028) and paragraph separator
//     (U+2029) are always escaped, because Go's encoder escapes them
//     unconditionally regardless of the SetEscapeHTML setting — the one
//     case native JSON.stringify would otherwise disagree with Go
//     byte-for-byte.
// Any change to field selection or formatting here is evidence-breaking
// for hash agreement across the API, this SDK, and the future Go SDK; it
// must track CanonicalizationVersion in lockstep with the Go side, never
// change silently.
import type { AuditContextInput, AuditEventInput, AuditOutcomeInput, AuditPolicyHintsInput, AuditTransactionStartInput } from "./types";

export const CANONICALIZATION_VERSION = "1";
export const HASH_ALGORITHM = "sha256";

// Forces UTC and exact millisecond precision, matching Go's
// "2006-01-02T15:04:05.000Z" canonical time format exactly.
export function formatCanonicalTimestamp(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new RangeError(`occurred_at is not a valid timestamp: ${String(value)}`);
    }
    // Date#toISOString already emits exactly this shape
    // (YYYY-MM-DDTHH:mm:ss.sssZ, always 3 fractional digits, always "Z"),
    // so no further reformatting is needed.
    return date.toISOString();
}

// Exported (unlike the rest of this file's per-field helpers) so
// transactionCanonical.ts (AS-0504) can build the same shapes for
// context/outcome/policy_hints/resource without duplicating this logic —
// the Audit Transaction wire request reuses these exact producer-payload
// shapes.
export function canonicalContext(context: AuditContextInput): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    setIfNotEmpty(out, "request_id", context.request_id);
    setIfNotEmpty(out, "correlation_id", context.correlation_id);
    setIfNotEmpty(out, "job_id", context.job_id);
    setIfNotEmpty(out, "trace_id", context.trace_id);
    setIfNotEmpty(out, "span_id", context.span_id);
    setIfNotEmpty(out, "causation_event_id", context.causation_event_id);
    return out;
}

export function canonicalOutcome(outcome: AuditOutcomeInput): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    setIfNotEmpty(out, "reason_code", outcome.reason_code);
    setIfNotEmpty(out, "reason_safe", outcome.reason_safe);
    if (outcome.http_status_code !== undefined && outcome.http_status_code !== 0) {
        out["http_status_code"] = outcome.http_status_code;
    }
    return out;
}

export function canonicalPolicyHints(policy: AuditPolicyHintsInput): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (policy.regulatory_tags && policy.regulatory_tags.length > 0) {
        out["regulatory_tags"] = policy.regulatory_tags;
    }
    setIfNotEmpty(out, "data_classification", policy.data_classification);
    return out;
}

export function setIfNotEmpty(obj: Record<string, unknown>, key: string, value: string | undefined): void {
    if (value) obj[key] = value;
}

/**
 * Builds the canonical producer-content object for `input`, whose
 * `record_id`/`event_id` must already be assigned (createEvent's job).
 * Field selection mirrors Go's CanonicalBytes exactly: optional/absent
 * fields are omitted, never emitted as null.
 */
export function buildCanonicalObject(input: AuditEventInput & { record_id: string; event_id: string }): Record<string, unknown> {
    const obj: Record<string, unknown> = {
        record_id: input.record_id,
        event_id: input.event_id,
        occurred_at: formatCanonicalTimestamp(input.occurred_at),
        event_type: input.event_type,
        category: input.category,
        action: input.action,
        result: input.result,
        actor: { type: input.actor.type, id: input.actor.id },
        resource: canonicalResource(input.resource),
    };
    if (input.context !== undefined) obj["context"] = canonicalContext(input.context);
    if (input.outcome !== undefined) obj["outcome"] = canonicalOutcome(input.outcome);
    if (input.policy_hints !== undefined) obj["policy_hints"] = canonicalPolicyHints(input.policy_hints);
    if (input.metadata && Object.keys(input.metadata).length > 0) obj["metadata"] = input.metadata;
    return obj;
}

export function canonicalResource(resource: AuditEventInput["resource"] | AuditTransactionStartInput["resource"]): Record<string, unknown> {
    const out: Record<string, unknown> = { type: resource.type, id: resource.id };
    if (resource.attributes && Object.keys(resource.attributes).length > 0) {
        out["attributes"] = resource.attributes;
    }
    return out;
}

// U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), built from
// escape codes rather than literal characters so they cannot be mangled
// by an editor/terminal that treats them as line breaks.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LINE_SEPARATORS_PATTERN = new RegExp(`[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "g");

/** Recursively sorts object keys by UTF-8 byte order (not JS default string/locale order) so hash agreement holds for any Unicode metadata key, then serializes compactly. */
export function canonicalStringify(value: unknown): string {
    const json = JSON.stringify(sortDeep(value));
    if (json === undefined) {
        throw new TypeError("canonicalStringify: value is not JSON-serializable");
    }
    return json.replace(LINE_SEPARATORS_PATTERN, (ch) => (ch === LINE_SEPARATOR ? "\\u2028" : "\\u2029"));
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortDeep);
    }
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
        const sorted: Record<string, unknown> = {};
        const keys = Object.keys(value as Record<string, unknown>).sort(compareUtf8Bytes);
        for (const key of keys) {
            sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

const utf8Encoder = new TextEncoder();

function compareUtf8Bytes(a: string, b: string): number {
    const aBytes = utf8Encoder.encode(a);
    const bBytes = utf8Encoder.encode(b);
    const len = Math.min(aBytes.length, bBytes.length);
    for (let i = 0; i < len; i += 1) {
        const diff = (aBytes[i] as number) - (bBytes[i] as number);
        if (diff !== 0) return diff;
    }
    return aBytes.length - bBytes.length;
}
