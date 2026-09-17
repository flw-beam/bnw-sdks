package audit

import (
	"fmt"
	"time"
)

// buildTransactionStartObject builds the deterministic JSON object sent
// as a start request body, matching audit-service-api's
// schemas.AuditTransactionStartRequest field-for-field. Unlike one-shot's
// canonicalization, this is not the server's internal audit_records
// canonicalization (that inherits lifecycle_state/position server-side
// and is owned entirely by internal/core/audittransaction) — it exists
// only so a retry of the same logical call sends byte-identical bytes.
func buildTransactionStartObject(input TransactionStartInput) map[string]any {
	obj := map[string]any{
		"record_id":            input.RecordID,
		"event_id":             input.EventID,
		"audit_transaction_id": input.AuditTransactionID,
		"occurred_at":          input.OccurredAt.UTC().Format(canonicalTimeFormat),
		"event_type":           input.EventType,
		"category":             input.Category,
		"action":               input.Action,
		"actor":                map[string]any{"type": string(input.Actor.Type), "id": input.Actor.ID},
		"resource":             canonicalResource(input.Resource),
	}
	if input.Context != nil {
		obj["context"] = canonicalContext(*input.Context)
	}
	if input.PolicyHints != nil {
		obj["policy_hints"] = canonicalPolicyHints(*input.PolicyHints)
	}
	if len(input.Metadata) > 0 {
		obj["metadata"] = input.Metadata
	}
	return obj
}

func buildTransactionTerminalObject(input transactionTerminalInput) map[string]any {
	obj := map[string]any{
		"record_id":            input.RecordID,
		"references_record_id": input.ReferencesRecordID,
		"occurred_at":          input.OccurredAt.UTC().Format(canonicalTimeFormat),
	}
	if input.Result != "" {
		obj["result"] = string(input.Result)
	}
	if input.Outcome != nil {
		obj["outcome"] = canonicalOutcome(*input.Outcome)
	}
	if len(input.Metadata) > 0 {
		obj["metadata"] = input.Metadata
	}
	return obj
}

// createTransactionStart validates input, assigns stable IDs, and
// canonicalizes it once. The result is safe to retry — resending it
// never changes its identity or bytes.
func createTransactionStart(input TransactionStartInput, now func() time.Time, random func() float64) (preparedTransactionStart, error) {
	if err := validateTransactionStartInput(input); err != nil {
		return preparedTransactionStart{}, err
	}

	generatedAt := now()
	recordID := input.RecordID
	if recordID == "" {
		id, err := newULID(generatedAt)
		if err != nil {
			return preparedTransactionStart{}, newConfigError("failed to generate record_id: " + err.Error())
		}
		recordID = id
	}
	eventID := input.EventID
	if eventID == "" {
		id, err := newULID(generatedAt)
		if err != nil {
			return preparedTransactionStart{}, newConfigError("failed to generate event_id: " + err.Error())
		}
		eventID = id
	}
	auditTransactionID := input.AuditTransactionID
	if auditTransactionID == "" {
		id, err := newULID(generatedAt)
		if err != nil {
			return preparedTransactionStart{}, newConfigError("failed to generate audit_transaction_id: " + err.Error())
		}
		auditTransactionID = id
	}

	withIDs := input
	withIDs.RecordID = recordID
	withIDs.EventID = eventID
	withIDs.AuditTransactionID = auditTransactionID

	canonicalObject := buildTransactionStartObject(withIDs)
	payload, err := canonicalMarshal(canonicalObject)
	if err != nil {
		return preparedTransactionStart{}, newValidationError("failed to canonicalize transaction start: " + err.Error())
	}
	if len(payload) > MaxCanonicalRecordBytes {
		return preparedTransactionStart{}, newValidationError(fmt.Sprintf("canonical record of %d bytes exceeds the %d-byte contract limit", len(payload), MaxCanonicalRecordBytes))
	}

	occurredAt, _ := canonicalObject["occurred_at"].(string)
	return preparedTransactionStart{
		AuditTransactionID: auditTransactionID,
		EventID:            eventID,
		RecordID:           recordID,
		OccurredAt:         occurredAt,
		Payload:            payload,
	}, nil
}

