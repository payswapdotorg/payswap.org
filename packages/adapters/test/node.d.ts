/**
 * Minimal ambient declarations for node builtins. src/** uses node:crypto
 * (the deterministic HMAC webhook verifier); test/** additionally uses
 * node:fs and node:path for the boundary scanner. These declarations match
 * the real builtin signatures for exactly the functions used.
 */
declare module "node:crypto" {
  export interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "hex"): string;
  }
  export function createHmac(algorithm: "sha256" | "sha512", secret: string): Hmac;
}

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
  };
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export const sep: string;
}

declare const process: {
  cwd(): string;
};
