package audit

import (
	"bytes"
	"fmt"
	"time"
)

// MaxBatchRecords is the contract's per-batch item ceiling, matching
// audit-service-api's DecodeBatch default
// (internal/core/auditrecord/batchdecode.go).
const MaxBatchRecords = 500

// PreparedBatch is one network-ready batch chunk: up to MaxBatchRecords
// prepared items, in original order, plus the exact canonical JSON
// envelope body ({"records":[...]}). Payload is built by concatenating
// each item's own canonical bytes verbatim, never reserializing an item
// — the server hashes each item independently from its own bytes, so
// this is byte-for-byte what a one-shot POST of that same item would
// have sent.
type PreparedBatch struct {
	Items   []PreparedEvent
	Payload []byte
}

// CreateBatch assigns stable IDs and canonicalizes every input once,
// then splits the result into one or more network-ready chunks bounded
// by MaxBatchRecords, preserving input order across chunk boundaries.
// Performs no network I/O. Fails closed: if any input fails to prepare,
// no chunk is returned at all — a batch call must not partially
// construct itself around a caller bug in one item.
func (c *Client) CreateBatch(inputs []EventInput) ([]PreparedBatch, error) {
	return createBatch(inputs, c.now, c.random)
}

func createBatch(inputs []EventInput, now func() time.Time, random func() float64) ([]PreparedBatch, error) {
	if len(inputs) == 0 {
		return nil, newValidationError("batch must contain at least one record")
	}
	prepared := make([]PreparedEvent, len(inputs))
	for i, input := range inputs {
		item, err := createEvent(input, now, random)
		if err != nil {
			return nil, fmt.Errorf("batch item %d: %w", i, err)
		}
		prepared[i] = item
	}
	return chunkPrepared(prepared), nil
}

// chunkPrepared splits items into consecutive, order-preserving chunks
// of at most MaxBatchRecords each.
func chunkPrepared(items []PreparedEvent) []PreparedBatch {
	batches := make([]PreparedBatch, 0, (len(items)+MaxBatchRecords-1)/MaxBatchRecords)
	for start := 0; start < len(items); start += MaxBatchRecords {
		end := min(start+MaxBatchRecords, len(items))
		chunk := items[start:end]
		batches = append(batches, PreparedBatch{Items: chunk, Payload: buildBatchPayload(chunk)})
	}
	return batches
}

func buildBatchPayload(items []PreparedEvent) []byte {
	var buf bytes.Buffer
	buf.WriteString(`{"records":[`)
	for i, item := range items {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(item.Payload)
	}
	buf.WriteString(`]}`)
	return buf.Bytes()
}

// BatchItemError is one item's safe, stable rejection reason, mirroring
// audit-service-api's schemas.BatchItemError.
type BatchItemError struct {
	Code      string
	Message   string
	Retryable bool
}

// BatchItemResult is one input record's independent resolved outcome.
// Index is relative to the original input slice passed to
// SendBatch/CreateBatch, not to whichever chunk the item landed in.
type BatchItemResult struct {
	Index      int
	RecordID   string
	EventID    string
	Status     string // "ACCEPTED", "DUPLICATE", or "REJECTED"
	AcceptedAt string
	Error      *BatchItemError
}

// BatchResult aggregates every chunk's item results in original input
// order.
type BatchResult struct {
	AcceptedCount  int
	DuplicateCount int
	RejectedCount  int
	Results        []BatchItemResult
}

// BatchOptions carries the per-call knobs SendBatch/SendPreparedBatch(es)
// accept beyond ctx and the events themselves.
type BatchOptions struct {
	// RequestID, if set, is only honored when the call resolves to
	// exactly one underlying HTTP request (a single chunk). A
	// multi-chunk call needs one distinct request ID per request, so
	// this SDK generates one per chunk in that case instead of silently
	// reusing a caller-supplied value across unrelated requests.
	RequestID string
	// Timeout bounds each individual attempt of each chunk (not the
	// whole call). Zero uses Config.Timeout.
	Timeout time.Duration
}
