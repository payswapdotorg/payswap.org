/**
 * UX-006 — the merchant ⇄ consumer projection switch (contract 10 §6: "same
 * account, two projections — one product").
 *
 * A SERVER component (progressive enhancement, exactly like the RoleSwitcher
 * pattern): the form posts to the server action, which sets the
 * clearly-marked projection-preference cookie and revalidates /app. It never
 * authenticates, never grants authority and never unlocks session-scoped
 * data — preview mode keeps its honest marking either way.
 *
 * Mounted at PAGE LEVEL on the Command Center home (both projections), per
 * the UX-006 file-ownership plan: the shell files stay untouched (the
 * parallel search lane owns them), so this control is the projection seam's
 * user affordance on the surface that re-composes per projection.
 */

import type { SidebarProjectionKind } from "@payswap/ux";

import { setCcProjectionPreference } from "./projection-actions";

export function ProjectionSwitch({
  projection,
  idPrefix = "cc-projection",
}: {
  /** The effective projection for THIS render (drives the marked state). */
  readonly projection: SidebarProjectionKind;
  readonly idPrefix?: string;
}) {
  const merchantId = `${idPrefix}-merchant`;
  const consumerId = `${idPrefix}-consumer`;
  return (
    <form action={setCcProjectionPreference} className="cc-role-form" data-testid="projection-switch">
      <p className="cc-role-form__note" id={`${idPrefix}-label`}>
        View:{" "}
        <strong>{projection === "consumer" ? "Consumer" : "Merchant"}</strong>{" "}
        — same account, same objects, two projections. The projection never
        changes your session or your authority.
      </p>
      <div className="cc-role-form" role="group" aria-labelledby={`${idPrefix}-label`}>
        <span className="cc-role-form__note">
          <label className="ps-label" htmlFor={merchantId}>
            Merchant view (default)
          </label>
          <input
            id={merchantId}
            type="radio"
            name="projection"
            value="merchant"
            defaultChecked={projection === "merchant"}
            className="ps-select"
          />
        </span>
        <span className="cc-role-form__note">
          <label className="ps-label" htmlFor={consumerId}>
            Consumer view
          </label>
          <input
            id={consumerId}
            type="radio"
            name="projection"
            value="consumer"
            defaultChecked={projection === "consumer"}
            className="ps-select"
          />
        </span>
        <button type="submit" className="ps-button ps-button--sm ps-button--secondary">
          Apply view
        </button>
      </div>
    </form>
  );
}
