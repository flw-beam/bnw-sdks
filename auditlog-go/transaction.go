package audit

import (
	"context"
	"sync"
)

// Transaction is a one-owner, process-local helper for one Audit
// Transaction lifecycle: NEW -> START_IN_FLIGHT -> STARTED, then STARTED
// -> COMPLETE_IN_FLIGHT -> COMPLETED or STARTED -> ABORT_IN_FLIGHT ->
// ABORTED. It is NOT safe for concurrent use by multiple goroutines in
// the sense of issuing two overlapping Record/Complete/Abort calls —
// construct one Transaction per logical business operation and do not
// share it across goroutines that might call it concurrently. It does
// serialize itself defensively (a busy guard rejects an overlapping
// call rather than corrupting state), but that guard exists to fail
// loudly, not to make concurrent use a supported pattern. The main
// Client remains safe for concurrent use across many Transactions.
//
// A Transaction holds no durable state and cannot be resumed after a
// process restart. If the process crashes after Record succeeds but
// before Complete/Abort is called, the evidence honestly remains
// STARTED — see the README's "Transaction lifecycle" section and
// internal/testutils/testdata/contracts/sdk/v1/transactions/manifest.json's
// process_crash_recovery guidance.
type Transaction struct {
	mu     sync.Mutex
	client *Client
	state  TransactionState

	reserved           bool
	auditTransactionID string
	eventID            string
	startRecordID      string
	startPrepared      preparedTransactionStart

	terminalChosen   bool
	terminalKind     TransactionState // TransactionStateCompleted or TransactionStateAborted once chosen
	terminalPrepared preparedTransactionTerminal
}

// NewTransaction constructs a new, unstarted Transaction bound to c.
func (c *Client) NewTransaction() *Transaction {
	return newTransaction(c)
}

func newTransaction(c *Client) *Transaction {
	return &Transaction{client: c, state: TransactionStateNew}
}

func (t *Transaction) lock()   { t.mu.Lock() }
func (t *Transaction) unlock() { t.mu.Unlock() }

// State reports the Transaction's current state. Safe for concurrent use.
func (t *Transaction) State() TransactionState {
	t.lock()
	defer t.unlock()
	return t.state
}

// AuditTransactionID reports the reserved transaction ID, or "" before
// the first Record call has reserved one. A caller that needs to persist
// this ID for restart-recovery purposes (see the README) should read it
// only after Record has returned successfully.
func (t *Transaction) AuditTransactionID() string {
	t.lock()
	defer t.unlock()
	return t.auditTransactionID
}

// EventID reports the reserved event ID, or "" before the first Record
// call has reserved one.
func (t *Transaction) EventID() string {
	t.lock()
	defer t.unlock()
	return t.eventID
}

// StartRecordID reports the reserved start record ID, or "" before the
// first Record call has reserved one.
func (t *Transaction) StartRecordID() string {
	t.lock()
	defer t.unlock()
	return t.startRecordID
}

// newTransactionStateError reports an invalid call against the
// Transaction's current state (busy, wrong order, already terminal, or
// mutual exclusion). It returns *APIError (CodeValidationError,
// non-retryable) so callers branch on err.(*APIError) exactly the way
// they already do for every other validation failure in this module.
func newTransactionStateError(message string) error {
	return newValidationError(message)
}

// Record prepares input (generating and reserving audit_transaction_id/
// event_id/record_id on first call) and durably starts the transaction,
// retrying eligible transient failures with the exact same prepared
// bytes. It resolves for both ACCEPTED and DUPLICATE.
//
// Calling Record again after it already succeeded is rejected — a
// Transaction starts at most once. Calling Record again after a failed
// attempt is allowed and reuses the exact same reserved IDs and prepared
// bytes, so a caller-driven retry (beyond this call's own internal retry
// budget) remains idempotent.
func (t *Transaction) Record(ctx context.Context, input TransactionStartInput, opts RecordOptions) (TransactionStartReceipt, error) {
	t.lock()
	switch t.state {
	case TransactionStateStartInFlight, TransactionStateCompleteInFlight, TransactionStateAbortInFlight:
		t.unlock()
		return TransactionStartReceipt{}, newTransactionStateError("transaction: a call is already in flight; overlapping calls are not allowed")
	case TransactionStateStarted, TransactionStateCompleted, TransactionStateAborted:
		t.unlock()
		return TransactionStartReceipt{}, newTransactionStateError("transaction: Record can only succeed once per transaction; this transaction has already started")
	}
	// t.state == TransactionStateNew here.
	if !t.reserved {
		prepared, err := createTransactionStart(input, t.client.now, t.client.random)
		if err != nil {
			t.unlock()
			return TransactionStartReceipt{}, err
		}
		t.reserved = true
		t.auditTransactionID = prepared.AuditTransactionID
		t.eventID = prepared.EventID
		t.startRecordID = prepared.RecordID
		t.startPrepared = prepared
	}
	prepared := t.startPrepared
	t.state = TransactionStateStartInFlight
	t.unlock()

	receipt, err := t.client.sendTransactionStart(ctx, prepared, opts)

	t.lock()
	if err != nil {
		// Revert to NEW (not a terminal failure state) so a caller-driven
		// retry can call Record again and reuse the exact same reserved
		// IDs and bytes reserved above.
		t.state = TransactionStateNew
		t.unlock()
		return TransactionStartReceipt{}, err
	}
	t.state = TransactionStateStarted
	t.unlock()
	return receipt, nil
}

