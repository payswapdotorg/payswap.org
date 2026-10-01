/**
 * Local re-export of the protocol-owned settlement instruction type under a
 * distinct local name (the settlement plane consumes it; it must never
 * redefine it).
 */
import type { SettlementInstruction } from "@payswap/protocol";

export type ProtocolSettlementInstruction = SettlementInstruction;
