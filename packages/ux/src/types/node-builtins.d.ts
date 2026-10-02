/**
 * Minimal vendored ambient declarations for the node: builtins used by this
 * package's program (pattern established by @payswap/interfaces in W3-001 and
 * @payswap/api in W3-002).
 *
 * Rationale: @payswap/ux declares only @payswap/* workspace dependencies
 * (W3-006 work order); @types/node is deliberately NOT added, so the exact
 * surface needed is declared here. src/ itself imports no node builtin — the
 * declarations cover the node:crypto imports inside the @payswap/interfaces
 * and @payswap/api sources that this package's program type-checks
 * transitively. Because ambient module declarations are program-global, this
 * also covers the test-side scanner (node:fs / node:path are declared in
 * test/node.d.ts).
 *
 * Remove this file when @types/node enters the workspace dependency set under
 * repository governance.
 */

declare module 'node:crypto' {
  export interface HmacLike {
    update(data: string, inputEncoding: 'utf8'): HmacLike;
    digest(encoding: 'hex'): string;
  }
  export interface HashLike {
    update(data: string, inputEncoding: 'utf8'): HashLike;
    digest(encoding: 'hex'): string;
  }
  export function createHmac(algorithm: 'sha256' | 'sha512', key: string | Uint8Array): HmacLike;
  export function randomBytes(size: number): { toString(encoding: string): string };
  export function createHash(algorithm: 'sha256'): HashLike;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomUUID(): string;
}
