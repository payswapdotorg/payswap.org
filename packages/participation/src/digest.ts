/**
 * @payswap/participation — deterministic digests (W3-004 internal).
 *
 * Determinism discipline (W3-004 §5): no clock randomness, no Math.random,
 * no ambient entropy anywhere in this package. Digests used for cohort
 * assignment, program-version fingerprints and reward reproducibility
 * (INV-P03) are computed with FNV-1a over an exact, ordered serialization
 * of their inputs — identical inputs always produce identical digests on
 * every platform (pure integer arithmetic over UTF-8 code units).
 */

/** FNV-1a 32-bit over the UTF-16 code units of `input`. Pure and stable. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    hash ^= code;
    // 32-bit FNV prime multiplication via shifts (avoids float precision loss).
    hash =
      (hash + ((hash << 1) >>> 0) + ((hash << 4) >>> 0) + ((hash << 7) >>> 0) + ((hash << 8) >>> 0) + ((hash << 24) >>> 0)) >>>
      0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministic digest of ordered parts: parts are joined with a separator
 * that callers must never embed in the parts (the length prefix below makes
 * the serialization prefix-free, so embedded separators cannot cause
 * collisions between different part boundaries).
 */
export function stableDigest(parts: readonly string[]): string {
  let serialized = '';
  for (const part of parts) {
    serialized += `${part.length}:${part}`;
  }
  return `dgb1:${fnv1a32(serialized)}`;
}
