// @vitest-environment jsdom
/**
 * UX-006 — the consumer safety center anatomy (contract 10 §5): spending
 * permissions with HUMAN scopes, revoke per row WITH a simulation of
 * effect (security contract §4.5) and the honest not-submitted gate;
 * warnings with attack explanations in human language (§4.4) and the
 * honest empty; disputes "Report a problem" (structured reason select →
 * status tracking) with validation that follows the form contract.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  SpendingPermissions,
  revokeSimulationSentence,
  spendingScopeSentence,
  type SpendingPermissionRecord,
} from "../src/components/consumer/spending-permissions";
import { SecurityWarnings } from "../src/components/consumer/security-warnings";
import { DisputeTracker } from "../src/components/consumer/dispute-tracker";

afterEach(() => {
  cleanup();
});

const PERMISSION: SpendingPermissionRecord = {
  id: "perm_test_1",
  grantee: "Acme Studio",
  scope: { kind: "limited", limit: { minorUnits: "50000000", currency: "USDC" } },
  grantedAt: "2026-10-01T09:00:00Z",
};

const UNLIMITED: SpendingPermissionRecord = {
  id: "perm_test_2",
  grantee: "News stand",
  scope: { kind: "unlimited" },
  grantedAt: "2026-09-20T09:00:00Z",
};

describe("safety: spending permissions render scopes in HUMAN words", () => {
  it("a limited allowance reads 'X can spend up to N <asset>' — never approval/allowance jargon", () => {
    expect(spendingScopeSentence(PERMISSION)).toBe(
      "Acme Studio can spend up to 50 USDC from your account",
    );
    const jargon = spendingScopeSentence(PERMISSION);
    expect(jargon).not.toMatch(/approval|allowance/i);
  });

  it("an unlimited scope says so in plain words", () => {
    expect(spendingScopeSentence(UNLIMITED)).toBe(
      "News stand can spend without a limit from your account",
    );
  });

  it("empty list: the honest empty teaches — no fabricated permission renders", () => {
    render(<SpendingPermissions permissions={[]} />);
    expect(screen.getByTestId("safety-permissions-empty")).toBeTruthy();
    expect(screen.getByText(/No spending permissions granted/i)).toBeTruthy();
    expect(screen.queryByTestId("safety-permissions-list")).toBeNull();
  });

  it("rows render the scope sentence and a Revoke affordance", () => {
    render(<SpendingPermissions permissions={[PERMISSION]} />);
    expect(screen.getByText("Acme Studio can spend up to 50 USDC from your account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });
});

describe("safety: revoke per row WITH simulation of effect (security contract §4.5)", () => {
  it("the simulation states what revoking WILL do, before any confirm", () => {
    const sentence = revokeSimulationSentence(PERMISSION);
    expect(sentence).toContain("stops Acme Studio from spending anything more");
    expect(sentence).toContain("Payments already on their way are not affected");
    expect(sentence).toContain("revoking is not a pause");
  });

  it("the flow: Reveal simulation → Confirm → the honest not-submitted gate (never a fake revocation)", () => {
    render(<SpendingPermissions permissions={[PERMISSION]} />);
    const revoke = screen.getByRole("button", { name: "Revoke" });
    // Before: no simulation, no result.
    expect(screen.queryByTestId("safety-revoke-simulation-perm_test_1")).toBeNull();
    fireEvent.click(revoke);
    // The simulation of effect renders BEFORE the irreversible action.
    const simulation = screen.getByTestId("safety-revoke-simulation-perm_test_1");
    expect(simulation.textContent).toContain("Before you revoke:");
    expect(simulation.textContent).toContain("stops Acme Studio from spending anything more");
    // Confirm…
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    // …and the honest not-submitted state renders: nothing was revoked.
    const result = screen.getByTestId("safety-revoke-result-perm_test_1");
    expect(result.textContent).toContain("nothing was revoked");
    expect(result.textContent).toContain("the permission remains active");
  });

  it("the revoke disclosure is one-at-a-time and aria-expanded is honest", () => {
    render(<SpendingPermissions permissions={[PERMISSION, UNLIMITED]} />);
    const revokeOne = screen.getAllByRole("button", { name: "Revoke" })[0]!;
    expect(revokeOne.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(revokeOne);
    expect(revokeOne.getAttribute("aria-expanded")).toBe("true");
    // Closing the simulation also clears any confirm result.
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    fireEvent.click(revokeOne);
    expect(screen.queryByTestId("safety-revoke-result-perm_test_1")).toBeNull();
  });
});

describe("safety: warnings explain attacks in human language (security contract §4.4)", () => {
  it("empty: the honest empty — never a fabricated warning", () => {
    render(<SecurityWarnings warnings={[]} />);
    expect(screen.getByTestId("safety-warnings-empty")).toBeTruthy();
    expect(screen.getByText(/No active warnings/i)).toBeTruthy();
  });

  it("an active warning explains the ATTACK (not the protocol) and says what to do", () => {
    render(
      <SecurityWarnings
        warnings={[
          {
            id: "warn_test_1",
            title: "A site is asking for a spending permission",
            explanation:
              "This site is asking you to approve a spending permission that could move your funds — approving would let it spend your USDC. Only approve if you initiated this.",
            action: "If you don't recognize it, don't approve — and revoke anything you already granted.",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("safety-warning-warn_test_1")).toBeTruthy();
    const card = screen.getByTestId("safety-warning-warn_test_1").textContent ?? "";
    // The attack explanation pattern: what it could cost, in human words.
    expect(card).toContain("could move your funds");
    expect(card).toContain("let it spend your USDC");
    expect(card).toContain("What to do:");
  });
});

describe("safety: disputes — report a problem with a structured reason and status tracking", () => {
  it("the lifecycle vocabulary renders verbatim (Needs review · In review · Resolved)", () => {
    render(<DisputeTracker paymentId="pay_test_1" disputes={[]} />);
    const lifecycle = screen.getByTestId("safety-dispute-lifecycle").textContent ?? "";
    expect(lifecycle).toContain("Needs review");
    expect(lifecycle).toContain("In review");
    expect(lifecycle).toContain("Resolved");
    expect(screen.getByTestId("safety-disputes-empty")).toBeTruthy();
  });

  it("the reason set is structured and human (never free text)", () => {
    render(<DisputeTracker paymentId="pay_test_1" disputes={[]} />);
    const select = screen.getByTestId("safety-report-reason") as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => option.textContent ?? "");
    expect(options).toContain("I didn't authorize this payment");
    expect(options).toContain("I was charged the wrong amount");
    expect(options).toContain("I didn't receive what I paid for");
    expect(options).toContain("I was charged more than once");
    expect(options).toContain("Something else");
  });

  it("submit is blocked without a payment: the report is always about ONE real payment", () => {
    render(<DisputeTracker paymentId={null} disputes={[]} />);
    const submit = screen.getByTestId("safety-report-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/Open the payment first/i)).toBeTruthy();
  });

  it("validation: submitting without a reason shows the inline error; picking one clears it (never stale)", () => {
    render(<DisputeTracker paymentId="pay_test_1" disputes={[]} />);
    const submit = screen.getByTestId("safety-report-submit");
    fireEvent.click(submit);
    expect(screen.getByText(/Pick a reason/i)).toBeTruthy();
    // The error clears on valid selection (contract 07 §3.3).
    const select = screen.getByTestId("safety-report-reason") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "unauthorized" } });
    expect(screen.queryByText(/Pick a reason/i)).toBeNull();
  });

  it("submitting collects the report and renders the honest not-submitted state (nothing filed)", () => {
    render(<DisputeTracker paymentId="pay_test_1" disputes={[]} />);
    const select = screen.getByTestId("safety-report-reason") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "duplicate" } });
    fireEvent.click(screen.getByTestId("safety-report-submit"));
    const result = screen.getByTestId("safety-report-result").textContent ?? "";
    expect(result).toContain("NOT filed");
    expect(result).toContain("no dispute command is on this deployment's dispatch allowlist");
    expect(result).toContain("Nothing was submitted");
  });

  it("tracked disputes render their status when real records exist", () => {
    render(
      <DisputeTracker
        paymentId={null}
        disputes={[
          {
            id: "disp_test_1",
            paymentId: "pay_test_1",
            reasonLabel: "I was charged more than once",
            status: "In review",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("safety-disputes-list")).toBeTruthy();
    // The reason ALSO appears as a <option> in the report form's select —
    // scope the assertions to the tracked list itself.
    const list = screen.getByTestId("safety-disputes-list");
    expect(within(list).getByText("I was charged more than once")).toBeTruthy();
    expect(within(list).getByText("In review")).toBeTruthy();
  });
});
