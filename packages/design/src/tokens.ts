/**
 * @payswap/design — design tokens (programmatic mirror of tokens.css).
 *
 * Source: You-platform reference extraction, 2026-10-02
 * (spec/phase-3/research/you-platform-reference-extraction-2026-10-02.md).
 * Laws encoded here:
 *  - NO indigo/blue primary: the only accent family is emerald.
 *  - amber carries attention + UNKNOWN; red carries failure ONLY.
 *  - UNKNOWN is visually distinct from danger (different ramp, dashed border,
 *    different tint) and is never styled as failure.
 * This module is pure data: no React, no DOM, no network, no financial
 * semantics.
 */

export const TOKEN_VERSION = "1.1.0" as const;

/** Neutral ramp (warm stone) — near-white canvas to near-black ink. */
export const neutral = {
  0: "#ffffff",
  50: "#fafaf8",
  100: "#f4f3f0",
  200: "#e7e4de",
  300: "#d6d2c9",
  400: "#a8a29a",
  500: "#79746c",
  600: "#5c5750",
  700: "#44403a",
  800: "#2b2925",
  900: "#1c1a17",
  950: "#131211",
} as const;

/** Emerald ramp — the single brand accent (money / positive). */
export const emerald = {
  50: "#ecfdf5",
  100: "#d1fae5",
  200: "#a7f3d0",
  300: "#6ee7b7",
  400: "#34d399",
  500: "#10b981",
  600: "#059669",
  700: "#047857",
  800: "#065f46",
  900: "#064e3b",
} as const;

/** Amber ramp — attention AND unknown; never failure. */
export const amber = {
  50: "#fffbeb",
  100: "#fef3c7",
  200: "#fde68a",
  300: "#fcd34d",
  400: "#fbbf24",
  500: "#f59e0b",
  600: "#d97706",
  700: "#b45309",
  800: "#92400e",
} as const;

/** Red ramp — danger: failure ONLY, never UNKNOWN. */
export const red = {
  50: "#fef2f2",
  100: "#fee2e2",
  200: "#fecaca",
  300: "#fca5a5",
  400: "#f87171",
  500: "#ef4444",
  600: "#dc2626",
  700: "#b91c1c",
  800: "#991b1b",
} as const;

/** The canonical semantic token names (CSS custom properties on :root). */
export const SEMANTIC_TOKEN_NAMES = [
  "--ps-bg",
  "--ps-fg",
  "--ps-fg-muted",
  "--ps-fg-subtle",
  "--ps-surface",
  "--ps-surface-raised",
  "--ps-surface-sunken",
  "--ps-border",
  "--ps-border-strong",
  "--ps-accent",
  "--ps-accent-emphasis",
  "--ps-accent-tint",
  "--ps-on-accent",
  "--ps-positive",
  "--ps-positive-tint",
  "--ps-attention",
  "--ps-attention-tint",
  "--ps-unknown",
  "--ps-unknown-tint",
  "--ps-danger",
  "--ps-danger-emphasis",
  "--ps-danger-tint",
  "--ps-focus",
  "--ps-scrim",
] as const;

export type SemanticTokenName = (typeof SEMANTIC_TOKEN_NAMES)[number];

/** Light-theme semantic values (hex; tints are opaque ramps at theme level). */
export const semanticLight: Record<SemanticTokenName, string> = {
  "--ps-bg": neutral[50],
  "--ps-fg": neutral[900],
  "--ps-fg-muted": neutral[600],
  "--ps-fg-subtle": neutral[500],
  "--ps-surface": neutral[0],
  "--ps-surface-raised": neutral[0],
  "--ps-surface-sunken": neutral[100],
  "--ps-border": neutral[200],
  "--ps-border-strong": neutral[300],
  "--ps-accent": emerald[700],
  "--ps-accent-emphasis": emerald[800],
  "--ps-accent-tint": emerald[50],
  "--ps-on-accent": "#ffffff",
  "--ps-positive": emerald[700],
  "--ps-positive-tint": emerald[50],
  "--ps-attention": amber[700],
  "--ps-attention-tint": amber[100],
  "--ps-unknown": amber[700],
  "--ps-unknown-tint": amber[50],
  "--ps-danger": red[700],
  "--ps-danger-emphasis": red[800],
  "--ps-danger-tint": red[50],
  "--ps-focus": neutral[900],
  "--ps-scrim": "rgba(19, 18, 17, 0.55)",
};

/** Dark-theme semantic values. */
export const semanticDark: Record<SemanticTokenName, string> = {
  "--ps-bg": neutral[950],
  "--ps-fg": neutral[100],
  "--ps-fg-muted": neutral[400],
  "--ps-fg-subtle": neutral[500],
  "--ps-surface": neutral[900],
  "--ps-surface-raised": neutral[800],
  "--ps-surface-sunken": "#0d0c0b",
  "--ps-border": neutral[800],
  "--ps-border-strong": neutral[700],
  "--ps-accent": emerald[400],
  "--ps-accent-emphasis": emerald[300],
  "--ps-accent-tint": "rgba(52, 211, 153, 0.12)",
  "--ps-on-accent": emerald[900],
  "--ps-positive": emerald[400],
  "--ps-positive-tint": "rgba(52, 211, 153, 0.12)",
  "--ps-attention": amber[400],
  "--ps-attention-tint": "rgba(251, 191, 36, 0.14)",
  "--ps-unknown": amber[400],
  "--ps-unknown-tint": "rgba(251, 191, 36, 0.08)",
  "--ps-danger": red[400],
  "--ps-danger-emphasis": red[500],
  "--ps-danger-tint": "rgba(248, 113, 113, 0.12)",
  "--ps-focus": neutral[100],
  "--ps-scrim": "rgba(0, 0, 0, 0.7)",
};

