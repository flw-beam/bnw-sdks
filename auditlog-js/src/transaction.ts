// Transaction: a one-owner, process-local helper for one Audit
// Transaction lifecycle: NEW -> START_IN_FLIGHT -> STARTED, then STARTED
// -> COMPLETE_IN_FLIGHT -> COMPLETED or STARTED -> ABORT_IN_FLIGHT ->
// ABORTED. A busy guard (a synchronous state check before the first
// `await` in each method) rejects an overlapping call rather than
// racing two in-flight requests for the same transaction — JS's
// single-threaded execution model makes this check-then-set sequence
// atomic with respect to any other call on the same Transaction
// instance, without needing a real lock.
//
// A Transaction holds no durable state and cannot be resumed after a
// process restart. If the process crashes after record() succeeds but
// before complete()/abort() is called, the evidence honestly remains
// STARTED — see the README's "Transaction lifecycle" section and
// internal/testutils/testdata/contracts/sdk/v1/transactions/manifest.json's
// process_crash_recovery guidance.
import { AuditError } from "./errors";
import { createTransactionStart, createTransactionTerminal } from "./transactionPrepare";
import type { PreparedTransactionStart, PreparedTransactionTerminal } from "./transactionPrepare";
import { sendTransactionStart, sendTransactionTerminal } from "./transactionRetry";
import type { SendTransactionDeps } from "./transactionRetry";
import type {
    AuditTransactionAbortInput,
    AuditTransactionCompleteInput,
    AuditTransactionStartInput,
    RequestOptions,
    TransactionStartReceipt,
    TransactionState,
    TransactionTerminalReceipt,
} from "./types";

export interface TransactionDeps extends SendTransactionDeps {
    now: () => Date;
    random: () => number;
}

export class Transaction {
    private readonly deps: TransactionDeps;
    private state: TransactionState = "NEW";

    private reserved = false;
    private auditTransactionId = "";
    private eventId = "";
    private startRecordId = "";
    private startPrepared: PreparedTransactionStart | undefined;

    private terminalChosen = false;
    private terminalKind: "COMPLETED" | "ABORTED" | undefined;
    private terminalPrepared: PreparedTransactionTerminal | undefined;

    constructor(deps: TransactionDeps) {
        this.deps = deps;
    }

    /** The Transaction's current state. */
    get currentState(): TransactionState {
        return this.state;
    }

    /** The reserved transaction ID, or "" before `record` has reserved one. */
    get auditTransactionIdValue(): string {
        return this.auditTransactionId;
    }

    /** The reserved event ID, or "" before `record` has reserved one. */
    get eventIdValue(): string {
        return this.eventId;
    }

    /** The reserved start record ID, or "" before `record` has reserved one. */
    get startRecordIdValue(): string {
        return this.startRecordId;
    }

    /**
     * Prepares `input` (generating and reserving audit_transaction_id/
     * event_id/record_id on first call) and durably starts the
     * transaction, retrying eligible transient failures with the exact
     * same prepared bytes. Resolves for both ACCEPTED and DUPLICATE.
     *
     * Calling `record` again after it already succeeded is rejected — a
     * Transaction starts at most once. Calling it again after a failed
     * attempt is allowed and reuses the exact same reserved IDs and
     * prepared bytes.
     */
    async record(input: AuditTransactionStartInput, options: RequestOptions = {}): Promise<TransactionStartReceipt> {
        if (this.state === "START_IN_FLIGHT" || this.state === "COMPLETE_IN_FLIGHT" || this.state === "ABORT_IN_FLIGHT") {
            throw AuditError.validation("transaction: a call is already in flight; overlapping calls are not allowed");
        }
        if (this.state !== "NEW") {
            throw AuditError.validation("transaction: record can only succeed once per transaction; this transaction has already started");
        }

        if (!this.reserved) {
            const prepared = createTransactionStart(input, { now: this.deps.now, random: this.deps.random });
            this.reserved = true;
            this.auditTransactionId = prepared.auditTransactionId;
            this.eventId = prepared.eventId;
            this.startRecordId = prepared.recordId;
            this.startPrepared = prepared;
        }
        const prepared = this.startPrepared as PreparedTransactionStart;
        this.state = "START_IN_FLIGHT";

        try {
            const receipt = await sendTransactionStart(prepared, options, this.deps);
            this.state = "STARTED";
            return receipt;
        } catch (error) {
            // Revert to NEW (not a terminal failure state) so a
            // caller-driven retry can call record again and reuse the
            // exact same reserved IDs and bytes reserved above.
            this.state = "NEW";
            throw error;
        }
    }

