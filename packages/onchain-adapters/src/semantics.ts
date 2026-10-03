/**
 * @payswap/onchain-adapters — EXPLICIT family semantics profiles (P4-W2-001
 * hard constraint: "Fee, finality and reorg semantics EXPLICIT per family …
 * An adapter that cannot express a semantic must fail closed, not
 * approximate").
 *
 * Every family adapter declares its fee model, finality model and reorg
 * detection semantics as DATA with provenance — descriptive guidance only:
 * finality itself stays protocol-owned (finality CANDIDATES only, INV-F06).
 * The profiles are validated deterministically; a profile that cannot
 * express its family's semantics is REJECTED at construction, and runtime
 * semantics derivation (from observed rail state) throws
 * SemanticNotExpressibleError rather than approximating.
 *
 * Family models:
 * - EVM:    GAS_AUCTION fee model (EIP-1559 baseFee+priority when expressible),
 *           PROBABILISTIC finality, confirmation-depth guidance, reorgs
 *           detected by BLOCK_HASH observation.
 * - SOLANA: SIGNATURE_FEE model (lamports per signature), slot-depth
 *           confirmation guidance, finalized-commitment guidance, forks
 *           detected by SLOT/status observation.
 * - UTXO:   SATOSHI_PER_VBYTE fee model, declared MempoolPolicy (BIP-125
 *           opt-in RBF / CPFP — declared with provenance, never assumed),
 *           PROBABILISTIC finality, depth guidance, reorgs detected by
 *           BLOCK_HASH observation.
 */

import { ValidationError } from "@payswap/protocol";
import type { ChainFamily } from "@payswap/onchain-domain";

// ---------------------------------------------------------------------------
// Fee semantics (exact integer minor units — INV-F01)
// ---------------------------------------------------------------------------

/** EVM GAS_AUCTION fee semantics: EIP-1559 dynamic-fee shape. */
export interface EvmFeeSemantics {
  readonly family: "EVM";
  readonly expressible: true;
  readonly feeModel: "GAS_AUCTION";
  /** Exact base fee per gas in wei (integer decimal string). */
  readonly baseFeePerGasMinorUnits: string;
  /** Exact priority fee per gas in wei, when expressible. */
  readonly priorityFeePerGasMinorUnits?: string;
  /** Exact gas limit in gas units (integer decimal string). */
  readonly gasLimit: string;
  /** Whether EIP-1559 fee parameters are expressible on this observation. */
  readonly eip1559: boolean;
}

/** Solana SIGNATURE_FEE semantics: lamports per signature. */
export interface SolanaFeeSemantics {
  readonly family: "SOLANA";
  readonly expressible: true;
  readonly feeModel: "SIGNATURE_FEE";
  /** Exact lamports charged per signature (integer decimal string). */
  readonly lamportsPerSignature: string;
}

/** UTXO mempool policy declaration (explicit, provenanced — never assumed). */
export interface UtxoMempoolPolicy {
  readonly replacement: "BIP125_OPT_IN" | "UNSUPPORTED" | "UNDECLARED";
  readonly cpfp: "SUPPORTED" | "UNSUPPORTED" | "UNDECLARED";
  /** Provenance of the declaration (documented policy reference). */
  readonly declaredBy: string;
}

/** UTXO SATOSHI_PER_VBYTE fee semantics. */
export interface UtxoFeeSemantics {
  readonly family: "UTXO";
  readonly expressible: true;
  readonly feeModel: "SATOSHI_PER_VBYTE";
  /**
   * Fee rate in satoshi per virtual byte, as an EXACT DECIMAL STRING
   * (verbatim from the provider's numeric text — no float arithmetic). A
   * RATE is not money: fee AMOUNTS are integer satoshi computed downstream by
   * the trusted surface (INV-F01 applies to amounts, not to the observed
   * rate quote, which is carried verbatim with provenance).
   */
  readonly feeRateSatPerVByte: string;
  /** Which confirmation-target estimate bucket the rate was derived from. */
  readonly estimateTargetBlocks: number;
  readonly mempoolPolicy: UtxoMempoolPolicy;
}

