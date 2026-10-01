/**
 * Minimal vendored ambient declarations for the node: builtins used by this
 * package (pattern established by @payswap/interfaces in W3-001).
 *
 * Rationale: @payswap/api declares only @payswap/* workspace dependencies
 * (W3-002 work order); @types/node is deliberately NOT added, so the exact
 * surface consumed by src/ is declared here. Because ambient module
 * declarations are program-global, these declarations also cover the
 * node:crypto imports inside the sibling @payswap/interfaces sources that
 * this package's program type-checks transitively.
 *
 * Remove this file when @types/node enters the workspace dependency set
 * under repository governance.
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
  export function createHmac(algorithm: 'sha256', key: string | Uint8Array): HmacLike;
  export function createHash(algorithm: 'sha256'): HashLike;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomUUID(): string;
}
