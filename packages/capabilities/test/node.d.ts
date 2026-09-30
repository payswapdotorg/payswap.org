/**
 * Minimal ambient declarations for node built-ins used by test infrastructure
 * only (the boundary scanner). src/** remains free of any non-relative import.
 */
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
