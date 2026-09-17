package audit

import (
	"regexp"
	"strings"
)

// Universal local validation, mirroring the client-checkable subset of
// audit-service-api's internal/core/auditrecord/validate.go exactly
// (independently re-implemented, not imported — see this module's own
// "no imports from internal/**" rule). Registry-specific rules
// (event_type registration, category/action pairing, per-field metadata
// schema review) are deliberately not enforced here: this module ships
// no bundled registry snapshot, and the server remains authoritative
// for those.
var eventTypePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`)

const (
	maxMetadataKeys  = 20
	maxMetadataBytes = 8 * 1024
	maxMetadataDepth = 3
	maxArrayElements = 100
	maxOpaqueIDLen   = 255
)

// prohibitedMetadataKeys mirrors auditrecord.prohibitedMetadataKeys exactly.
var prohibitedMetadataKeys = []string{
	"password", "passwd", "secret", "token", "api_key", "apikey", "private_key",
	"cvv", "card_number", "card_num", "pan", "stack_trace", "stacktrace", "full_body",
}

var validActorTypes = map[ActorType]bool{ActorTypeAdmin: true, ActorTypeService: true, ActorTypeSystem: true, ActorTypeUser: true}
var validResults = map[AuditResult]bool{ResultSuccess: true, ResultFailure: true, ResultDenied: true}

func validateEventInput(input EventInput) error {
	if input.EventType == "" {
		return newValidationError("event_type is required")
	}
	if input.Category == "" {
		return newValidationError("category is required")
	}
	if input.Action == "" {
		return newValidationError("action is required")
	}
	if input.Result == "" {
		return newValidationError("result is required")
	}
	if input.OccurredAt.IsZero() {
		return newValidationError("occurred_at is required")
	}
	if !validResults[input.Result] {
		return newValidationError("result must be one of SUCCESS, FAILURE, DENIED")
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

	if err := validateOpaqueID("actor.id", input.Actor.ID); err != nil {
		return err
	}
	if strings.Contains(input.Actor.ID, "@") {
		return newValidationError("actor.id must not be an email address")
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
	if len(input.Resource.Attributes) > 0 {
		if err := validateProhibitedContent(input.Resource.Attributes, "resource.attributes"); err != nil {
			return err
		}
	}
	return nil
}

func validateOpaqueID(field, id string) error {
	if id == "" || len(id) > maxOpaqueIDLen {
		return newValidationError(field + " must be 1-255 characters")
	}
	return nil
}

func validateMetadataBounds(metadata map[string]any, field string) error {
	if len(metadata) > maxMetadataKeys {
		return newValidationError(field + " has more than 20 keys")
	}
	if valueDepth(metadata, 0) > maxMetadataDepth {
		return newValidationError(field + " exceeds the maximum nesting depth")
	}
	if err := validateArrayBounds(metadata, field); err != nil {
		return err
	}
	encoded, err := canonicalMarshal(metadata)
	if err != nil {
		return newValidationError(field + " could not be serialized")
	}
	if len(encoded) > maxMetadataBytes {
		return newValidationError(field + " exceeds 8KB")
	}
	return nil
}

func valueDepth(v any, current int) int {
	switch t := v.(type) {
	case map[string]any:
		maxDepth := current
		for _, val := range t {
			if d := valueDepth(val, current+1); d > maxDepth {
				maxDepth = d
			}
		}
		return maxDepth
	case []any:
		maxDepth := current
		for _, val := range t {
			if d := valueDepth(val, current+1); d > maxDepth {
				maxDepth = d
			}
		}
		return maxDepth
	default:
		return current
	}
}

func validateArrayBounds(v any, field string) error {
	switch t := v.(type) {
	case map[string]any:
		for _, val := range t {
			if err := validateArrayBounds(val, field); err != nil {
				return err
			}
		}
	case []any:
		if len(t) > maxArrayElements {
			return newValidationError(field + " contains an array exceeding 100 elements")
		}
		for _, val := range t {
			if err := validateArrayBounds(val, field); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateProhibitedContent rejects any key in v, at any depth, that
// matches a prohibited secret-shaped field name. Only the field name
// ever appears in the returned error; the value is never inspected for
// error-message purposes.
func validateProhibitedContent(v map[string]any, path string) error {
	for key, val := range v {
		lower := strings.ToLower(key)
		for _, blocked := range prohibitedMetadataKeys {
			if strings.Contains(lower, blocked) {
				return newValidationError("field name \"" + path + "." + key + "\" matches a prohibited secret-shaped pattern")
			}
		}
		if nested, ok := val.(map[string]any); ok {
			if err := validateProhibitedContent(nested, path+"."+key); err != nil {
				return err
			}
		}
	}
	return nil
}
