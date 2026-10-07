/**
 * UX-006 — the consumer mobile navigation (contract 10 §6, Phase 1
 * `responsive.md`): a bottom tab bar (Home · Pay · Activity · Contacts ·
 * Safety) plus a floating Send action, visible only below the lg breakpoint
 * (1024px — exactly where the shell's static sidebar hides and the drawer
 * takes over). The sidebar STAYS on desktop; this never replaces it.
 *
 * A SERVER component: show/hide is pure CSS (a scoped style block with a
 * max-width media query — no viewport JS, no hydration cost), every target
 * is a real anchor with a 44px minimum hit area, and the active tab is
 * derived server-side from the current route. Presentational only.
 */

import Link from "next/link";

/** One bottom tab: label + route + the surface it activates on. */
export interface ConsumerTab {
  readonly id: "home" | "pay" | "activity" | "contacts" | "safety";
  readonly label: string;
  readonly href: string;
}

/** The contract-10 §6 tab set — labels in the consumer vocabulary. */
export const CONSUMER_TABS: readonly ConsumerTab[] = Object.freeze([
  { id: "home", label: "Home", href: "/app" },
  { id: "pay", label: "Pay", href: "/app/payments?start=1" },
  { id: "activity", label: "Activity", href: "/app/transactions" },
  { id: "contacts", label: "Contacts", href: "/app?view=contacts" },
  { id: "safety", label: "Safety", href: "/app/safety" },
]);

/**
 * The scoped mobile styles: the bar and FAB render in the DOM on every
 * consumer surface (server-rendered, deep-linkable) but are DISPLAY-NONE at
 * desktop widths, where the object-model sidebar is the navigation. 44px
 * minimum touch targets per the responsive contract.
 */
const CONSUMER_TABBAR_CSS = `
.cc-consumer-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:40;display:flex;justify-content:space-around;align-items:stretch;background:var(--ps-surface,#fff);border-top:1px solid var(--ps-border,#d4d4d8);padding:0;margin:0;list-style:none}
.cc-consumer-tabbar__tab{flex:1 1 0;min-height:44px;display:flex;align-items:center;justify-content:center;padding:10px 4px;font-size:var(--ps-text-sm,0.875rem);color:var(--ps-text,#18181b);text-decoration:none;border-top:3px solid transparent}
.cc-consumer-tabbar__tab[aria-current="page"]{border-top-color:var(--ps-accent,#059669);font-weight:var(--ps-weight-semibold,600)}
.cc-consumer-fab{position:fixed;right:16px;bottom:calc(44px + 20px);z-index:41;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:12px 18px;border-radius:9999px;background:var(--ps-accent,#059669);color:var(--ps-on-accent,#fff);font-weight:var(--ps-weight-semibold,600);text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,0.18)}
@media (min-width:1024px){.cc-consumer-tabbar{display:none}.cc-consumer-fab{display:none}}
`;

export function ConsumerTabBar({ active }: { readonly active?: ConsumerTab["id"] }) {
  return (
    <>
      <style>{CONSUMER_TABBAR_CSS}</style>
      <nav aria-label="Consumer navigation" data-testid="consumer-tabbar">
        <ul className="cc-consumer-tabbar">
          {CONSUMER_TABS.map((tab) => (
            <li key={tab.id}>
              <Link
                href={tab.href}
                className="cc-consumer-tabbar__tab"
                aria-current={tab.id === active ? "page" : undefined}
                data-testid={`consumer-tab-${tab.id}`}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {/* The FAB Send: the one-tap money action, routed to the SAME W1
          create-payment workflow the CreateMenu "Pay" chord opens — never a
          parallel flow (contract 10 §4 reuses W1). */}
      <Link className="cc-consumer-fab" href="/app/payments?start=1" data-testid="consumer-fab-send">
        Send
      </Link>
    </>
  );
}
