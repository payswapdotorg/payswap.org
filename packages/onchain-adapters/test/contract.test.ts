import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import { ADAPTER_LIFECYCLE_STAGES } from "../src/contract.js";
import type { ChainFamilyAdapter } from "../src/contract.js";
import { validateFamilySemanticsProfile } from "../src/semantics.js";
import { validateLifecycleDeclaration } from "../src/lifecycle.js";
import { evmAdapter, solanaAdapter, utxoAdapter } from "./adapter-fixture.js";
import { UnsupportedLifecycleStageError } from "../src/errors.js";

/**
 * Contract tests per family (work order, contract-first step 2): lifecycle
 * completeness, explicit semantics, environment discrimination — the frozen
 * adapter contract is verified against EVERY delivered family.
 */
const FAMILIES: readonly { readonly name: string; readonly adapter: () => ChainFamilyAdapter }[] = [
  { name: "EVM", adapter: () => evmAdapter() as unknown as ChainFamilyAdapter },
  { name: "SOLANA", adapter: () => solanaAdapter() as unknown as ChainFamilyAdapter },
  { name: "UTXO", adapter: () => utxoAdapter() as unknown as ChainFamilyAdapter },
];

describe("lifecycle completeness (every stage explicit, per family)", () => {
  for (const family of FAMILIES) {
    it(`${family.name}: every lifecycle stage is EXPLICITLY declared true/false`, () => {
      const adapter = family.adapter();
      for (const stage of ADAPTER_LIFECYCLE_STAGES) {
        expect(typeof adapter.lifecycle[stage], `${family.name}.${stage}`).toBe("boolean");
      }
      // The lifecycle vocabulary is exactly the frozen nine stages.
      expect(ADAPTER_LIFECYCLE_STAGES).toHaveLength(9);
      expect(adapter.lifecycle).toHaveProperty("observe");
      expect(adapter.lifecycle).toHaveProperty("prepare");
      expect(adapter.lifecycle).toHaveProperty("simulate");
      expect(adapter.lifecycle).toHaveProperty("authorize");
      expect(adapter.lifecycle).toHaveProperty("broadcast");
      expect(adapter.lifecycle).toHaveProperty("observeResult");
      expect(adapter.lifecycle).toHaveProperty("finality");
      expect(adapter.lifecycle).toHaveProperty("reconcile");
      expect(adapter.lifecycle).toHaveProperty("evidence");
    });

    it(`${family.name}: identity, family and environment are declared and consistent`, () => {
      const adapter = family.adapter();
      expect(adapter.adapterId.length).toBeGreaterThan(0);
      expect(adapter.family).toBe(family.name as "EVM" | "SOLANA" | "UTXO");
      expect(adapter.environment.chainKey).toBe(adapter.chainKey);
      expect(classify(adapter)).toBe(family.name as "EVM" | "SOLANA" | "UTXO");
    });

    it(`${family.name}: explicit semantics profile (fee + finality + reorg/fork)`, () => {
      const adapter = family.adapter();
      expect(adapter.semantics.family).toBe(family.name as "EVM" | "SOLANA" | "UTXO");
      expect(adapter.semantics.finality.finalityModel).toBe("PROBABILISTIC");
      // Re-validated through the semantics validator (round trip).
      expect(() => validateFamilySemanticsProfile(adapter.semantics)).not.toThrow();
    });

    it(`${family.name}: evidence() returns append-only, frozen entries`, () => {
      const adapter = family.adapter();
      expect(Array.isArray(adapter.evidence())).toBe(true);
      const evidence = adapter.evidence();
      for (const entry of evidence) {
        expect(Object.isFrozen(entry)).toBe(true);
        expect(entry.environmentClass).toBe(adapter.environment.environmentClass);
      }
    });
  }

  it("an undeclared lifecycle stage never validates (fail closed)", () => {
    expect(() => validateLifecycleDeclaration({ observe: true })).toThrow(ValidationError);
    expect(() =>
      validateLifecycleDeclaration({
        observe: true,
        prepare: true,
        simulate: "yes",
        authorize: true,
        broadcast: true,
        observeResult: true,
        finality: true,
        reconcile: true,
        evidence: true,
      }),
    ).toThrow(ValidationError);
  });

  it("the UTXO family declares simulate UNSUPPORTED and fails closed when called", () => {
    const adapter = utxoAdapter();
    expect(adapter.lifecycle.simulate).toBe(false);
    expect(() => adapter.simulate()).toThrow(UnsupportedLifecycleStageError);
    expect(() => adapter.simulate()).toThrow(/never approximated/);
  });
});

function classify(adapter: ChainFamilyAdapter): string {
  return adapter.family;
}

