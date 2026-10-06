import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { StatusChip, STATUS_CHIP_STATES } from "../src/components/StatusChip.js";
import { StatusPill } from "../src/components/StatusPill.js";
import {
  OUTCOME_STATES,
  stateLabel,
  stateChipClass,
} from "../src/tokens.js";

/* Reads from the package root (vitest runs with cwd = package dir). */
const componentsCss = readFileSync(
  join(process.cwd(), "src", "components.css"),
  "utf8",
);

/* ---------- StatusChip: THE outcome renderer (contract 03 §2.2) ---------- */

describe("StatusChip", () => {
  it("renders every state with its word label, icon, class and data-state", () => {
    for (const state of OUTCOME_STATES) {
      const { unmount } = render(<StatusChip state={state} />);
      const chip = document.querySelector(".ps-chip")!;
      expect(chip).toHaveClass("ps-chip", stateChipClass[state]);
      expect(chip).toHaveAttribute("data-state", state);
      // visible word label (words, never codes)
      expect(screen.getByText(stateLabel[state])).toBeInTheDocument();
      // icon is present and hidden from AT (the label is the carrier)
      const icon = chip.querySelector(".ps-chip__icon svg");
      expect(icon).not.toBeNull();
      expect(chip.querySelector(".ps-chip__icon")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      unmount();
    }
  });

  it("exposes a stable default data-testid per state (overridable)", () => {
    render(<StatusChip state="succeeded" />);
    expect(screen.getByTestId("ps-chip-succeeded")).toBeInTheDocument();

    const { unmount } = render(
      <StatusChip state="failed" data-testid="row-status" />,
    );
    expect(screen.getByTestId("row-status")).toBeInTheDocument();
    expect(screen.queryByTestId("ps-chip-failed")).toBeNull();
    unmount();
  });

  it("technical detail renders as native tooltip + SR description", () => {
    render(
      <StatusChip state="succeeded" detail="Settled in block 19200041" />,
    );
    const chip = screen.getByTestId("ps-chip-succeeded");
    expect(chip).toHaveAttribute("title", "Settled in block 19200041");
    const describedBy = chip.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description).not.toBeNull();
    expect(description).toHaveTextContent("Settled in block 19200041");
    expect(description).toHaveClass("ps-sr-only");
  });

  it("no detail means no tooltip and no description wiring", () => {
    render(<StatusChip state="processing" />);
    const chip = screen.getByTestId("ps-chip-processing");
    expect(chip).not.toHaveAttribute("title");
    expect(chip).not.toHaveAttribute("aria-describedby");
  });

  it("label override replaces the word (still a word, still visible)", () => {
    render(<StatusChip state="partially_refunded" label="Half back" />);
    expect(screen.getByText("Half back")).toBeInTheDocument();
    expect(screen.queryByText(stateLabel.partially_refunded)).toBeNull();
  });

  it("processing carries the dashed in-flight treatment in CSS (never red)", () => {
    const processingBlock =
      /\.ps-chip--processing \{[^}]*\}/.exec(componentsCss)?.[0] ?? "";
    expect(processingBlock).toContain("border-style: dashed");
    expect(processingBlock).toContain("var(--ps-state-processing)");
    expect(processingBlock).not.toContain("--ps-danger");
  });

  it("exports all eight states for state-driven pickers", () => {
    expect([...STATUS_CHIP_STATES]).toEqual([...OUTCOME_STATES]);
  });
});

/* ---------- StatusPill transition posture ---------- */

describe("StatusPill (transition compat)", () => {
  it("still renders its legacy tones unchanged (additive API)", () => {
    render(<StatusPill tone="unknown">Reconciling</StatusPill>);
    const pill = document.querySelector(".ps-pill")!;
    expect(pill).toHaveAttribute("data-tone", "unknown");
    expect(pill).toHaveClass("ps-pill--unknown");
    expect(screen.getByText("Reconciling")).toBeInTheDocument();
  });
});

/* ---------- no raw hex in component code (contract 02 §10) ---------- */

describe("no raw hex in components", () => {
  it("component sources contain zero hex colors (tokens only)", () => {
    const files = [
      "StatusChip.tsx",
      "StatusPill.tsx",
      "ListPage.tsx",
      "ObjectDetailHeader.tsx",
      "ActivityTimeline.tsx",
      "MetricCard.tsx",
      "CreateMenu.tsx",
      "SetupGuideWidget.tsx",
      "EnvironmentBanner.tsx",
      "RelatedObjects.tsx",
      "ConfirmationButton.tsx",
      "RecommendationsCard.tsx",
      "MoneyInput.tsx",
      "Field.tsx",
      "Input.tsx",
      "Select.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(
        join(process.cwd(), "src", "components", file),
        "utf8",
      );
      expect(
        source.match(/#[0-9a-fA-F]{3,8}\b/g),
        `${file} contains raw hex colors`,
      ).toBeNull();
    }
  });

  it("every var(--ps-*) referenced by components.css is a declared token", () => {
    const tokensCss = readFileSync(
      join(process.cwd(), "src", "tokens.css"),
      "utf8",
    );
    const declared = new Set(
      [...tokensCss.matchAll(/(--ps-[a-z0-9_-]+):/gi)].map((m) => m[1]),
    );
    const referenced = new Set(
      [...componentsCss.matchAll(/var\((--ps-[a-z0-9_-]+)\)/g)].map(
        (m) => m[1],
      ),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(declared.has(name), `undeclared token referenced: ${name}`).toBe(
        true,
      );
    }
  });
});
