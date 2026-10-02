/**
 * Minimal ambient declarations for the Node built-ins used by TEST files only
 * (tokens.css reading) — pattern established by @payswap/trust in W2-001 and
 * @payswap/ux in W3-006.
 */

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}

declare const process: {
  cwd(): string;
};
