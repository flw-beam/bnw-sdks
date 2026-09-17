package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// SendBatch prepares inputs (equivalent to CreateBatch) and durably
// delivers every resulting chunk, in order, retrying each chunk's
// eligible transient failures with that chunk's exact prepared bytes.
// If a chunk fails irrecoverably, SendBatch returns the results already
// obtained from prior, fully-resolved chunks alongside the error — a
// caller can inspect a partial BatchResult even on error.
func (c *Client) SendBatch(ctx context.Context, inputs []EventInput, opts BatchOptions) (BatchResult, error) {
	batches, err := c.CreateBatch(inputs)
	if err != nil {
		return BatchResult{}, err
	}
	return c.sendPreparedBatches(ctx, batches, opts)
}

// SendPreparedBatch delivers one already-prepared chunk — e.g. one
// loaded back from outbox rows — skipping re-preparation.
func (c *Client) SendPreparedBatch(ctx context.Context, batch PreparedBatch, opts BatchOptions) (BatchResult, error) {
	return c.sendPreparedBatches(ctx, []PreparedBatch{batch}, opts)
}

func (c *Client) sendPreparedBatches(ctx context.Context, batches []PreparedBatch, opts BatchOptions) (BatchResult, error) {
	var aggregate BatchResult
	singleChunk := len(batches) == 1
	offset := 0
	for _, batch := range batches {
		if err := ctx.Err(); err != nil {
			return aggregate, newNetworkError(networkErrorArgs{Canceled: true, Cause: err})
		}

		chunkOpts := opts
		if !singleChunk {
			// See BatchOptions.RequestID's doc comment: a caller-supplied
			// ID is only meaningful for a single underlying request.
			chunkOpts.RequestID = ""
		}

		results, err := c.sendBatchChunk(ctx, batch, chunkOpts)
		if err != nil {
			return aggregate, err
		}
		for i := range results {
			results[i].Index += offset
			switch results[i].Status {
			case "ACCEPTED":
				aggregate.AcceptedCount++
			case "DUPLICATE":
				aggregate.DuplicateCount++
			case "REJECTED":
				aggregate.RejectedCount++
			}
		}
		aggregate.Results = append(aggregate.Results, results...)
		offset += len(batch.Items)
	}
	return aggregate, nil
}

// sendBatchChunk is SendBatch's per-chunk retry loop — the batch analog
// of record() in retry.go. Every attempt reuses the exact same chunk
// payload and (for the logical call) the same request ID.
func (c *Client) sendBatchChunk(ctx context.Context, batch PreparedBatch, opts BatchOptions) ([]BatchItemResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, newNetworkError(networkErrorArgs{Canceled: true, Cause: err})
	}

	requestID := opts.RequestID
	if requestID == "" {
		id, err := newULID(c.now())
		if err != nil {
			return nil, newConfigError("failed to generate request id: " + err.Error())
		}
		requestID = id
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = c.timeout
	}
	requestURL := strings.TrimRight(c.baseURL, "/") + "/api/v1/events:batch"

	var lastErr *APIError
	for attempt := 1; attempt <= c.retry.MaxAttempts; attempt++ {
		results, apiErr := c.sendBatchOnce(ctx, requestURL, batch, requestID, timeout)
		if apiErr == nil {
			return results, nil
		}
		lastErr = apiErr

		attemptsRemain := attempt < c.retry.MaxAttempts
		if !apiErr.Retryable || !attemptsRemain {
			return nil, apiErr
		}

		delay := computeDelay(attempt, c.retry, apiErr.RetryAfter, c.random)
		if err := c.sleep(ctx, delay); err != nil {
			return nil, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, Cause: err})
		}
		if ctx.Err() != nil {
			return nil, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, Cause: ctx.Err()})
		}
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, newConfigError("sendBatchChunk: retry loop exited without a result")
}

// sendBatchOnce performs exactly one HTTP attempt against
// /api/v1/events:batch, mirroring sendOnce's shape in transport.go.
func (c *Client) sendBatchOnce(ctx context.Context, requestURL string, batch PreparedBatch, requestID string, attemptTimeout time.Duration) ([]BatchItemResult, *APIError) {
	apiKey, err := c.apiKeyProvider(ctx)
	if err != nil {
		return nil, newConfigError("APIKeyProvider: " + err.Error())
	}

	attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, requestURL, bytes.NewReader(batch.Payload))
	if err != nil {
		return nil, newConfigError("failed to build request: " + err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", requestID)
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		canceled := ctx.Err() != nil
		timedOut := !canceled && attemptCtx.Err() != nil
		return nil, newNetworkError(networkErrorArgs{Canceled: canceled, TimedOut: timedOut, RequestID: requestID, Cause: err})
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: resp.StatusCode, RequestID: requestID, Cause: err})
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return parseBatchAcceptedBody(body, resp.StatusCode, requestID)
	}
	return nil, parseErrorBody(body, resp, requestID, "", "", c.now())
}

// batchResponseEnvelope mirrors schemas.SuccessBody[schemas.BatchAcceptedResponse]
// — the batch route wraps its payload under "data", unlike the one-shot
// route's flat body.
type batchResponseEnvelope struct {
	Data struct {
		Results []struct {
			Index      int    `json:"index"`
			RecordID   string `json:"record_id"`
			EventID    string `json:"event_id"`
			Status     string `json:"status"`
			AcceptedAt string `json:"accepted_at"`
			Error      *struct {
				Code      string `json:"code"`
				Message   string `json:"message"`
				Retryable bool   `json:"retryable"`
			} `json:"error"`
		} `json:"results"`
	} `json:"data"`
}

func parseBatchAcceptedBody(body []byte, httpStatus int, requestID string) ([]BatchItemResult, *APIError) {
	var parsed batchResponseEnvelope
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, Cause: err})
	}
	if len(parsed.Data.Results) == 0 {
		return nil, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, Cause: errEmptyBatchResults})
	}

	results := make([]BatchItemResult, len(parsed.Data.Results))
	for i, r := range parsed.Data.Results {
		item := BatchItemResult{Index: r.Index, RecordID: r.RecordID, EventID: r.EventID, Status: r.Status, AcceptedAt: r.AcceptedAt}
		if r.Error != nil {
			item.Error = &BatchItemError{Code: r.Error.Code, Message: r.Error.Message, Retryable: r.Error.Retryable}
		}
		results[i] = item
	}
	return results, nil
}

var errEmptyBatchResults = errors.New("batch response contained no results")
