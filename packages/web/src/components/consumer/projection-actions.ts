"use server";

/**
 * UX-006 — the projection-preference server action (contract 10 §6: "merchant
 * CAN switch projections — same account, two projections").
 *
 * The projection preference is a CLEARLY-MARKED view derivation with exactly
 * the same law as the role preference (`setCcRolePreference`): it never
 * authenticates, never grants authority, never unlocks session-scoped data
 * and never touches financial state. Switching projections changes how the
 * SAME object model is labeled and composed — never which objects exist.
 *
 * The merchant projection stays the default: an absent or invalid value
 * fails closed to "no preference" (the role's own default applies).
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { CC_PROJECTION_COOKIE } from "@/lib/cc/session-seam";

function parseProjection(value: FormDataEntryValue | null): "merchant" | "consumer" | null {
  if (value !== "merchant" && value !== "consumer") {
    return null;
  }
  return value;
}

/**
 * Set (or clear) the Command Center projection preference cookie, then
 * revalidate the /app tree so the projection derivation re-renders
 * server-side. The cookie mirrors the role cookie's shape: readable by the
 * server render, no authority derived from it, expiring with the visit week.
 */
export async function setCcProjectionPreference(formData: FormData): Promise<void> {
  const projection = parseProjection(formData.get("projection"));
  const store = await cookies();
  if (projection === null) {
    store.delete(CC_PROJECTION_COOKIE);
  } else {
    store.set(CC_PROJECTION_COOKIE, projection, {
      path: "/",
      sameSite: "lax",
      httpOnly: false, // read by server render; no authority is derived from it
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  revalidatePath("/app", "layout");
}