// createTransactionTerminal validates input, assigns a stable record_id,
// and canonicalizes it once.
func createTransactionTerminal(input transactionTerminalInput, now func() time.Time, random func() float64) (preparedTransactionTerminal, error) {
	if err := validateTransactionTerminalInput(input); err != nil {
		return preparedTransactionTerminal{}, err
	}

	recordID := input.RecordID
	if recordID == "" {
		id, err := newULID(now())
		if err != nil {
			return preparedTransactionTerminal{}, newConfigError("failed to generate record_id: " + err.Error())
		}
		recordID = id
	}
	withID := input
	withID.RecordID = recordID

	canonicalObject := buildTransactionTerminalObject(withID)
	payload, err := canonicalMarshal(canonicalObject)
	if err != nil {
		return preparedTransactionTerminal{}, newValidationError("failed to canonicalize transaction terminal: " + err.Error())
	}
	if len(payload) > MaxCanonicalRecordBytes {
		return preparedTransactionTerminal{}, newValidationError(fmt.Sprintf("canonical record of %d bytes exceeds the %d-byte contract limit", len(payload), MaxCanonicalRecordBytes))
	}

	occurredAt, _ := canonicalObject["occurred_at"].(string)
	return preparedTransactionTerminal{
		RecordID:           recordID,
		ReferencesRecordID: input.ReferencesRecordID,
		OccurredAt:         occurredAt,
		Result:             string(input.Result),
		Payload:            payload,
	}, nil
}

// validateTransactionStartInput mirrors the client-checkable subset of
// audit-service-api's internal/core/audittransaction.ValidateStart.
// "Start result absent" is enforced by TransactionStartInput's shape,
// not a runtime check — the type has no Result field to be present.
func validateTransactionStartInput(input TransactionStartInput) error {
	if input.OccurredAt.IsZero() {
		return newValidationError("occurred_at is required")
	}
	if input.EventType == "" {
		return newValidationError("event_type is required")
	}
	if input.Category == "" {
		return newValidationError("category is required")
	}
	if input.Action == "" {
		return newValidationError("action is required")
	}
	if len(input.EventType) < 3 || len(input.EventType) > 120 || !eventTypePattern.MatchString(input.EventType) {
		return newValidationError("event_type must be a lowercase dotted name of 3-120 characters")
	}
	if input.RecordID != "" && !isValidULID(input.RecordID) {
		return newValidationError("record_id is not a valid ULID")
	}
	if input.EventID != "" && !isValidULID(input.EventID) {
		return newValidationError("event_id is not a valid ULID")
	}
	if input.AuditTransactionID != "" && !isValidULID(input.AuditTransactionID) {
		return newValidationError("audit_transaction_id is not a valid ULID")
	}

	if err := validateOpaqueID("actor.id", input.Actor.ID); err != nil {
		return err
	}
	if !validActorTypes[input.Actor.Type] {
		return newValidationError("actor.type must be one of ADMIN, SERVICE, SYSTEM, USER")
	}
	if input.Resource.Type == "" {
		return newValidationError("resource.type is required")
	}
	if err := validateOpaqueID("resource.id", input.Resource.ID); err != nil {
		return err
	}
	if input.Context != nil && input.Context.CausationEventID != "" && !isValidULID(input.Context.CausationEventID) {
		return newValidationError("context.causation_event_id is not a valid ULID")
	}
	if len(input.Metadata) > 0 {
		if err := validateMetadataBounds(input.Metadata, "metadata"); err != nil {
			return err
		}
		if err := validateProhibitedContent(input.Metadata, "metadata"); err != nil {
			return err
		}
	}
	return nil
}

// validateTransactionTerminalInput mirrors the client-checkable subset
// of internal/core/audittransaction.ValidateTerminalTransition's
// caller-controllable fields (identity/reference/lifecycle-position
// invariants are the server's job, since a client cannot know the
// visible start's identity to compare against).
func validateTransactionTerminalInput(input transactionTerminalInput) error {
	if input.ReferencesRecordID == "" {
		return newValidationError("references_record_id is required")
	}
	if !isValidULID(input.ReferencesRecordID) {
		return newValidationError("references_record_id is not a valid ULID")
	}
	if input.OccurredAt.IsZero() {
		return newValidationError("occurred_at is required")
	}
	if input.RecordID != "" && !isValidULID(input.RecordID) {
		return newValidationError("record_id is not a valid ULID")
	}
	if input.Result != "" && input.Result != ResultSuccess && input.Result != ResultFailure && input.Result != ResultDenied {
		return newValidationError("result must be one of SUCCESS, FAILURE, DENIED")
	}
	if len(input.Metadata) > 0 {
		if err := validateMetadataBounds(input.Metadata, "metadata"); err != nil {
			return err
		}
		if err := validateProhibitedContent(input.Metadata, "metadata"); err != nil {
			return err
		}
	}
	return nil
}
