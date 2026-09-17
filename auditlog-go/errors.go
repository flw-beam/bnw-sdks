package audit

import (
	"fmt"
	"time"
)

// Local error codes for failures that never reached a server response.
// Server-issued codes (INVALID_JSON, INVALID_SCHEMA, INSUFFICIENT_PERMISSION,
// IDEMPOTENCY_CONFLICT, PAYLOAD_TOO_LARGE, RATE_LIMIT_ERROR,
// INGESTION_UNAVAILABLE, and so on — httperr.HTTPErrorKind in
// audit-service-api) pass through directly from the response body's own
// error_code field; this module does not redeclare that catalogue.
const (
	CodeConfigError       = "CONFIG_ERROR"
	CodeValidationError   = "VALIDATION_ERROR"
	CodeNetworkError      = "NETWORK_ERROR"
	CodeTimeout           = "TIMEOUT"
	CodeCanceled          = "CANCELED"
	CodeMalformedResponse = "MALFORMED_RESPONSE"
)

// nonRetryableHTTPStatus is the closed set of statuses never retried,
// even though the status alone might otherwise suggest a transient
// condition. Kept as an explicit table (matching audit-service-sdk's JS
// twin's NON_RETRYABLE_STATUSES) rather than "everything except
// 429/5xx", so a change to the server's catalogue is a deliberate edit
// here, not a status-code guess.
var nonRetryableHTTPStatus = map[int]bool{400: true, 401: true, 403: true, 409: true, 413: true}

// APIError is the one error type this module ever returns from a
// network-attempting call. Error() returns a safe, generic message (plus
// the stable Code, which is never secret) — the API key and the request
// payload are never included in any field or in Error()'s string.
// Richer detail is available only through the typed fields below, and
// through Unwrap for errors.As/errors.Is chains onto a wrapped safe cause.
type APIError struct {
	Code       string
	HTTPStatus int
	RequestID  string
	RecordID   string
	EventID    string
	Retryable  bool
	RetryAfter time.Duration
	cause      error
}

func (e *APIError) Error() string {
	if e.Code == "" {
		return "audit request failed"
	}
	return fmt.Sprintf("audit request failed: %s", e.Code)
}

func (e *APIError) Unwrap() error { return e.cause }

func retryableForStatus(httpStatus int) bool {
	if nonRetryableHTTPStatus[httpStatus] {
		return false
	}
	return httpStatus == 429 || httpStatus >= 500
}

type serverResponseErrorArgs struct {
	HTTPStatus int
	ErrorCode  string
	Message    string
	RequestID  string
	RecordID   string
	EventID    string
	RetryAfter time.Duration
	// Retryable is the server's own `retryable` field from the error
	// response body, when present. A nil pointer means the field was
	// absent or not a boolean (an older server or a malformed body);
	// retryableForStatus is used as the fallback in that case only, so
	// the server's answer always wins once it is present.
	Retryable *bool
}

func newServerResponseError(args serverResponseErrorArgs) *APIError {
	code := args.ErrorCode
	if code == "" {
		code = "UNHANDLED_SERVER_ERROR"
	}
	var cause error
	if args.Message != "" {
		cause = fmt.Errorf("%s", args.Message)
	}
	retryable := retryableForStatus(args.HTTPStatus)
	if args.Retryable != nil {
		retryable = *args.Retryable
	}
	return &APIError{
		Code:       code,
		HTTPStatus: args.HTTPStatus,
		RequestID:  args.RequestID,
		RecordID:   args.RecordID,
		EventID:    args.EventID,
		Retryable:  retryable,
		RetryAfter: args.RetryAfter,
		cause:      cause,
	}
}

type malformedResponseErrorArgs struct {
	HTTPStatus int
	RequestID  string
	RecordID   string
	EventID    string
	Cause      error
}

func newMalformedResponseError(args malformedResponseErrorArgs) *APIError {
	return &APIError{
		Code:       CodeMalformedResponse,
		HTTPStatus: args.HTTPStatus,
		RequestID:  args.RequestID,
		RecordID:   args.RecordID,
		EventID:    args.EventID,
		// A malformed body on an otherwise 2xx-looking response is
		// ambiguous, not a known permanent rejection — safe to retry
		// because retries reuse the same record_id idempotently.
		Retryable: args.HTTPStatus >= 200 && args.HTTPStatus < 300,
		cause:     args.Cause,
	}
}

type networkErrorArgs struct {
	Canceled  bool
	TimedOut  bool
	RequestID string
	RecordID  string
	EventID   string
	Cause     error
}

func newNetworkError(args networkErrorArgs) *APIError {
	switch {
	case args.Canceled:
		return &APIError{Code: CodeCanceled, RequestID: args.RequestID, RecordID: args.RecordID, EventID: args.EventID, Retryable: false, cause: args.Cause}
	case args.TimedOut:
		return &APIError{Code: CodeTimeout, RequestID: args.RequestID, RecordID: args.RecordID, EventID: args.EventID, Retryable: true, cause: args.Cause}
	default:
		return &APIError{Code: CodeNetworkError, RequestID: args.RequestID, RecordID: args.RecordID, EventID: args.EventID, Retryable: true, cause: args.Cause}
	}
}

func newValidationError(message string) *APIError {
	return &APIError{Code: CodeValidationError, Retryable: false, cause: fmt.Errorf("%s", message)}
}

func newConfigError(message string) *APIError {
	return &APIError{Code: CodeConfigError, Retryable: false, cause: fmt.Errorf("%s", message)}
}
