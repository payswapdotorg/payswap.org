/**
 * UX-005 — the universal search/command surface: shared TYPES (contract 06).
 *
 * Pure types only — no directives, no runtime, no DOM: the same shapes flow
 * through the pure derivation (search-derivation.ts), the server data
 * action (search-data.ts) and the client surface (universal-search.tsx).
 *
 * Honesty laws encoded structurally:
 * - resource rows are DERIVED from the payments plane's reads — a component
 *   never fabricates one (constructors live in the fold, fed by plane data);
 * - every non-ok plane outcome has its OWN status (the honest-state ladder,
 *   contract 07): unconfigured · preview-no-session · http-error ·
 *   network-error — never rendered as "no results";
 * - `amount` strings are PRE-FORMATTED display text from the exact
 *   minor-unit formatter; no float ever touches a money path.
 */

import type { OutcomeState } from "@payswap/design";

/** Which honest rung served (or failed) a payments search read. */
export type SearchResourcesStatus =
  | "ok"
  | "unconfigured"
  | "preview-no-session"
  | "http-error"
  | "network-error";

/** Where the rows came from — stated on the surface, never implied. */
export type SearchResourcesSource = "authoritative-api" | "test-fixtures";

/**
 * One payments list-cell row (contract 06 §3 Resources: "each row = the
 * object's list-cell renderer — masked IDs, status chip"). Derived from a
 * `PaymentRecordView` by the pure fold; the ID is masked for display while
 * `id` stays the public identifier the detail route needs.
 */
export interface SearchPaymentRow {
  readonly id: string;
  /** Masked display form (e.g. "pay_test_u…_to_eur"). */
  readonly maskedId: string;
  readonly state: OutcomeState;
  readonly stateDetail?: string;
  /** Pre-formatted exact amount ("25 USDC"). */
  readonly amount: string;
  readonly counterparty: string;
  readonly description?: string;
  /** Pre-formatted UTC timestamp. */
  readonly createdAt: string;
  /** The masked method line (e.g. "Visa •••• 4242"), when the record has one. */
  readonly methodLine?: string;
}

/**
 * The honest outcome of a resources query: the payments rows when the plane
 * served them, or the plane's own honest state (verbatim message for
 * transport errors) — never a fabricated row, never "no results" in place
 * of an unconfigured state.
 */
export interface SearchResourcesResult {
  readonly status: SearchResourcesStatus;
  readonly source?: SearchResourcesSource;
  readonly payments?: readonly SearchPaymentRow[];
  /** Verbatim transport truth (http/network errors) or the plane's detail. */
  readonly message?: string;
}

/** One recent entry (contract 06 §5: recents persist LOCALLY, never server). */
export interface SearchRecentEntry {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly href: string;
  /** When it was recorded (epoch ms — ordering only, never displayed). */
  readonly at: number;
}
