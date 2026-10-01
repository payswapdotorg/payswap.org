import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Package boundary (@payswap/ux), following the repo-wide boundary-test
 * convention (see packages/campaigns/test/boundary.test.ts):
 *
 * 1. every non-relative import in src/** is a DECLARED @payswap/* dependency
 *    of this package's package.json (the W3-006 work-order dependency set:
 *    @payswap/api + @payswap/payment + @payswap/execution +
 *    @payswap/interfaces);
 * 2. the declared workspace dependency set is a subset of the frozen maximum
 *    allowlist for this package;
 * 3. src/** NEVER imports a network/DOM primitive — this is the UX CONTRACT
 *    layer: deterministic pure functions, no DOM, no network, no rendering
 *    (journeys reach the protocol exclusively through the injected
 *    @payswap/api handler);
 * 4. src/** never uses ambient entropy or ambient time, and never `any`;
 * 5. test/** imports only relative modules, node: builtins, @payswap/* and
 *    vitest.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  '@payswap/api',
  '@payswap/payment',
  '@payswap/execution',
  '@payswap/interfaces',
];

const FORBIDDEN_IMPORTS: readonly string[] = [
  '@payswap/agents',
  '@payswap/capabilities',
  '@payswap/campaigns',
  '@payswap/connectors',
  '@payswap/trust',
  '@payswap/lab',
  '@payswap/settlement',
  '@payswap/adapters',
  '@payswap/rails',
  '@payswap/security',
  '@payswap/protocol',
  '@payswap/participation',
];

const NETWORK_PRIMITIVES: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /new\s+XMLHttpRequest/,
  /new\s+WebSocket/,
  /from\s+['"]node:http['"]/,
  /from\s+['"]node:https['"]/,
  /from\s+['"]node:net['"]/,
  /from\s+['"]node:dgram['"]/,
];

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function readPackageDeps(): { readonly dependencies: readonly string[]; readonly devDependencies: readonly string[] } {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
  };
  return {
    dependencies: Object.keys(raw.dependencies ?? {}),
    devDependencies: Object.keys(raw.devDependencies ?? {}),
  };
}

describe('package boundary (@payswap/ux)', () => {
  it('scans a non-empty src tree', () => {
    const files = listSourceFiles(join(process.cwd(), 'src'));
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it('src/** imports only its declared @payswap/* dependencies + relative modules', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) {
          continue;
        }
        if (!specifier.startsWith('@payswap/')) {
          offenders.push(`${file.replace(root + '/', '')}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every @payswap/* import in src/** is a declared runtime dependency (W3-006 set)', () => {
    const root = join(process.cwd(), 'src');
    const { dependencies } = readPackageDeps();
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('@payswap/') && !dependencies.includes(specifier)) {
          offenders.push(`${file.replace(root + '/', '')}: '${specifier}' (not declared)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the declared runtime dependency set matches the frozen W3-006 allowlist', () => {
    const { dependencies } = readPackageDeps();
    const workspaceDeps = dependencies.filter((dep) => dep.startsWith('@payswap/'));
    expect([...workspaceDeps].sort()).toEqual([...MAX_WORKSPACE_DEPS].sort());
  });

  it('src/** never imports authority domains outside the allowlist', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (source.includes(`from '${forbidden}'`) || source.includes(`from "${forbidden}"`)) {
          offenders.push(`${file.replace(root + '/', '')}: '${forbidden}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/** contains NO network/DOM primitives (UX contract layer — journeys use the injected api handler)', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of NETWORK_PRIMITIVES) {
        if (pattern.test(source)) {
          offenders.push(`${file.replace(root + '/', '')}: ${String(pattern)}`);
        }
      }
      // DOM API usage (property access on the DOM globals), not the bare words.
      if (/\bdocument\s*\./.test(source) || /\bwindow\s*\./.test(source)) {
        offenders.push(`${file.replace(root + '/', '')}: DOM global usage`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/** never uses ambient entropy or ambient time (no Math.random / Date.now)', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('Math.random')) {
        offenders.push(`${file.replace(root + '/', '')}: Math.random`);
      }
      if (source.includes('Date.now')) {
        offenders.push(`${file.replace(root + '/', '')}: Date.now`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/** contains no `any` (strict typing)', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      if (/\bas\s+any\b/.test(source) || /:\s*any\b/.test(source)) {
        offenders.push(file.replace(root + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('test/** imports only relative modules, node: builtins, @payswap/* and vitest', () => {
    const root = join(process.cwd(), 'test');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@payswap/') ||
          specifier === 'vitest';
        if (!allowed) {
          offenders.push(`${file.replace(root + '/', '')}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
