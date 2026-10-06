"use client";

import { useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";

export interface SetupGuideStep {
  id: string;
  /** Step sentence ("Secure your wallet"). */
  label: ReactNode;
  /** Completed steps render quiet + checked; the checklist never reorders history. */
  done: boolean;
}

export interface SetupGuideWidgetProps extends HTMLAttributes<HTMLElement> {
  /** The full checklist, in order. */
  steps: SetupGuideStep[];
  /**
   * The single "Next:" step id. Defaults to the first step that is not done;
   * when every step is done the widget says so instead of inventing work.
   */
  nextStepId?: string;
  /** Step activation (navigation to the step's surface). */
  onSelectStep?: (stepId: string) => void;
  /** Widget heading (default "Finish setup"). */
  title?: string;
  /** Start collapsed (default true — one Next step visible, checklist collapsible). */
  defaultCollapsed?: boolean;
}

/**
 * SetupGuideWidget (contract 03 §2.10 / 01 §7): the sidebar-footer card.
 * Exactly ONE "Next: <step>" is named and linked; the full checklist is
 * collapsible and re-openable — never a modal wall. The widget renders the
 * consumer's real step state; it never fabricates progress or completion.
 */
export function SetupGuideWidget({
  steps,
  nextStepId,
  onSelectStep,
  title = "Finish setup",
  defaultCollapsed = true,
  className,
  ...rest
}: SetupGuideWidgetProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const listId = useId("ps-setup-steps");

  const nextStep =
    steps.find((step) => step.id === nextStepId) ??
    steps.find((step) => !step.done);

  return (
    <aside className={cx("ps-setup", className)} {...rest}>
      <p className="ps-label">{title}</p>
      {nextStep ? (
        <p className="ps-setup__next">
          Next:{" "}
          <button
            type="button"
            className="ps-setup__next-link"
            onClick={() => onSelectStep?.(nextStep.id)}
          >
            {nextStep.label}
          </button>
        </p>
      ) : steps.length > 0 ? (
        <p className="ps-setup__complete">All steps complete</p>
      ) : null}
      {steps.length > 0 ? (
        <>
          <button
            type="button"
            className="ps-setup__toggle"
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "Show all steps" : "Hide steps"}
          </button>
          {!collapsed ? (
            <ol id={listId} className="ps-setup__steps">
              {steps.map((step) => (
                <li
                  key={step.id}
                  className={cx(
                    "ps-setup__step",
                    step.done && "ps-setup__step--done",
                  )}
                >
                  <button
                    type="button"
                    className="ps-setup__step-btn"
                    aria-current={
                      nextStep?.id === step.id ? "step" : undefined
                    }
                    onClick={() => onSelectStep?.(step.id)}
                  >
                    <span className="ps-setup__marker" aria-hidden="true">
                      {step.done ? "✓" : "○"}
                    </span>
                    <span className="ps-setup__step-label">{step.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