    /**
     * Prepares `input` (generating and reserving a record_id on first
     * call) and durably completes a previously started transaction, with
     * result server-set to SUCCESS. Deliberately omits `result` from the
     * request itself: the wire contract for complete has no result field
     * at all (unlike abort, which requires one) — sending one would make
     * the server reject the request as carrying an unknown top-level
     * field. The receipt's own `result` still comes back as `"SUCCESS"`
     * from the server's response body.
     */
    async complete(input: AuditTransactionCompleteInput, options: RequestOptions = {}): Promise<TransactionTerminalReceipt> {
        return this.terminal("COMPLETED", { record_id: input.record_id, occurred_at: input.occurred_at, outcome: input.outcome, metadata: input.metadata }, options);
    }

    /**
     * Prepares `input` and durably aborts a previously started
     * transaction. `result` defaults to `"FAILURE"` when omitted; it must
     * be `"FAILURE"` or `"DENIED"`. See `complete` for the shared
     * mutual-exclusion and ordering rules.
     */
    async abort(input: AuditTransactionAbortInput, options: RequestOptions = {}): Promise<TransactionTerminalReceipt> {
        const result = input.result ?? "FAILURE";
        if (result !== "FAILURE" && result !== "DENIED") {
            throw AuditError.validation("abort result must be FAILURE or DENIED");
        }
        return this.terminal("ABORTED", { record_id: input.record_id, occurred_at: input.occurred_at, result, outcome: input.outcome, metadata: input.metadata }, options);
    }

    private async terminal(
        kind: "COMPLETED" | "ABORTED",
        input: { record_id?: string; occurred_at: string | Date; result?: string; outcome?: AuditTransactionCompleteInput["outcome"]; metadata?: Record<string, unknown> },
        options: RequestOptions,
    ): Promise<TransactionTerminalReceipt> {
        if (this.state === "NEW" || this.state === "START_IN_FLIGHT") {
            throw AuditError.validation("transaction: cannot complete/abort before record has succeeded");
        }
        if (this.state === "COMPLETE_IN_FLIGHT" || this.state === "ABORT_IN_FLIGHT") {
            throw AuditError.validation("transaction: a call is already in flight; overlapping calls are not allowed");
        }
        if (this.state === "COMPLETED" || this.state === "ABORTED") {
            throw AuditError.validation("transaction: this transaction already reached a terminal state");
        }
        if (this.terminalChosen && this.terminalKind !== kind) {
            throw AuditError.validation(`transaction: complete and abort are mutually exclusive; this transaction already chose ${String(this.terminalKind)}`);
        }

        if (!this.terminalChosen) {
            const prepared = createTransactionTerminal(
                { record_id: input.record_id, references_record_id: this.startRecordId, occurred_at: input.occurred_at, result: input.result, outcome: input.outcome, metadata: input.metadata },
                { now: this.deps.now, random: this.deps.random },
            );
            this.terminalChosen = true;
            this.terminalKind = kind;
            this.terminalPrepared = prepared;
        }
        const prepared = this.terminalPrepared as PreparedTransactionTerminal;
        this.state = kind === "COMPLETED" ? "COMPLETE_IN_FLIGHT" : "ABORT_IN_FLIGHT";

        try {
            const receipt = await sendTransactionTerminal(this.auditTransactionId, kind === "COMPLETED" ? "complete" : "abort", prepared, options, this.deps);
            this.state = kind;
            return receipt;
        } catch (error) {
            // Revert to STARTED (not a terminal failure state) so a
            // caller-driven retry can call the same method again — the
            // mutual-exclusion check above already pins terminalKind, so
            // a caller cannot flip to the other terminal kind after this.
            this.state = "STARTED";
            throw error;
        }
    }
}
