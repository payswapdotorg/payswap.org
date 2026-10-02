/**
 * Minimal ambient declarations for platform builtins. src/** uses the real
 * fetch (AbortController/timers/fetch/URLSearchParams/Buffer for the Basic
 * auth token) and the env-driven credential surface (process.env /
 * NodeJS.ProcessEnv); test/** additionally uses node:fs / node:path for the
 * boundary scanner. `node:crypto` is declared because this package's
 * TypeScript program includes @payswap/adapters sources (workspace exports
 * resolve to src), whose deterministic HMAC webhook verifier imports it.
 * These declarations match the real builtin signatures for exactly the
 * surface used.
 */
declare module "node:crypto" {
  export interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "hex"): string;
  }
  export function createHmac(algorithm: "sha256" | "sha512", secret: string): Hmac;
  export function randomBytes(size: number): Buffer;
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
  export const sep: string;
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
