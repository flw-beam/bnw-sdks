package audit

import "time"

// TransactionState is the closed set of states a Transaction helper
// moves through. It is never persisted or resumed across a process
// restart — see the README's "Transaction lifecycle" section.
type TransactionState string

const (
	TransactionStateNew              TransactionState = "NEW"
	TransactionStateStartInFlight    TransactionState = "START_IN_FLIGHT"
	TransactionStateStarted          TransactionState = "STARTED"
	TransactionStateCompleteInFlight TransactionState = "COMPLETE_IN_FLIGHT"
	TransactionStateAbortInFlight    TransactionState = "ABORT_IN_FLIGHT"
	TransactionStateCompleted        TransactionState = "COMPLETED"
	TransactionStateAborted          TransactionState = "ABORTED"
)

// TransactionStartInput is the producer-authored payload opening one
// Audit Transaction. record_id/event_id/audit_transaction_id are
// normally left empty so Record generates and reuses stable ULIDs.
// There is no field for tenant_id/producer_id/environment/result — a
// caller cannot even attempt to set a server-owned field, because this
// type has no such field to set.
type TransactionStartInput struct {
	RecordID           string         `json:"record_id,omitempty"`
	EventID            string         `json:"event_id,omitempty"`
	AuditTransactionID string         `json:"audit_transaction_id,omitempty"`
	OccurredAt         time.Time      `json:"occurred_at"`
	EventType          string         `json:"event_type"`
	Category           string         `json:"category"`
	Action             string         `json:"action"`
	Actor              Actor          `json:"actor"`
	Resource           Resource       `json:"resource"`
	Context            *EventContext  `json:"context,omitempty"`
	PolicyHints        *PolicyHints   `json:"policy_hints,omitempty"`
	Metadata           map[string]any `json:"metadata,omitempty"`
}

// TransactionStartReceipt is the resolved outcome of a start call.
// Status may be ACCEPTED or DUPLICATE — both are success.
type TransactionStartReceipt struct {
	AuditTransactionID string
	EventID            string
	RecordID           string
	LifecycleState     string
	LifecyclePosition  int
	Status             string
	AcceptedAt         string
	RequestID          string
}

// TransactionCompleteInput is the producer-authored delta completing a
// previously started Audit Transaction. RecordID is normally left empty
// so Complete generates and reuses a stable ULID. There is no field for
// event ID, actor, resource, event type, category, action, result,
// producer, environment, or tenant — the API/processor inherits
// immutable start identity, and a completed result is always
// server-set to SUCCESS.
type TransactionCompleteInput struct {
	RecordID   string         `json:"record_id,omitempty"`
	OccurredAt time.Time      `json:"occurred_at"`
	Outcome    *EventOutcome  `json:"outcome,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// TransactionAbortInput is the producer-authored delta aborting a
// previously started Audit Transaction. Result defaults to
// ResultFailure when left empty; it must be ResultFailure or
// ResultDenied.
type TransactionAbortInput struct {
	RecordID   string         `json:"record_id,omitempty"`
	OccurredAt time.Time      `json:"occurred_at"`
	Result     AuditResult    `json:"result,omitempty"`
	Outcome    *EventOutcome  `json:"outcome,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// TransactionTerminalReceipt is the resolved outcome of a complete/abort
// call. Status may be ACCEPTED or DUPLICATE — both are success.
type TransactionTerminalReceipt struct {
	AuditTransactionID string
	EventID            string
	RecordID           string
	ReferencesRecordID string
	LifecycleState     string
	LifecyclePosition  int
	Result             string
	Status             string
	AcceptedAt         string
	RequestID          string
}

// preparedTransactionStart is the immutable, already-canonicalized
// outcome of createTransactionStart. Payload is the exact JSON bytes
// sent as the request body — every retry of the same logical call
// reuses these exact bytes.
type preparedTransactionStart struct {
	AuditTransactionID string
	EventID            string
	RecordID           string
	OccurredAt         string
	Payload            []byte
}

// preparedTransactionTerminal is the immutable, already-canonicalized
// outcome of createTransactionTerminal.
type preparedTransactionTerminal struct {
	RecordID           string
	ReferencesRecordID string
	OccurredAt         string
	Result             string
	Payload            []byte
}

// transactionTerminalInput is the internal, kind-neutral shape both
// Complete and Abort funnel into before preparation.
type transactionTerminalInput struct {
	RecordID           string
	ReferencesRecordID string
	OccurredAt         time.Time
	Result             AuditResult
	Outcome            *EventOutcome
	Metadata           map[string]any
}
