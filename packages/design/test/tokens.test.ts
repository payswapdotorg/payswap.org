import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOKEN_VERSION,
  neutral,
  emerald,
  amber,
  red,
  SEMANTIC_TOKEN_NAMES,
  semanticLight,
  semanticDark,
  typeScale,
  spacing,
  radius,
  motion,
  density,
  STATUS_TONES,
  statusToneClass,
  statusToneTokenFamily,
  TOUCH_TARGET_PX,
} from "../src/tokens.js";

/* tokens.css read from the package root (vitest runs with cwd = package dir) */
const css = readFileSync(join(process.cwd(), "src", "tokens.css"), "utf8");

/* ---------- helpers (pure) ---------- */

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex: ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two opaque hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function hueOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  if (max === r) return ((g - b) / d + (g < b ? 6 : 0)) * 60;
  if (max === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
}

/* ---------- token file <-> programmatic mirror ---------- */

describe("tokens.css and tokens.ts agree", () => {
  it("declares every canonical semantic token in the stylesheet", () => {
    for (const name of SEMANTIC_TOKEN_NAMES) {
      expect(css).toContain(`  ${name}:`);
    }
  });

  it("declares the light-theme semantic values from the mirror", () => {
    // tokens.css uses var() references for ramp values; assert the references
    // themselves resolve to the same ramp entries declared in tokens.ts.
    expect(css).toContain("--ps-accent: var(--ps-emerald-700)");
    expect(css).toContain("--ps-unknown: var(--ps-amber-700)");
    expect(css).toContain("--ps-danger: var(--ps-red-700)");
    expect(css).toContain("--ps-bg: var(--ps-neutral-50)");
    expect(css).toContain("--ps-fg: var(--ps-neutral-900)");
  });

  it("declares ramps with the exact hex values from tokens.ts", () => {
    for (const [k, v] of Object.entries(emerald)) {
      expect(css).toContain(`--ps-emerald-${k}: ${v}`);
    }
    for (const [k, v] of Object.entries(amber)) {
      expect(css).toContain(`--ps-amber-${k}: ${v}`);
    }
    for (const [k, v] of Object.entries(red)) {
      expect(css).toContain(`--ps-red-${k}: ${v}`);
    }
  });

  it("has a dark theme block and a reduced-motion collapse", () => {
    expect(css).toContain(".ps-theme-dark");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("--ps-duration-fast: 0.01ms");
  });
});

/* ---------- the accent laws ---------- */

