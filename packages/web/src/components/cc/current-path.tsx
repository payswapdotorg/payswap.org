"use client";

/**
 * Reads the current pathname on the client (post-hydration) for the
 * not-found surface. Renders an honest placeholder server-side and fills in
 * the real path after mount — never a guessed value.
 */

import { useEffect, useState } from "react";

export function CurrentPath({ fallback }: { readonly fallback: string }) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    setPath(window.location.pathname);
  }, []);
  return <span className="ps-mono">{path ?? fallback}</span>;
}
