// Minimal ULID generator: 26-character Crockford base32, a 10-character
// millisecond timestamp component followed by a 16-character random
// component. Matches the shape audit-service-api's internal/core/ids
// (oklog/ulid) produces and validates — ids.ValidULID accepts any
// syntactically valid ULID, so this SDK does not need bit-for-bit
// entropy-source parity with the Go implementation, only the same
// 26-character Crockford base32 shape.
//
// No dependency on `ulid`/`uuid`: this SDK ships with zero runtime
// dependencies by design (fewer supply-chain surfaces for a producer
// credential holder to audit).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_LEN = TIME_LEN + RANDOM_LEN;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(timeMs: number): string {
    let remaining = Math.floor(timeMs);
    const chars = new Array<string>(TIME_LEN);
    for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
        chars[i] = ENCODING[remaining % 32] as string;
        remaining = Math.floor(remaining / 32);
    }
    return chars.join("");
}

function encodeRandom(random: () => number): string {
    const chars = new Array<string>(RANDOM_LEN);
    for (let i = 0; i < RANDOM_LEN; i += 1) {
        chars[i] = ENCODING[Math.floor(random() * 32)] as string;
    }
    return chars.join("");
}

/** Generates a fresh ULID for `at`, drawing randomness from `random` (a function returning a float in [0, 1)). */
export function newULID(at: Date, random: () => number): string {
    return encodeTime(at.getTime()) + encodeRandom(random);
}

/** Reports whether `value` is a syntactically valid 26-character Crockford-base32 ULID. */
export function isValidULID(value: string): boolean {
    return ULID_PATTERN.test(value);
}

export const ULID_LENGTH = ULID_LEN;
