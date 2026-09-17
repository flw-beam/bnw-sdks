package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// CanonicalizationVersion identifies the algorithm buildCanonicalBytes
// implements — kept in lockstep with audit-service-api's
// internal/core/auditrecord.CanonicalizationVersion. Any change to field
// selection, timestamp formatting, or key naming here is
// evidence-breaking and requires a new version, never an in-place change.
const CanonicalizationVersion = "1"

// HashAlgorithm identifies the hash function canonicalHash implements.
const HashAlgorithm = "sha256"

// canonicalTimeFormat forces UTC and millisecond precision, matching
// Go's server-side format exactly: "2006-01-02T15:04:05.000Z".
const canonicalTimeFormat = "2006-01-02T15:04:05.000Z"

// buildCanonicalObject mirrors auditrecord.CanonicalBytes's field
// selection exactly: optional/absent fields are omitted, never emitted
// as null. input.RecordID/EventID must already be assigned.
func buildCanonicalObject(input EventInput) map[string]any {
	obj := map[string]any{
		"record_id":   input.RecordID,
		"event_id":    input.EventID,
		"occurred_at": input.OccurredAt.UTC().Format(canonicalTimeFormat),
		"event_type":  input.EventType,
		"category":    input.Category,
		"action":      input.Action,
		"result":      string(input.Result),
		"actor":       map[string]any{"type": string(input.Actor.Type), "id": input.Actor.ID},
		"resource":    canonicalResource(input.Resource),
	}
	if input.Context != nil {
		obj["context"] = canonicalContext(*input.Context)
	}
	if input.Outcome != nil {
		obj["outcome"] = canonicalOutcome(*input.Outcome)
	}
	if input.PolicyHints != nil {
		obj["policy_hints"] = canonicalPolicyHints(*input.PolicyHints)
	}
	if len(input.Metadata) > 0 {
		obj["metadata"] = input.Metadata
	}
	return obj
}

func canonicalResource(r Resource) map[string]any {
	out := map[string]any{"type": r.Type, "id": r.ID}
	if len(r.Attributes) > 0 {
		out["attributes"] = r.Attributes
	}
	return out
}

func canonicalContext(c EventContext) map[string]any {
	out := map[string]any{}
	setIfNotEmpty(out, "request_id", c.RequestID)
	setIfNotEmpty(out, "correlation_id", c.CorrelationID)
	setIfNotEmpty(out, "job_id", c.JobID)
	setIfNotEmpty(out, "trace_id", c.TraceID)
	setIfNotEmpty(out, "span_id", c.SpanID)
	setIfNotEmpty(out, "causation_event_id", c.CausationEventID)
	return out
}

func canonicalOutcome(o EventOutcome) map[string]any {
	out := map[string]any{}
	setIfNotEmpty(out, "reason_code", o.ReasonCode)
	setIfNotEmpty(out, "reason_safe", o.ReasonSafe)
	if o.HTTPStatusCode != 0 {
		out["http_status_code"] = o.HTTPStatusCode
	}
	return out
}

func canonicalPolicyHints(p PolicyHints) map[string]any {
	out := map[string]any{}
	if len(p.RegulatoryTags) > 0 {
		out["regulatory_tags"] = p.RegulatoryTags
	}
	setIfNotEmpty(out, "data_classification", string(p.DataClassification))
	return out
}

func setIfNotEmpty(obj map[string]any, key, value string) {
	if value != "" {
		obj[key] = value
	}
}

// canonicalMarshal mirrors audit-service-api's internal/core/
// canonicaljson.Marshal exactly: encoding/json.Marshal on a
// map[string]any already sorts object keys (Go's own documented
// behavior) and produces compact output with no insignificant
// whitespace; disabling HTML escaping (SetEscapeHTML(false)) matches
// the server's own canonicalization path. Go's encoder — like the
// server's — always escapes U+2028/U+2029 regardless of that setting,
// so no special-casing is needed for the one place a naive
// implementation could disagree across languages (see the JS SDK's
// canonical.ts for that exact cross-language pitfall).
func canonicalMarshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// canonicalHash returns the sha256:<lowercase hex> fingerprint of
// canonicalBytes, matching auditrecord.Hash exactly.
func canonicalHash(canonicalBytes []byte) string {
	sum := sha256.Sum256(canonicalBytes)
	return "sha256:" + hex.EncodeToString(sum[:])
}
