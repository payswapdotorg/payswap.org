import type { ReactNode } from "react";

// The design system's tokens + component styles for every (auth)-group
// surface (sign-in, onboarding, connect flows). Order matters: components
// consume the --ps-* custom properties from tokens.css.
import "@payswap/design/styles/tokens.css";
import "@payswap/design/styles/components.css";

/**
 * Route-group layout for the authentication/onboarding/connection surfaces
 * (P3-W1-002). These pages render inside the public site chrome (root
 * layout header/footer) with the design-system primitives available.
 */
export default function AuthGroupLayout({ children }: { children: ReactNode }) {
  return <div className="ps-theme-light flex-1 bg-stone-100">{children}</div>;
}
