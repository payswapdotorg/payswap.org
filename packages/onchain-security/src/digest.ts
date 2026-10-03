/**
 * @payswap/onchain-security — package-local deterministic content digest.
 *
 * Same deliberately-local discipline as @payswap/security signatures.ts and
 * the settlement package's command hash (the protocol kernel exports no
 * general content-addressing primitive at this stage): an FNV-1a 64-bit
 * digest over a canonical bigint-safe serialization. It detects structural
 * change and content-binds authorization artifacts, expected-state diffs
 * and recheck observations. It is NOT a cryptographic defense; signing and
 * signature verification live at the trusted-surface boundary.
 *
 * Deterministic only: pure function of the input value.
 */

/** Deterministic canonical serialization (sorted keys, bigint-safe). */
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
        if (key === undefined) {
          continue;
        }
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

/** FNV-1a 64-bit digest of the canonical serialization, lowercase hex. */
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

/**
 * Content digest of a protocol-owned SettlementInstruction (the financial
 * object a signing request authorizes). Hashes the full instruction
 * content — id, set, parties, exact Money, and the INV-F07 net-position
 * derivation — so ANY drift in what is being settled changes the digest and
 * voids a previously issued authorization at recheck.
 */
export function settlementInstructionDigest(instruction: {
  readonly id: string;
  readonly setId: string;
  readonly debtor: string;
  readonly creditor: string;
  readonly amount: { readonly currency: string; readonly value: bigint };
  readonly fromNetPosition: unknown;
}): string {
  return contentDigest({
    id: instruction.id,
    setId: instruction.setId,
    debtor: instruction.debtor,
    creditor: instruction.creditor,
    amount: { currency: instruction.amount.currency, value: instruction.amount.value },
    fromNetPosition: instruction.fromNetPosition,
  });
}
