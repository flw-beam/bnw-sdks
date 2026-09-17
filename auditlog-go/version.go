package audit

// Version identifies this module's own release. Keep it in lockstep with
// any tag/release this module cuts — there is no build-time injection
// step. Sent as part of every request's User-Agent header.
const Version = "0.1.2"

// userAgent is the exact User-Agent value every request sends.
const userAgent = "audit-service-sdk-go/" + Version
