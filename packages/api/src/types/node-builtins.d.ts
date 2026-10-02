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
    update(data: Uint8Array): HashLike;
    digest(encoding: 'hex'): string;
    digest(): Uint8Array;
  }
  export interface KeyObjectLike {
    export(options: { readonly format: 'der'; readonly type: 'spki' | 'pkcs8' }): Uint8Array;
  }
  export function createPrivateKey(source: {
    readonly key: Uint8Array;
    readonly format: 'der';
    readonly type: 'pkcs8';
  }): KeyObjectLike;
  export function createPublicKey(privateKey: KeyObjectLike): KeyObjectLike;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObjectLike): Uint8Array;
  export function createHmac(algorithm: 'sha256' | 'sha512', key: string | Uint8Array): HmacLike;
  export function randomBytes(size: number): { toString(encoding: string): string };
  export function createHash(algorithm: 'sha256'): HashLike;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomUUID(): string;
}
