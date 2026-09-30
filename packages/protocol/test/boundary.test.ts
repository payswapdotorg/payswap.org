import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architectural boundary guard (W1-001 acceptance):
 * `@payswap/protocol` is a deterministic domain package with ZERO runtime
 * dependencies — provider SDKs, frameworks, drivers and every other package
 * can never cross into it. Every import under src/ must be relative.
 *
 * It also guards determinism at the source level: no pseudo-randomness, no
 * ambient host clock outside the declared edge adapter (clock.ts), no
 * timers standing in for settlement.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

const sourceFiles = listTypeScriptFiles(srcDir);

const MODULE_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
];

function extractModuleSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

describe('architectural boundary: @payswap/protocol', () => {
  it('scans a non-empty source tree', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(10);
    expect(sourceFiles.map((file) => relative(packageRoot, file))).toContain('src/index.ts');
  });

  it('contains ONLY relative imports — zero runtime dependencies (W1-001 acceptance)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of extractModuleSpecifiers(source)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          offenders.push(`${relative(packageRoot, file)} -> '${specifier}'`);
        }
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('never uses pseudo-random sources (Math.random is forbidden everywhere)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (readFileSync(file, 'utf8').includes('Math.random')) {
        offenders.push(relative(packageRoot, file));
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('reads the host wall clock ONLY inside the clock.ts edge adapter', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const relativePath = relative(srcDir, file);
      if (relativePath === 'clock.ts') {
        continue; // declared edge adapter
      }
      if (readFileSync(file, 'utf8').includes('Date.now')) {
        offenders.push(relativePath);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('never schedules timers (no setTimeout standing in for settlement)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (readFileSync(file, 'utf8').includes('setTimeout')) {
        offenders.push(relative(packageRoot, file));
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});
