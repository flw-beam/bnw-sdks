package audit

import "time"

// ActorType is the closed set of principal kinds, mirroring
// domain.ActorType in audit-service-api. Duplicated here deliberately —
// this module imports nothing from audit-service-api's internal/**; SDK
// behavior is proven against the shared conformance fixtures instead of
// private package reuse.
type ActorType string

const (
	ActorTypeAdmin   ActorType = "ADMIN"
	ActorTypeService ActorType = "SERVICE"
	ActorTypeSystem  ActorType = "SYSTEM"
	ActorTypeUser    ActorType = "USER"
)

// AuditResult is the closed one-shot result enum, mirroring domain.AuditResult.
type AuditResult string

const (
	ResultSuccess AuditResult = "SUCCESS"
	ResultFailure AuditResult = "FAILURE"
	ResultDenied  AuditResult = "DENIED"
)

// DataClassification mirrors domain.DataClassification.
type DataClassification string

const (
	DataClassificationPublic       DataClassification = "PUBLIC"
	DataClassificationInternal     DataClassification = "INTERNAL"
	DataClassificationConfidential DataClassification = "CONFIDENTIAL"
	DataClassificationRestricted   DataClassification = "RESTRICTED"
)

// Actor is the principal that performed or attempted the action.
type Actor struct {
	Type ActorType `json:"type"`
	ID   string    `json:"id"`
}

// Resource is the primary object affected or targeted by the action.
type Resource struct {
	Type       string         `json:"type"`
	ID         string         `json:"id"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

// EventContext carries operational references that help investigators
// correlate evidence without changing its identity.
type EventContext struct {
	RequestID        string `json:"request_id,omitempty"`
	CorrelationID    string `json:"correlation_id,omitempty"`
	JobID            string `json:"job_id,omitempty"`
	TraceID          string `json:"trace_id,omitempty"`
	SpanID           string `json:"span_id,omitempty"`
	CausationEventID string `json:"causation_event_id,omitempty"`
}

// EventOutcome supplies safe structured details explaining a final result.
type EventOutcome struct {
	ReasonCode     string `json:"reason_code,omitempty"`
	ReasonSafe     string `json:"reason_safe,omitempty"`
	HTTPStatusCode int    `json:"http_status_code,omitempty"`
}

// PolicyHints carries producer-supplied classification hints. The server
// validates them and applies authoritative policy; this SDK cannot
// weaken retention or protection through this value.
type PolicyHints struct {
	RegulatoryTags     []string           `json:"regulatory_tags,omitempty"`
	DataClassification DataClassification `json:"data_classification,omitempty"`
}

// EventInput is the producer-authored one-shot event. RecordID/EventID
// are normally left empty so CreateEvent generates and reuses stable
// ULIDs; set them only to re-prepare an event you already generated IDs
// for. There is no field for tenant_id/producer_id/environment/
// accepted_at — a caller cannot even attempt to set a server-owned
// field, because EventInput's Go type has no such field to set. This is
// this module's answer to "reject caller attempts to provide tenant/
// producer/environment/server fields": enforced by the type system, not
// a runtime check.
type EventInput struct {
	RecordID    string         `json:"record_id,omitempty"`
	EventID     string         `json:"event_id,omitempty"`
	OccurredAt  time.Time      `json:"occurred_at"`
	EventType   string         `json:"event_type"`
	Category    string         `json:"category"`
	Action      string         `json:"action"`
	Result      AuditResult    `json:"result"`
	Actor       Actor          `json:"actor"`
	Resource    Resource       `json:"resource"`
	Context     *EventContext  `json:"context,omitempty"`
	Outcome     *EventOutcome  `json:"outcome,omitempty"`
	PolicyHints *PolicyHints   `json:"policy_hints,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

// PreparedEvent is the immutable, already-canonicalized outcome of
// CreateEvent. Payload is the exact canonical JSON bytes sent as the
// request body — every retry of the same logical call reuses these
// exact bytes.
type PreparedEvent struct {
	RecordID   string
	EventID    string
	OccurredAt string
	Payload    []byte
}

// RecordReceipt is one resolved delivery outcome. ACCEPTED and DUPLICATE
// are both success.
type RecordReceipt struct {
	RecordID   string
	EventID    string
	Status     string // "ACCEPTED" or "DUPLICATE"
	AcceptedAt string
	RequestID  string
}

// RecordOptions carries the per-call knobs Record accepts beyond ctx and
// the event itself. Cancellation and the overall call deadline are
// controlled by ctx, per Go idiom — there is no separate signal type.
type RecordOptions struct {
	// RequestID, if set, is reused across every attempt of this logical
	// call instead of one this SDK generates.
	RequestID string
	// Timeout bounds each individual attempt (not the whole call,
	// including backoff — bound that with ctx instead). Zero uses
	// Config.Timeout.
	Timeout time.Duration
}
