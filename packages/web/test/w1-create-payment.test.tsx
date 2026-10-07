// @vitest-environment jsdom
/**
 * UX-004 — W1 "Create a payment" (contract 04 §2 W1, field-for-field).
 *
 * The validation matrix: per-field inline errors BELOW fields, clear-on-valid
 * (never stale after re-validation), submit blocked until valid, dependent
 * options disabling WITH reasons, the ConfirmationButton restating
 * amount+asset, the dual-submit, and the honest submission paths through the
 * REAL dispatch transport (success → payment detail route; API error → the
 * failed attempt with its registry reason; no session → the honest preview
 * note — never a fake success, never an error dressed as failure).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  }),
  usePathname: () => "/app/payments",
  useSearchParams: () => new URLSearchParams(),
}));

import { asConnectedCapabilityInstanceId } from "@payswap/ux";
import type { ConnectedCapabilityInstanceRecord } from "@payswap/ux";

import { CreatePaymentWorkflow } from "../src/components/workflows/create-payment-workflow";

const INSTANCE_ID = asConnectedCapabilityInstanceId("ci_stripe_test_1");
const CONNECTED: readonly ConnectedCapabilityInstanceRecord[] = [
  {
    instanceId: INSTANCE_ID,
    providerId: "stripe",
    connectedAt: "2026-10-02T12:00:00Z",
    state: "ACTIVE",
  },
];
const ROUTABILITY = [
  { instanceId: INSTANCE_ID, currency: "USDC", routable: true },
];
const DIRECTORY = [{ id: "cus_test_amara", displayName: "Amara Okafor" }];
const METHODS_ON_FILE = [{ counterpartyName: "Amara Okafor", maskedLine: "Visa •••• 4242" }];

afterEach(() => {
  cleanup();
  routerPush.mockClear();
  vi.restoreAllMocks();
});

type WorkflowProps = Parameters<typeof CreatePaymentWorkflow>[0];

function renderWorkflow(overrides: Partial<WorkflowProps> = {}): void {
  const props: WorkflowProps = {
    connectedInstances: CONNECTED,
    routabilityChecks: ROUTABILITY,
    contactDirectory: DIRECTORY,
    methodsOnFile: METHODS_ON_FILE,
    autoStart: false,
    ...overrides,
  };
  render(<CreatePaymentWorkflow {...props} />);
}

/** Fill the form to a valid manual-entry state (Amara, 25 USDC). */
function fillValidForm(): void {
  fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: "25" } });
  fireEvent.change(screen.getByPlaceholderText("Find or add a contact…"), {
    target: { value: "Ama" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Amara Okafor" }));
  fireEvent.change(screen.getByLabelText(/^Statement descriptor/), {
    target: { value: "PAYSWAP*ORDER1024" },
  });
}

function sendButton(): HTMLButtonElement {
  return document.querySelector("button.ps-confirm") as HTMLButtonElement;
}

describe("W1 anatomy: the form is the contract, field-for-field", () => {
  it("renders the segmented schedule, amount, currency, combobox, descriptor and funding rails", () => {
    renderWorkflow();
    expect(screen.getByRole("radiogroup", { name: "Schedule" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "One-time" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: "Recurring" })).toBeTruthy();
    // Currency-prefixed amount (the MoneyInput prefix renders the asset).
    expect(document.querySelector(".ps-money-input__prefix")?.textContent).toBe("USDC");
    expect(screen.getByPlaceholderText("Find or add a contact…")).toBeTruthy();
    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    // Anchored: the Manual-entry radio label also says “statement descriptor”.
    expect(screen.getByLabelText(/^Statement descriptor/)).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Funding rail" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Manual entry/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Method on file/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Hosted link/i })).toBeTruthy();
    expect(screen.getByText("Send and create another")).toBeTruthy();
  });

  it("choosing Recurring enables the interval (dependent-disable WITH reason otherwise)", () => {
    renderWorkflow();
    const reason = screen.getByText("Choose Recurring to set a schedule.");
    expect(reason.className).toContain("ps-field__reason");
    fireEvent.click(screen.getByRole("radio", { name: "Recurring" }));
    expect(screen.queryByText("Choose Recurring to set a schedule.")).toBeNull();
    expect((screen.getByLabelText(/Interval/i) as HTMLSelectElement).disabled).toBe(false);
  });

  it("the on-file rail disables WITH its reason until the counterparty has a method on file", () => {
    renderWorkflow({ methodsOnFile: [] });
    expect(
      screen.getByText("Select a counterparty to see their methods on file."),
    ).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Method on file/i }) as HTMLInputElement).disabled).toBe(true);

    // Pick the counterparty — the reason changes (still honest: none on file).
    fireEvent.change(screen.getByPlaceholderText("Find or add a contact…"), {
      target: { value: "Amara" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Amara Okafor" }));
    expect(
      screen.getByText(
        "No payment method is on file for Amara Okafor yet — methods land here after their first payment.",
      ),
    ).toBeTruthy();
  });

  it("with a method on file the rail enables and states it (masked)", () => {
    renderWorkflow();
    fireEvent.change(screen.getByPlaceholderText("Find or add a contact…"), {
      target: { value: "Amara" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Amara Okafor" }));
    expect((screen.getByRole("radio", { name: /Method on file/i }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/Visa •••• 4242/)).toBeTruthy();
  });
});

describe("W1 validation matrix (contract 07 §3.3)", () => {
  it("submit is blocked until the form is valid (never a silent drop)", () => {
    renderWorkflow();
    expect(sendButton().disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Send and create another/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("per-field inline error renders BELOW the field and clears on valid input", () => {
    renderWorkflow();
    const amount = screen.getByLabelText(/Amount/i);

    fireEvent.blur(amount);
    const error = screen.getByRole("alert");
    expect(error.textContent).toContain("Enter an amount greater than zero");
    // BELOW the field: the input precedes the error in the document.
    expect(
      amount.compareDocumentPosition(error),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.change(amount, { target: { value: "25" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("precision beyond the asset is blocked with the exact reason", () => {
    renderWorkflow();
    const amount = screen.getByLabelText(/Amount/i);
    fireEvent.change(amount, { target: { value: "0.0000001" } });
    fireEvent.blur(amount);
    expect(screen.getByRole("alert").textContent).toContain(
      "More precision than USDC carries (6 decimals)",
    );
  });

  it("non-numeric input names the expected shape", () => {
    renderWorkflow();
    const amount = screen.getByLabelText(/Amount/i);
    fireEvent.change(amount, { target: { value: "twenty-five" } });
    fireEvent.blur(amount);
    expect(screen.getByRole("alert").textContent).toContain("plain number");
  });

  it("the counterparty is required unless the rail is a hosted link", () => {
    renderWorkflow();
    const counterparty = screen.getByPlaceholderText("Find or add a contact…");
    fireEvent.blur(counterparty);
    expect(screen.getByRole("alert").textContent).toContain(
      "A counterparty is required to send a payment directly",
    );

    // Switching the rail clears the no-longer-applicable error immediately
    // (never a stale error after the constraint changed).
    fireEvent.click(screen.getByRole("radio", { name: /Hosted link/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the descriptor is required for manually-funded payments", () => {
    renderWorkflow();
    const descriptor = screen.getByLabelText(/^Statement descriptor/);
    fireEvent.blur(descriptor);
    expect(screen.getByRole("alert").textContent).toContain(
      "A statement descriptor is required for manually-funded payments",
    );
    fireEvent.change(descriptor, { target: { value: "PAYSWAP*ORDER1024" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the amount error re-derives when the currency changes precision", () => {
    renderWorkflow();
    const amount = screen.getByLabelText(/Amount/i);
    // 4 decimals: valid for USDC (6), invalid for EUR (2).
    fireEvent.change(amount, { target: { value: "10.5000" } });
    fireEvent.blur(amount);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Currency/i), { target: { value: "EUR" } });
    expect(screen.getByRole("alert").textContent).toContain(
      "More precision than EUR carries (2 decimals)",
    );
  });
});

describe("W1 confirmation (contract 04 §2 W1.4)", () => {
  it("the send button RESTATES amount + asset; the dual-submit stays secondary", () => {
    renderWorkflow();
    fillValidForm();
    expect(sendButton().disabled).toBe(false);
    // The ConfirmationButton carries verb + amount + asset in its own label
    // (contract 03 §2.15) — the promise travels with the action.
    expect(sendButton().textContent).toContain("Send");
    expect(sendButton().textContent).toContain("25");
    expect(sendButton().textContent).toContain("USDC");
    expect((screen.getByRole("button", { name: /Send and create another/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("in-button Processing state keeps restating what is being processed", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    renderWorkflow({ csrfToken: "csrf-test" });
    fillValidForm();
    fireEvent.click(sendButton());
    const processing = (await screen.findByRole("button", {
      name: /Processing 25 USDC…/,
    })) as HTMLButtonElement;
    expect(processing.disabled).toBe(true);
    resolveFetch?.(
      new Response(
        JSON.stringify({
          status: "ok",
          statusCode: 200,
          body: { data: { intent: { id: "pay_new_1" } }, meta: {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith("/app/payments/pay_new_1");
    });
  });

  it("hosted-link mode changes the verb to Create link for and hands off to W2", () => {
    renderWorkflow();
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("radio", { name: /Hosted link/i }));
    const create = screen.getByRole("button", { name: /Create link for 25 USDC/i }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(routerPush).toHaveBeenCalledTimes(1);
    const [href] = routerPush.mock.calls[0] as [string];
    expect(href.startsWith("/app/payments/link?")).toBe(true);
    expect(href).toContain("amount=25000000");
    expect(href).toContain("currency=USDC");
  });
});

describe("W1 submission honesty (the REAL transport, answers folded verbatim)", () => {
  it("a routable instance is named as the execution rail; none is honest absence", () => {
    renderWorkflow();
    expect(screen.getByTestId("execution-rail-line").textContent).toContain("stripe");

    cleanup();
    renderWorkflow({ connectedInstances: [], routabilityChecks: [] });
    const line = screen.getByTestId("execution-rail-line").textContent;
    expect(line).toContain("No connected capability can route USDC yet");
    expect(line).toContain("never an execution surface");
  });

  it("no session → the honest preview note, never a fake success and never an error", async () => {
    renderWorkflow({ csrfToken: undefined });
    fillValidForm();
    fireEvent.click(sendButton());
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("marked preview");
    expect(note.textContent).toContain("never mutates anything");
    expect(screen.queryByTestId("payment-failure-card")).toBeNull();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("the API's session-not-wired answer renders as the honest unavailable state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: "The PaySwap API requires its own session tokens." }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderWorkflow({ csrfToken: "csrf-test" });
    fillValidForm();
    fireEvent.click(sendButton());
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("requires its own session tokens");
    expect(note.textContent).toContain("Nothing was mutated");
    expect(screen.queryByTestId("payment-failure-card")).toBeNull();
  });

  it("an API error answer → the failed attempt with its REGISTRY reason + recovery affordances", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "http-error",
            statusCode: 422,
            body: {
              error: {
                code: "insufficient_balance",
                category: "VALIDATION",
                message: "the source wallet holds less than the payment amount",
              },
              meta: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderWorkflow({ csrfToken: "csrf-test" });
    fillValidForm();
    fireEvent.click(sendButton());

    const card = await screen.findByTestId("payment-failure-card");
    // The registry sentence (contract 07 §4 anatomy) — never free text.
    expect(card.textContent).toContain("Insufficient balance — The source wallet holds less than the payment amount.");
    expect(card.textContent).toContain("You can: Top up the source wallet or switch to another rail.");
    // The verbatim technical line.
    expect(card.textContent).toContain("insufficient_balance");
    // Recovery affordances: Retry · Edit & retry · Investigate · support.
    expect(screen.getByRole("button", { name: /Retry \(same details, fresh intent\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit & retry/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Investigate the evidence/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Docs & support/ })).toBeTruthy();
    // The audit-trail promise (contract 04 §4.2).
    expect(card.textContent).toContain("audit trail never loses it");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("no routable capability → the certified journey's honest empty state (no fabricated submission)", () => {
    renderWorkflow({ connectedInstances: [], routabilityChecks: [] });
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /Send 25 USDC/ }));
    // beginPayJourney with zero options renders the connect-gate empty state.
    expect(screen.getByText("No connected capability")).toBeTruthy();
    expect(screen.getByText(/never treated as executable authority/)).toBeTruthy();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("dual-submit: Send and create another keeps the flow open (no navigation, form reset)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            statusCode: 200,
            body: { data: { intent: { id: "pay_new_2" } }, meta: {} },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderWorkflow({ csrfToken: "csrf-test" });
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /Send and create another/ }));
    await waitFor(() => {
      expect(routerPush).not.toHaveBeenCalled();
    });
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("pay_new_2");
    // The composer re-arms for the next payment (amount cleared, rail kept).
    expect((screen.getByLabelText(/Amount/i) as HTMLInputElement).value).toBe("");
    expect(sendButton().disabled).toBe(true);
  });
});

describe("W1 counterparty combobox (ambiguity resolved by choice, never a guess)", () => {
  it("candidates render as chips and picking one selects the contact", () => {
    renderWorkflow();
    fireEvent.change(screen.getByPlaceholderText("Find or add a contact…"), {
      target: { value: "ama" },
    });
    const chip = screen.getByRole("button", { name: "Amara Okafor" });
    fireEvent.click(chip);
    expect(screen.getByTestId("selected-counterparty").textContent).toContain("Amara Okafor");
    expect(screen.getByTestId("selected-counterparty").textContent).toContain("cus_test_amara");
  });

  it("an unknown name offers the inline Add-contact chip (never a dead end)", () => {
    renderWorkflow();
    fireEvent.change(screen.getByPlaceholderText("Find or add a contact…"), {
      target: { value: "Zoe" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add contact 'Zoe'/ }));
    expect(screen.getByTestId("selected-counterparty").textContent).toContain("Zoe");
    expect(screen.getByTestId("selected-counterparty").textContent).toContain("contact:new:Zoe");
  });
});
