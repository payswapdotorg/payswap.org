import Link from "next/link";
import {
  COMMAND_CENTER_HREF,
  COMMAND_CENTER_LABEL,
  PRIMARY_NAV,
} from "@/lib/site";

/**
 * PaySwap mark: two opposing arrows (a swap) on an emerald tile.
 * Decorative — the adjacent text carries the name.
 */
export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" className="fill-emerald-700" />
      <path
        d="M7 10h11v-3l7 5-7 5v-3H7z"
        className="fill-white"
      />
      <path
        d="M25 18H14v-3l-7 5 7 5v-3h11z"
        className="fill-emerald-200"
      />
    </svg>
  );
}

function HeaderLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
    >
      {label}
    </Link>
  );
}

/**
 * Mobile navigation — a native <details> disclosure, so it is keyboard
 * operable and screen-reader accessible without any client JavaScript.
 */
function MobileNav() {
  return (
    <details className="relative md:hidden">
      <summary
        aria-label="Open navigation menu"
        className="grid h-11 w-11 cursor-pointer list-none place-items-center rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 [&::-webkit-details-marker]:hidden"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M4 6h16M4 12h16M4 18h16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-2 w-60 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
        <nav aria-label="Mobile" className="flex flex-col">
          {PRIMARY_NAV.map((link) => (
            <HeaderLink key={link.href} href={link.href} label={link.label} />
          ))}
          <Link
            href={COMMAND_CENTER_HREF}
            className="mt-1 flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            Open {COMMAND_CENTER_LABEL}
          </Link>
        </nav>
      </div>
    </details>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/"
          aria-label="PaySwap — home"
          className="flex min-h-[44px] items-center gap-2 rounded-md pr-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-stone-900">
            PaySwap
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center md:flex">
          {PRIMARY_NAV.map((link) => (
            <HeaderLink key={link.href} href={link.href} label={link.label} />
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href={COMMAND_CENTER_HREF}
            className="hidden min-h-[44px] items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 sm:inline-flex"
          >
            Open {COMMAND_CENTER_LABEL}
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
