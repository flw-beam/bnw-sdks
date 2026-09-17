// Deterministic request-body builders for the Audit Transaction lifecycle
// (AS-0504), reusing canonical.ts's field-shape helpers (context/outcome/
// policy_hints/resource) directly rather than duplicating them. Unlike
// one-shot's buildCanonicalObject, this is NOT a mirror of the server's
// internal audit_records canonicalization (audittransaction.CanonicalStartBytes/
// CanonicalTerminalBytes own that, and inherit lifecycle_state/position
// server-side) — it exists only so a retry of the same logical call sends
// byte-identical request bytes, matching audit-service-api's
// schemas.AuditTransactionStartRequest/AuditTransactionCompleteRequest/
// AuditTransactionAbortRequest field-for-field.
import { canonicalContext, canonicalOutcome, canonicalPolicyHints, canonicalResource, formatCanonicalTimestamp } from "./canonical";
import type { AuditTransactionAbortInput, AuditTransactionCompleteInput, AuditTransactionStartInput } from "./types";

/** Builds the canonical start request object. `record_id`/`event_id`/`audit_transaction_id` must already be assigned. */
export function buildTransactionStartObject(
    input: AuditTransactionStartInput & { record_id: string; event_id: string; audit_transaction_id: string },
): Record<string, unknown> {
    const obj: Record<string, unknown> = {
        record_id: input.record_id,
        event_id: input.event_id,
        audit_transaction_id: input.audit_transaction_id,
        occurred_at: formatCanonicalTimestamp(input.occurred_at),
        event_type: input.event_type,
        category: input.category,
        action: input.action,
        actor: { type: input.actor.type, id: input.actor.id },
        resource: canonicalResource(input.resource),
    };
    if (input.context !== undefined) obj["context"] = canonicalContext(input.context);
    if (input.policy_hints !== undefined) obj["policy_hints"] = canonicalPolicyHints(input.policy_hints);
    if (input.metadata && Object.keys(input.metadata).length > 0) obj["metadata"] = input.metadata;
    return obj;
}

/** Internal, kind-neutral shape both complete and abort funnel into before building a request object. */
export interface TransactionTerminalObjectInput {
    record_id: string;
    references_record_id: string;
    occurred_at: string | Date;
    result?: string;
    outcome?: AuditTransactionCompleteInput["outcome"] | AuditTransactionAbortInput["outcome"];
    metadata?: Record<string, unknown>;
}

/** Builds the canonical complete/abort request object. `record_id` must already be assigned. */
export function buildTransactionTerminalObject(input: TransactionTerminalObjectInput): Record<string, unknown> {
    const obj: Record<string, unknown> = {
        record_id: input.record_id,
        references_record_id: input.references_record_id,
        occurred_at: formatCanonicalTimestamp(input.occurred_at),
    };
    if (input.result) obj["result"] = input.result;
    if (input.outcome !== undefined) obj["outcome"] = canonicalOutcome(input.outcome);
    if (input.metadata && Object.keys(input.metadata).length > 0) obj["metadata"] = input.metadata;
    return obj;
}