/** Type scale: named steps in px (12/13/14/16/18/24/32). */
export const typeScale = {
  "2xs": 12,
  xs: 13,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 24,
  "2xl": 32,
} as const;

export type TypeStep = keyof typeof typeScale;

export const fontStacks = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
} as const;

/** Section-label style (small-caps group headings, from the reference). */
export const sectionLabel = {
  size: typeScale["2xs"],
  weight: fontWeights.semibold,
  tracking: "0.12em",
  transform: "uppercase",
} as const;

/** Spacing: 4px base grid. */
export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export type SpaceStep = keyof typeof spacing;

/** Density: comfortable for public pages, compact for command-center tables. */
export const density = {
  comfortable: 1,
  compact: 0.75,
} as const;

export type DensityMode = keyof typeof density;

/** Minimum interactive target (WCAG 2.5.8 / mobile posture). */
export const TOUCH_TARGET_PX = 44;

/** Radius: 8px standard; 4px inputs; 12px panels. */
export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 9999,
} as const;

export type RadiusStep = keyof typeof radius;

/** Motion: 150ms micro; 200–250ms panels; always respects reduced motion. */
export const motion = {
  fast: 150,
  panel: 200,
  slow: 250,
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
} as const;

/** Elevation: exactly two levels (raised card, modal overlay). */
export const elevation = {
  1: "0 1px 2px rgba(19,18,17,0.06), 0 1px 3px rgba(19,18,17,0.08)",
  2: "0 8px 24px rgba(19,18,17,0.16), 0 2px 6px rgba(19,18,17,0.1)",
} as const;

/**
 * StatusPill tones. The five tones from the work order plus `failed` (the
 * canonical terminal-failure state). `unknown` and `failed`/danger styling are
 * intentionally disjoint: amber ramp + dashed border vs red ramp + solid
 * border. UNKNOWN is never rendered with danger styling (INV-X01 posture).
 */
export const STATUS_TONES = [
  "ok",
  "attention",
  "unknown",
  "blocked",
  "disabled",
  "failed",
] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/** CSS class applied per tone — the visual distinctness contract. */
export const statusToneClass: Record<StatusTone, string> = {
  ok: "ps-pill--ok",
  attention: "ps-pill--attention",
  unknown: "ps-pill--unknown",
  blocked: "ps-pill--blocked",
  disabled: "ps-pill--disabled",
  failed: "ps-pill--failed",
};

/** Which semantic token family each tone consumes (documentation + tests). */
export const statusToneTokenFamily: Record<StatusTone, string> = {
  ok: "--ps-positive",
  attention: "--ps-attention",
  unknown: "--ps-unknown",
  blocked: "--ps-danger",
  disabled: "--ps-fg-muted",
  failed: "--ps-danger",
};

/* ====================================================================
 * Outcome states (UX contract 02 §2 / 03 §2.2, v1.1 — TL-review R1).
 * The EIGHT-state vocabulary is the single source for outcome rendering;
 * StatusChip is its only renderer. Layered over the existing ramps only.
 * ==================================================================== */

export const OUTCOME_STATES = [
  "succeeded",
  "processing",
  "failed",
  "refunded",
  "partially_refunded",
  "disputed",
  "blocked",
  "dropped",
] as const;

export type OutcomeState = (typeof OUTCOME_STATES)[number];

/** Word labels — chips render words, never codes (contract 02 §7). */
export const stateLabel: Record<OutcomeState, string> = {
  succeeded: "Succeeded",
  processing: "Processing",
  failed: "Failed",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  disputed: "Disputed",
  blocked: "Blocked",
  dropped: "Dropped",
};

/** CSS class applied per state by StatusChip — the visual vocabulary. */
export const stateChipClass: Record<OutcomeState, string> = {
  succeeded: "ps-chip--succeeded",
  processing: "ps-chip--processing",
  failed: "ps-chip--failed",
  refunded: "ps-chip--refunded",
  partially_refunded: "ps-chip--partially_refunded",
  disputed: "ps-chip--disputed",
  blocked: "ps-chip--blocked",
  dropped: "ps-chip--dropped",
};

/** Which state token each state consumes (documentation + tests). */
export const stateTokenFamily: Record<OutcomeState, string> = {
  succeeded: "--ps-state-succeeded",
  processing: "--ps-state-processing",
  failed: "--ps-state-failed",
  refunded: "--ps-state-refunded",
  partially_refunded: "--ps-state-partially_refunded",
  disputed: "--ps-state-disputed",
  blocked: "--ps-state-blocked",
  dropped: "--ps-state-dropped",
};

