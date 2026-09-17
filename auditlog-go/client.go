package audit

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"time"
)

var defaultRetryConfig = RetryConfig{MaxAttempts: 3, BaseDelay: 200 * time.Millisecond, MaxDelay: 5 * time.Second}

const defaultTimeout = 10 * time.Second

// Client is safe for concurrent use by multiple goroutines: it holds no
// mutable per-call state — every Record/CreateEvent call is independent.
type Client struct {
	apiKeyProvider APIKeyProvider
	baseURL        string
	httpClient     *http.Client
	timeout        time.Duration
	retry          RetryConfig
	now            func() time.Time
	random         func() float64
	sleep          func(ctx context.Context, d time.Duration) error
}

// NewClient validates cfg and constructs a Client. It performs no
// network I/O: no request is sent until Record is actually called.
func NewClient(cfg Config) (*Client, error) {
	if cfg.APIKeyProvider == nil {
		return nil, newConfigError("APIKeyProvider is required (use StaticAPIKey for a static key)")
	}
	if cfg.BaseURL == "" {
		return nil, newConfigError("BaseURL is required")
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil {
		return nil, newConfigError(fmt.Sprintf("BaseURL is not a valid URL: %s", cfg.BaseURL))
	}
	if parsed.Scheme != "https" && !cfg.AllowInsecureHTTP {
		return nil, newConfigError(fmt.Sprintf("BaseURL must use HTTPS (got %q); set AllowInsecureHTTP: true only for local development", parsed.Scheme))
	}

	retry := cfg.Retry
	if retry.MaxAttempts == 0 {
		retry.MaxAttempts = defaultRetryConfig.MaxAttempts
	}
	if retry.BaseDelay == 0 {
		retry.BaseDelay = defaultRetryConfig.BaseDelay
	}
	if retry.MaxDelay == 0 {
		retry.MaxDelay = defaultRetryConfig.MaxDelay
	}
	if retry.MaxAttempts < 1 {
		return nil, newConfigError("Retry.MaxAttempts must be >= 1")
	}
	if retry.MaxDelay < retry.BaseDelay {
		return nil, newConfigError("Retry.MaxDelay must be >= Retry.BaseDelay")
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	now := cfg.Now
	if now == nil {
		now = timeNowUTC
	}
	random := cfg.Random
	if random == nil {
		random = rand.Float64
	}
	sleepFn := cfg.Sleep
	if sleepFn == nil {
		sleepFn = defaultSleep
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}

	return &Client{
		apiKeyProvider: cfg.APIKeyProvider,
		baseURL:        cfg.BaseURL,
		httpClient:     httpClient,
		timeout:        timeout,
		retry:          retry,
		now:            now,
		random:         random,
		sleep:          sleepFn,
	}, nil
}

func timeNowUTC() time.Time { return time.Now().UTC() }

func defaultSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// CreateEvent assigns stable IDs and canonicalizes input once. The
// result is safe to persist (e.g. in an outbox row) and resend later via
// RecordPrepared — resending it never changes its identity or bytes.
// This performs no network I/O.
func (c *Client) CreateEvent(input EventInput) (PreparedEvent, error) {
	return createEvent(input, c.now, c.random)
}

// Record prepares input (equivalent to CreateEvent) and durably delivers
// it, retrying eligible transient failures with the exact same prepared
// bytes. It resolves for both ACCEPTED and DUPLICATE — a caller must not
// treat DUPLICATE as an error.
func (c *Client) Record(ctx context.Context, input EventInput, opts RecordOptions) (RecordReceipt, error) {
	prepared, err := c.CreateEvent(input)
	if err != nil {
		return RecordReceipt{}, err
	}
	return c.RecordPrepared(ctx, prepared, opts)
}

// RecordPrepared delivers an already-prepared event — e.g. one loaded
// back from an outbox row — skipping re-preparation. Phase 3 does not
// implement outbox relay behavior itself; this only supports it.
func (c *Client) RecordPrepared(ctx context.Context, prepared PreparedEvent, opts RecordOptions) (RecordReceipt, error) {
	return c.record(ctx, prepared, opts)
}
