/**
 * Minimal ambient declarations for platform builtins. This package's
 * TypeScript program includes @payswap/rails and @payswap/adapters sources
 * (workspace exports resolve to src): the fiat/mobile-money rails use the
 * real fetch surface (AbortController/timers/fetch/URLSearchParams/Buffer)
 * and the env-driven credential surface (process.env / NodeJS.ProcessEnv),
 * and the adapters' deterministic HMAC webhook verifier imports node:crypto.
 * These declarations match the real builtin signatures for exactly the
 * surface used (same pattern as packages/journeys/test/node.d.ts).
 * test/** additionally uses node:fs / node:path for the boundary scanner.
 */
declare module "node:crypto" {
  export interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "hex"): string;
  }
  export interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Uint8Array;
  }
  export interface KeyObject {
    export(options: { readonly format: "der"; readonly type: "spki" | "pkcs8" }): Uint8Array;
  }
  export function createHmac(algorithm: "sha256" | "sha512", secret: string): Hmac;
  export function randomBytes(size: number): Buffer;
  export function createHash(algorithm: "sha256"): Hash;
  export function createPrivateKey(source: {
    readonly key: Uint8Array;
    readonly format: "der";
    readonly type: "pkcs8";
  }): KeyObject;
  export function createPublicKey(privateKey: KeyObject): KeyObject;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): Uint8Array;
}

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
  };
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export const sep: string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare namespace NodeJS {
  export interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

declare const process: {
  readonly env: NodeJS.ProcessEnv;
  cwd(): string;
};

interface AbortSignalLike {
  readonly aborted: boolean;
}

declare class AbortController {
  readonly signal: AbortSignalLike;
  abort(): void;
}

declare function setTimeout(handler: () => void, timeout: number): number;
declare function clearTimeout(id: number): void;

declare class URLSearchParams {
  constructor(init: string | Readonly<Record<string, string>>);
  toString(): string;
}

declare class Buffer {
  static from(input: string, encoding: string): Buffer;
  toString(encoding: string): string;
}

declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignalLike;
    cache?: string;
  },
): Promise<{ readonly status: number; text(): Promise<string> }>;