/**
 * Border treatment per state. `processing` is the only dashed chip: in-flight
 * (never final, never red). Every other state renders a solid border; the
 * ramp + fill treatment carries the rest of the distinction.
 */
export const stateBorderStyle: Record<OutcomeState, "solid" | "dashed"> = {
  succeeded: "solid",
  processing: "dashed",
  failed: "solid",
  refunded: "solid",
  partially_refunded: "solid",
  disputed: "solid",
  blocked: "solid",
  dropped: "solid",
};

/** The canonical outcome-state token names (CSS custom properties). */
export const STATE_TOKEN_NAMES = [
  "--ps-state-succeeded",
  "--ps-state-succeeded-tint",
  "--ps-state-processing",
  "--ps-state-processing-tint",
  "--ps-state-failed",
  "--ps-state-failed-tint",
  "--ps-state-refunded",
  "--ps-state-refunded-tint",
  "--ps-state-partially_refunded",
  "--ps-state-partially_refunded-tint",
  "--ps-state-disputed",
  "--ps-state-disputed-tint",
  "--ps-state-blocked",
  "--ps-state-blocked-tint",
  "--ps-state-dropped",
  "--ps-state-dropped-tint",
] as const;

export type StateTokenName = (typeof STATE_TOKEN_NAMES)[number];

/**
 * Light-theme state values (resolved ramp hex; "transparent" marks the
 * outline treatments). `processing` resolves to the amber ramp, NEVER red;
 * `dropped` (unknown/timeout) is amber-outline, also never red.
 */
export const stateTokenLight: Record<StateTokenName, string> = {
  "--ps-state-succeeded": emerald[700],
  "--ps-state-succeeded-tint": emerald[50],
  "--ps-state-processing": amber[700],
  "--ps-state-processing-tint": amber[50],
  "--ps-state-failed": red[700],
  "--ps-state-failed-tint": red[50],
  "--ps-state-refunded": neutral[600],
  "--ps-state-refunded-tint": "transparent",
  "--ps-state-partially_refunded": neutral[700],
  "--ps-state-partially_refunded-tint": neutral[100],
  "--ps-state-disputed": amber[700],
  "--ps-state-disputed-tint": amber[100],
  "--ps-state-blocked": red[700],
  "--ps-state-blocked-tint": "transparent",
  "--ps-state-dropped": amber[700],
  "--ps-state-dropped-tint": "transparent",
};

/** Dark-theme state values. */
export const stateTokenDark: Record<StateTokenName, string> = {
  "--ps-state-succeeded": emerald[400],
  "--ps-state-succeeded-tint": "rgba(52, 211, 153, 0.12)",
  "--ps-state-processing": amber[400],
  "--ps-state-processing-tint": "rgba(251, 191, 36, 0.08)",
  "--ps-state-failed": red[400],
  "--ps-state-failed-tint": "rgba(248, 113, 113, 0.12)",
  "--ps-state-refunded": neutral[400],
  "--ps-state-refunded-tint": "transparent",
  "--ps-state-partially_refunded": neutral[300],
  "--ps-state-partially_refunded-tint": "rgba(255, 255, 255, 0.08)",
  "--ps-state-disputed": amber[400],
  "--ps-state-disputed-tint": "rgba(251, 191, 36, 0.14)",
  "--ps-state-blocked": red[400],
  "--ps-state-blocked-tint": "transparent",
  "--ps-state-dropped": amber[400],
  "--ps-state-dropped-tint": "transparent",
};

/* ====================================================================
 * Environment tokens (UX contract 02 §2 / 01 §2).
 * `env.test` is an INVERTED stone mark: distinct from every state color, so
 * "test" can never read as "error" or "success". `env.live` is the default
 * world with no special marking.
 * ==================================================================== */

export const ENVIRONMENT_KINDS = ["test", "live"] as const;

export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** Which environment token each kind consumes (documentation + tests). */
export const envTokenFamily: Record<EnvironmentKind, string> = {
  test: "--ps-env-test",
  live: "--ps-env-live",
};

/** The canonical environment token names (CSS custom properties). */
export const ENV_TOKEN_NAMES = [
  "--ps-env-test",
  "--ps-env-test-on",
  "--ps-env-live",
  "--ps-env-live-tint",
] as const;

export type EnvTokenName = (typeof ENV_TOKEN_NAMES)[number];

/** Light-theme environment values (inverted stone for test). */
export const envTokenLight: Record<EnvTokenName, string> = {
  "--ps-env-test": neutral[950],
  "--ps-env-test-on": neutral[0],
  "--ps-env-live": neutral[600],
  "--ps-env-live-tint": "transparent",
};

/** Dark-theme environment values (inversion flips with the theme). */
export const envTokenDark: Record<EnvTokenName, string> = {
  "--ps-env-test": neutral[0],
  "--ps-env-test-on": neutral[950],
  "--ps-env-live": neutral[400],
  "--ps-env-live-tint": "transparent",
};
