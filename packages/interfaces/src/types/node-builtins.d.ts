/**
 * Minimal vendored ambient declarations for the node: builtins used by this
 * package.
 *
 * Rationale: @payswap/interfaces is a zero-runtime-dependency package (W3-001
 * Stage 0 TL decision) and the repository lockfile must remain untouched, so
 * @types/node is deliberately NOT added as a dependency. Only the exact
 * surface consumed by src/ and test/ is declared here.
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
  export function createHmac(algorithm: 'sha256' | 'sha512', key: string | Uint8Array): HmacLike;
  export function randomBytes(size: number): { toString(encoding: string): string };
  export function createHash(algorithm: 'sha256'): HashLike;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomUUID(): string;
}

declare module 'node:fs/promises' {
  export interface Dirent {
    isFile(): boolean;
    isDirectory(): boolean;
    name: string;
  }
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

interface ImportMeta {
  readonly url: string;
}
