# audit-service-sdk-go

First-party Go SDK for delivering one-shot Audit Service events to
`audit-api`'s `POST /api/v1/events`.

This is an independently versioned Go module developed inside this private
repository at `sdks/go/` (module path
`github.com/flw-beam/bnw-sdks/auditlog-go`). It
imports nothing from this repository's `internal/**` packages; its
behavior is proven against the language-neutral fixtures in
`internal/testutils/testdata/contracts/sdk/v1/**`, the same ones its
TypeScript/JavaScript twin (`sdks/js/`) consumes, not by private package
reuse.

The planned distribution path is a public release snapshot in
[`flw-beam/bnw-sdks`](https://github.com/flw-beam/bnw-sdks), while development
stays here. Public release notes identify the private source commit used to
assemble each exported snapshot.

## Scope

This SDK is a **producer-write** integration: it prepares audit events,
sends them, and tells the caller whether to delete, retry, or quarantine
an outbox row (see the "Retry semantics" and "What this SDK does not
guarantee" sections below). It does not read events back, search
records, run backfills, or verify archive evidence — those are separate,
read-side or compliance concerns with their own contracts. A caller that
only needs to write audit events does not need anything beyond what is
documented in this README.

## Install

Requires Go 1.24 or newer.

The module path is already the public path. The package is still developed in
this private repository until a public `bnw-sdks` release tag exists:

```sh
go get github.com/flw-beam/bnw-sdks/auditlog-go@v0.1.1
```

That command only works for consumers after the matching public tag has been
created in `bnw-sdks`. For a future version, use:

```sh
go get github.com/flw-beam/bnw-sdks/auditlog-go@vX.Y.Z
```

`vX.Y.Z` is a placeholder, not an available release. Public Go tags will be
named `auditlog-go/vX.Y.Z` in `bnw-sdks`, as required for a module in that
subdirectory. Pin an exact version and commit `go.mod` and `go.sum`. The SDK
version does not select staging, pilot, or production: use the same tested
version and supply the appropriate service URL and API key at runtime.

## Authentication

`APIKeyProvider` supplies one opaque Bearer credential — sent as
`Authorization: Bearer <value>` on every request — and nothing about it
needs to be parsed or interpreted by your code:

```go
client, err := audit.NewClient(audit.Config{
	APIKeyProvider: audit.StaticAPIKey(mustGetenv("AUDIT_API_KEY")),
	BaseURL:        "https://audit.example.com",
})
```

The key is bound server-side, at creation time, to exactly one tenant,
one environment (`development`/`staging`/`production`), a set of
scopes, and an allowed-event-type pattern list — a producer never
selects or overrides any of that from client code or request JSON.
`BaseURL` and the key's own bound environment must agree: a staging key
presented to the production `BaseURL` (or vice versa) fails
authentication the same as any other invalid credential, not with a
distinct error — pick the credential for the environment you are
actually calling. The SDK install version is independent of that choice.

The full secret (`ak_<env>_<key-id>.<random>`) is returned exactly once,
in the response to the create or rotate call that produced it — never
again, on any later read. Treat it as you would any other database
credential: load it from your own secret store, never commit it, and
never log it. `APIError` and its `Error()` string are guaranteed to
never contain it (see [`errors.As` example](#errorsas-example) below).

A missing, malformed, unknown, revoked, or expired key returns a
`401 UNAUTHORIZED_ERROR` with `Retryable: false` (see
[Retry semantics](#retry-semantics)) — retrying the exact same request
with the exact same key cannot succeed. See
[Credential rotation example](#credential-rotation-example) below for
how to pick up a new key without a process restart, and
`audit-service-docs/contracts.md` §5 plus
`docs/runbooks/key-rotation.md` in this repository for the full
create/list/rotate/revoke admin contract and the overlap window that
lets an old and a new key both work during a deploy.

## One-shot example

```go
package main

import (
	"context"
	"log"
	"time"

	audit "github.com/flw-beam/bnw-sdks/auditlog-go"
)

func main() {
	client, err := audit.NewClient(audit.Config{
		APIKeyProvider: audit.StaticAPIKey(mustGetenv("AUDIT_API_KEY")),
		BaseURL:        "https://audit.example.com",
	})
	if err != nil {
		log.Fatal(err)
	}

	receipt, err := client.Record(context.Background(), audit.EventInput{
		EventType:  "order.created",
		Category:   "ORDER",
		Action:     "CREATE",
		Result:     audit.ResultSuccess,
		OccurredAt: time.Now(),
		Actor:      audit.Actor{Type: audit.ActorTypeUser, ID: "user_123"},
		Resource:   audit.Resource{Type: "ORDER", ID: "ord_456"},
	}, audit.RecordOptions{})
	if err != nil {
		log.Fatal(err)
	}

	// receipt.Status is "ACCEPTED" or "DUPLICATE" — treat both as success.
	log.Println(receipt.RecordID, receipt.Status)
}
```

## Batch example

```go
result, err := client.SendBatch(context.Background(), []audit.EventInput{event1, event2}, audit.BatchOptions{})
if err != nil {
	log.Fatal(err)
}
for _, item := range result.Results {
	// item.Status is "ACCEPTED", "DUPLICATE", or "REJECTED".
	// item.Index is the item's position in the input slice you passed in.
	log.Println(item.Index, item.Status)
}
```

`SendBatch` prepares and splits inputs into chunks of up to `audit.MaxBatchRecords`
(500) and sends one request per chunk, in order. Each chunk is retried as a
whole on a transient failure (same retry rules as `Record`); a single
`REJECTED` item inside an otherwise-successful response is never retried —
it is surfaced in `result.Results` for the caller to handle. `CreateBatch`
is the network-free builder equivalent of `CreateEvent`, for outbox-style
persistence before delivery; `SendPreparedBatch` delivers one chunk you
already built (e.g. loaded back from an outbox row).

The server admits one rate-limit token per record in a chunk, not one per
request: a full 500-record chunk costs 500 units against your tenant and
producer buckets. The server's default burst configuration is sized to
admit one full-size chunk from an otherwise-idle bucket; sustained
concurrent worker throughput is still bounded by the server's configured
per-second rate, so tune `BatchOptions`/worker concurrency to your
account's documented rate rather than assuming every chunk can go out
back-to-back.

## Outbox decision table

Every response this SDK can return maps to exactly one of three outbox
actions — delete the row, keep it for retry, or move it to operator
quarantine. This mirrors `audit-service-docs/contracts.md` §4.3's outbox
decision table; nothing here should ever disagree with it.

| Outcome | Action | Why |
|---|---|---|
| `Status == "ACCEPTED"` or `"DUPLICATE"` | Delete outbox row | Durably accepted (or a safe retry of already-accepted content) |
| Batch item `Status == "REJECTED"`, `Error.Retryable == true` | Keep row, retry later | Temporary or ambiguous infrastructure failure |
| Batch item `Status == "REJECTED"`, `Error.Retryable == false` | Move row to quarantine | Permanently invalid; retrying cannot succeed |
| Whole-request `*APIError` with `Retryable == true` (network error, `429`, `5xx`) | Retry the same prepared payload later | No durable per-item result can be trusted, or the outcome is ambiguous |
| Whole-request `*APIError` with `Retryable == false` (`400`, `401`, `403`, `409`, `413`) | Quarantine | Retrying the unchanged request cannot succeed |

```go
func handleBatchResult(result audit.BatchResult) {
	for _, item := range result.Results {
		switch item.Status {
		case "ACCEPTED", "DUPLICATE":
			markOutboxSent(item.RecordID)
		case "REJECTED":
			if item.Error != nil && item.Error.Retryable {
				keepForRetry(item.RecordID)
				continue
			}
			moveToQuarantine(item.RecordID, item.Error.Code)
		}
	}
}
```

## Transaction lifecycle example

```go
txn := client.NewTransaction()

start, err := txn.Record(context.Background(), audit.TransactionStartInput{
	OccurredAt: time.Now(),
	EventType:  "order.creation",
	Category:   "ORDER",
	Action:     "CREATE",
	Actor:      audit.Actor{Type: audit.ActorTypeUser, ID: "user_123"},
	Resource:   audit.Resource{Type: "ORDER", ID: "ord_456"},
})
if err != nil {
	log.Fatal(err)
}

// ... your business work happens here ...

if businessErr != nil {
	if _, abortErr := txn.Abort(context.Background(), audit.TransactionAbortInput{
		OccurredAt: time.Now(),
		Result:     audit.ResultFailure, // omit Result and it defaults to FAILURE
		Outcome:    &audit.EventOutcome{ReasonCode: "VALIDATION_FAILED", ReasonSafe: "Order could not be created."},
	}); abortErr != nil {
		// Both businessErr and abortErr matter: the original failure and
		// whether the audit trail itself durably recorded it are
		// independent facts. Never let a failed Abort call hide or
		// replace businessErr.
		log.Printf("business error: %v; audit abort also failed: %v", businessErr, abortErr)
	}
	return
}

if _, err := txn.Complete(context.Background(), audit.TransactionCompleteInput{OccurredAt: time.Now()}); err != nil {
	log.Fatal(err)
}
_ = start
```

A `Transaction` describes exactly one logical event's STARTED ->
COMPLETED|ABORTED lifecycle — it is not a workflow, saga, or multi-step
batch. It is process-local: `NewTransaction` holds no durable state, and
there is no way to "resume" a `Transaction` object after a process
restart. If your process crashes after `Record` succeeds but before
`Complete`/`Abort` is called, the evidence honestly remains
`STARTED`, then (after the server's configured incomplete threshold)
displays as `Incomplete - no terminal record observed` — nothing
auto-aborts it. A caller that needs restart recovery must durably
persist `txn.AuditTransactionID()`, `txn.EventID()`, and
`txn.StartRecordID()` itself *before* treating the start as sent, and
issue the eventual terminal call via a fresh `Transaction` or a raw HTTP
call against the documented `/complete`/`/abort` routes — there is no
SDK-level "reattach to an existing Transaction" API.

`Complete` and `Abort` are mutually exclusive and each may be called at
most once successfully; calling `Record`, `Complete`, or `Abort` while a
previous call on the same `Transaction` is still in flight returns a
non-retryable validation error rather than racing two requests for the
same transaction. `Abort`'s `Result` defaults to `audit.ResultFailure`
when left empty — SDKs abort as failure by default so a caller does not
have to remember to set it for the common case.

One-shot `Record`/outbox delivery remains the preferred tool when only
the final fact matters (e.g. "an order was created") — reach for a
`Transaction` specifically when you need durable evidence that an
attempt *started*, independent of whether it later succeeded.

## Cancellation example

```go
ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
defer cancel()

receipt, err := client.Record(ctx, event, audit.RecordOptions{Timeout: 1500 * time.Millisecond})
if err != nil {
	var apiErr *audit.APIError
	if errors.As(err, &apiErr) && apiErr.Code == audit.CodeCanceled {
		// caller-driven cancellation — never retried
	}
}
```

`RecordOptions.Timeout` bounds each individual attempt; `ctx` bounds the
whole logical call (including time spent waiting between retries). A
per-attempt timeout is retried (it is ambiguous — the record may already
be durably accepted); a caller-driven `ctx` cancellation is never
retried.

## Credential rotation example

```go
client, err := audit.NewClient(audit.Config{
	// Called immediately before every attempt, so a credential rotation
	// takes effect on the very next request — no process restart needed.
	APIKeyProvider: func(ctx context.Context) (string, error) {
		return loadCurrentProducerKeyFromYourSecretStore(ctx)
	},
	BaseURL: "https://audit.example.com",
})
```

## `errors.As` example

```go
_, err := client.Record(ctx, event, audit.RecordOptions{})
var apiErr *audit.APIError
if errors.As(err, &apiErr) {
	log.Printf("code=%s httpStatus=%d retryable=%t requestID=%s", apiErr.Code, apiErr.HTTPStatus, apiErr.Retryable, apiErr.RequestID)
}
```

`APIError.Error()` returns a safe, generic message plus the stable
`Code` (never secret) — the API key and the request payload are never
in `Error()`'s string or in any `APIError` field. Richer detail is only
available through the typed fields above.

## Retry semantics

`APIError.Retryable` is read directly from the server response's own
`retryable` field when present; the table below is used only as a
fallback for a server response that omits it (an older server or a
malformed body). The server is always the source of truth.

| Condition | Retried? | Why |
|---|---|---|
| Network timeout / connection reset | Yes | Ambiguous — the request may have already been durably accepted; retrying reuses the same `record_id`, which the server resolves idempotently. |
| `429 RATE_LIMIT_ERROR` | Yes | Transient; honors `Retry-After` if present. |
| `503` (`INGESTION_UNAVAILABLE` / `SERVICE_UNAVAILABLE_ERROR`) | Yes | Transient dependency outage. |
| Any other `5xx` | Yes | Ambiguous server-side failure; same idempotent-resolution argument as a network timeout. |
| `400 INVALID_SCHEMA` / `413 PAYLOAD_TOO_LARGE` | No | The request is malformed or too large; retrying with the same bytes cannot succeed. |
| `401 UNAUTHORIZED_ERROR` / `403 INSUFFICIENT_PERMISSION` | No | The credential is invalid or lacks permission. |
| `409 IDEMPOTENCY_CONFLICT` | No | The same `record_id` already has *different* immutable content on record; only a new `record_id` can be a fresh attempt. |
| `409 TRANSACTION_ALREADY_TERMINAL` | No | A terminal record already exists for this transaction; a second `Complete`/`Abort` cannot succeed. |
| `400 INVALID_LIFECYCLE` | No | The transition itself is invalid (wrong reference, arbitrary state, an aborted result other than FAILURE/DENIED). |
| `ctx` is canceled/deadline-exceeded | No | You asked for it to stop. |

Backoff is the greater of the server's `Retry-After` (seconds or an
HTTP-date, though `audit-api` today always sends whole seconds) and
exponential backoff (`BaseDelay * 2^(attempt-1)`, capped at `MaxDelay`),
plus a bounded random addition (at most one `BaseDelay` unit). `Record`,
`Complete`, and `Abort` on a `Transaction` share this exact retry
machinery — a `Transaction` call retries transient failures internally
using the same reserved IDs and prepared bytes across every attempt.

## What this SDK does **not** guarantee

Same guarantees (and the same explicit non-guarantees) as the
TypeScript/JavaScript SDK: `202`/an accepted `Record` call means
durably placed on the Kafka acceptance boundary, not "already
queryable"; delivery is exactly-once-*effective* for one immutable
record (the server deduplicates by `record_id`/content hash), not
exactly-once Kafka delivery; and this SDK never makes your own
business-database transaction atomic with event delivery.

## Concurrency

`*Client` holds no mutable per-call state and is safe for concurrent use
by multiple goroutines — one client per process is the intended usage
(see `TestClientConcurrentUse`, intended for `go test -race`).

`*Transaction`, by contrast, is a one-owner helper for one logical
event's lifecycle: construct one per business operation and do not share
it across goroutines that might call it concurrently. It defensively
serializes itself with a mutex (never held across network I/O — state is
reserved/committed under lock, the request itself happens outside it),
so an overlapping call is rejected with a clear, non-retryable error
instead of racing two in-flight requests; that guard exists to fail
loudly, not to make concurrent use of one `Transaction` a supported
pattern.

## Conformance

`transaction_test.go` exercises the shared fixtures under
`internal/testutils/testdata/contracts/sdk/v1/transactions/` (valid
start/complete/abort requests, and the invalid sequences under
`invalid/`), alongside this package's own state-machine and
retry-classification tests.
