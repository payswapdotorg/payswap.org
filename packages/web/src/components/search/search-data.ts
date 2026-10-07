"use server";

/**
 * UX-005 — the honest search data action (contract 06 §3 Resources + §5
 * behavior rules).
 *
 * A SERVER ACTION (Next.js "use server"): the client search surface calls
 * it with the typed query; it reads the operator's OWN session through the
 * certified session plane, resolves the payments-plane input exactly the
 * way the payments collection does, and folds the read into list-cell rows
 * through the SAME pure fold (`foldPaymentsReadForSearch`).
 *
 * Honesty laws:
 * - the query touches only the operator's own account (the principal rides
 *   as request context through `paySwapApiFetch` — the B2 transport law);
 * - no auth-sensitive data is required or returned: rows carry public
 *   identifiers (masked for display), exact pre-formatted amounts, states;
 * - every non-ok plane outcome keeps its own honest status — never
 *   fabricated rows, never "no results" in place of an unconfigured state;
 * - the marked preview carries no session → the honest preview-no-session
 *   state (nothing is read, nothing renders as if it were yours).
 */

import { currentWebSessionContext } from "@/lib/session/server";

import { listPaymentsFor, paymentsPlaneInput } from "@/app/app/payments/_server/payments-plane";

import { foldPaymentsReadForSearch } from "./search-derivation";
import type { SearchResourcesResult } from "./search-types";

/**
 * Query the operator's payments through the honest payments plane (the
 * fixtures/API/honest-empty ladder) and fold the matching rows for the
 * search surface. Async (a server action); pure in its data path.
 */
export async function queryPaymentsResources(query: string): Promise<SearchResourcesResult> {
  const context = await currentWebSessionContext();
  const sessioned = context.configured && context.session.valid;
  const principalRef = sessioned ? context.session.view.principalRef : null;

  const read = await listPaymentsFor(paymentsPlaneInput(principalRef));
  return foldPaymentsReadForSearch(read, query);
}