/** The union of family fee semantics. */
export type FamilyFeeSemantics = EvmFeeSemantics | SolanaFeeSemantics | UtxoFeeSemantics;

// ---------------------------------------------------------------------------
// Finality + reorg semantics (guidance — finality stays protocol-owned)
// ---------------------------------------------------------------------------

export interface EvmFinalitySemantics {
  readonly family: "EVM";
  readonly finalityModel: "PROBABILISTIC";
  /** Declared confirmation-depth guidance (blocks). */
  readonly confirmationDepthTarget: number;
  /** How reorgs are detected: the containing block's hash is re-observed. */
  readonly reorgDetection: "BLOCK_HASH_OBSERVATION";
}

export interface SolanaFinalitySemantics {
  readonly family: "SOLANA";
  readonly finalityModel: "PROBABILISTIC";
  /** Declared slot-depth confirmation guidance. */
  readonly slotConfirmationTarget: number;
  /** Declared commitment level treated as the finality-candidate gate. */
  readonly finalizedCommitment: "finalized" | "confirmed";
  /** How forks are detected: signature status disappearance at commitment. */
  readonly forkDetection: "SIGNATURE_STATUS_OBSERVATION";
}

export interface UtxoFinalitySemantics {
  readonly family: "UTXO";
  readonly finalityModel: "PROBABILISTIC";
  /** Declared confirmation-depth guidance (blocks/depth). */
  readonly confirmationDepthTarget: number;
  /** How reorgs are detected: the containing block's hash is re-observed. */
  readonly reorgDetection: "BLOCK_HASH_OBSERVATION";
}

export type FamilyFinalitySemantics =
  | EvmFinalitySemantics
  | SolanaFinalitySemantics
  | UtxoFinalitySemantics;

// ---------------------------------------------------------------------------
// The family semantics profile (one per family adapter)
// ---------------------------------------------------------------------------

export interface EvmSemanticsProfile {
  readonly family: "EVM";
  readonly fee: EvmFeeSemantics | { readonly expressible: false; readonly reason: string };
  readonly finality: EvmFinalitySemantics;
}

export interface SolanaSemanticsProfile {
  readonly family: "SOLANA";
  readonly fee: SolanaFeeSemantics | { readonly expressible: false; readonly reason: string };
  readonly finality: SolanaFinalitySemantics;
}

export interface UtxoSemanticsProfile {
  readonly family: "UTXO";
  readonly fee: UtxoFeeSemantics | { readonly expressible: false; readonly reason: string };
  readonly finality: UtxoFinalitySemantics;
}

export type FamilySemanticsProfile =
  | EvmSemanticsProfile
  | SolanaSemanticsProfile
  | UtxoSemanticsProfile;

// ---------------------------------------------------------------------------
// Validation (deterministic, fail closed)
// ---------------------------------------------------------------------------

const EXACT_DECIMAL = /^(0|[1-9][0-9]*)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireExactDecimal(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || !EXACT_DECIMAL.test(value)) {
    errors.push(
      `${label} must be a non-negative exact integer decimal string (INV-F01 — no floating-point fees), got '${String(value)}'`,
    );
  }
}