describe("accent laws", () => {
  it("has NO indigo/blue primary: the only accent family is emerald", () => {
    // Emerald hue lands in the green-teal band (~140-170deg); anything in the
    // indigo/blue band (~200-280deg) is banned from the accent + status ramps.
    for (const hex of [emerald[700], emerald[800], semanticLight["--ps-accent"], semanticLight["--ps-accent-emphasis"]]) {
      const h = hueOf(hex);
      expect(h).toBeGreaterThanOrEqual(120);
      expect(h).toBeLessThanOrEqual(180);
    }
    for (const hex of [semanticDark["--ps-accent"], semanticDark["--ps-accent-emphasis"]]) {
      const h = hueOf(hex);
      expect(h).toBeGreaterThanOrEqual(120);
      expect(h).toBeLessThanOrEqual(180);
    }
  });

  it("declares no indigo/blue ramp tokens at all", () => {
    expect(css).not.toMatch(/--ps-(indigo|blue|sky|azure|cobalt)/i);
  });

  it("UNKNOWN and danger use disjoint ramps (amber vs red)", () => {
    expect(semanticLight["--ps-unknown"]).not.toBe(
      semanticLight["--ps-danger"],
    );
    expect(semanticLight["--ps-unknown"]).toMatch(/^#(fffbeb|fef3c7|fde68a|fcd34d|fbbf24|f59e0b|d97706|b45309|92400e)$/);
    expect(semanticLight["--ps-danger"]).toMatch(/^#(fef2f2|fee2e2|fecaca|fca5a5|f87171|ef4444|dc2626|b91c1c|991b1b)$/);
    expect(hueOf(semanticLight["--ps-unknown"])).toBeLessThan(60); // yellow/amber
    expect(hueOf(semanticLight["--ps-danger"])).toBeLessThan(20); // red
  });

  it("statusToneClass keeps unknown distinct from failed/blocked", () => {
    expect(statusToneClass.unknown).not.toBe(statusToneClass.failed);
    expect(statusToneClass.unknown).not.toBe(statusToneClass.blocked);
    expect(statusToneTokenFamily.unknown).toBe("--ps-unknown");
    expect(statusToneTokenFamily.failed).toBe("--ps-danger");
    expect(STATUS_TONES).toContain("unknown");
    expect(STATUS_TONES).toContain("ok");
    expect(STATUS_TONES).toContain("attention");
    expect(STATUS_TONES).toContain("blocked");
    expect(STATUS_TONES).toContain("disabled");
  });
});

/* ---------- WCAG AA contrast (light theme) ---------- */

describe("WCAG AA contrast (light theme)", () => {
  const cases: Array<[string, string, string]> = [
    ["body text", semanticLight["--ps-fg"], semanticLight["--ps-bg"]],
    ["muted text", semanticLight["--ps-fg-muted"], semanticLight["--ps-bg"]],
    ["body text on surface", semanticLight["--ps-fg"], semanticLight["--ps-surface"]],
    ["accent text on bg", semanticLight["--ps-accent"], semanticLight["--ps-bg"]],
    ["on-accent text (primary button)", semanticLight["--ps-on-accent"], semanticLight["--ps-accent"]],
    ["positive text on tint", semanticLight["--ps-positive"], semanticLight["--ps-positive-tint"]],
    ["attention text on tint", semanticLight["--ps-attention"], semanticLight["--ps-attention-tint"]],
    ["unknown text on tint", semanticLight["--ps-unknown"], semanticLight["--ps-unknown-tint"]],
    ["danger text on tint", semanticLight["--ps-danger"], semanticLight["--ps-danger-tint"]],
    ["danger emphasis text on bg", semanticLight["--ps-danger-emphasis"], semanticLight["--ps-bg"]],
  ];

  for (const [name, fg, bg] of cases) {
    it(`${name} ≥ 4.5:1`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("focus ring vs page background ≥ 3:1 (focus appearance)", () => {
    expect(
      contrastRatio(semanticLight["--ps-focus"], semanticLight["--ps-bg"]),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("WCAG AA contrast (dark theme)", () => {
  const cases: Array<[string, string, string]> = [
    ["body text", semanticDark["--ps-fg"], semanticDark["--ps-bg"]],
    ["muted text", semanticDark["--ps-fg-muted"], semanticDark["--ps-bg"]],
    ["body text on surface", semanticDark["--ps-fg"], semanticDark["--ps-surface"]],
    ["accent text on bg", semanticDark["--ps-accent"], semanticDark["--ps-bg"]],
    ["on-accent text (primary button)", semanticDark["--ps-on-accent"], semanticDark["--ps-accent"]],
    ["danger text on bg", semanticDark["--ps-danger"], semanticDark["--ps-bg"]],
    ["unknown text on bg", semanticDark["--ps-unknown"], semanticDark["--ps-bg"]],
  ];

  for (const [name, fg, bg] of cases) {
    it(`${name} ≥ 4.5:1`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/* ---------- scale discipline ---------- */

describe("scales", () => {
  it("type scale is exactly 12/13/14/16/18/24/32 px", () => {
    expect(Object.values(typeScale)).toEqual([12, 13, 14, 16, 18, 24, 32]);
  });

  it("spacing is a 4px base grid", () => {
    for (const v of Object.values(spacing)) {
      expect(v % 4).toBe(0);
    }
    expect(spacing[1]).toBe(4);
    expect(spacing[16]).toBe(64);
  });

  it("radius is 4/8/12 with full", () => {
    expect(radius.sm).toBe(4);
    expect(radius.md).toBe(8);
    expect(radius.lg).toBe(12);
  });

  it("motion is 150/200/250ms", () => {
    expect(motion.fast).toBe(150);
    expect(motion.panel).toBe(200);
    expect(motion.slow).toBe(250);
  });

  it("density compact is tighter than comfortable; touch target ≥ 44px", () => {
    expect(density.compact).toBeLessThan(density.comfortable);
    expect(TOUCH_TARGET_PX).toBeGreaterThanOrEqual(44);
  });

  it("neutral ramp is monotonic from near-white to near-black", () => {
    const steps = Object.values(neutral);
    const lums = steps.map((h) => relativeLuminance(h));
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i]!).toBeLessThan(lums[i - 1]!);
    }
  });

  it("carries a token version", () => {
    // 1.1.0 — UX-001 convergence: the 8 outcome-state tokens + env tokens
    // layered over the existing ramps (contracts 02 §2, v1.1).
    expect(TOKEN_VERSION).toBe("1.1.0");
  });
});
