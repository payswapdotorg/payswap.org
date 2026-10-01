import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Package boundary for @payswap/api (W3-002 work order):
 * - src/** may import ONLY relative modules, node: builtins and @payswap/*
 *   workspace packages;
 * - src/** never uses ambient entropy or ambient time for security artifacts
 *   (no Math.random, no Date.now — everything flows through injected clocks);
 * - src/** contains no `any` (strict typing; brief §5);
 * - test/** may additionally import the test framework and relative helpers.
 */

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
  const fromRe = /\bfrom\s*(["'])([^"']+)\1/g;
  const dynamicRe = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  const sideEffectRe = /(?:^|[;\n])\s*import\s*(["'])([^"']+)\1/g;
  for (const match of source.matchAll(fromRe)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(dynamicRe)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(sideEffectRe)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('package boundary (@payswap/api)', () => {
  it('scans a non-empty src tree', () => {
    const files = listSourceFiles(join(process.cwd(), 'src'));
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it('src/** imports only relative modules, node: builtins and @payswap/* packages', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@payswap/');
        if (!allowed) {
          offenders.push(`${file.replace(root + sep, '')}: '${specifier}'`);
        }
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
        offenders.push(`${file.replace(root + sep, '')}: Math.random`);
      }
      if (source.includes('Date.now')) {
        offenders.push(`${file.replace(root + sep, '')}: Date.now`);
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
        offenders.push(file.replace(root + sep, ''));
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
          offenders.push(`${file.replace(root + sep, '')}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
