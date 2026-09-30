/**
 * Canonical JSON serialization used for hashing and signing contract objects
 * (webhook signatures, approval request hashes).
 *
 * Canonicalization rules (documented contract, deterministic across
 * serializers):
 * - object keys are sorted by UTF-16 code-unit order (ascending);
 * - no insignificant whitespace;
 * - `undefined`-valued object keys are dropped;
 * - `undefined` array entries serialize as null (JSON compatibility);
 * - non-finite numbers, bigint, symbols and functions are rejected;
 * - strings use standard JSON escaping.
 *
 * CONSOLIDATION CANDIDATE: align with @payswap/protocol (W3-002).
 */

export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string' || type === 'boolean') {
    return JSON.stringify(value);
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical JSON: non-finite numbers are not allowed');
    }
    return JSON.stringify(value);
  }
  if (type === 'bigint') {
    throw new Error('canonical JSON: bigint is not allowed; encode as a decimal string');
  }
  if (type === 'undefined') {
    throw new Error('canonical JSON: top-level undefined is not representable');
  }
  if (type !== 'object') {
    throw new Error(`canonical JSON: unsupported value of type ${type}`);
  }
  if (Array.isArray(value)) {
    const items = value.map((element) => (element === undefined ? 'null' : canonicalJson(element)));
    return `[${items.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',');
  return `{${body}}`;
}
