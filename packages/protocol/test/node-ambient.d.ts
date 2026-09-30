/**
 * Minimal ambient declarations for the Node built-ins used by TEST files only.
 *
 * The workspace intentionally ships no @types/node (the protocol package has
 * zero runtime dependencies and the lockfile is frozen for W1-001), so the
 * test-local imports of node:fs / node:path / node:url are declared here.
 * These declarations never leak into src/ (the domain boundary test guards
 * that src/** is free of non-relative imports).
 */

declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

interface ImportMeta {
  readonly url: string;
}
