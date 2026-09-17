package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// sendOnce performs exactly one HTTP attempt: resolves the API key
// immediately before the request, sends the exact prepared payload, and
// parses the response defensively (tolerating additive unknown fields —
// only the fields this SDK reads are extracted; anything else in the
// body is ignored, never rejected). ctx is the caller's own context
// (used to distinguish a caller-driven cancellation from this attempt's
// own timeout); attemptTimeout bounds this one attempt only.
func (c *Client) sendOnce(ctx context.Context, requestURL string, prepared PreparedEvent, requestID string, attemptTimeout time.Duration) (RecordReceipt, *APIError) {
	apiKey, err := c.apiKeyProvider(ctx)
	if err != nil {
		return RecordReceipt{}, newConfigError("APIKeyProvider: " + err.Error())
	}

	attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, requestURL, bytes.NewReader(prepared.Payload))
	if err != nil {
		return RecordReceipt{}, newConfigError("failed to build request: " + err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", requestID)
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		canceled := ctx.Err() != nil
		timedOut := !canceled && attemptCtx.Err() != nil
		return RecordReceipt{}, newNetworkError(networkErrorArgs{Canceled: canceled, TimedOut: timedOut, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return RecordReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: resp.StatusCode, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return parseAcceptedBody(body, resp.StatusCode, requestID, prepared)
	}
	return RecordReceipt{}, parseErrorBody(body, resp, requestID, prepared.RecordID, prepared.EventID, c.now())
}

func parseAcceptedBody(body []byte, httpStatus int, requestID string, prepared PreparedEvent) (RecordReceipt, *APIError) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return RecordReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}
	status, _ := parsed["status"].(string)
	if status != "ACCEPTED" && status != "DUPLICATE" {
		return RecordReceipt{}, newMalformedResponseError(malformedResponseErrorArgs{HTTPStatus: httpStatus, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: errUnexpectedStatusField})
	}

	recordID, _ := parsed["record_id"].(string)
	if recordID == "" {
		recordID = prepared.RecordID
	}
	eventID, _ := parsed["event_id"].(string)
	if eventID == "" {
		eventID = prepared.EventID
	}
	acceptedAt, _ := parsed["accepted_at"].(string)
	if acceptedAt == "" {
		acceptedAt = prepared.OccurredAt
	}
	return RecordReceipt{RecordID: recordID, EventID: eventID, Status: status, AcceptedAt: acceptedAt, RequestID: requestID}, nil
}

func parseErrorBody(body []byte, resp *http.Response, requestID string, recordID string, eventID string, now time.Time) *APIError {
	var errBody map[string]any
	_ = json.Unmarshal(body, &errBody) // best-effort; a malformed error body still yields a classified error below
	errorCode, _ := errBody["error_code"].(string)
	message, _ := errBody["message"].(string)
	retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"), now)

	var retryable *bool
	if v, ok := errBody["retryable"].(bool); ok {
		retryable = &v
	}

	return newServerResponseError(serverResponseErrorArgs{
		HTTPStatus: resp.StatusCode,
		ErrorCode:  errorCode,
		Message:    message,
		RequestID:  requestID,
		RecordID:   recordID,
		EventID:    eventID,
		RetryAfter: retryAfter,
		Retryable:  retryable,
	})
}

var errUnexpectedStatusField = errors.New("response status field was neither ACCEPTED nor DUPLICATE")
