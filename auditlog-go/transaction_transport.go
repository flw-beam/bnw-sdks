package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// sendTransactionStart is the retry loop for a start call: resolves the
// API key immediately before each attempt, sends the exact prepared
// bytes, and — for a retryable outcome with attempts remaining — waits
// the greater of the server's Retry-After and exponential backoff, plus
// bounded jitter, before trying again. Mirrors record() in retry.go
// exactly, minus the URL and response shape.
func (c *Client) sendTransactionStart(ctx context.Context, prepared preparedTransactionStart, opts RecordOptions) (TransactionStartReceipt, error) {
	if err := ctx.Err(); err != nil {
		return TransactionStartReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}

	requestID := opts.RequestID
	if requestID == "" {
		id, err := newULID(c.now())
		if err != nil {
			return TransactionStartReceipt{}, newConfigError("failed to generate request id: " + err.Error())
		}
		requestID = id
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = c.timeout
	}
	requestURL := strings.TrimRight(c.baseURL, "/") + "/api/v1/audit-transactions"

	var lastErr *APIError
	for attempt := 1; attempt <= c.retry.MaxAttempts; attempt++ {
		receipt, apiErr := c.sendTransactionStartOnce(ctx, requestURL, prepared, requestID, timeout)
		if apiErr == nil {
			return receipt, nil
		}
		lastErr = apiErr

		attemptsRemain := attempt < c.retry.MaxAttempts
		if !apiErr.Retryable || !attemptsRemain {
			return TransactionStartReceipt{}, apiErr
		}

		delay := computeDelay(attempt, c.retry, apiErr.RetryAfter, c.random)
		if err := c.sleep(ctx, delay); err != nil {
			return TransactionStartReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
		}
		if ctx.Err() != nil {
			return TransactionStartReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: ctx.Err()})
		}
	}

	if lastErr != nil {
		return TransactionStartReceipt{}, lastErr
	}
	return TransactionStartReceipt{}, newConfigError("sendTransactionStart: retry loop exited without a result")
}

func (c *Client) sendTransactionStartOnce(ctx context.Context, requestURL string, prepared preparedTransactionStart, requestID string, attemptTimeout time.Duration) (TransactionStartReceipt, *APIError) {
	apiKey, err := c.apiKeyProvider(ctx)
	if err != nil {
		return TransactionStartReceipt{}, newConfigError("APIKeyProvider: " + err.Error())
	}

	attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, requestURL, bytes.NewReader(prepared.Payload))
	if err != nil {
		return TransactionStartReceipt{}, newConfigError("failed to build request: " + err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", requestID)
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		canceled := ctx.Err() != nil
		timedOut := !canceled && attemptCtx.Err() != nil
		return TransactionStartReceipt{}, newNetworkError(networkErrorArgs{Canceled: canceled, TimedOut: timedOut, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return TransactionStartReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: resp.StatusCode, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return parseTransactionStartBody(body, resp.StatusCode, requestID, prepared)
	}
	return TransactionStartReceipt{}, parseErrorBody(body, resp, requestID, prepared.RecordID, prepared.EventID, c.now())
}

func parseTransactionStartBody(body []byte, httpStatus int, requestID string, prepared preparedTransactionStart) (TransactionStartReceipt, *APIError) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return TransactionStartReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}
	status, _ := parsed["status"].(string)
	if status != "ACCEPTED" && status != "DUPLICATE" {
		return TransactionStartReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: errUnexpectedStatusField})
	}

	auditTransactionID, _ := parsed["audit_transaction_id"].(string)
	if auditTransactionID == "" {
		auditTransactionID = prepared.AuditTransactionID
	}
	eventID, _ := parsed["event_id"].(string)
	if eventID == "" {
		eventID = prepared.EventID
	}
	recordID, _ := parsed["record_id"].(string)
	if recordID == "" {
		recordID = prepared.RecordID
	}
	lifecycleState, _ := parsed["lifecycle_state"].(string)
	lifecyclePosition := intFromAny(parsed["lifecycle_position"])
	acceptedAt, _ := parsed["accepted_at"].(string)
	if acceptedAt == "" {
		acceptedAt = prepared.OccurredAt
	}

	return TransactionStartReceipt{
		AuditTransactionID: auditTransactionID,
		EventID:            eventID,
		RecordID:           recordID,
		LifecycleState:     lifecycleState,
		LifecyclePosition:  lifecyclePosition,
		Status:             status,
		AcceptedAt:         acceptedAt,
		RequestID:          requestID,
	}, nil
}

