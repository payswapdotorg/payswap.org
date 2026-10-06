import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import {
  OUTCOME_STATES,
  stateLabel,
  stateChipClass,
  stateTokenFamily,
  stateBorderStyle,
  STATE_TOKEN_NAMES,
  stateTokenLight,
  stateTokenDark,
  ENVIRONMENT_KINDS,
  envTokenFamily,
  ENV_TOKEN_NAMES,
  envTokenLight,
  envTokenDark,
  neutral,
  emerald,
  amber,
  red,
} from "../src/tokens.js";

/* tokens.css / components.css read from the package root (cwd = package dir) */
const css = readFileSync(join(process.cwd(), "src", "tokens.css"), "utf8");
const componentCss = readFileSync(
  join(process.cwd(), "src", "components.css"),
  "utf8",
);

/* ---------- helpers (mirrors tokens.test.ts) ---------- */

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex: ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, (n & 255)];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const AMBER_HEXES = new Set(Object.values(amber));
const RED_HEXES = new Set(Object.values(red));
const EMERALD_HEXES = new Set(Object.values(emerald));

/* ---------- the eight-state vocabulary (contract 02 §2 / 03 §2.2, R1) ----- */

describe("outcome-state vocabulary", () => {
  it("is exactly the eight contract states, in contract order", () => {
    expect([...OUTCOME_STATES]).toEqual([
      "succeeded",
      "processing",
      "failed",
      "refunded",
      "partially_refunded",
      "disputed",
      "blocked",
      "dropped",
    ]);
  });

  it("labels are words, never codes (contract 02 §7)", () => {
    expect(stateLabel.succeeded).toBe("Succeeded");
    expect(stateLabel.processing).toBe("Processing");
    expect(stateLabel.partially_refunded).toBe("Partially refunded");
    for (const state of OUTCOME_STATES) {
      expect(stateLabel[state].length).toBeGreaterThan(0);
      expect(stateLabel[state]).not.toMatch(/[_A-Z]{2,}/); // no codes
    }
  });

  it("every state has a distinct chip class and token family", () => {
    expect(new Set(Object.values(stateChipClass)).size).toBe(8);
    expect(new Set(Object.values(stateTokenFamily)).size).toBe(8);
    for (const state of OUTCOME_STATES) {
      expect(stateChipClass[state]).toBe(`ps-chip--${state}`);
      expect(stateTokenFamily[state]).toBe(`--ps-state-${state}`);
    }
  });
});

/* ---------- tokens.css <-> tokens.ts mirror ---------- */

