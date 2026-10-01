import { describe, expect, it } from "vitest";
import type { Money } from "@payswap/protocol";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import type { DocumentAllocation } from "@payswap/payment";
import type { SettlementInstruction } from "../src/instructions.js";
import type { ExternalFundsReconciliationResult } from "../src/reconciliation.js";
import type { SettlementCertificate } from "../src/certificates.js";
import type { ProtocolSettlementInstruction } from "./type-utils.js";

/**
 * Compile-time assertion helpers. A failed Expect<...> is a tsc error, so the
 * type-level guarantees below are enforced by the typecheck gate.
 */
export type Expect<T extends true> = T;
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type AssignableTo<X, Y> = X extends Y ? true : false;

describe("type-level guarantees (W1-004)", () => {
  it("INV-C09: an external funds observation is never assignable to money (never custody)", () => {
    // The nominal observationKind brand + mandatory freshness/provenance make
    // the observation structurally distinct from any Money/balance type.
    type ObservationIsNotMoney = Expect<Equal<AssignableTo<ExternalFundsPositionObservation, Money>, false>>;
    type ResultIsNotMoney = Expect<Equal<AssignableTo<ExternalFundsReconciliationResult, Money>, false>>;
    expect(true).toBe(true);
  });

  it("consumes the protocol settlement instruction (extends it, never redefines it)", () => {
    type SettlementExtendsProtocol = Expect<
      Equal<AssignableTo<SettlementInstruction, ProtocolSettlementInstruction>, true>
    >;
    expect(true).toBe(true);
  });

  it("preserves remittance allocations verbatim end-to-end (payment → instruction → certificate)", () => {
    type InstructionRemittance = Expect<
      Equal<SettlementInstruction["remittance"], readonly DocumentAllocation[]>
    >;
    type CertificateRemittance = Expect<
      Equal<SettlementCertificate["remittance"], readonly DocumentAllocation[]>
    >;
    expect(true).toBe(true);
  });
});
