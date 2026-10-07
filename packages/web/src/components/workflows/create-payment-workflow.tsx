"use client";

/**
 * UX-004 — W1, "Create a payment" (contract 04 §2 W1, field-for-field) —
 * the convergence of the Pay-journey composing surface onto the workflow
 * contract.
 *
 * FORM (progressive disclosure, simple first):
 * - segmented One-time | Recurring (the schedule select disables WITH a
 *   reason until Recurring is chosen — contract 03 §2.12);
 * - Amount: currency-prefixed MoneyInput with blur auto-formatting
 *   (@payswap/design groupDigits; exact minor-unit parse — never a float);
 * - Currency select;
 * - Counterparty combobox ("Find or add a contact…") resolving against the
 *   injected directory through the certified `resolveCounterparty`
 *   (@payswap/ux): candidates as chips, or the inline "Add '<name>'" chip —
 *   ambiguity resolved by choice, never a guess;
 * - Description + statement descriptor (auto-formatted; the descriptor is
 *   REQUIRED when the funding rail is manual entry);
 * - Funding rail radio: manual entry · on-file method · hosted link — the
 *   on-file option disables WITH its reason until the counterparty has a
 *   method on file (dependent-disable, contract 03 §2.12).
 *
 * VALIDATION (contract 07 §3.3): per-field inline errors BELOW fields,
 * clear-on-valid, submit blocked until valid — never a silent drop.
 *
 * CONFIRM: a ConfirmationButton restating amount + asset ("Send 25 USDC")
 * with the in-button Processing state, plus the dual-submit
 * "Send and create another" for repeat flows.
 *
 * SUBMISSION is the REAL certified path: beginPayJourney → (routable
 * connected instance) selectPayCapability → the authenticated
 * /api/journeys/dispatch transport → applyPaymentSubmissionResponse — the
 * same folds the Wave-1 surface uses. Success navigates to the payment
 * detail route (the object exists immediately); a failed submission renders
 * the attempt as an OBJECT VIEW (failed chip + the registry reason + the
 * verbatim technical detail + Retry / Edit & retry / Investigate) — the
 * audit trail never loses the attempt. UNKNOWN stays reconciliation
 * (INV-X01) through the certified journey renders.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  ConnectedCapabilityInstanceRecord,
  ContactDirectoryEntry,
  CurrencyRoutabilityCheck,
  DisambiguationChip,
  PayJourney,
  ViewAction,
} from "@payswap/ux";
import {
  applyPaymentSubmissionResponse,
  beginPayJourney,
  resolveCounterparty,
  selectPayCapability,
} from "@payswap/ux";
import {
  Button,
  ConfirmationButton,
  Field,
  Input,
  MoneyInput,
  Panel,
  Select,
  StatusChip,
} from "@payswap/design";
import type { ErrorReasonId } from "@payswap/ux";

import type { FundingRail } from "@/app/app/payments/_view/payment-view";
import {
  assetExponent,
  composeRegistrySentence,
  errorReasonIdFromApiCode,
  parseAmountToMinorUnits,
} from "@/app/app/payments/_view/payment-view";

import { PayJourneyView } from "@/components/cc/pay-journey-surface";
import { dispatchJourneyApiCommand } from "@/lib/cc/journey-dispatch";

const CURRENCIES = ["USDC", "EUR", "USD", "GHS"] as const;

export interface MethodOnFile {
  readonly counterpartyName: string;
  readonly maskedLine: string;
}

export interface CreatePaymentWorkflowProps {
  /** Authority records of connected instances (the only execution surface). */
  readonly connectedInstances: readonly ConnectedCapabilityInstanceRecord[];
  /** Authority routability checks per instance (absent check = not routable). */
  readonly routabilityChecks: readonly CurrencyRoutabilityCheck[];
  /** The operator's contact directory (injected; empty is honest). */
  readonly contactDirectory: readonly ContactDirectoryEntry[];
  /** Methods on file per counterparty (injected authority data; empty is honest). */
  readonly methodsOnFile: readonly MethodOnFile[];
  readonly autoStart: boolean;
  /** The live session's CSRF echo (undefined in the marked preview). */
  readonly csrfToken?: string;
}

type Schedule = "one-time" | "recurring";
type Interval = "weekly" | "monthly";

/** Which requirements a funding rail imposes (the W1 form's dependent rules). */
function requiresCounterpartyFor(rail: FundingRail): boolean {
  return rail !== "hosted-link";
}

