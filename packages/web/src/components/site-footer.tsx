import Link from "next/link";
import { Logo } from "@/components/site-header";
import {
  COMMAND_CENTER_HREF,
  COMMAND_CENTER_LABEL,
  PRIMARY_NAV,
} from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-stone-200 bg-stone-50">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2">
              <Logo className="h-6 w-6" />
              <p className="text-sm font-semibold text-stone-900">PaySwap</p>
            </div>
            <p className="mt-3 text-sm leading-6 text-stone-600">
              The non-custodial economic operating system for the payment
              providers and rails you already use. PaySwap never holds your
              funds or your provider credentials.
            </p>
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-10 gap-y-1 sm:grid-cols-2"
          >
            {PRIMARY_NAV.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex min-h-[44px] items-center text-sm font-medium text-stone-600 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href={COMMAND_CENTER_HREF}
              className="flex min-h-[44px] items-center text-sm font-medium text-stone-600 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              {COMMAND_CENTER_LABEL}
            </Link>
          </nav>
        </div>

        <p className="mt-10 border-t border-stone-200 pt-6 text-xs leading-5 text-stone-500">
          © PaySwap.org — Balances and provider state shown in the product are
          external observations from the providers you connect; they are never
          PaySwap custody. Financial truth is protocol-owned: this website
          holds no financial state of its own.
        </p>
      </div>
    </footer>
  );
}
