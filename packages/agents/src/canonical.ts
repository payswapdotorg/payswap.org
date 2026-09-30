/**
 * Deterministic canonical serialization and content digest.
 *
 * Used to freeze released Organization versions (INV-G02) and to derive stable
 * contract keys. NOT a cryptographic primitive: it detects structural change,
 * it does not defend against adversarial collision. Security-relevant
 * signatures live at the trust/trusted-surface boundary, never here.
 *
 * CONSOLIDATION CANDIDATE (W2-002): align with @payswap/protocol content addressing
 */

export function canonicalString(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return `n:${value.toString()}`;
    case "bigint":
      return `b:${value.toString()}`;
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(",")}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        parts.push(`${JSON.stringify(key)}:${serialize(record[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(
        `canonicalString: unsupported value of type '${typeof value}'`,
      );
  }
}

/** FNV-1a 64-bit digest of the canonical serialization, as lowercase hex. */
export function contentDigest(value: unknown): string {
  const input = serialize(value);
  const prime = 0x100000001b3n;
  const offset = 0xcbf29ce484222325n;
  let hash = offset;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