function requiresDescriptorFor(rail: FundingRail): boolean {
  return rail === "manual-entry";
}

interface FormErrors {
  readonly amount?: string;
  readonly counterparty?: string;
  readonly descriptor?: string;
}

type Phase =
  | { readonly kind: "COMPOSING" }
  | { readonly kind: "JOURNEY"; readonly journey: PayJourney };

/** The failure outcome card state (the attempt-as-object audit view). */
interface FailureCard {
  readonly reasonId: ErrorReasonId | null;
  readonly registrySentence: string | null;
  readonly technical: string;
  readonly evidenceHref: string;
}

export function CreatePaymentWorkflow({
  connectedInstances,
  routabilityChecks,
  contactDirectory,
  methodsOnFile,
  autoStart,
  csrfToken,
}: CreatePaymentWorkflowProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "COMPOSING" });
  const [schedule, setSchedule] = useState<Schedule>("one-time");
  const [recurrenceInterval, setRecurrenceInterval] = useState<Interval>("monthly");
  const [amountText, setAmountText] = useState("");
  const [currency, setCurrency] = useState<string>("USDC");
  const [counterpartyText, setCounterpartyText] = useState("");
  const [selectedCounterparty, setSelectedCounterparty] = useState<ContactDirectoryEntry | null>(null);
  const [description, setDescription] = useState("");
  const [descriptor, setDescriptor] = useState("");
  const [fundingRail, setFundingRail] = useState<FundingRail>("manual-entry");
  const [errors, setErrors] = useState<FormErrors>({});
  const [pending, setPending] = useState(false);
  const [dualNote, setDualNote] = useState<string | null>(null);
  const [failureCard, setFailureCard] = useState<FailureCard | null>(null);

  const minorUnits = parseAmountToMinorUnits(amountText, currency);
  const methodsForCounterparty = useMemo(
    () =>
      (selectedCounterparty === null
        ? []
        : methodsOnFile.filter(
            (method) =>
              method.counterpartyName.toLowerCase() ===
              selectedCounterparty.displayName.toLowerCase(),
          )),
    [methodsOnFile, selectedCounterparty],
  );

  /** The honest execution rail: routable connected instances for this currency. */
  const routableInstances = useMemo(() => {
    const checks = new Map(routabilityChecks.map((check) => [check.instanceId, check]));
    return connectedInstances.filter((instance) => checks.get(instance.instanceId)?.routable === true);
  }, [connectedInstances, routabilityChecks]);
  const firstRoutable = routableInstances[0];

  const onFileDisabledReason =
    selectedCounterparty === null
      ? "Select a counterparty to see their methods on file."
      : methodsForCounterparty.length === 0
        ? `No payment method is on file for ${selectedCounterparty.displayName} yet — methods land here after their first payment.`
        : undefined;

  const requiresCounterparty = requiresCounterpartyFor(fundingRail);
  const requiresDescriptor = requiresDescriptorFor(fundingRail);

  const isValid =
    minorUnits !== null &&
    (!requiresCounterparty || selectedCounterparty !== null) &&
    (!requiresDescriptor || descriptor.trim().length > 0);

  const resolution = useMemo(
    () =>
      selectedCounterparty === null && counterpartyText.trim().length > 0
        ? resolveCounterparty(counterpartyText.trim(), contactDirectory)
        : null,
    [counterpartyText, contactDirectory, selectedCounterparty],
  );

  function pickChip(chip: DisambiguationChip): void {
    if (chip.kind === "counterparty-candidate") {
      const entry = contactDirectory.find((candidate) => candidate.id === chip.value);
      if (entry !== undefined) {
        setSelectedCounterparty(entry);
        setCounterpartyText(entry.displayName);
        setErrors((current) => ({ ...current, counterparty: undefined }));
      }
      return;
    }
    if (chip.kind === "add-contact") {
      setSelectedCounterparty({ id: `contact:new:${chip.value}`, displayName: chip.value });
      setCounterpartyText(chip.value);
      setErrors((current) => ({ ...current, counterparty: undefined }));
    }
  }

  /**
   * The per-field error derivations (contract 07 §3.3): each field owns ONE
   * message, derived from the CURRENT form state — a re-derivation can never
   * leave a stale error behind after the input changed.
   */
  function amountErrorFor(text: string, forCurrency: string): string | undefined {
    if (parseAmountToMinorUnits(text, forCurrency) === null) {
      const plain = text.trim().replace(/,/g, "");
      if (/^\d+(?:\.\d+)?$/.test(plain)) {
        return `More precision than ${forCurrency} carries (${assetExponent(forCurrency)} decimals) — round to the nearest unit.`;
      }
      return "Enter an amount greater than zero, as a plain number (e.g. 25 or 10.50).";
    }
    return undefined;
  }

  function counterpartyErrorFor(): string | undefined {
    if (!requiresCounterparty || selectedCounterparty !== null) {
      return undefined;
    }
    return counterpartyText.trim().length > 0
      ? "Pick a contact (or add one) so the payment has a recipient — or switch the funding rail to a hosted link."
      : "A counterparty is required to send a payment directly — pick a contact, add one, or switch the funding rail to a hosted link.";
  }

  function descriptorErrorFor(
    text: string,
    rail: FundingRail = fundingRail,
  ): string | undefined {
    if (!requiresDescriptorFor(rail) || text.trim().length > 0) {
      return undefined;
    }
    return "A statement descriptor is required for manually-funded payments — the customer needs it to recognize the payment on their statement.";
  }

  /**
   * Blur validation (contract 04 §2 W1.3 with the blocked submit): because
   * the submit button is DISABLED until the form is valid, per-field inline
   * errors appear on blur — never only after an impossible click — and clear
   * on the next edit (Field onErrorClear + this re-derivation).
   */
  function blurField(field: "amount" | "counterparty" | "descriptor"): void {
    setErrors((current) => ({
      ...current,
      amount: field === "amount" ? amountErrorFor(amountText, currency) : current.amount,
      counterparty:
        field === "counterparty" ? counterpartyErrorFor() : current.counterparty,
      descriptor: field === "descriptor" ? descriptorErrorFor(descriptor) : current.descriptor,
    }));
  }

  /** Validate everything (the submit-attempt path — defense in depth). */
  function validate(): boolean {
    const next: FormErrors = {
      ...(amountErrorFor(amountText, currency) === undefined
        ? {}
        : { amount: amountErrorFor(amountText, currency) }),
      ...(counterpartyErrorFor() === undefined ? {} : { counterparty: counterpartyErrorFor() }),
      ...(descriptorErrorFor(descriptor) === undefined
        ? {}
        : { descriptor: descriptorErrorFor(descriptor) }),
    };
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /** Auto-format the statement descriptor visibly (contract 03 §2.12). */
  function formatDescriptor(value: string): string {
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9* ]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 22);
  }

  /**
   * Switch the funding rail and re-derive every rail-dependent error, so a
   * requirement that no longer applies clears IMMEDIATELY (never a stale
   * error after the constraint changed — contract 07 §3.3).
   */
  function changeFundingRail(rail: FundingRail): void {
    setFundingRail(rail);
    setErrors((current) => ({
      ...current,
      counterparty:
        requiresCounterpartyFor(rail) && selectedCounterparty === null
          ? current.counterparty
          : undefined,
      descriptor: descriptorErrorFor(descriptor, rail),
    }));
  }

  async function submit(mode: "send" | "send-and-create-another"): Promise<void> {
    if (pending || !isValid) {
      return;
    }
    if (!validate()) {
      return;
    }
    setDualNote(null);
    setFailureCard(null);

    if (fundingRail === "hosted-link") {
      // The hosted rail creates a PAYMENT LINK (W2) pre-filled from this form
      // — an honest hand-off, not a second submission path.
      const params = new URLSearchParams({
        amount: minorUnits ?? "0",
        currency,
        ...(description.trim().length === 0 ? {} : { description: description.trim() }),
        ...(selectedCounterparty === null ? {} : { name: selectedCounterparty.displayName }),
      });
      router.push(`/app/payments/link?${params.toString()}`);
      return;
    }

    const request = {
      amount: { currency, minorUnits: minorUnits ?? "0" },
      recipient: selectedCounterparty?.displayName ?? "",
    };
    let journey = beginPayJourney({ request, connectedInstances, routabilityChecks });
    if (firstRoutable !== undefined) {
      try {
        journey = selectPayCapability(journey, firstRoutable.instanceId, []);
      } catch {
        // Fail-closed honesty: the contract refused the fold — the journey
        // stays in capability selection and renders its own honest state.
      }
    }
    const submitAction = journey.actions.find((action) => action.actionId === "submit-payment");
    if (submitAction === undefined || firstRoutable === undefined) {
      // No routable connected capability: the certified journey renders its
      // honest empty state (never a fabricated submission).
      setPhase({ kind: "JOURNEY", journey });
      return;
    }

    setPending(true);
    try {
      const result = await dispatchJourneyApiCommand("pay", submitAction, csrfToken);
      if (result.kind === "response") {
        let folded: PayJourney;
        try {
          folded = applyPaymentSubmissionResponse(journey, result.response);
        } catch {
          setDualNote(
            "The contract refused to fold the API's answer — the journey state is unchanged and nothing was fabricated.",
          );
          return;
        }
        setPhase({ kind: "JOURNEY", journey: folded });
        if (folded.submittedIntentId !== undefined) {
          if (mode === "send") {
            router.push(`/app/payments/${encodeURIComponent(folded.submittedIntentId)}`);
          } else {
            setDualNote(
              `Sent ${amountText.trim()} ${currency} — create another below, or view the payment (${folded.submittedIntentId}).`,
            );
            setAmountText("");
            setDescription("");
            setPhase({ kind: "COMPOSING" });
          }
          return;
        }
        if (folded.stateName === "REVIEWING_ROUTE" && folded.error !== undefined) {
          const error = folded.error;
          const reasonId = errorReasonIdFromApiCode(error.code);
          setFailureCard({
            reasonId,
            registrySentence: reasonId === null ? null : composeRegistrySentence(reasonId),
            technical: `API error ${error.code} (${error.category}): ${error.message}`,
            evidenceHref: "/app/evidence",
          });
        }
        return;
      }
      setDualNote(result.message);
    } finally {
      setPending(false);
    }
  }

  function onJourneyAction(action: ViewAction): void {
    if (phase.kind !== "JOURNEY") {
      return;
    }
    const journey = phase.journey;
    if (action.actionId.startsWith("select-capability:")) {
      const instanceId = action.actionId.slice("select-capability:".length);
      const option = journey.options.find(
        (candidate) => candidate.instance.instanceId === instanceId,
      );
      if (option === undefined) {
        setDualNote("That capability is not among this journey's connected instance options.");
        return;
      }
      try {
        setPhase({
          kind: "JOURNEY",
          journey: selectPayCapability(journey, option.instance.instanceId, []),
        });
      } catch {
        setDualNote("The contract refused this selection — see the routability reasons listed.");
      }
      return;
    }
    switch (action.actionId) {
      case "choose-different-capability":
        setPhase({
          kind: "JOURNEY",
          journey: beginPayJourney({
            request: journey.request,
            connectedInstances,
            routabilityChecks,
          }),
        });
        return;
      case "retry-as-new-intent":
        setPhase({ kind: "COMPOSING" });
        return;
      case "submit-payment": {
        void submit("send");
        return;
      }
      default:
        return;
    }
  }

  if (phase.kind === "JOURNEY") {
    return (
      <div className="cc-stack">
        <PayJourneyView journey={phase.journey} onAction={onJourneyAction} />
        {pending ? (
          <p className="cc-actions__reason" role="status">
            Dispatching the payment submission to the authoritative PaySwap API…
          </p>
        ) : null}
        {dualNote !== null ? (
          <p role="status" className="cc-actions__reason">
            {dualNote}
          </p>
        ) : null}
        {failureCard !== null ? (
          <FailureOutcomeCard card={failureCard} onRetry={() => {
            setPhase({ kind: "COMPOSING" });
          }} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="cc-stack" id="create-payment">
      <Panel
        title="Create a payment"
        description="The W1 flow: compose the payment, choose how it is funded, confirm with the amount restated on the button. Submission dispatches through the authenticated PaySwap API — nothing is simulated."
        headingLevel={2}
      >
        {autoStart ? (
          <p className="cc-actions__reason" role="status">
            Started from the Pay action — compose the payment below.
          </p>
        ) : null}
        {dualNote !== null ? (
          <p role="status" className="cc-actions__reason">
            {dualNote}
          </p>
        ) : null}

        <fieldset className="cc-stack">
          <legend className="ps-label">Schedule</legend>
          <div role="radiogroup" aria-label="Schedule" className="cc-actions">
            {(["one-time", "recurring"] as const).map((option) => (
              <label key={option} className="cc-actions__item">
                <input
                  type="radio"
                  name="payment-schedule"
                  value={option}
                  checked={schedule === option}
                  onChange={() => {
                    setSchedule(option);
                  }}
                />
                <span>{option === "one-time" ? "One-time" : "Recurring"}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="cc-grid">
          <Field
            label="Amount"
            required
            hint="Currency-prefixed; formats on blur. Exact minor units under the hood — never a rounded float."
            error={errors.amount}
            onErrorClear={() => {
              setErrors((current) => ({ ...current, amount: undefined }));
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
              onBlur={() => {
                blurField("amount");
              }}
            />
          </Field>
          <Field label="Currency" required hint="Routability is derived from connected instances — see the funding rail below.">
            <Select
              value={currency}
              onChange={(event) => {
                const nextCurrency = event.target.value;
                setCurrency(nextCurrency);
                // Precision depends on the asset — re-derive the amount
                // error whenever an amount is entered, so neither a STALE
                // error nor a silent block can persist after the constraint
                // changed (contract 07 §3.3).
                setErrors((current) =>
                  amountText.trim().length === 0 && current.amount === undefined
                    ? current
                    : { ...current, amount: amountErrorFor(amountText, nextCurrency) },
                );
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

        {schedule === "recurring" ? (
          <Field label="Interval" required hint="How often the payment repeats.">
            <Select
              value={recurrenceInterval}
              onChange={(event) => {
                setRecurrenceInterval(event.target.value as Interval);
              }}
            >
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
        ) : (
          <Field
            label="Interval"
            hint="How often the payment repeats."
            disabledReason="Choose Recurring to set a schedule."
          >
            <Select disabled value="monthly" onChange={() => undefined}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
        )}

        <Field
          label="Counterparty"
          hint="Find or add a contact… — who this payment is for. Optional for hosted links."
          error={errors.counterparty}
          onErrorClear={() => {
            setErrors((current) => ({ ...current, counterparty: undefined }));
          }}
        >
          <Input
            value={counterpartyText}
            placeholder="Find or add a contact…"
            autoComplete="off"
            onChange={(event) => {
              setCounterpartyText(event.target.value);
              setSelectedCounterparty(null);
            }}
            onBlur={() => {
              blurField("counterparty");
            }}
          />
        </Field>
        {selectedCounterparty !== null ? (
          <p className="cc-actions__reason" data-testid="selected-counterparty">
            Paying <strong>{selectedCounterparty.displayName}</strong>{" "}
            <span className="ps-mono">({selectedCounterparty.id})</span> —{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setSelectedCounterparty(null);
                setCounterpartyText("");
              }}
            >
              Change
            </Button>
          </p>
        ) : resolution !== null ? (
          <div className="cc-actions" data-testid="counterparty-chips">
            {resolution.chips.map((chip) => (
              <span key={`${chip.kind}:${chip.value}`} className="cc-actions__item">
                <Button size="sm" variant="secondary" onClick={() => pickChip(chip)}>
                  {chip.label}
                </Button>
              </span>
            ))}
          </div>
        ) : null}

        <Field
          label="Description"
          hint="What this payment is for — appears in lists and on the detail page."
        >
          <Input
            value={description}
            placeholder="Order #1024 — design retainer"
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        <Field
          label="Statement descriptor"
          hint="How the payment appears on the customer's statement. Auto-formatted as you type; required for manual funding."
          error={errors.descriptor}
          onErrorClear={() => {
            setErrors((current) => ({ ...current, descriptor: undefined }));
          }}
        >
          <Input
            value={descriptor}
            placeholder="PAYSWAP*ORDER1024"
            onChange={(event) => {
              setDescriptor(formatDescriptor(event.target.value));
            }}
            onBlur={() => {
              blurField("descriptor");
            }}
          />
        </Field>

        <fieldset className="cc-stack">
          <legend className="ps-label">Funding rail</legend>
          <div role="radiogroup" aria-label="Funding rail" className="cc-stack">
            <label className="cc-actions__item">
              <input
                type="radio"
                name="funding-rail"
                value="manual-entry"
                checked={fundingRail === "manual-entry"}
                onChange={() => {
                  changeFundingRail("manual-entry");
                }}
              />
              <span>
                <strong>Manual entry</strong> — the customer pays by bank transfer or
                wallet and you record it here. Needs a statement descriptor.
              </span>
            </label>
            <div className="cc-stack">
              <label className="cc-actions__item">
                <input
                  type="radio"
                  name="funding-rail"
                  value="on-file"
                  checked={fundingRail === "on-file"}
                  disabled={onFileDisabledReason !== undefined}
                  onChange={() => {
                    changeFundingRail("on-file");
                  }}
                />
                <span>
                  <strong>Method on file</strong> — charge the counterparty&rsquo;s saved
                  method.
                  {methodsForCounterparty.length > 0
                    ? ` (${methodsForCounterparty.map((method) => method.maskedLine).join(", ")})`
                    : ""}
                </span>
              </label>
              {onFileDisabledReason !== undefined ? (
                <p className="cc-actions__reason" data-testid="onfile-disable-reason">
                  {onFileDisabledReason}
                </p>
              ) : null}
            </div>
            <label className="cc-actions__item">
              <input
                type="radio"
                name="funding-rail"
                value="hosted-link"
                checked={fundingRail === "hosted-link"}
                onChange={() => {
                  changeFundingRail("hosted-link");
                }}
              />
              <span>
                <strong>Hosted link</strong> — the customer pays through a PaySwap
                hosted link you share (created pre-filled from this form).
              </span>
            </label>
          </div>
          <p className="cc-actions__reason" data-testid="execution-rail-line">
            {firstRoutable !== undefined ? (
              <>
                Execution rail: <strong>{firstRoutable.providerId}</strong> (connected
                instance <span className="ps-mono">{firstRoutable.instanceId}</span>).
              </>
            ) : (
              <>
                No connected capability can route {currency} yet —{" "}
                <Link href="/app/capabilities" className="font-semibold text-emerald-800 underline">
                  connect one in Capabilities
                </Link>
                , or use a hosted link. The provider catalogue is never an execution
                surface (honest absence, not a failure).
              </>
            )}
          </p>
        </fieldset>

        {failureCard !== null ? (
          <FailureOutcomeCard
            card={failureCard}
            onRetry={() => {
              setFailureCard(null);
            }}
          />
        ) : null}

        <div className="cc-actions">
          <span className="cc-actions__item">
            <ConfirmationButton
              verb={fundingRail === "hosted-link" ? "Create link for" : "Send"}
              amount={minorUnits === null ? "—" : amountText.replace(/,/g, "")}
              asset={currency}
              processing={pending}
              disabled={!isValid}
              onClick={() => {
                void submit("send");
              }}
            />
          </span>
          <span className="cc-actions__item">
            <Button
              variant="secondary"
              disabled={!isValid || pending}
              onClick={() => {
                void submit("send-and-create-another");
              }}
            >
              Send and create another
            </Button>
          </span>
        </div>
        <p className="cc-actions__reason">
          The confirm button restates the amount + asset so the promise travels with
          the action; Processing shows in-button. &ldquo;Send and create another&rdquo;
          keeps the flow open for repeat payments.
        </p>
      </Panel>
    </div>
  );
}

/** The failed-attempt object view — the audit trail never loses the attempt. */
function FailureOutcomeCard({
  card,
  onRetry,
}: {
  readonly card: FailureCard;
  readonly onRetry: () => void;
}) {
  return (
    <div role="alert" className="cc-stack" data-testid="payment-failure-card">
      <p className="cc-actions__reason">
        <StatusChip state="failed" /> <strong>Payment attempt recorded — failed.</strong>{" "}
        {card.registrySentence ?? "The verbatim API answer is below."}
      </p>
      <p className="cc-actions__reason ps-mono">{card.technical}</p>
      <p className="cc-actions__reason">
        The failed attempt stays on the record (contract 04 §4.2) — the audit
        trail never loses it. Recovery affordances:
      </p>
      <div className="cc-actions">
        <span className="cc-actions__item">
          <Button size="sm" variant="primary" onClick={onRetry}>
            Retry (same details, fresh intent)
          </Button>
        </span>
        <span className="cc-actions__item">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Edit &amp; retry
          </Button>
        </span>
        <span className="cc-actions__item">
          <Link href={card.evidenceHref} className="ps-button ps-button--sm ps-button--secondary">
            Investigate the evidence
          </Link>
        </span>
        <span className="cc-actions__item">
          <Link href="/developers" className="ps-button ps-button--sm ps-button--secondary">
            Docs &amp; support
          </Link>
        </span>
      </div>
    </div>
  );
}
