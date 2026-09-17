package audit

import (
	"context"
	"net/http"
	"time"
)

// APIKeyProvider resolves the current API key immediately before each
// attempt, so a credential rotation takes effect on the very next
// request with no process restart needed. It is never rendered in
// errors, logs, or telemetry by this module. Wrap a static key with
// StaticAPIKey.
type APIKeyProvider func(ctx context.Context) (string, error)

// StaticAPIKey returns an APIKeyProvider that always resolves to key.
func StaticAPIKey(key string) APIKeyProvider {
	return func(context.Context) (string, error) { return key, nil }
}

// RetryConfig bounds Record's retry behavior. A zero value for any field
// falls back to the corresponding default in NewClient.
type RetryConfig struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// Config is NewClient's static configuration. NewClient validates it
// but performs no network I/O.
type Config struct {
	APIKeyProvider APIKeyProvider
	BaseURL        string
	// HTTPClient is the pooled/injected client every request reuses.
	// Defaults to http.DefaultClient. Its Transport is the seam for test
	// doubles (see a fake http.RoundTripper), matching this module's own
	// tests and testing.md's Go SDK example.
	HTTPClient *http.Client
	// Timeout bounds each individual attempt. Defaults to 10s.
	Timeout time.Duration
	Retry   RetryConfig
	// AllowInsecureHTTP allows a non-HTTPS BaseURL (e.g.
	// http://localhost:4000 in local development). Never set this
	// against a real deployment.
	AllowInsecureHTTP bool
	// Now and Random are injectable hooks for deterministic tests (ULID
	// generation and retry jitter), matching the equivalent hooks the JS
	// SDK exposes for the same reason. Default to time.Now and a
	// package-level math/rand source when nil.
	Now    func() time.Time
	Random func() float64
	// Sleep is an injectable, context-aware delay function, primarily
	// for deterministic retry-backoff tests. Defaults to a real sleep
	// that returns ctx.Err() if ctx is done first.
	Sleep func(ctx context.Context, d time.Duration) error
}
