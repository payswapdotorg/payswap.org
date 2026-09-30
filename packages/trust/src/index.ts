/**
 * @payswap/trust — Trust, identity, principals, mandates, delegated authority,
 * authorization decisions and security epoch.
 * Work Order: W2-001 (Stage 0 contract freeze)
 */

export const PACKAGE_NAME = "@payswap/trust" as const;

export * from "./principal.js";
export * from "./mandate.js";
export * from "./attenuation.js";
export * from "./authorization.js";
export * from "./security-epoch.js";
