// Keep in lockstep with package.json's "version" field — there is no
// build-time injection step, so a release must bump both by hand. Sent
// in the User-Agent of every request per AS-0307.1's package requirements.
export const SDK_VERSION = "0.1.2";
export const SDK_NAME = "audit-service-sdk-js";
export const USER_AGENT = `${SDK_NAME}/${SDK_VERSION}`;
