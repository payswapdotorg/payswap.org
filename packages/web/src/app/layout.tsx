import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PaySwap — the non-custodial economic operating system",
    template: "%s — PaySwap",
  },
  description:
    "PaySwap connects you to the payment providers and rails you already use — pay, collect, pay out and reconcile with authorization and evidence for every financial action. Non-custodial by construction.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-white font-sans text-stone-900 antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-stone-900 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <SiteHeader />
        {/* tabIndex=-1 makes the skip-link target programmatically
            focusable, so activating "Skip to content" actually MOVES focus
            into the main region (the design system's SkipLink contract) —
            without it, browsers only scroll and keyboard/AT users are left
            at the top of the document. P3-W2-003 defect fix. */}
        <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