describe("state + env tokens: stylesheet and mirror agree", () => {
  it("declares every state + env token name in the stylesheet", () => {
    for (const name of [...STATE_TOKEN_NAMES, ...ENV_TOKEN_NAMES]) {
      expect(css).toContain(`  ${name}:`);
    }
  });

  it("light theme resolves state tokens onto the existing ramps only", () => {
    // The var() references in tokens.css resolve to the same ramp entries
    // the mirror declares — no new hues anywhere.
    expect(css).toContain("--ps-state-succeeded: var(--ps-emerald-700)");
    expect(css).toContain("--ps-state-processing: var(--ps-amber-700)");
    expect(css).toContain("--ps-state-failed: var(--ps-red-700)");
    expect(css).toContain("--ps-state-refunded: var(--ps-neutral-600)");
    expect(css).toContain("--ps-state-partially_refunded: var(--ps-neutral-700)");
    expect(css).toContain("--ps-state-disputed: var(--ps-amber-700)");
    expect(css).toContain("--ps-state-blocked: var(--ps-red-700)");
    expect(css).toContain("--ps-state-dropped: var(--ps-amber-700)");
    expect(stateTokenLight["--ps-state-succeeded"]).toBe(emerald[700]);
    expect(stateTokenLight["--ps-state-processing"]).toBe(amber[700]);
    expect(stateTokenLight["--ps-state-failed"]).toBe(red[700]);
    expect(stateTokenLight["--ps-state-refunded"]).toBe(neutral[600]);
    expect(stateTokenLight["--ps-state-partially_refunded"]).toBe(neutral[700]);
    expect(stateTokenLight["--ps-state-disputed"]).toBe(amber[700]);
    expect(stateTokenLight["--ps-state-blocked"]).toBe(red[700]);
    expect(stateTokenLight["--ps-state-dropped"]).toBe(amber[700]);
  });

  it("dark theme declares the mirrored dark values", () => {
    expect(css).toContain("--ps-state-succeeded: var(--ps-emerald-400)");
    expect(css).toContain(
      "--ps-state-succeeded-tint: rgba(52, 211, 153, 0.12)",
    );
    expect(stateTokenDark["--ps-state-processing"]).toBe(amber[400]);
    expect(stateTokenDark["--ps-state-dropped"]).toBe(amber[400]);
    expect(stateTokenDark["--ps-state-blocked"]).toBe(red[400]);
  });

  it("declares the env tokens in both themes (inverted stone for test)", () => {
    expect(css).toContain("--ps-env-test: var(--ps-neutral-950)");
    expect(css).toContain("--ps-env-test-on: var(--ps-neutral-0)");
    expect(css).toContain("--ps-env-live: var(--ps-fg-muted)");
    expect(envTokenLight["--ps-env-test"]).toBe(neutral[950]);
    expect(envTokenDark["--ps-env-test"]).toBe(neutral[0]);
    expect(envTokenFamily.test).toBe("--ps-env-test");
    expect(envTokenFamily.live).toBe("--ps-env-live");
    expect([...ENVIRONMENT_KINDS]).toEqual(["test", "live"]);
  });

  it("introduces no indigo/blue ramps (law carried into the new tokens)", () => {
    expect(css).not.toMatch(/--ps-(indigo|blue|sky|azure|cobalt)/i);
  });
});

/* ---------- the processing/dropped laws ---------- */

describe("processing is NEVER red; dropped is never failure", () => {
  it("processing resolves to the amber ramp in both themes", () => {
    for (const value of [
      stateTokenLight["--ps-state-processing"],
      stateTokenDark["--ps-state-processing"],
    ]) {
      expect(AMBER_HEXES.has(value)).toBe(true);
      expect(RED_HEXES.has(value)).toBe(false);
    }
    expect(stateTokenLight["--ps-state-processing"]).not.toBe(
      stateTokenLight["--ps-state-failed"],
    );
  });

  it("dropped (unknown/timeout after broadcast) is amber, never red", () => {
    expect(AMBER_HEXES.has(stateTokenLight["--ps-state-dropped"])).toBe(true);
    expect(RED_HEXES.has(stateTokenLight["--ps-state-dropped"])).toBe(false);
    expect(stateTokenLight["--ps-state-dropped"]).not.toBe(
      stateTokenLight["--ps-state-failed"],
    );
  });

  it("processing is the only dashed chip border (in-flight is not final)", () => {
    expect(stateBorderStyle.processing).toBe("dashed");
    for (const state of OUTCOME_STATES) {
      if (state !== "processing") {
        expect(stateBorderStyle[state]).toBe("solid");
      }
    }
  });
});

/* ---------- env.test distinctness law (contract 02 §2) ---------- */

