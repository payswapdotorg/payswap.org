"use client";

/**
 * UX-004 — W2, the payment-link builder (contract 04 §2 W2, field-for-field).
 *
 * Sections: Select type → Product (combobox; an unknown name offers the
 * inline "Add '<name>' as new product" modal: Name/Description/Image/Pricing
 * One-off|Recurring) → Payment page options in TIERS (basic: collect
 * name/address/phone, limit payments → advanced: custom fields, promo codes,
 * save details, ToS consent) → After payment. Every PRICED option states its
 * fee inline (managed delivery: 3.5% per transaction — the estimate is exact
 * integer minor-unit math, labeled an estimate).
 *
 * The CTA wording selector (Pay · Request · Donate) drives the preview's
 * button label; the live preview pane shows the payswap.link URL (clearly a
 * PREVIEW — no link exists yet) + "Use your domain" + the live estimate.
 *
 * HONESTY: creating a link is a financial mutation — it dispatches through
 * the authoritative API only. No certified link-creation command exists in
 * @payswap/ux yet and the journey-dispatch allowlist carries none, so the
 * Create action renders the honest not-yet state and NEVER fabricates a
 * payswap.link URL (the result page renders only real records — API or the
 * clearly-marked TEST fixtures).
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Button,
  Dialog,
  Field,
  Input,
  MoneyInput,
  Panel,
  Select,
} from "@payswap/design";

import type { LinkCtaWording } from "@/app/app/payments/_view/payment-view";
import {
  LINK_CTA_LABELS,
  assetExponent,
  linkEstimateLine,
  parseAmountToMinorUnits,
} from "@/app/app/payments/_view/payment-view";

export interface PaymentLinkBuilderProps {
  /** Initial values (the W1 hosted-link hand-off or a fresh start). */
  readonly initial?: {
    readonly amountMinorUnits?: string;
    readonly currency?: string;
    readonly name?: string;
    readonly description?: string;
  };
  /** The operator's product directory (injected; empty is honest). */
  readonly productDirectory: readonly { readonly id: string; readonly name: string }[];
  /** The live session's CSRF echo (undefined in the marked preview). */
  readonly csrfToken?: string;
  /** True when the authoritative API runtime is configured (else the honest gate says so). */
  readonly apiConfigured: boolean;
}

type PricingKind = "one-off" | "recurring";

interface DraftProduct {
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly pricingKind: PricingKind;
  readonly amountText: string;
  readonly currency: string;
}

const CURRENCIES = ["USDC", "EUR", "USD", "GHS"] as const;

/** The tiered payment-page options (contract 04 §2 W2.3). */
interface PageOptions {
  readonly collectName: boolean;
  readonly collectAddress: boolean;
  readonly collectPhone: boolean;
  readonly limitPayments: boolean;
  readonly maxPayments: string;
  readonly customFields: boolean;
  readonly promoCodes: boolean;
  readonly saveDetails: boolean;
  readonly tosConsent: boolean;
  readonly managedDelivery: boolean;
}

const MANAGED_DELIVERY_FEE_BPS = 350n; // 3.5% — stated inline wherever priced

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "link"
  );
}

