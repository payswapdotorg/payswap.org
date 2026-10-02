/**
 * The Command Center role switcher (P3-W2-002) — a SERVER component so the
 * form works without JavaScript (progressive enhancement): the select posts
 * to the server action, which sets the role-preference cookie and
 * revalidates /app.
 *
 * Honesty law: this is a clearly-marked PREVIEW affordance. It never
 * authenticates, never grants authority, and never unlocks session-scoped
 * data — those surfaces keep their honest unavailable states under preview.
 */

import type { ProductRole } from "@payswap/ux";
import { PRODUCT_ROLES } from "@payswap/ux";

import { setCcRolePreference } from "@/app/app/actions";

export function RoleSwitcher({
  rolePreference,
  idPrefix = "cc-role",
}: {
  readonly rolePreference: ProductRole | null;
  readonly idPrefix?: string;
}) {
  const selectId = `${idPrefix}-select`;
  return (
    <form action={setCcRolePreference} className="cc-role-form">
      <label className="ps-label" htmlFor={selectId}>
        View as role (preview)
      </label>
      <select
        id={selectId}
        name="role"
        defaultValue={rolePreference ?? ""}
        className="ps-select cc-role-form__select"
      >
        <option value="">No role selected</option>
        {PRODUCT_ROLES.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      <button type="submit" className="ps-button ps-button--sm ps-button--secondary">
        Apply
      </button>
    </form>
  );
}