describe("env.test is visually distinct from every state color", () => {
  it("differs in VALUE from every state fg and tint (light + dark)", () => {
    for (const value of [
      envTokenLight["--ps-env-test"],
      envTokenDark["--ps-env-test"],
    ]) {
      for (const stateValue of [
        ...Object.values(stateTokenLight),
        ...Object.values(stateTokenDark),
      ]) {
        expect(value).not.toBe(stateValue);
      }
    }
  });

  it("is stone (not the error, success, or attention ramps)", () => {
    for (const value of [
      envTokenLight["--ps-env-test"],
      envTokenDark["--ps-env-test"],
    ]) {
      expect(RED_HEXES.has(value)).toBe(false);
      expect(EMERALD_HEXES.has(value)).toBe(false);
      expect(AMBER_HEXES.has(value)).toBe(false);
    }
  });

  it("no chip rule consumes an env token and no env rule consumes a state token", () => {
    const chipBlocks = componentCss.match(/\.ps-chip--[a-z_]+ \{[^}]*\}/g) ?? [];
    expect(chipBlocks.length).toBe(8);
    for (const block of chipBlocks) {
      expect(block).not.toMatch(/--ps-env-/);
      expect(block).not.toMatch(/--ps-danger|--ps-positive|--ps-unknown|--ps-attention/);
    }
    const envBlocks =
      componentCss.match(/\.ps-env-(banner|badge)[^{}]*\{[^}]*\}/g) ?? [];
    expect(envBlocks.length).toBeGreaterThan(0);
    for (const block of envBlocks) {
      expect(block).not.toMatch(/--ps-state-/);
      expect(block).not.toMatch(/--ps-danger|--ps-positive|--ps-unknown|--ps-attention/);
    }
  });
});

/* ---------- WCAG AA contrast for the new tokens (light theme) ---------- */

describe("WCAG AA contrast (state + env tokens, light theme)", () => {
  const SURFACE = neutral[0];

  const cases: Array<[string, string, string]> = [
    ["succeeded text on tint", stateTokenLight["--ps-state-succeeded"], stateTokenLight["--ps-state-succeeded-tint"]],
    ["processing text on tint", stateTokenLight["--ps-state-processing"], stateTokenLight["--ps-state-processing-tint"]],
    ["failed text on tint", stateTokenLight["--ps-state-failed"], stateTokenLight["--ps-state-failed-tint"]],
    ["partially_refunded text on tint", stateTokenLight["--ps-state-partially_refunded"], stateTokenLight["--ps-state-partially_refunded-tint"]],
    ["disputed text on tint", stateTokenLight["--ps-state-disputed"], stateTokenLight["--ps-state-disputed-tint"]],
    // outline treatments render on the surface
    ["refunded text on surface", stateTokenLight["--ps-state-refunded"], SURFACE],
    ["blocked text on surface", stateTokenLight["--ps-state-blocked"], SURFACE],
    ["dropped text on surface", stateTokenLight["--ps-state-dropped"], SURFACE],
    ["env.test ink on env.test fill", envTokenLight["--ps-env-test-on"], envTokenLight["--ps-env-test"]],
  ];

  for (const [name, fg, bg] of cases) {
    it(`${name} ≥ 4.5:1`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("env.test ink on fill ≥ 4.5:1 in the DARK theme too", () => {
    expect(
      contrastRatio(envTokenDark["--ps-env-test-on"], envTokenDark["--ps-env-test"]),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

/* ---------- specimen: every token role renders ---------- */

describe("token specimen", () => {
  it("renders a node for every semantic, state and env token role", () => {
    const allNames = [
      // base semantic roles (existing)
      "--ps-bg", "--ps-fg", "--ps-fg-muted", "--ps-fg-subtle",
      "--ps-surface", "--ps-surface-raised", "--ps-surface-sunken",
      "--ps-border", "--ps-border-strong", "--ps-accent",
      "--ps-accent-emphasis", "--ps-accent-tint", "--ps-on-accent",
      "--ps-positive", "--ps-positive-tint", "--ps-attention",
      "--ps-attention-tint", "--ps-unknown", "--ps-unknown-tint",
      "--ps-danger", "--ps-danger-emphasis", "--ps-danger-tint",
      "--ps-focus", "--ps-scrim",
      ...STATE_TOKEN_NAMES,
      ...ENV_TOKEN_NAMES,
    ];
    render(
      <div data-testid="specimen">
        {allNames.map((name) => (
          <span key={name} data-token={name} style={{ ["--ps-probe" as string]: `var(${name})` }}>
            {name}
          </span>
        ))}
      </div>,
    );
    for (const name of allNames) {
      const node = document.querySelector(`[data-token="${name}"]`);
      expect(node, `token role not rendered: ${name}`).not.toBeNull();
    }
  });
});
