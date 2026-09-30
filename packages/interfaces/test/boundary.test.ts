import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(packageRoot, 'src');

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

describe('package boundary (W3-001: self-contained contracts)', () => {
  it('src/** contains only relative imports and node: builtins', async () => {
    const files = await collectSourceFiles(srcRoot);
    expect(files.length).toBeGreaterThanOrEqual(15);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = match[1];
        if (specifier === undefined) {
          continue;
        }
        if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('node:')) {
          violations.push(`${relative(srcRoot, file)}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
