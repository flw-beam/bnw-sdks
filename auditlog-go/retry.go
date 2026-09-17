package audit

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// record is the retry loop: resolves the API key immediately before
// each attempt (inside sendOnce), sends the exact prepared bytes, and —
// for a retryable outcome with attempts remaining — waits the greater
// of the server's Retry-After and exponential backoff, plus bounded
// jitter, before trying again. Every attempt reuses the exact same
// prepared payload and (for the logical call) the same request ID.
func (c *Client) record(ctx context.Context, prepared PreparedEvent, opts RecordOptions) (RecordReceipt, error) {
	if err := ctx.Err(); err != nil {
		return RecordReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
	}

	requestID := opts.RequestID
	if requestID == "" {
		id, err := newULID(c.now())
		if err != nil {
			return RecordReceipt{}, newConfigError("failed to generate request id: " + err.Error())
		}
		requestID = id
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = c.timeout
	}
	requestURL := strings.TrimRight(c.baseURL, "/") + "/api/v1/events"

	var lastErr *APIError
	for attempt := 1; attempt <= c.retry.MaxAttempts; attempt++ {
		receipt, apiErr := c.sendOnce(ctx, requestURL, prepared, requestID, timeout)
		if apiErr == nil {
			return receipt, nil
		}
		lastErr = apiErr

		attemptsRemain := attempt < c.retry.MaxAttempts
		if !apiErr.Retryable || !attemptsRemain {
			return RecordReceipt{}, apiErr
		}

		delay := computeDelay(attempt, c.retry, apiErr.RetryAfter, c.random)
		if err := c.sleep(ctx, delay); err != nil {
			return RecordReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: err})
		}
		if ctx.Err() != nil {
			return RecordReceipt{}, newNetworkError(networkErrorArgs{Canceled: true, RequestID: requestID, RecordID: prepared.RecordID, EventID: prepared.EventID, Cause: ctx.Err()})
		}
	}

	// Unreachable: the loop above always either returns or throws before
	// exhausting attempts (the last iteration's non-retryable-or-no-
	// attempts-left branch returns). Kept as a typed internal assertion
	// rather than a bare panic, matching this task's own guidance for
	// its JS twin.
	if lastErr != nil {
		return RecordReceipt{}, lastErr
	}
	return RecordReceipt{}, newConfigError("record: retry loop exited without a result")
}

// computeDelay is the greater of exponential backoff and any server
// Retry-After, plus a bounded (at most one BaseDelay unit) random
// addition — matching the JS SDK's identical formula in src/retry.ts.
func computeDelay(attempt int, retry RetryConfig, retryAfter time.Duration, random func() float64) time.Duration {
	exponential := retry.BaseDelay * time.Duration(int64(1)<<uint(attempt-1))
	if exponential > retry.MaxDelay || exponential <= 0 {
		exponential = retry.MaxDelay
	}
	base := exponential
	if retryAfter > base {
		base = retryAfter
	}
	jitter := time.Duration(random() * float64(retry.BaseDelay))
	return base + jitter
}

// parseRetryAfter parses a Retry-After header value (either whole
// seconds or an HTTP-date) into a duration. Returns 0 for an absent or
// unparseable header. audit-api today always sends whole seconds
// (internal/http/api/events/support.go's mapAdmissionError); the
// HTTP-date branch is forward-compatible parsing, not a guess this SDK
// needs right now.
func parseRetryAfter(value string, now time.Time) time.Duration {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(trimmed); err == nil {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(trimmed); err == nil {
		if delta := at.Sub(now); delta > 0 {
			return delta
		}
		return 0
	}
	return 0
}
