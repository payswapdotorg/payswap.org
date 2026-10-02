import Link from "next/link";

import { CurrentPath } from "@/components/cc/current-path";

/**
 * The honest unmatched-deep-link notice (Wave 1's doctrine, preserved):
 * /app deep links never 404 silently — unmatched /app/* paths render this
 * notice inside the Command Center shell, stating exactly what is unknown
 * and where the real sections are.
 */
export default function CommandCenterNotFound() {
  return (
    <section aria-labelledby="cc-notfound-heading">
      <h1 id="cc-notfound-heading" className="cc-section-heading">
        Unrecognized Command Center path
      </h1>
      <p className="cc-section-intro">
        <CurrentPath fallback="this /app path" /> is not one of the Command
        Center sections in the navigation. The URL still resolves (deep links
        never 404 here) — it will serve an authenticated section view if the
        product grows one.
      </p>
      <div className="cc-gate-links">
        <Link href="/app">Go to Overview</Link>
        <Link href="/app/settings">Open Settings</Link>
        <Link href="/">Back to the public site</Link>
      </div>
    </section>
  );
}
