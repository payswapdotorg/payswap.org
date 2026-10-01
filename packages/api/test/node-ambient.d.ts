/**
 * Minimal ambient declarations for the Node built-ins used by TEST files only
 * (the boundary scanner) — pattern established by @payswap/trust in W2-001.
 * src/ uses only node:crypto, declared in src/types/node-builtins.d.ts.
 */

declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
  };
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export const sep: string;
}

declare const process: {
  cwd(): string;
};
