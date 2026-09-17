// AuditClient — the SDK's one public entry point. The constructor
// validates static config and constructs collaborators, but never
// performs network I/O: no request is sent until `record()` (or a
// caller-driven send of a `createEvent()` result) is actually called.
import { createBatch } from "./batch";
import { sendBatches } from "./batchRetry";
import { AuditError } from "./errors";
import { createEvent } from "./prepare";
import { DEFAULT_RETRY_CONFIG, sendPrepared } from "./retry";
import type { RetryConfigResolved } from "./retry";
import { Transaction } from "./transaction";
import { FetchTransport } from "./transport";
import { newULID } from "./ulid";
import { USER_AGENT } from "./version";
import type { AuditClientConfig, AuditEventInput, BatchOptions, BatchResult, PreparedAuditBatch, PreparedAuditEvent, RecordReceipt, RequestOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

function isBrowserRuntime(): boolean {
    // A conservative, best-effort detector: `window` + `document` is
    // present in every mainstream browser and absent in Node.js,
    // Deno, Bun, and Cloudflare Workers alike. It is deliberately not
    // exhaustive — this SDK's own docs are the authoritative "server-only"
    // boundary; this check only catches the most common accidental case
    // of bundling a long-lived producer secret into a browser build.
    return typeof (globalThis as { window?: unknown }).window !== "undefined"
        && typeof (globalThis as { document?: unknown }).document !== "undefined";
}

function resolveRetryConfig(retry: AuditClientConfig["retry"]): RetryConfigResolved {
    const maxAttempts = retry?.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts;
    const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs;
    const maxDelayMs = retry?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs;
    if (maxAttempts < 1) throw AuditError.config("retry.maxAttempts must be >= 1");
    if (baseDelayMs < 0) throw AuditError.config("retry.baseDelayMs must be >= 0");
    if (maxDelayMs < baseDelayMs) throw AuditError.config("retry.maxDelayMs must be >= retry.baseDelayMs");
    return { maxAttempts, baseDelayMs, maxDelayMs };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}

export class AuditClient {
    private readonly resolveApiKey: () => Promise<string>;
    private readonly baseUrl: string;
    private readonly transport: import("./types").AuditTransport;
    private readonly retry: RetryConfigResolved;
    private readonly defaultTimeoutMs: number;
    private readonly now: () => Date;
    private readonly random: () => number;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

    constructor(config: AuditClientConfig) {
        if (!config.apiKey) {
            throw AuditError.config("apiKey is required (a string or a () => string | Promise<string> provider)");
        }
        if (!config.baseUrl) {
            throw AuditError.config("baseUrl is required");
        }

        let parsedBaseUrl: URL;
        try {
            parsedBaseUrl = new URL(config.baseUrl);
        } catch {
            throw AuditError.config(`baseUrl is not a valid URL: ${config.baseUrl}`);
        }
        if (parsedBaseUrl.protocol !== "https:" && !config.allowInsecureHttp) {
            throw AuditError.config(
                `baseUrl must use HTTPS (got "${parsedBaseUrl.protocol}"); set allowInsecureHttp: true only for local development`,
            );
        }

        if (isBrowserRuntime()) {
            throw AuditError.config(
                "AuditClient is server-only: it holds a long-lived producer secret that must never reach a browser. "
                + "Use it from a server-side process (e.g. your backend), never from client-side/browser JavaScript.",
            );
        }

        this.baseUrl = config.baseUrl;
        this.resolveApiKey = typeof config.apiKey === "string"
            ? (() => {
                const key = config.apiKey as string;
                return () => Promise.resolve(key);
            })()
            : async () => (config.apiKey as () => string | Promise<string>)();
        this.transport = config.transport ?? new FetchTransport();
        this.retry = resolveRetryConfig(config.retry);
        this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.now = config.now ?? (() => new Date());
        this.random = config.random ?? Math.random;
        this.sleep = config.sleep ?? defaultSleep;
    }

    /**
     * Assigns stable IDs and canonicalizes `input` once. The result is
     * immutable and safe to persist (e.g. in an outbox row) and resend
     * later — resending it never changes its identity or bytes. Phase 3
     * does not implement outbox relay itself; this only prepares for it.
     */
    createEvent(input: AuditEventInput): PreparedAuditEvent {
        return createEvent(input, { now: this.now, random: this.random });
    }

    /**
     * Prepares `input` (if not already a PreparedAuditEvent) and durably
     * delivers it, retrying eligible transient failures with the exact
     * same prepared bytes. Resolves for both ACCEPTED and DUPLICATE — a
     * caller must not treat DUPLICATE as an error.
     */
    async record(input: AuditEventInput | PreparedAuditEvent, options: RequestOptions = {}): Promise<RecordReceipt> {
        const prepared = isPrepared(input) ? input : this.createEvent(input);
        return sendPrepared(prepared, options, {
            transport: this.transport,
            baseUrl: this.baseUrl,
            resolveApiKey: this.resolveApiKey,
            userAgent: USER_AGENT,
            retry: this.retry,
            defaultTimeoutMs: this.defaultTimeoutMs,
            random: this.random,
            sleep: this.sleep,
            newRequestId: () => newULID(this.now(), this.random),
        });
    }

    /**
     * Prepares every input once, then splits into one or more network-
     * ready chunks bounded by MAX_BATCH_RECORDS, preserving input order.
     * Performs no network I/O.
     */
    createBatch(inputs: AuditEventInput[]): PreparedAuditBatch[] {
        return createBatch(inputs, { now: this.now, random: this.random });
    }

    /**
     * Prepares inputs (equivalent to createBatch) and durably delivers
     * every resulting chunk, in order, retrying each chunk's eligible
     * transient failures with that chunk's exact prepared bytes.
     */
    async sendBatch(inputs: AuditEventInput[], options: BatchOptions = {}): Promise<BatchResult> {
        const batches = this.createBatch(inputs);
        return this.sendBatchesInternal(batches, options);
    }

    /**
     * Delivers one already-prepared chunk — e.g. one loaded back from
     * outbox rows — skipping re-preparation.
     */
    async sendPreparedBatch(batch: PreparedAuditBatch, options: BatchOptions = {}): Promise<BatchResult> {
        return this.sendBatchesInternal([batch], options);
    }

    private async sendBatchesInternal(batches: PreparedAuditBatch[], options: BatchOptions): Promise<BatchResult> {
        return sendBatches(batches, options, {
            transport: this.transport,
            baseUrl: this.baseUrl,
            resolveApiKey: this.resolveApiKey,
            userAgent: USER_AGENT,
            retry: this.retry,
            defaultTimeoutMs: this.defaultTimeoutMs,
            random: this.random,
            sleep: this.sleep,
            newRequestId: () => newULID(this.now(), this.random),
        });
    }

    /**
     * Constructs a new, unstarted `Transaction` helper for one Audit
     * Transaction lifecycle (STARTED -> COMPLETED|ABORTED). Construct one
     * Transaction per logical business operation — it is not shared
     * across unrelated operations, and it holds no durable state (see
     * the README's "Transaction lifecycle" section).
     */
    newTransaction(): Transaction {
        return new Transaction({
            transport: this.transport,
            baseUrl: this.baseUrl,
            resolveApiKey: this.resolveApiKey,
            userAgent: USER_AGENT,
            retry: this.retry,
            defaultTimeoutMs: this.defaultTimeoutMs,
            random: this.random,
            sleep: this.sleep,
            newRequestId: () => newULID(this.now(), this.random),
            now: this.now,
        });
    }
}

function isPrepared(value: AuditEventInput | PreparedAuditEvent): value is PreparedAuditEvent {
    return typeof (value as PreparedAuditEvent).payload === "string" && typeof (value as PreparedAuditEvent).recordId === "string";
}