describe("semantics profiles fail closed (explicit, never approximated)", () => {
  it("an EVM fee shape without exact integers is rejected (INV-F01)", () => {
    expect(() =>
      validateFamilySemanticsProfile({
        family: "EVM",
        fee: {
          family: "EVM",
          expressible: true,
          feeModel: "GAS_AUCTION",
          baseFeePerGasMinorUnits: "1.5", // float money — rejected
          gasLimit: "21000",
          eip1559: true,
        },
        finality: { family: "EVM", finalityModel: "PROBABILISTIC", confirmationDepthTarget: 12, reorgDetection: "BLOCK_HASH_OBSERVATION" },
      }),
    ).toThrow(ValidationError);
  });

  it("an inexpressible fee REQUIRES an explicit reason (the limitation is recorded)", () => {
    expect(() =>
      validateFamilySemanticsProfile({
        family: "EVM",
        fee: { expressible: false },
        finality: { family: "EVM", finalityModel: "PROBABILISTIC", confirmationDepthTarget: 12, reorgDetection: "BLOCK_HASH_OBSERVATION" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateFamilySemanticsProfile({
        family: "EVM",
        fee: { expressible: false, reason: "no baseFee observed" },
        finality: { family: "EVM", finalityModel: "PROBABILISTIC", confirmationDepthTarget: 12, reorgDetection: "BLOCK_HASH_OBSERVATION" },
      }),
    ).not.toThrow();
  });

  it("a UTXO fee rate is an exact decimal string (verbatim provider text)", () => {
    expect(() =>
      validateFamilySemanticsProfile({
        family: "UTXO",
        fee: {
          family: "UTXO",
          expressible: true,
          feeModel: "SATOSHI_PER_VBYTE",
          feeRateSatPerVByte: "2.5",
          estimateTargetBlocks: 6,
          mempoolPolicy: { replacement: "BIP125_OPT_IN", cpfp: "SUPPORTED", declaredBy: "BIP-125" },
        },
        finality: { family: "UTXO", finalityModel: "PROBABILISTIC", confirmationDepthTarget: 6, reorgDetection: "BLOCK_HASH_OBSERVATION" },
      }),
    ).not.toThrow();
    expect(() =>
      validateFamilySemanticsProfile({
        family: "UTXO",
        fee: {
          family: "UTXO",
          expressible: true,
          feeModel: "SATOSHI_PER_VBYTE",
          feeRateSatPerVByte: "abc",
          estimateTargetBlocks: 6,
          mempoolPolicy: { replacement: "BIP125_OPT_IN", cpfp: "SUPPORTED", declaredBy: "BIP-125" },
        },
        finality: { family: "UTXO", finalityModel: "PROBABILISTIC", confirmationDepthTarget: 6, reorgDetection: "BLOCK_HASH_OBSERVATION" },
      }),
    ).toThrow(ValidationError);
  });

  it("a mempool policy claim without provenance is rejected", () => {
    expect(() =>
      validateFamilySemanticsProfile({
        family: "UTXO",
        fee: {
          family: "UTXO",
          expressible: true,
          feeModel: "SATOSHI_PER_VBYTE",
          feeRateSatPerVByte: "2.5",
          estimateTargetBlocks: 6,
          mempoolPolicy: { replacement: "BIP125_OPT_IN", cpfp: "SUPPORTED", declaredBy: "" },
        },
        finality: { family: "UTXO", finalityModel: "PROBABILISTIC", confirmationDepthTarget: 6, reorgDetection: "BLOCK_HASH_OBSERVATION" },
      }),
    ).toThrow(ValidationError);
  });

  it("family/semantics mismatch fails closed (EVM semantics under a SOLANA profile)", () => {
    expect(() =>
      validateFamilySemanticsProfile({
        family: "SOLANA",
        fee: {
          family: "EVM",
          expressible: true,
          feeModel: "GAS_AUCTION",
          baseFeePerGasMinorUnits: "1",
          gasLimit: "21000",
          eip1559: true,
        },
        finality: { family: "SOLANA", finalityModel: "PROBABILISTIC", slotConfirmationTarget: 32, finalizedCommitment: "finalized", forkDetection: "SIGNATURE_STATUS_OBSERVATION" },
      }),
    ).toThrow(ValidationError);
  });

  it("undeclared families have no semantics shape (MOVE fails closed)", () => {
    expect(() =>
      validateFamilySemanticsProfile({
        family: "MOVE",
        fee: { expressible: false, reason: "-" },
        finality: { family: "MOVE", finalityModel: "DETERMINISTIC" } as never,
      }),
    ).toThrow(ValidationError);
  });
});
