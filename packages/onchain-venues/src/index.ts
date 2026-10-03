/**
 * @payswap/onchain-venues — the venue extension-pack contract (P4-W2-002).
 *
 * This barrel is the VENUE-NEUTRAL registration model: how an onchain
 * execution venue registers as a capability pack. It contains NO
 * venue-specific vocabulary (the concrete venue packs are the package's
 * subpath exports — the dependency direction is strictly venue → core,
 * mirrored from the onchain-adapters family model and adversarially
 * verified in test/adversarial.test.ts).
 *
 * A venue extension pack composes the CANONICAL models — never a parallel
 * vocabulary:
 * - the onchain-domain §2A layers: ProtocolDefinition (the descriptive
 *   catalogue entry carrying the full INV-SC01 smart-contract declarations
 *   of every contract the venue comprises — router, factory, settlement
 *   contract), ProtocolImplementation (a provider's implementation) and
 *   ConnectedProtocolInstance (the ONLY protocol-shaped authorization
 *   scope — the catalogue never authorizes, INV-C05);
 * - the onchain-domain capability flavors: DexCapability (DEX/aggregator
 *   venues) and IntentExecutionCapability (solver-oriented venues), both
 *   validated by the canonical flavor validator;
 * - the best-execution ExecutionVenue port: quote (an observation carrying
 *   the full observation law), observeHealth, planWrite (venue-owned
 *   kernel write planning) and simulate.
 *
 * Deterministic identity laws (reused, never duplicated): the protocol
 * capability id is `protocol.${chainKey}:${protocolKey}`; the pack id is
 * `venue-pack/${venueId}@${version}`.
 */

import { ValidationError } from "@payswap/protocol";
import type { ProtocolDefinition } from "@payswap/onchain-domain";
import type { ProtocolImplementation } from "@payswap/onchain-domain";
import { validateProtocolDefinition, validateProtocolImplementation } from "@payswap/onchain-domain";
import type { ExecutionVenue } from "@payswap/best-execution";
import { validateVenueDescriptor } from "@payswap/best-execution";

export const PACKAGE_NAME = "@payswap/onchain-venues" as const;

// The shared venue-neutral §2A capability base (pack-internal helpers).
export * from "./capability-base.js";

// ---------------------------------------------------------------------------
// The venue extension pack
// ---------------------------------------------------------------------------

/**
 * A venue extension pack: everything a venue contributes to the platform —
 * its canonical protocol declarations (onchain-domain), its implementation
 * descriptor, and its execution-venue registration (best-execution port).
 * Venue-specific shapes live inside the venue pack's own files; this
 * contract is venue-neutral.
 */
export interface VenueExtensionPack {
  /** Deterministic pack identity: `venue-pack/${venueId}@${version}`. */
  readonly packId: string;
  readonly version: string;
  /** The venue's registration behind the best-execution port. */
  readonly venue: ExecutionVenue;
  /** The canonical onchain-domain protocol catalogue entry (INV-SC01 declarations). */
  readonly protocol: ProtocolDefinition;
  /** The provider implementation descriptor of this pack's protocol. */
  readonly implementation: ProtocolImplementation;
}

const PACK_ID_PATTERN = /^venue-pack\/[a-z0-9][a-z0-9._:-]{0,63}@\d+\.\d+\.\d+$/;

/**
 * Validates a venue extension pack (fail closed). Deterministic coupling
 * rules:
 * - packId is canonical: `venue-pack/${venueId}@${semver}`;
 * - the venue descriptor, protocol definition and implementation all
 *   validate through the canonical validators;
 * - the venue's protocol binding (protocolKey + chainKey) matches the
 *   protocol definition's descriptor EXACTLY — a pack's venue port and its
 *   protocol declarations are the same venue, never two;
 * - the implementation's protocolKey/chainKey match too.
 */
export function validateVenueExtensionPack(pack: VenueExtensionPack): VenueExtensionPack {
  if (pack === null || typeof pack !== "object") {
    throw new ValidationError("a venue extension pack must be an object");
  }
  const errors: string[] = [];
  if (typeof pack.packId !== "string" || !PACK_ID_PATTERN.test(pack.packId)) {
    errors.push(
      "packId must be canonical 'venue-pack/<venueId>@<semver>' (e.g. 'venue-pack/...@1.0.0')",
    );
  }
  if (typeof pack.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pack.version)) {
    errors.push("version must be semantic (e.g. 1.0.0)");
  }
  try {
    validateVenueDescriptor(pack.venue.descriptor);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let protocol: ProtocolDefinition | undefined;
  try {
    protocol = validateProtocolDefinition(pack.protocol);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let implementation: ProtocolImplementation | undefined;
  try {
    implementation = validateProtocolImplementation(pack.implementation);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (protocol !== undefined) {
    if (protocol.protocol.protocolKey !== pack.venue.protocol.protocolKey) {
      errors.push(
        `the venue port declares protocolKey '${pack.venue.protocol.protocolKey}' but the pack's protocol definition declares '${protocol.protocol.protocolKey}' — a pack is ONE venue`,
      );
    }
    if (protocol.protocol.chainKey !== pack.venue.protocol.chainKey) {
      errors.push(
        `the venue port declares chainKey '${pack.venue.protocol.chainKey}' but the pack's protocol definition declares '${protocol.protocol.chainKey}' — a pack is ONE venue on ONE chain`,
      );
    }
  }
  if (implementation !== undefined) {
    if (implementation.protocolKey !== pack.venue.protocol.protocolKey) {
      errors.push(
        "the implementation descriptor's protocolKey must match the venue's protocol binding",
      );
    }
    if (implementation.chainKey !== pack.venue.protocol.chainKey) {
      errors.push(
        "the implementation descriptor's chainKey must match the venue's protocol binding",
      );
    }
  }
  if (typeof pack.packId === "string" && PACK_ID_PATTERN.test(pack.packId)) {
    const venuePart = pack.packId.slice("venue-pack/".length).split("@")[0] as string;
    if (pack.venue?.descriptor?.venueId !== venuePart) {
      errors.push(
        `packId venue part '${venuePart}' must equal the venue descriptor's venueId '${String(pack.venue?.descriptor?.venueId)}'`,
      );
    }
    const versionPart = pack.packId.split("@").pop() as string;
    if (pack.version !== versionPart) {
      errors.push("packId version part must equal the pack's version field");
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid venue extension pack: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
  return Object.freeze({
    packId: pack.packId,
    version: pack.version,
    venue: pack.venue,
    protocol: protocol as ProtocolDefinition,
    implementation: implementation as ProtocolImplementation,
  });
}

/** Deterministic pack identity: `venue-pack/${venueId}@${version}`. */
export function venuePackId(venueId: string, version: string): string {
  return `venue-pack/${venueId}@${version}`;
}
