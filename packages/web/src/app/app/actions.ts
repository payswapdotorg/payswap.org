"use server";

/**
 * Command Center server actions (P3-W2-002).
 *
 * The role preference is a CLEARLY-MARKED preview affordance — it never
 * authenticates, never grants authority and never unlocks session-scoped
 * data (those sections keep their honest unavailable states in preview
 * mode). Invalid input fails closed to "no preference".
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { ProductRole } from "@payswap/ux";
import { PRODUCT_ROLES } from "@payswap/ux";

import { CC_ROLE_COOKIE } from "@/lib/cc/session-seam";

function parseRole(value: FormDataEntryValue | null): ProductRole | null {
  if (typeof value !== "string") {
    return null;
  }
  return (PRODUCT_ROLES as readonly string[]).includes(value) ? (value as ProductRole) : null;
}

/**
 * Set (or clear) the Command Center role preference cookie, then revalidate
 * the /app tree so the navigation derivation re-renders server-side.
 */
export async function setCcRolePreference(formData: FormData): Promise<void> {
  const role = parseRole(formData.get("role"));
  const store = await cookies();
  if (role === null) {
    store.delete(CC_ROLE_COOKIE);
  } else {
    store.set(CC_ROLE_COOKIE, role, {
      path: "/",
      sameSite: "lax",
      httpOnly: false, // read by server render; no authority is derived from it
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  revalidatePath("/app", "layout");
}
