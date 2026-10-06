/**
 * Minimal ambient declarations for node builtins used by test
 * infrastructure (the boundary scanner, the audit scanner, the committed
 * receipt verification). src/** remains free of any non-relative import.
 *
 * This package's TypeScript program includes @payswap/operations sources
 * (workspace exports resolve to src), which transitively include
 * @payswap/journeys and @payswap/rails: the Stellar rail signs with the
 * real node:crypto surface (createPrivateKey/createPublicKey/sign over
 * Uint8Array keys). Those declarations follow the house pattern
 * (packages/adversarial/test/node.d.ts, packages/rails/test/node.d.ts).
 */
declare class Buffer extends Uint8Array {
  static from(input: string | Uint8Array | Buffer, encoding?: string): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  toString(encoding: string): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array | Buffer, encoding?: string): Hash;
    digest(): Uint8Array;
    digest(encoding: "hex" | "base64"): string;
  }
  export interface Hmac {
    update(data: string | Uint8Array | Buffer, encoding?: string): Hmac;
    digest(encoding: "hex" | "base64"): string;
  }
  export interface KeyObject {
    export(options: { readonly format: "der"; readonly type: "spki" | "pkcs8" }): Uint8Array;
  }
  export function createHmac(algorithm: "sha256" | "sha512", secret: string): Hmac;
  export function randomBytes(size: number): Buffer;
  export function createHash(algorithm: "sha256"): Hash;
  export function createPrivateKey(source: {
    readonly key: Uint8Array | Buffer;
    readonly format: "der";
    readonly type: "pkcs8";
  }): KeyObject;
  export function createPublicKey(privateKey: KeyObject): KeyObject;
  export function sign(algorithm: null, data: Uint8Array | Buffer, key: KeyObject): Uint8Array;
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

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};
