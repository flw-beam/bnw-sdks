# @flutterwavego/audit-service-sdk

First-party server-side TypeScript/JavaScript SDK for delivering one-shot
Audit Service events to `audit-api`'s `POST /api/v1/events`.

## Server-only — read this first

This SDK holds a long-lived producer secret (your `apiKey`). It must
**only** run in a server-side process you control — never in a browser,
mobile WebView, or any other environment where an end user could extract
the secret from memory or a bundle. The constructor makes a best-effort
attempt to detect a browser runtime (`window` + `document`) and throws if
it finds one, but that check is not exhaustive; it is not a substitute
for keeping this package out of any client-side bundle in the first
place. Producer secrets are also never logged, included in thrown
`AuditError` fields, or exposed via `console.log`/`util.inspect` on the
client — only via the exact string you supply.

## Scope

This SDK is a **producer-write** integration: it prepares audit events,
sends them, and tells the caller whether to delete, retry, or quarantine
an outbox row (see "Retry semantics" and "What this SDK does not
guarantee" below). It does not read events back, search records, run
backfills, or verify archive evidence — those are separate, read-side or
compliance concerns with their own contracts. A caller that only needs
to write audit events does not need anything beyond what is documented
in this README.

## What this SDK actually guarantees

- **Stable identity across retries.** `record_id`/`event_id` are
  generated once (or reused, if you supply your own) and every retry of
  the same logical call sends the exact same canonical bytes under the
  same `record_id`.
- **`ACCEPTED` and `DUPLICATE` are both success.** A safe retry of
  already-durable content resolves normally; it is not an error you need
  to special-case.
- **Retryable failures are retried; permanent ones are not.** Network
  timeouts/resets, `429`, and `5xx` are retried with backoff; `400`,
  `401`, `403`, `409`, and `413` are not, because retrying them can never
  succeed (see "Retry semantics" below).

## What this SDK does **not** guarantee

- It does not make `202 Accepted` mean "already queryable" — coverage
  (how far the processor has durably caught up) is a separate concept
  the read API reports, not something this SDK observes.
- It does not give you exactly-once Kafka delivery. It gives you
  *exactly-once-effective* delivery of one immutable record: the server
  deduplicates retries of the same `record_id`/content, but a `record()`
  call itself can be attempted more than once by you (or by an outbox
  you build on top of `createEvent()`).
- It does not make your own business database transaction atomic with
  event delivery. If you write to your database and call `record()` as
  two separate steps, a crash between them is possible; that is a
  business-level outbox problem this SDK does not solve for you (though
  `createEvent()`'s stable, immutable output is designed to be safely
  storable in your own outbox row if you build one).

## Install

This package is developed in this private repository at `sdks/js/`. Its
current package name is `@flutterwavego/audit-service-sdk`, its version is
`0.1.0`, and it is `private: true`; it is not published to an npm registry.
Existing private-repository consumers still need private access. The planned
distribution path is a public release snapshot in
[`flw-beam/bnw-sdks`](https://github.com/flw-beam/bnw-sdks), with no npm
registry requirement. Public release notes identify the private source commit
used to assemble each exported snapshot.

**Public pnpm Git install — after a public tag exists:**

```sh
pnpm add 'github:flw-beam/bnw-sdks#auditlog-js-vX.Y.Z&path:auditlog-js'
```

The `#<tag>&path:<subdirectory>` form requires pnpm 9 or newer. Quote the
argument because `&` has shell meaning. The tag is an exact package version;
`vX.Y.Z` is a placeholder. `dist/` is intentionally absent from Git. The
package's `prepare` script is intended to build it during the Git install;
the public release process must prove this works in a clean consumer.

**Public npm tarball install — after the release asset exists:**

```sh
npm install 'https://github.com/flw-beam/bnw-sdks/releases/download/auditlog-js-vX.Y.Z/auditlog-js-X.Y.Z.tgz'
```

The publisher will build and attach this `.tgz` to the public GitHub Release.
It contains the built `dist/` output, so npm consumers do not need the SDK
build toolchain. A bare `npm install @flutterwavego/audit-service-sdk` would
need a registry publication and is not part of this workflow.

**Local path — for developing against an unpublished change
in the same checkout:**

```sh
pnpm add "link:../audit-service-api/sdks/js"
```

Requires Node.js 18.17 or later (for its stable global `fetch`).

Pin the SDK release independently of the target environment. Test a version
against staging, then promote the same version to production; configure each
deployment's Audit Service URL and API key at runtime.

## Authentication

`apiKey` supplies one opaque Bearer credential — sent as
`Authorization: Bearer <value>` on every request — and nothing about it
needs to be parsed or interpreted by your code:

```ts
const client = new AuditClient({
  apiKey: process.env.AUDIT_API_KEY!,
  baseUrl: "https://audit.example.com",
});
```

The key is bound server-side, at creation time, to exactly one tenant,
one environment (`development`/`staging`/`production`), a set of
scopes, and an allowed-event-type pattern list — a producer never
selects or overrides any of that from client code or request JSON.
`baseUrl` and the key's own bound environment must agree: a staging key
presented to the production `baseUrl` (or vice versa) fails
authentication the same as any other invalid credential, not with a
distinct error — pick the credential for the environment you are
actually calling. The SDK install version is independent of that choice.

The full secret (`ak_<env>_<key-id>.<random>`) is returned exactly once,
in the response to the create or rotate call that produced it — never
again, on any later read. Treat it as you would any other database
credential: load it from your own secret store, never commit it, and
never log it. `AuditError` and its `.message` are guaranteed to never
contain it.

A missing, malformed, unknown, revoked, or expired key returns a
`401 UNAUTHORIZED_ERROR` with `retryable: false` (see
[Retry semantics](#retry-semantics)) — retrying the exact same request
with the exact same key cannot succeed. See
[Credential rotation example](#credential-rotation-example) below for
how to pick up a new key without a process restart, and
`audit-service-docs/contracts.md` §5 plus
`docs/runbooks/key-rotation.md` in this repository for the full
create/list/rotate/revoke admin contract and the overlap window that
lets an old and a new key both work during a deploy.

## One-shot example

```ts
import { AuditClient } from "@flutterwavego/audit-service-sdk";

const client = new AuditClient({
  apiKey: process.env.AUDIT_API_KEY!,
  baseUrl: "https://audit.example.com",
});

const receipt = await client.record({
  event_type: "order.created",
  category: "ORDER",
  action: "CREATE",
  result: "SUCCESS",
  occurred_at: new Date(),
  actor: { type: "USER", id: "user_123" },
  resource: { type: "ORDER", id: "ord_456" },
});

// receipt.status is "ACCEPTED" or "DUPLICATE" — treat both as success.
console.log(receipt.recordId, receipt.status);
```

## Batch example

```ts
const result = await client.sendBatch([event1, event2]);
for (const item of result.results) {
  // item.status is "ACCEPTED", "DUPLICATE", or "REJECTED".
  // item.index is the item's position in the array you passed in.
  console.log(item.index, item.status);
}
```

`sendBatch` prepares and splits inputs into chunks of up to `MAX_BATCH_RECORDS`
(500) and sends one request per chunk, in order. Each chunk is retried as a
whole on a transient failure (same retry rules as `record`); a single
`REJECTED` item inside an otherwise-successful response is never retried —
it is surfaced in `result.results` for the caller to handle. `createBatch`
is the network-free builder equivalent of `createEvent`, for outbox-style
persistence before delivery; `sendPreparedBatch` delivers one chunk you
already built (e.g. loaded back from an outbox row).

The server admits one rate-limit token per record in a chunk, not one per
request: a full 500-record chunk costs 500 units against your tenant and
producer buckets. The server's default burst configuration is sized to
admit one full-size chunk from an otherwise-idle bucket; sustained
concurrent throughput is still bounded by the server's configured
per-second rate, so size concurrent `sendBatch` calls to your account's
documented rate rather than assuming every chunk can go out back-to-back.

## Outbox decision table

Every response this SDK can return maps to exactly one of three outbox
actions — delete the row, keep it for retry, or move it to operator
quarantine. This mirrors `audit-service-docs/contracts.md` §4.3's outbox
decision table; nothing here should ever disagree with it.

| Outcome | Action | Why |
|---|---|---|
| `status === "ACCEPTED"` or `"DUPLICATE"` | Delete outbox row | Durably accepted (or a safe retry of already-accepted content) |
| Batch item `status === "REJECTED"`, `error.retryable === true` | Keep row, retry later | Temporary or ambiguous infrastructure failure |
| Batch item `status === "REJECTED"`, `error.retryable === false` | Move row to quarantine | Permanently invalid; retrying cannot succeed |
| Thrown `AuditError` with `retryable === true` (network error, `429`, `5xx`) | Retry the same prepared payload later | No durable per-item result can be trusted, or the outcome is ambiguous |
| Thrown `AuditError` with `retryable === false` (`400`, `401`, `403`, `409`, `413`) | Quarantine | Retrying the unchanged request cannot succeed |

```ts
function handleBatchResult(result: BatchResult) {
  for (const item of result.results) {
    switch (item.status) {
      case "ACCEPTED":
      case "DUPLICATE":
        markOutboxSent(item.recordId);
        break;
      case "REJECTED":
        if (item.error?.retryable) {
          keepForRetry(item.recordId);
        } else {
          moveToQuarantine(item.recordId, item.error?.code);
        }
        break;
    }
  }
}
```

## Transaction lifecycle example

```ts
const txn = client.newTransaction();

const start = await txn.record({
  occurred_at: new Date(),
  event_type: "order.creation",
  category: "ORDER",
  action: "CREATE",
  actor: { type: "USER", id: "user_123" },
  resource: { type: "ORDER", id: "ord_456" },
});

try {
  // ... your business work happens here ...
  await txn.complete({ occurred_at: new Date() });
} catch (businessError) {
  try {
    // result defaults to "FAILURE" when omitted
    await txn.abort({ occurred_at: new Date(), outcome: { reason_code: "VALIDATION_FAILED", reason_safe: "Order could not be created." } });
  } catch (abortError) {
    // Both businessError and abortError matter: the original failure and
    // whether the audit trail itself durably recorded it are independent
    // facts. Never let a failed abort call hide or replace businessError.
    console.error("business error:", businessError, "audit abort also failed:", abortError);
  }
  throw businessError;
}
```

A `Transaction` describes exactly one logical event's STARTED ->
COMPLETED|ABORTED lifecycle — it is not a workflow, saga, or multi-step
batch. It is process-local: `client.newTransaction()` holds no durable
state, and there is no way to "resume" a `Transaction` object after a
process restart. If your process crashes after `record` succeeds but
before `complete`/`abort` is called, the evidence honestly remains
`STARTED`, then (after the server's configured incomplete threshold)
displays as `Incomplete - no terminal record observed` — nothing
auto-aborts it. A caller that needs restart recovery must durably
persist the transaction/event/start-record IDs itself *before* treating
the start as sent (`txn.record()`'s resolved receipt carries them), and
issue the eventual terminal call via a fresh `Transaction` or a raw HTTP
call against the documented `/complete`/`/abort` routes — there is no
SDK-level "reattach to an existing Transaction" API.

`complete` and `abort` are mutually exclusive and each may be called at
most once successfully; calling `record`, `complete`, or `abort` while a
previous call on the same `Transaction` is still in flight throws a
non-retryable `AuditError` (`VALIDATION_ERROR`) rather than racing two
requests for the same transaction — JS's single-threaded execution model
makes this a synchronous check with no real lock needed. `abort`'s
`result` defaults to `"FAILURE"` when left empty — SDKs abort as failure
by default so a caller does not have to remember to set it for the
common case.

One-shot `record`/outbox delivery remains the preferred tool when only
the final fact matters (e.g. "an order was created") — reach for a
`Transaction` specifically when you need durable evidence that an
attempt *started*, independent of whether it later succeeded.

## Timeout and cancellation example

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 2_000); // give up after 2s total

try {
  await client.record(event, { signal: controller.signal, timeoutMs: 1_500 });
} catch (error) {
  if (error instanceof AuditError && error.code === "ABORTED") {
    // caller-driven cancellation — never retried
  }
}
```

`timeoutMs` bounds each individual attempt; `signal` bounds the whole
logical call (including time spent waiting between retries). A timeout
is retried (it is ambiguous — the record may already be durably
accepted); an explicit `signal` abort is never retried.

## Credential rotation example

```ts
const client = new AuditClient({
  // Called immediately before every attempt, so a credential rotation
  // takes effect on the very next request — no process restart needed.
  apiKey: async () => await loadCurrentProducerKeyFromYourSecretStore(),
  baseUrl: "https://audit.example.com",
});
```

## Retry semantics

`AuditError.retryable` is read directly from the server response's own
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
| `401 UNAUTHORIZED_ERROR` / `403 INSUFFICIENT_PERMISSION` | No | The credential is invalid or lacks permission; retrying cannot succeed without an operator fixing the credential. |
| `409 IDEMPOTENCY_CONFLICT` | No | The same `record_id` already has *different* immutable content on record — the server will never accept this exact `record_id` again with this content; only a new `record_id` (with correspondingly different content) can be a fresh attempt. |
| `409 TRANSACTION_ALREADY_TERMINAL` | No | A terminal record already exists for this transaction; a second `complete`/`abort` cannot succeed. |
| `400 INVALID_LIFECYCLE` | No | The transition itself is invalid (wrong reference, arbitrary state, an aborted result other than FAILURE/DENIED). |
| Caller-supplied `AbortSignal` fires | No | You asked for it to stop; the SDK never overrides that. |

Backoff is the greater of the server's `Retry-After` (seconds or an
HTTP-date, though `audit-api` today always sends whole seconds) and
exponential backoff (`baseDelayMs * 2^(attempt-1)`, capped at
`maxDelayMs`), plus a bounded random addition (at most one
`baseDelayMs` unit) so many clients retrying the same outage do not
retry in lockstep.

## Ambiguous outcomes

A network timeout, connection reset, or `5xx` never tells you for
certain whether the server durably accepted your event before the
failure. This SDK's answer is always the same: **retry with the exact
same prepared bytes.** Because acceptance is keyed by `record_id` and
compared by canonical content hash, a retry of an already-accepted
event resolves as `DUPLICATE` (success), and a retry of a genuinely
failed attempt proceeds normally. You do not need — and should not
attempt — to guess which case you are in.

## Guarantee vocabulary

- **Prepared**: the immutable, canonicalized output of `createEvent()`.
  Preparing an event never talks to the network.
- **Accepted**: the server has durably placed your event on the Kafka
  acceptance boundary. This SDK's `record()` resolving successfully
  means "accepted," not "already visible to a reader."
- **Duplicate**: a safe retry of content already accepted under the
  same `record_id`. Success, not an error.
- **Idempotency conflict**: the same `record_id` was reused with
  *different* content. A permanent failure — generate a new `record_id`
  for a genuinely new attempt.

This SDK never claims: constructor-time connectivity (the constructor
performs no network I/O at all), immediate post-`record()` queryability,
exactly-once Kafka delivery, or atomicity with any business-database
transaction.

## Advanced: outbox-style preparation

`createEvent()` and `record()` are separate on purpose:

```ts
const prepared = client.createEvent(event); // no network I/O
// ... persist `prepared` in your own outbox table ...
const receipt = await client.record(prepared); // deliver it later, possibly in a different process
```

Phase 3 does not implement outbox relay behavior itself — this only
prepares for a caller to build one.

## Conformance

This SDK is tested against the same language-neutral fixtures the Go SDK
and `audit-api` itself use:
`internal/testutils/testdata/contracts/sdk/v1/**` in this repository (see
`test/canonical.test.ts`, `test/validate.test.ts`, `test/retry.test.ts`,
and `test/transaction.test.ts`, which additionally exercises
`internal/testutils/testdata/contracts/sdk/v1/transactions/**`).