function requirePositiveInteger(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be a positive integer`);
  }
}

function validateFeeShape(
  candidate: unknown,
  family: ChainFamily,
): FamilyFeeSemantics | { readonly expressible: false; readonly reason: string } {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError(`family '${family}' semantics must declare a fee shape`);
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const expressible = (record as { expressible?: unknown }).expressible;
  if (expressible === false) {
    if (!isNonEmptyString(record.reason)) {
      throw new ValidationError(
        `family '${family}' fee semantics: an inexpressible shape requires an explicit reason — the limitation is recorded, never approximated`,
      );
    }
    return { expressible: false, reason: record.reason };
  }
  const errors: string[] = [];
  switch (family) {
    case "EVM": {
      requireExactDecimal(record.baseFeePerGasMinorUnits, "fee.baseFeePerGasMinorUnits", errors);
      if (
        record.priorityFeePerGasMinorUnits !== undefined &&
        (typeof record.priorityFeePerGasMinorUnits !== "string" ||
          !EXACT_DECIMAL.test(record.priorityFeePerGasMinorUnits))
      ) {
        errors.push("fee.priorityFeePerGasMinorUnits, when present, must be an exact decimal string");
      }
      requireExactDecimal(record.gasLimit, "fee.gasLimit", errors);
      if (record.eip1559 !== true && record.eip1559 !== false) {
        errors.push("fee.eip1559 must be an explicit boolean");
      }
      if (errors.length > 0) {
        throw new ValidationError(`Invalid EVM fee semantics: ${errors.join("; ")}`);
      }
      return {
        family: "EVM",
        expressible: true,
        feeModel: "GAS_AUCTION",
        baseFeePerGasMinorUnits: record.baseFeePerGasMinorUnits as string,
        gasLimit: record.gasLimit as string,
        eip1559: record.eip1559 as boolean,
        ...(isNonEmptyString(record.priorityFeePerGasMinorUnits)
          ? { priorityFeePerGasMinorUnits: record.priorityFeePerGasMinorUnits }
          : {}),
      };
    }
    case "SOLANA": {
      requireExactDecimal(record.lamportsPerSignature, "fee.lamportsPerSignature", errors);
      if (errors.length > 0) {
        throw new ValidationError(`Invalid Solana fee semantics: ${errors.join("; ")}`);
      }
      return {
        family: "SOLANA",
        expressible: true,
        feeModel: "SIGNATURE_FEE",
        lamportsPerSignature: record.lamportsPerSignature as string,
      };
    }
    case "UTXO": {
      if (
        typeof record.feeRateSatPerVByte !== "string" ||
        !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(record.feeRateSatPerVByte)
      ) {
        errors.push(
          "fee.feeRateSatPerVByte must be an exact decimal string (sat/vB, verbatim provider text — no float arithmetic)",
        );
      }
      requirePositiveInteger(record.estimateTargetBlocks, "fee.estimateTargetBlocks", errors);
      const policy = record.mempoolPolicy;
      if (policy === null || typeof policy !== "object") {
        errors.push("fee.mempoolPolicy must be declared (explicit UTXO mempool policy)");
      } else {
        const policyRecord = policy as Readonly<Record<string, unknown>>;
        const replacement = policyRecord.replacement;
        const cpfp = policyRecord.cpfp;
        if (
          replacement !== "BIP125_OPT_IN" &&
          replacement !== "UNSUPPORTED" &&
          replacement !== "UNDECLARED"
        ) {
          errors.push(
            "fee.mempoolPolicy.replacement must be BIP125_OPT_IN, UNSUPPORTED or UNDECLARED (never guessed)",
          );
        }
        if (cpfp !== "SUPPORTED" && cpfp !== "UNSUPPORTED" && cpfp !== "UNDECLARED") {
          errors.push("fee.mempoolPolicy.cpfp must be SUPPORTED, UNSUPPORTED or UNDECLARED");
        }
        if (!isNonEmptyString(policyRecord.declaredBy)) {
          errors.push(
            "fee.mempoolPolicy.declaredBy must be a non-empty provenance reference — a policy claim without provenance is rejected",
          );
        }
        if (errors.length > 0) {
          throw new ValidationError(`Invalid UTXO fee semantics: ${errors.join("; ")}`);
        }
        return {
          family: "UTXO",
          expressible: true,
          feeModel: "SATOSHI_PER_VBYTE",
          feeRateSatPerVByte: record.feeRateSatPerVByte as string,
          estimateTargetBlocks: record.estimateTargetBlocks as number,
          mempoolPolicy: Object.freeze({
            replacement: replacement as UtxoMempoolPolicy["replacement"],
            cpfp: cpfp as UtxoMempoolPolicy["cpfp"],
            declaredBy: policyRecord.declaredBy as string,
          }),
        };
      }
      throw new ValidationError(`Invalid UTXO fee semantics: ${errors.join("; ")}`);
    }
    default:
      throw new ValidationError(
        `family '${String(family)}' has no declared semantics shape (declared shapes: EVM, SOLANA, UTXO — fail closed, never guessed)`,
      );
  }
}

function validateFinalityShape(candidate: unknown, family: ChainFamily): FamilyFinalitySemantics {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError(`family '${family}' semantics must declare a finality shape`);
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const errors: string[] = [];
  switch (family) {
    case "EVM": {
      requirePositiveInteger(record.confirmationDepthTarget, "finality.confirmationDepthTarget", errors);
      if (record.reorgDetection !== "BLOCK_HASH_OBSERVATION") {
        errors.push("finality.reorgDetection must be 'BLOCK_HASH_OBSERVATION' for EVM");
      }
      if (record.finalityModel !== "PROBABILISTIC") {
        errors.push("finality.finalityModel must be 'PROBABILISTIC' for EVM");
      }
      if (errors.length > 0) {
        throw new ValidationError(`Invalid EVM finality semantics: ${errors.join("; ")}`);
      }
      return {
        family: "EVM",
        finalityModel: "PROBABILISTIC",
        confirmationDepthTarget: record.confirmationDepthTarget as number,
        reorgDetection: "BLOCK_HASH_OBSERVATION",
      };
    }
    case "SOLANA": {
      requirePositiveInteger(record.slotConfirmationTarget, "finality.slotConfirmationTarget", errors);
      if (record.finalizedCommitment !== "finalized" && record.finalizedCommitment !== "confirmed") {
        errors.push("finality.finalizedCommitment must be 'finalized' or 'confirmed'");
      }
      if (record.forkDetection !== "SIGNATURE_STATUS_OBSERVATION") {
        errors.push("finality.forkDetection must be 'SIGNATURE_STATUS_OBSERVATION' for Solana");
      }
      if (record.finalityModel !== "PROBABILISTIC") {
        errors.push("finality.finalityModel must be 'PROBABILISTIC' for Solana (forks before final commitment)");
      }
      if (errors.length > 0) {
        throw new ValidationError(`Invalid Solana finality semantics: ${errors.join("; ")}`);
      }
      return {
        family: "SOLANA",
        finalityModel: "PROBABILISTIC",
        slotConfirmationTarget: record.slotConfirmationTarget as number,
        finalizedCommitment: record.finalizedCommitment as "finalized" | "confirmed",
        forkDetection: "SIGNATURE_STATUS_OBSERVATION",
      };
    }
    case "UTXO": {
      requirePositiveInteger(record.confirmationDepthTarget, "finality.confirmationDepthTarget", errors);
      if (record.reorgDetection !== "BLOCK_HASH_OBSERVATION") {
        errors.push("finality.reorgDetection must be 'BLOCK_HASH_OBSERVATION' for UTXO");
      }
      if (record.finalityModel !== "PROBABILISTIC") {
        errors.push("finality.finalityModel must be 'PROBABILISTIC' for UTXO");
      }
      if (errors.length > 0) {
        throw new ValidationError(`Invalid UTXO finality semantics: ${errors.join("; ")}`);
      }
      return {
        family: "UTXO",
        finalityModel: "PROBABILISTIC",
        confirmationDepthTarget: record.confirmationDepthTarget as number,
        reorgDetection: "BLOCK_HASH_OBSERVATION",
      };
    }
    default:
      throw new ValidationError(
        `family '${String(family)}' has no declared finality shape (declared shapes: EVM, SOLANA, UTXO)`,
      );
  }
}

/**
 * Validates a complete family semantics profile (deterministic, fail closed).
 * Returns the frozen profile; an invalid or incomplete profile throws — a
 * family adapter with implicit semantics is unconstructible.
 */
export function validateFamilySemanticsProfile(
  candidate: unknown,
): FamilySemanticsProfile {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("family semantics profile must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const family = record.family;
  if (family !== "EVM" && family !== "SOLANA" && family !== "UTXO") {
    throw new ValidationError(
      "semantics profile family must be EVM, SOLANA or UTXO (the declared adapter families — others fail closed)",
    );
  }
  const fee = validateFeeShape(record.fee, family);
  const finality = validateFinalityShape(record.finality, family);
  return Object.freeze({ family, fee: Object.freeze(fee), finality: Object.freeze(finality) }) as FamilySemanticsProfile;
}
