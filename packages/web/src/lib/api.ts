/**
 * Thin client for the authoritative PaySwap API runtime.
 *
 * Law (P3-W1-001 + repo invariants): this web surface is a CONSUMER of the
 * authoritative PaySwap API — it holds no financial state of its own. This
 * module is the single place that knows how to reach that API:
 *
 * - the base URL comes ONLY from NEXT_PUBLIC_PAYSWAP_API_URL (referenced by
 *   name — never a value in Git);
 * - when the variable is absent, every helper returns the honest
 *   `unconfigured` state instead of guessing, defaulting or fabricating;
 * - results are discriminated unions — network failures surface as
 *   network-error, non-2xx as http-error — so no caller can mistake a
 *   transport outcome for financial truth;
 * - there are no retries, no local caching of financial state, no mock
 *   fallbacks. UNKNOWN stays UNKNOWN; the caller reconciles.
 */

/** The environment variable that names the API runtime host. */
export const API_BASE_URL_ENV_VAR = "NEXT_PUBLIC_PAYSWAP_API_URL" as const;

export type ApiRuntimeState =
  | {
      readonly configured: false;
      readonly baseUrl: null;
      readonly envVar: typeof API_BASE_URL_ENV_VAR;
    }
  | {
      readonly configured: true;
      readonly baseUrl: string;
      readonly envVar: typeof API_BASE_URL_ENV_VAR;
    };

/**
 * Resolve the API runtime configuration. The raw value is injectable so
 * callers (and tests) never depend on ambient env mutation.
 */
export function apiRuntimeState(
  rawEnv: string | undefined = process.env[API_BASE_URL_ENV_VAR],
): ApiRuntimeState {
  const trimmed = typeof rawEnv === "string" ? rawEnv.trim() : "";
  if (trimmed.length === 0) {
    return {
      configured: false,
      baseUrl: null,
      envVar: API_BASE_URL_ENV_VAR,
    };
  }
  return {
    configured: true,
    baseUrl: trimmed.replace(/\/+$/, ""),
    envVar: API_BASE_URL_ENV_VAR,
  };
}

/**
 * Build an absolute API URL, or null when the runtime is unconfigured.
 * `path` must start with a single "/".
 */
export function buildApiUrl(
  state: ApiRuntimeState,
  path: string,
): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      `api: path must be an absolute site-relative path starting with "/", got ${JSON.stringify(path)}`,
    );
  }
  if (!state.configured || state.baseUrl === null) {
    return null;
  }
  return `${state.baseUrl}${path}`;
}

/** The honest outcome of a request through this client. */
export type ApiResult<T> =
  | { readonly status: "unconfigured" }
  | { readonly status: "network-error"; readonly message: string }
  | { readonly status: "http-error"; readonly statusCode: number }
  | { readonly status: "ok"; readonly data: T };

/**
 * Fetch JSON from the authoritative API. Never throws for the expected
 * failure modes and never invents a payload: the union carries exactly what
 * happened, so callers render the honest state (including UNKNOWN) instead
 * of guessing.
 */
export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const url = buildApiUrl(apiRuntimeState(), path);
  if (url === null) {
    return { status: "unconfigured" };
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    return {
      status: "network-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    return { status: "http-error", statusCode: response.status };
  }
  return { status: "ok", data: (await response.json()) as T };
}
