/**
 * The node-environment test stub for next/navigation: client components call
 * `useRouter().push/refresh` for navigations; in server-rendered test markup
 * there is no router, so the stub is a no-op (navigation behavior is
 * exercised in the real browser deployment — tests assert markup and folds).
 */

export function useRouter(): {
  readonly push: (href: string) => void;
  readonly refresh: () => void;
  readonly back: () => void;
  readonly forward: () => void;
  readonly prefetch: (href: string) => void;
} {
  return {
    push: () => undefined,
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  };
}

export function usePathname(): string {
  return "/";
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
