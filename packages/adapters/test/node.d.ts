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
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export const sep: string;
}

declare const process: {
  cwd(): string;
};
