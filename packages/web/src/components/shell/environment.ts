/**
 * The Command Center environment seam (UX-003, contracts 01 §2 / 02 §9).
 *
 * Which world the deployed surface operates in. This deployment is
 * TEST-ONLY: no mainnet/live PaySwap deployment exists, so the honest
 * marking is the persistent `env.test` band on every authenticated page
 * ("Testnet — you're using test assets. Nothing here touches real money.")
 * plus the badge chip in the topbar.
 *
 * Honesty law: the `live` code path EXISTS (the `EnvironmentBanner`
 * component renders nothing for live — the default world needs no marking)
 * but is UNREACHABLE here. There is deliberately no env-var or query flip:
 * a configurable switch could dress a test deployment in live clothing, and
 * a fake live state is forbidden (runbook: no fabricated states; contract
 * 02 §2 env.live is "default; no special marking" — nothing to fake).
 * When a real live deployment exists, this seam becomes its derivation.
 */

import type { EnvironmentKind } from "@payswap/design";

export type { EnvironmentKind };

/** The world this deployment serves. Constant and honest: test. */
export const CC_ENVIRONMENT: EnvironmentKind = "test" as const;
