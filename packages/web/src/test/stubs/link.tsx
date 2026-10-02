import type { AnchorHTMLAttributes } from "react";

/**
 * Test-only stub for next/link: renders a plain anchor so page/component
 * suites can assert server-rendered markup in a node environment without
 * the Next.js runtime. Aliased in vitest.config.ts — never used by the app.
 */
export default function Link({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
