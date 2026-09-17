// Default transport: wraps the platform global `fetch`. AuditClient only
// constructs one when the caller supplies no `transport` override, so a
// client built with a custom transport never requires a global `fetch`
// to exist at all (e.g. in a sandboxed test runtime). Checking for
// `fetch`'s presence here is a capability check, not network I/O — it
// performs no request, so it does not violate "the constructor performs
// no network I/O."
import { AuditError } from "./errors";
import type { AuditTransport, AuditTransportResponse } from "./types";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class FetchTransport implements AuditTransport {
    private readonly fetchImpl: FetchLike;

    constructor(fetchImpl?: FetchLike) {
        this.fetchImpl = fetchImpl ?? resolveGlobalFetch();
    }

    async send(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<AuditTransportResponse> {
        const response = await this.fetchImpl(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            signal: init.signal,
        });
        return {
            status: response.status,
            headers: { get: (name: string) => response.headers.get(name) },
            text: () => response.text(),
        };
    }
}

function resolveGlobalFetch(): FetchLike {
    if (typeof globalThis.fetch !== "function") {
        throw AuditError.config(
            "no global fetch is available in this runtime; either run on Node.js 18.17+ (which provides one) or supply `transport` in AuditClientConfig",
        );
    }
    return globalThis.fetch.bind(globalThis) as FetchLike;
}
