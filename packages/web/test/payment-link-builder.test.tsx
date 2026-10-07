// @vitest-environment jsdom
/**
 * UX-004 — W2, the payment-link builder (contract 04 §2 W2, field-for-field).
 *
 * Tiered payment-page options (basic → advanced) with the priced option
 * stating its fee inline · the product combobox with the inline
 * "Add '<name>' as new product" modal (Name/Description/Image/Pricing) ·
 * the CTA wording selector (Pay · Request · Donate) driving the live
 * preview · the payswap.link PREVIEW URL + "Use your domain" + the live
 * estimate (exact integer math) · the honest create gate (no fabricated
 * link — creation is a financial mutation through the authoritative API,
 * and no certified link command exists yet) · the W1 hosted-link hand-off
 * pre-fill.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { PaymentLinkBuilder } from "../src/components/workflows/payment-link-builder";

const PRODUCT_DIRECTORY = [
  { id: "prod_test_1", name: "Design retainer — October" },
  { id: "prod_test_2", name: "Support plan" },
];

afterEach(() => {
  cleanup();
});

function renderBuilder(
  overrides: Partial<Parameters<typeof PaymentLinkBuilder>[0]> = {},
): void {
  render(
    <PaymentLinkBuilder
      productDirectory={PRODUCT_DIRECTORY}
      apiConfigured={false}
      {...overrides}
    />,
  );
}

describe("W2 anatomy: the sections are the contract", () => {
  it("renders Select type, the product combobox, tiered options, After payment, the CTA selector and the preview", () => {
    renderBuilder();
    expect(screen.getByRole("radiogroup", { name: "Link type" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "One-off payment" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Recurring payment" })).toBeTruthy();
    expect(screen.getByLabelText(/Product/)).toBeTruthy();
    expect(screen.getByText("Basic — what the payment page collects.")).toBeTruthy();
    expect(screen.getByText(/Advanced — heavier collection/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "After payment" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Call-to-action wording" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Live preview" })).toBeTruthy();
    // The tiered option set (basic + advanced), by label.
    for (const label of [
      /Collect the customer's name/,
      /Collect the customer's address/,
      /Collect the customer's phone/,
      /Limit the number of payments/,
      /Custom fields/,
      /Promo codes/,
      /save their details/,
      /terms-of-service consent/,
      /Managed delivery/,
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("the maximum-payments input is a dependent-disable WITH reason (contract 03 §2.12)", () => {
    renderBuilder();
    const reason = screen.getByText(/to set a maximum\.$/);
    expect(reason.className).toContain("ps-field__reason");
    expect((screen.getByLabelText(/Maximum payments/) as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText(/Limit the number of payments/));
    expect(screen.queryByText(/to set a maximum/)).toBeNull();
    const max = screen.getByLabelText(/Maximum payments/) as HTMLInputElement;
    expect(max.disabled).toBe(false);
    fireEvent.change(max, { target: { value: "10" } });
    expect(max.value).toBe("10");
  });

  it("every priced option states its fee inline (the managed-delivery 3.5%)", () => {
    renderBuilder();
    const feeLine = screen.getByTestId("managed-delivery-fee");
    expect(feeLine.textContent).toContain("3.5% fee per transaction");
    fireEvent.click(screen.getByLabelText(/Managed delivery/));
    expect(screen.getByTestId("managed-delivery-fee").textContent).toContain(
      "Adds a 3.5% fee per transaction",
    );
  });
});

describe("W2 product combobox + the inline Add-as-new-product modal", () => {
  it("an unknown name offers Add “<name>” as new product; the modal carries Name/Description/Image/Pricing", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Product/), {
      target: { value: "Consulting sprint" },
    });
    const offer = screen.getByTestId("add-product-offer");
    expect(offer.textContent).toContain("as new product");
    fireEvent.click(within(offer).getByRole("button", { name: /as new product/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Consulting sprint/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/^Name/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Description/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Image/)).toBeTruthy();
    expect(within(dialog).getByRole("radiogroup", { name: "Pricing" })).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "One-off" })).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Recurring" })).toBeTruthy();
  });

  it("adding the draft product attaches it to the link (clearly a draft)", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/Product/), {
      target: { value: "Consulting sprint" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /as new product/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    expect(screen.getByTestId("selected-product").textContent).toContain(
      "Consulting sprint",
    );
    expect(screen.getByTestId("selected-product").textContent).toContain(
      "new draft product",
    );
  });

  it("a known product name resolves against the injected directory", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Product/), {
      target: { value: "Support plan" },
    });
    // Exact match: no add-product offer, the datalist carries the directory.
    expect(screen.queryByTestId("add-product-offer")).toBeNull();
    const options = Array.from(document.querySelectorAll("datalist option"));
    expect(options.length).toBe(PRODUCT_DIRECTORY.length);
  });
});

describe("W2 CTA wording selector + live estimate (exact integer math)", () => {
  it("Pay · Request · Donate drive the preview's button verb", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "25" } });
    const preview = screen.getByTestId("link-preview");
    expect(within(preview).getByRole("button", { name: /Pay 25 USDC/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Request" }));
    expect(within(preview).getByRole("button", { name: /Request 25 USDC/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Donate" }));
    expect(within(preview).getByRole("button", { name: /Donate 25 USDC/ })).toBeTruthy();
  });

  it("the estimate line: 1 × 25 USDC = 25 USDC · Total 25 USDC (no fee)", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "25" } });
    expect(screen.getByTestId("link-estimate").textContent).toContain(
      "1 × 25 USDC = 25 USDC · Total 25 USDC",
    );
  });

  it("with managed delivery the estimate states the fee and adds it exactly (3.5% of 25 = 0.875)", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "25" } });
    fireEvent.click(screen.getByLabelText(/Managed delivery/));
    const estimate = screen.getByTestId("link-estimate").textContent ?? "";
    expect(estimate).toContain("Managed-delivery fee 3.5%");
    expect(estimate).toContain("Estimated total 25.875000 USDC");
    expect(estimate).toContain("1 × 25 USDC = 25 USDC");
  });

  it("the preview URL is payswap.link, clearly a PREVIEW, with the Use-your-domain affordance", () => {
    renderBuilder();
    const preview = screen.getByTestId("link-preview");
    expect(preview.textContent).toContain("https://payswap.link/l/");
    expect(preview.textContent).toContain("Preview — no link exists yet");
    expect(
      within(preview).getByRole("link", { name: /Use your domain/ }),
    ).toBeTruthy();
  });

  it("an invalid amount shows no estimate (never a guessed one)", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "abc" } });
    expect(screen.queryByTestId("link-estimate")).toBeNull();
    expect(screen.getByText(/Enter an amount to see the estimate/)).toBeTruthy();
  });
});

describe("W2 honesty: creating a link is a financial mutation (no fabrication)", () => {
  it("Create renders the honest not-created state — no payswap.link result is fabricated", () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/Product/), {
      target: { value: "Design retainer — October" },
    });
    const create = screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    const outcome = screen.getByTestId("link-create-honest-outcome");
    expect(outcome.getAttribute("role")).toBe("alert");
    expect(outcome.textContent).toContain("Link not created.");
    expect(outcome.textContent).toContain(
      "no certified link-creation command exists",
    );
    // With the API configured the honest state names the missing piece too.
    cleanup();
    renderBuilder({ apiConfigured: true, csrfToken: "csrf-test" });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/Product/), {
      target: { value: "Design retainer — October" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(screen.getByTestId("link-create-honest-outcome").textContent).toContain(
      "The API runtime is configured; the link surface is what has not shipped",
    );
  });

  it("Create stays blocked until the composition is valid (amount + product)", () => {
    renderBuilder();
    expect(
      (screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("W2 the W1 hosted-link hand-off pre-fills the builder", () => {
  it("adopts the exact minor units, currency, name and description from the hand-off", () => {
    renderBuilder({
      initial: {
        amountMinorUnits: "25000000",
        currency: "USDC",
        name: "Design retainer — October",
        description: "October retainer — 40 hours",
      },
    });
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe("25");
    expect((screen.getByLabelText(/Currency/) as HTMLSelectElement).value).toBe("USDC");
    expect((screen.getByLabelText(/Product/) as HTMLInputElement).value).toContain(
      "Design retainer — October",
    );
    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toBe(
      "October retainer — 40 hours",
    );
  });
});
