/**
 * An empty module shim (P3-W2-002 build integration).
 *
 * The @payswap/ux view-model barrel transitively re-exports
 * @payswap/interfaces' webhooks/approval modules, whose node:crypto usage
 * is authority-side (HMAC webhook verification, approval hashing). The web
 * app NEVER invokes those functions (verified: no import of
 * verifyWebhookSignature / approval hashing anywhere in packages/web/src).
 * The next.config webpack section aliases those two interface module FILES
 * to this shim so the client/edge chunks stay pure; the protocol packages
 * themselves are untouched.
 */
export {};