// Complete prepares input (generating and reserving a record_id on first
// call) and durably completes a previously started transaction, with
// result server-set to SUCCESS. It retries eligible transient failures
// with the exact same prepared bytes.
//
// Complete and Abort are mutually exclusive: once either has been
// chosen for this Transaction, calling the other returns an error
// without sending a request. Calling Complete before Record has
// succeeded, or after a terminal outcome already succeeded, is also
// rejected.
func (t *Transaction) Complete(ctx context.Context, input TransactionCompleteInput, opts RecordOptions) (TransactionTerminalReceipt, error) {
	return t.terminal(ctx, TransactionStateCompleted, transactionTerminalInput{
		RecordID:   input.RecordID,
		OccurredAt: input.OccurredAt,
		// Deliberately no Result here: the wire contract for /complete
		// has no result field at all (the server always sets it to
		// SUCCESS) — unlike /abort, which requires one. Setting Result
		// here would make buildTransactionTerminalObject include an
		// "unknown top-level field" the server's complete schema
		// rejects. The receipt's own Result still comes back as
		// "SUCCESS" from the server's response body.
		Outcome:  input.Outcome,
		Metadata: input.Metadata,
	}, opts)
}

// Abort prepares input and durably aborts a previously started
// transaction. Result defaults to ResultFailure when input.Result is
// empty; it must be ResultFailure or ResultDenied. See Complete for the
// shared mutual-exclusion and ordering rules.
func (t *Transaction) Abort(ctx context.Context, input TransactionAbortInput, opts RecordOptions) (TransactionTerminalReceipt, error) {
	result := input.Result
	if result == "" {
		result = ResultFailure
	}
	if result != ResultFailure && result != ResultDenied {
		return TransactionTerminalReceipt{}, newValidationError("abort result must be FAILURE or DENIED")
	}
	return t.terminal(ctx, TransactionStateAborted, transactionTerminalInput{
		RecordID:   input.RecordID,
		OccurredAt: input.OccurredAt,
		Result:     result,
		Outcome:    input.Outcome,
		Metadata:   input.Metadata,
	}, opts)
}

// terminal is the shared Complete/Abort implementation: kind is
// TransactionStateCompleted or TransactionStateAborted, chosen by the
// caller (Complete/Abort) before this function ever inspects state, so
// the mutual-exclusion check below always compares against the
// caller's actual intent.
func (t *Transaction) terminal(ctx context.Context, kind TransactionState, input transactionTerminalInput, opts RecordOptions) (TransactionTerminalReceipt, error) {
	t.lock()
	switch t.state {
	case TransactionStateNew, TransactionStateStartInFlight:
		t.unlock()
		return TransactionTerminalReceipt{}, newTransactionStateError("transaction: cannot complete/abort before Record has succeeded")
	case TransactionStateCompleteInFlight, TransactionStateAbortInFlight:
		t.unlock()
		return TransactionTerminalReceipt{}, newTransactionStateError("transaction: a call is already in flight; overlapping calls are not allowed")
	case TransactionStateCompleted, TransactionStateAborted:
		t.unlock()
		return TransactionTerminalReceipt{}, newTransactionStateError("transaction: this transaction already reached a terminal state")
	}
	if t.terminalChosen && t.terminalKind != kind {
		t.unlock()
		return TransactionTerminalReceipt{}, newTransactionStateError("transaction: complete and abort are mutually exclusive; this transaction already chose " + string(t.terminalKind))
	}
	// t.state == TransactionStateStarted here.
	if !t.terminalChosen {
		input.ReferencesRecordID = t.startRecordID
		prepared, err := createTransactionTerminal(input, t.client.now, t.client.random)
		if err != nil {
			t.unlock()
			return TransactionTerminalReceipt{}, err
		}
		t.terminalChosen = true
		t.terminalKind = kind
		t.terminalPrepared = prepared
	}
	prepared := t.terminalPrepared
	auditTransactionID := t.auditTransactionID
	inFlight := TransactionStateCompleteInFlight
	if kind == TransactionStateAborted {
		inFlight = TransactionStateAbortInFlight
	}
	t.state = inFlight
	t.unlock()

	receipt, err := t.client.sendTransactionTerminal(ctx, auditTransactionID, kind, prepared, opts)

	t.lock()
	if err != nil {
		// Revert to STARTED (not a terminal failure state) so a
		// caller-driven retry can call the same method again — the
		// mutual-exclusion check above already pins terminalKind, so a
		// caller cannot flip to the other terminal kind after this.
		t.state = TransactionStateStarted
		t.unlock()
		return TransactionTerminalReceipt{}, err
	}
	t.state = kind
	t.unlock()
	return receipt, nil
}