export function PaymentLinkBuilder({
  initial,
  productDirectory,
  csrfToken,
  apiConfigured,
}: PaymentLinkBuilderProps) {
  const [productText, setProductText] = useState(initial?.name ?? "");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [draftProduct, setDraftProduct] = useState<DraftProduct | null>(null);
  const [addProductOpen, setAddProductOpen] = useState(false);
  const [draftImage, setDraftImage] = useState("");
  const [amountText, setAmountText] = useState(() =>
    initial?.amountMinorUnits !== undefined && initial?.currency !== undefined
      ? stripToDecimal(initial.amountMinorUnits, initial.currency)
      : "",
  );
  const [currency, setCurrency] = useState(initial?.currency ?? "USDC");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [pricingKind, setPricingKind] = useState<PricingKind>("one-off");
  const [cta, setCta] = useState<LinkCtaWording>("pay");
  const [options, setOptions] = useState<PageOptions>({
    collectName: true,
    collectAddress: false,
    collectPhone: false,
    limitPayments: false,
    maxPayments: "",
    customFields: false,
    promoCodes: false,
    saveDetails: false,
    tosConsent: false,
    managedDelivery: false,
  });
  const [amountError, setAmountError] = useState<string | null>(null);
  const [createOutcome, setCreateOutcome] = useState<"idle" | "not-created">("idle");

  const selectedProduct =
    selectedProductId === null
      ? null
      : (productDirectory.find((product) => product.id === selectedProductId) ?? null);
  const productName = selectedProduct?.name ?? draftProduct?.name ?? productText.trim();

  const minorUnits = parseAmountToMinorUnits(amountText, currency);
  const estimate = useMemo(
    () =>
      minorUnits === null
        ? null
        : linkEstimateLine(
            productName || "New product",
            { minorUnits, currency },
            options.managedDelivery ? MANAGED_DELIVERY_FEE_BPS : 0n,
          ),
    [minorUnits, currency, productName, options.managedDelivery],
  );

  const previewUrl = `https://payswap.link/l/${slugify(productName || "new-link")}`;

  const exactMatch = productDirectory.find(
    (product) => product.name.toLowerCase() === productText.trim().toLowerCase(),
  );
  const offerAddProduct =
    productText.trim().length > 0 &&
    exactMatch === undefined &&
    selectedProductId === null &&
    draftProduct === null;

  function setOption<K extends keyof PageOptions>(key: K, value: PageOptions[K]): void {
    setOptions((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="cc-stack" id="payment-link-builder">
      <Panel
        title="Payment link"
        description="A no-code collection link: pick a product, choose what the payment page asks for, pick the button verb — then share one URL. Creation dispatches through the authoritative PaySwap API; nothing here is simulated."
        headingLevel={2}
      >
        <div className="cc-stack">
          {/* — Select type — */}
          <fieldset className="cc-stack">
            <legend className="ps-label">Select type</legend>
            <div role="radiogroup" aria-label="Link type" className="cc-actions">
              {(["one-off", "recurring"] as const).map((kind) => (
                <label key={kind} className="cc-actions__item">
                  <input
                    type="radio"
                    name="link-type"
                    value={kind}
                    checked={pricingKind === kind}
                    onChange={() => {
                      setPricingKind(kind);
                    }}
                  />
                  <span>{kind === "one-off" ? "One-off payment" : "Recurring payment"}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* — Product combobox — */}
          <Field
            label="Product"
            hint="Type to find a product — an unknown name offers to add it as a new product inline."
          >
            <Input
              value={productText}
              placeholder="Design retainer — October"
              autoComplete="off"
              list="product-directory"
              onChange={(event) => {
                setProductText(event.target.value);
                setSelectedProductId(null);
                setDraftProduct(null);
              }}
            />
          </Field>
          <datalist id="product-directory">
            {productDirectory.map((product) => (
              <option key={product.id} value={product.name} />
            ))}
          </datalist>
          {offerAddProduct ? (
            <p className="cc-actions__reason" data-testid="add-product-offer">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setAddProductOpen(true);
                }}
              >
                Add &ldquo;{productText.trim()}&rdquo; as new product
              </Button>{" "}
              — opens inline; the product becomes a draft attached to this link.
            </p>
          ) : null}
          {selectedProduct !== null || draftProduct !== null ? (
            <p className="cc-actions__reason" data-testid="selected-product">
              Product: <strong>{productName}</strong>
              {draftProduct !== null ? " (new draft product)" : ""}
            </p>
          ) : null}

          <div className="cc-grid">
            <Field
              label="Amount"
              required
              hint="What the link charges. Exact minor units under the hood."
              error={amountError}
              onErrorClear={() => {
                setAmountError(null);
              }}
            >
              <MoneyInput
                currency={currency}
                value={amountText}
                inputMode="decimal"
                placeholder="25"
                onChange={(event) => {
                  setAmountText(event.target.value);
                }}
              />
            </Field>
            <Field label="Currency" required>
              <Select
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value);
                }}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Description" hint="Shown under the product name on the payment page.">
            <Input
              value={description}
              placeholder="October retainer — 40 hours"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>

          {/* — Payment page options, tiered — */}
          <fieldset className="cc-stack">
            <legend className="ps-label">Payment page options</legend>
            <p className="cc-actions__reason">Basic — what the payment page collects.</p>
            <div className="cc-stack">
              <Toggle
                label="Collect the customer's name"
                checked={options.collectName}
                onChange={(value) => {
                  setOption("collectName", value);
                }}
              />
              <Toggle
                label="Collect the customer's address"
                checked={options.collectAddress}
                onChange={(value) => {
                  setOption("collectAddress", value);
                }}
              />
              <Toggle
                label="Collect the customer's phone"
                checked={options.collectPhone}
                onChange={(value) => {
                  setOption("collectPhone", value);
                }}
              />
              <div className="cc-stack">
                <Toggle
                  label="Limit the number of payments"
                  checked={options.limitPayments}
                  onChange={(value) => {
                    setOption("limitPayments", value);
                  }}
                />
                {options.limitPayments ? (
                  <Field label="Maximum payments" required hint="The link stops accepting payments after this many.">
                    <Input
                      value={options.maxPayments}
                      inputMode="numeric"
                      placeholder="10"
                      onChange={(event) => {
                        setOption("maxPayments", event.target.value.replace(/\D/g, "").slice(0, 4));
                      }}
                    />
                  </Field>
                ) : (
                  <Field
                    label="Maximum payments"
                    disabledReason="Turn on &ldquo;Limit the number of payments&rdquo; to set a maximum."
                  >
                    <Input disabled value="" onChange={() => undefined} />
                  </Field>
                )}
              </div>
            </div>
            <p className="cc-actions__reason">
              Advanced — heavier collection and conversion tooling.
            </p>
            <div className="cc-stack">
              <Toggle
                label="Custom fields (collect extra answers on checkout)"
                checked={options.customFields}
                onChange={(value) => {
                  setOption("customFields", value);
                }}
              />
              <Toggle
                label="Promo codes"
                checked={options.promoCodes}
                onChange={(value) => {
                  setOption("promoCodes", value);
                }}
              />
              <Toggle
                label="Let customers save their details for next time"
                checked={options.saveDetails}
                onChange={(value) => {
                  setOption("saveDetails", value);
                }}
              />
              <Toggle
                label="Require terms-of-service consent"
                checked={options.tosConsent}
                onChange={(value) => {
                  setOption("tosConsent", value);
                }}
              />
              <div className="cc-stack">
                <Toggle
                  label="Managed delivery — PaySwap handles delivery, support and reconciliation for this link"
                  checked={options.managedDelivery}
                  onChange={(value) => {
                    setOption("managedDelivery", value);
                  }}
                />
                <p className="cc-actions__reason" data-testid="managed-delivery-fee">
                  {options.managedDelivery
                    ? `Adds a 3.5% fee per transaction — the estimate below includes it (exact integer math, labeled an estimate).`
                    : `Priced option: turning this on adds a 3.5% fee per transaction, stated here inline. Off = no fee.`}
                </p>
              </div>
            </div>
          </fieldset>

          {/* — After payment — */}
          <Panel
            title="After payment"
            description="What the customer sees once they have paid."
            headingLevel={3}
          >
            <p className="cc-actions__reason">
              The confirmation page restates the descriptor
              {description.trim().length > 0 ? ` (“${description.trim()}”)` : ""} and the
              masked method, with a receipt link — no forced account creation
              (contract 04 §2 W3.5, the same page the hosted flow renders).
            </p>
          </Panel>

          {/* — CTA wording selector — */}
          <fieldset className="cc-stack">
            <legend className="ps-label">Call-to-action wording</legend>
            <div role="radiogroup" aria-label="Call-to-action wording" className="cc-actions">
              {(["pay", "request", "donate"] as const).map((wording) => (
                <label key={wording} className="cc-actions__item">
                  <input
                    type="radio"
                    name="cta-wording"
                    value={wording}
                    checked={cta === wording}
                    onChange={() => {
                      setCta(wording);
                    }}
                  />
                  <span>{LINK_CTA_LABELS[wording]}</span>
                </label>
              ))}
            </div>
            <p className="cc-actions__reason">
              The verb on the payment button — {LINK_CTA_LABELS[cta]}{" "}
              {minorUnits === null ? "…" : `${amountText.replace(/,/g, "")} ${currency}`}.
            </p>
          </fieldset>
        </div>
      </Panel>

      {/* — Live preview pane — */}
      <Panel
        title="Live preview"
        description="What the link will look like — a preview, not a created link."
        headingLevel={2}
      >
        <div className="cc-stack" data-testid="link-preview">
          <p className="cc-actions__reason">
            <span className="ps-mono">{previewUrl}</span> —{" "}
            <Link href="/app/settings" className="font-semibold text-emerald-800 underline">
              Use your domain
            </Link>{" "}
            (domain settings). <strong>Preview — no link exists yet.</strong>
          </p>
          <div className="ps-panel">
            <div className="ps-panel__body cc-stack">
              <p className="cc-section-heading">{productName || "New product"}</p>
              {description.trim().length > 0 ? (
                <p className="cc-actions__reason">{description}</p>
              ) : null}
              <p className="cc-actions__reason ps-num">
                {minorUnits === null
                  ? "—"
                  : `${amountText.replace(/,/g, "")} ${currency}`}{" "}
                · {pricingKind === "one-off" ? "One-off" : "Recurring"}
              </p>
              <Button variant="primary">
                {LINK_CTA_LABELS[cta]}{" "}
                {minorUnits === null ? "…" : `${amountText.replace(/,/g, "")} ${currency}`}
              </Button>
            </div>
          </div>
          {estimate !== null ? (
            <p className="cc-actions__reason" data-testid="link-estimate">
              Estimate: {estimate.estimate}
            </p>
          ) : (
            <p className="cc-actions__reason">Enter an amount to see the estimate.</p>
          )}
        </div>
      </Panel>

      {/* — Create (honest gate) — */}
      <Panel title="Create the link" description="One action, honestly gated." headingLevel={2}>
        <div className="cc-stack">
          <div className="cc-actions">
            <span className="cc-actions__item">
              <Button
                variant="primary"
                disabled={minorUnits === null || productName.length === 0}
                onClick={() => {
                  if (minorUnits === null) {
                    setAmountError("Enter an amount greater than zero.");
                    return;
                  }
                  setCreateOutcome("not-created");
                }}
              >
                Create link
              </Button>
            </span>
          </div>
          {createOutcome === "not-created" ? (
            <div role="alert" className="cc-stack" data-testid="link-create-honest-outcome">
              <p className="cc-actions__reason">
                <strong>Link not created.</strong> Payment-link creation is a financial
                mutation — it dispatches through the authoritative PaySwap API, and no
                certified link-creation command exists in the journey contracts yet
                (the dispatch allowlist carries none, and hand-assembled commands are
                refused by design).{" "}
                {apiConfigured
                  ? "The API runtime is configured; the link surface is what has not shipped."
                  : "The API runtime is not configured in this deployment either (NEXT_PUBLIC_PAYSWAP_API_URL)."}{" "}
                {csrfToken === undefined
                  ? "A signed-in session is also required — you are viewing the marked preview, which never mutates anything."
                  : ""}{" "}
                No payswap.link URL is fabricated here; the result page renders only
                real records.
              </p>
              <p className="cc-actions__reason">
                Everything you composed is preserved on this page — the moment the
                certified link command ships, this same form dispatches through
                it. Until then, links can be composed through the{" "}
                <Link href="/developers" className="font-semibold text-emerald-800 underline">
                  API docs
                </Link>{" "}
                (docs &amp; support), or share the W1 hosted-link hand-off.
              </p>
            </div>
          ) : null}
        </div>
      </Panel>

      {/* — Add-product modal (inline, from the combobox) — */}
      <Dialog
        open={addProductOpen}
        onClose={() => {
          setAddProductOpen(false);
        }}
        title={`Add “${productText.trim()}” as new product`}
        description="A draft product attached to this link — Name, Description, Image and Pricing. It becomes a catalog record when the link is created through the authoritative API."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setAddProductOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={productText.trim().length === 0 || parseAmountToMinorUnits(amountText, currency) === null}
              onClick={() => {
                setDraftProduct({
                  name: productText.trim(),
                  description,
                  imageUrl: draftImage.trim(),
                  pricingKind,
                  amountText,
                  currency,
                });
                setAddProductOpen(false);
              }}
            >
              Add product
            </Button>
          </>
        }
      >
        <div className="cc-stack">
          <Field label="Name" required hint="Shown as the link's headline.">
            <Input
              value={productText}
              onChange={(event) => {
                setProductText(event.target.value);
              }}
            />
          </Field>
          <Field label="Description" hint="One line under the name.">
            <Input
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
          <Field label="Image" hint="A product image URL — optional; stays a draft until the link is created.">
            <Input
              value={draftImage}
              placeholder="https://…"
              onChange={(event) => {
                setDraftImage(event.target.value);
              }}
            />
          </Field>
          <fieldset className="cc-stack">
            <legend className="ps-label">Pricing</legend>
            <div role="radiogroup" aria-label="Pricing" className="cc-actions">
              {(["one-off", "recurring"] as const).map((kind) => (
                <label key={kind} className="cc-actions__item">
                  <input
                    type="radio"
                    name="product-pricing"
                    value={kind}
                    checked={pricingKind === kind}
                    onChange={() => {
                      setPricingKind(kind);
                    }}
                  />
                  <span>{kind === "one-off" ? "One-off" : "Recurring"}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="cc-actions__reason">
            Amount and currency come from the builder above
            {minorUnits === null
              ? " — enter an amount there first."
              : ` (${amountText.replace(/,/g, "")} ${currency}, ${assetExponent(currency)} decimals exact).`}
          </p>
        </div>
      </Dialog>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="cc-actions__item">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );
}

/** Render minor units back to a plain decimal for the amount input. */
function stripToDecimal(minorUnits: string, currency: string): string {
  if (!/^\d+$/.test(minorUnits)) {
    return "";
  }
  const exp = assetExponent(currency);
  const value = BigInt(minorUnits);
  const whole = value / 10n ** BigInt(exp);
  const frac = value % 10n ** BigInt(exp);
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(exp, "0")}`;
}
