/**
 * UX-005 — the local recents store (contract 06 §5).
 *
 * "Recent + suggested commands persist per account (local, not server)" —
 * this store is BROWSER-LOCAL ONLY (localStorage), never a server call and
 * never auth-sensitive data: entries carry only what the operator executed
 * (a label, a route, a one-line detail) — no tokens, no principal refs, no
 * query text is persisted beyond the executed entry itself.
 *
 * The client surface holds no principal identity (honesty doctrine: no
 * auth-sensitive data in the search box), so the store is per browser
 * profile rather than per account — documented judgment call; namespacing
 * by account would require shipping an account identifier to the client.
 *
 * Pure functions with SSR/test guards (typeof window checks) — the
 * component calls them inside effects only.
 */

import type { SearchRecentEntry } from "./search-types";

/** The single localStorage key (one store per browser profile). */
export const SEARCH_RECENTS_KEY = "ps-search-recents" as const;

/** How many recents the zero-state renders. */
export const MAX_RECENTS = 5;

/** Load the recents (newest first); [] when storage is unavailable/empty. */
export function loadRecents(store: Storage | null = defaultStore()): readonly SearchRecentEntry[] {
  if (store === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getItem(SEARCH_RECENTS_KEY) ?? "[]") as unknown;
  } catch {
    return []; // corrupted storage is never a crash — it is an honest empty
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: SearchRecentEntry[] = [];
  for (const candidate of parsed) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { id?: unknown }).id === "string" &&
      typeof (candidate as { label?: unknown }).label === "string" &&
      typeof (candidate as { href?: unknown }).href === "string" &&
      typeof (candidate as { at?: unknown }).at === "number"
    ) {
      const record = candidate as SearchRecentEntry;
      entries.push({
        id: record.id,
        label: record.label,
        ...(record.detail === undefined ? {} : { detail: record.detail }),
        href: record.href,
        at: record.at,
      });
    }
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, MAX_RECENTS);
}

/**
 * Record one executed entry (deduped by id, newest first, capped at
 * MAX_RECENTS). Returns the new list; a full/unavailable storage is a no-op
 * (recents are an affordance, never a requirement).
 */
export function recordRecent(
  entry: Omit<SearchRecentEntry, "at">,
  at: number = Date.now(),
  store: Storage | null = defaultStore(),
): readonly SearchRecentEntry[] {
  const existing = loadRecents(store).filter((candidate) => candidate.id !== entry.id);
  const next: SearchRecentEntry[] = [
    { ...entry, at },
    ...existing,
  ].slice(0, MAX_RECENTS);
  if (store !== null) {
    try {
      store.setItem(SEARCH_RECENTS_KEY, JSON.stringify(next));
    } catch {
      // Quota or privacy mode — the in-memory list still returns.
    }
  }
  return next;
}

function defaultStore(): Storage | null {
  if (typeof window === "undefined" || window.localStorage === undefined) {
    return null;
  }
  try {
    // Probe access (Safari private mode throws on property access).
    const probe = window.localStorage;
    return probe;
  } catch {
    return null;
  }
}
