/**
 * Client-safe CSRF constants (split from csrf.ts, P3-W1-002).
 *
 * The HMAC machinery in csrf.ts is server-only (node:crypto); client
 * modules need only the header/prefix NAMES. This module carries no
 * imports at all so it is safe in every compilation.
 */
export const CSRF_HEADER = "x-payswap-csrf" as const;
export const CSRF_PREFIX = "csrf_v1_" as const;
