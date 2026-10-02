/**
 * Shared site constants for the PaySwap public web surface.
 */

export const SITE_NAME = "PaySwap" as const;

export const SITE_TAGLINE =
  "The non-custodial economic operating system for the payment providers and rails you already use." as const;

export interface NavLink {
  readonly href: string;
  readonly label: string;
}

/** Primary navigation of the public site. */
export const PRIMARY_NAV: readonly NavLink[] = [
  { href: "/", label: "Home" },
  { href: "/capabilities", label: "Capabilities" },
  { href: "/security", label: "Security" },
  { href: "/developers", label: "Developers" },
];

/** The authenticated entry boundary (honest gate in this deployment phase). */
export const COMMAND_CENTER_HREF = "/app" as const;
export const COMMAND_CENTER_LABEL = "Command Center" as const;