// sendTransactionTerminal is the retry loop for a complete/abort call.
func (c *Client) sendTransactionTerminal(ctx context.Context, auditTransactionID string, kind TransactionState, prepared preparedTransactionTerminal, opts RecordOptions) (TransactionTerminalReceipt, error) {
	if err := ctx.Err(); err != nil {
		return TransactionTerminalReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RecordID: prepared.RecordID, Cause: err})
	}

	requestID := opts.RequestID
	if requestID == "" {
		id, err := newULID(c.now())
		if err != nil {
			return TransactionTerminalReceipt{}, newConfigError("failed to generate request id: " + err.Error())
		}
		requestID = id
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = c.timeout
	}
	action := "complete"
	if kind == TransactionStateAborted {
		action = "abort"
	}
	requestURL := strings.TrimRight(c.baseURL, "/") + "/api/v1/audit-transactions/" + auditTransactionID + "/" + action

	var lastErr *APIError
	for attempt := 1; attempt <= c.retry.MaxAttempts; attempt++ {
		receipt, apiErr := c.sendTransactionTerminalOnce(ctx, requestURL, prepared, requestID, timeout)
		if apiErr == nil {
			return receipt, nil
		}
		lastErr = apiErr

		attemptsRemain := attempt < c.retry.MaxAttempts
		if !apiErr.Retryable || !attemptsRemain {
			return TransactionTerminalReceipt{}, apiErr
		}

		delay := computeDelay(attempt, c.retry, apiErr.RetryAfter, c.random)
		if err := c.sleep(ctx, delay); err != nil {
			return TransactionTerminalReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, RecordID: prepared.RecordID, Cause: err})
		}
		if ctx.Err() != nil {
			return TransactionTerminalReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, RecordID: prepared.RecordID, Cause: ctx.Err()})
		}
	}

	if lastErr != nil {
		return TransactionTerminalReceipt{}, lastErr
	}
	return TransactionTerminalReceipt{}, newConfigError("sendTransactionTerminal: retry loop exited without a result")
}

func (c *Client) sendTransactionTerminalOnce(ctx context.Context, requestURL string, prepared preparedTransactionTerminal, requestID string, attemptTimeout time.Duration) (TransactionTerminalReceipt, *APIError) {
	apiKey, err := c.apiKeyProvider(ctx)
	if err != nil {
		return TransactionTerminalReceipt{}, newConfigError("APIKeyProvider: " + err.Error())
	}

	attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, requestURL, bytes.NewReader(prepared.Payload))
	if err != nil {
		return TransactionTerminalReceipt{}, newConfigError("failed to build request: " + err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", requestID)
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		canceled := ctx.Err() != nil
		timedOut := !canceled && attemptCtx.Err() != nil
		return TransactionTerminalReceipt{}, newNetworkError(networkErrorArgs{Canceled: canceled, TimedOut: timedOut, RequestID: requestID, RecordID: prepared.RecordID, Cause: err})
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return TransactionTerminalReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: resp.StatusCode, RequestID: requestID, RecordID: prepared.RecordID, Cause: err})
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return parseTransactionTerminalBody(body, resp.StatusCode, requestID, prepared)
	}
	return TransactionTerminalReceipt{}, parseErrorBody(body, resp, requestID, prepared.RecordID, "", c.now())
}

func parseTransactionTerminalBody(body []byte, httpStatus int, requestID string, prepared preparedTransactionTerminal) (TransactionTerminalReceipt, *APIError) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return TransactionTerminalReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, RecordID: prepared.RecordID, Cause: err})
	}
	status, _ := parsed["status"].(string)
	if status != "ACCEPTED" && status != "DUPLICATE" {
		return TransactionTerminalReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, RecordID: prepared.RecordID, Cause: errUnexpectedStatusField})
	}

	recordID, _ := parsed["record_id"].(string)
	if recordID == "" {
		recordID = prepared.RecordID
	}
	referencesRecordID, _ := parsed["references_record_id"].(string)
	if referencesRecordID == "" {
		referencesRecordID = prepared.ReferencesRecordID
	}
	auditTransactionID, _ := parsed["audit_transaction_id"].(string)
	eventID, _ := parsed["event_id"].(string)
	lifecycleState, _ := parsed["lifecycle_state"].(string)
	lifecyclePosition := intFromAny(parsed["lifecycle_position"])
	result, _ := parsed["result"].(string)
	if result == "" {
		result = prepared.Result
	}
	acceptedAt, _ := parsed["accepted_at"].(string)
	if acceptedAt == "" {
		acceptedAt = prepared.OccurredAt
	}

	return TransactionTerminalReceipt{
		AuditTransactionID: auditTransactionID,
		EventID:            eventID,
		RecordID:           recordID,
		ReferencesRecordID: referencesRecordID,
		LifecycleState:     lifecycleState,
		LifecyclePosition:  lifecyclePosition,
		Result:             result,
		Status:             status,
		AcceptedAt:         acceptedAt,
		RequestID:          requestID,
	}, nil
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return 0
	}
}
