package audit

import (
	"fmt"
	"time"
)

// MaxCanonicalRecordBytes is the contract's canonical record size
// ceiling, matching audit-service-api's auditrecord.MaxCanonicalRecordBytes.
const MaxCanonicalRecordBytes = 32 * 1024

// createEvent mirrors audit-service-api's Prepare pipeline
// (internal/core/auditrecord/prepare.go), minus the parts only the
// server can do (registry lookup, duplicate-key/unknown-field rejection
// of raw wire bytes it did not author itself).
//
// PreparedEvent.Payload never retains a live reference to input's own
// maps (Metadata, Resource.Attributes) — by the time this returns, the
// event has already been fully serialized to an immutable []byte. A
// caller mutating their original input afterward cannot change what a
// later retry sends under the same record_id; this is this module's
// Go-idiomatic equivalent of the JS SDK's explicit deep-freeze step.
func createEvent(input EventInput, now func() time.Time, random func() float64) (PreparedEvent, error) {
	if err := validateEventInput(input); err != nil {
		return PreparedEvent{}, err
	}

	generatedAt := now()
	recordID := input.RecordID
	if recordID == "" {
		id, err := newULID(generatedAt)
		if err != nil {
			return PreparedEvent{}, newConfigError("failed to generate record_id: " + err.Error())
		}
		recordID = id
	}
	eventID := input.EventID
	if eventID == "" {
		id, err := newULID(generatedAt)
		if err != nil {
			return PreparedEvent{}, newConfigError("failed to generate event_id: " + err.Error())
		}
		eventID = id
	}

	withIDs := input
	withIDs.RecordID = recordID
	withIDs.EventID = eventID

	canonicalObject := buildCanonicalObject(withIDs)
	payload, err := canonicalMarshal(canonicalObject)
	if err != nil {
		return PreparedEvent{}, newValidationError("failed to canonicalize event: " + err.Error())
	}
	if len(payload) > MaxCanonicalRecordBytes {
		return PreparedEvent{}, newValidationError(fmt.Sprintf("canonical record of %d bytes exceeds the %d-byte contract limit", len(payload), MaxCanonicalRecordBytes))
	}

	occurredAt, _ := canonicalObject["occurred_at"].(string)
	return PreparedEvent{
		RecordID:   recordID,
		EventID:    eventID,
		OccurredAt: occurredAt,
		Payload:    payload,
	}, nil
}
