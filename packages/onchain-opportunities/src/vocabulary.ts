/**
 * @payswap/onchain-opportunities — the no-guaranteed-returns vocabulary law
 * (Work Order P4-W3-002 hard requirement 2: "Never claim guaranteed returns
 * — the expected-return field is an evidence-backed estimate with explicit
 * uncertainty bounds; language-level adversarial tests scan for guarantee
 * vocabulary ('guaranteed', 'risk-free', 'assured') in opportunity
 * surfaces").
 *
 * Every human-readable surface of every opportunity (title, description,
 * exit-path description and constraints, risk summaries, return-component
 * descriptions, the estimate basis, Lab capability descriptors) is scanned
 * at CONSTRUCTION time: an opportunity whose language claims guaranteed,
 * risk-free or assured outcomes is structurally invalid — it cannot be
 * constructed by any code path in this package. The scan is deterministic,
 * case-insensitive and tolerant of hyphen/space spelling variants, and the
 * pattern list is a frozen, exported contract (the adversarial suite proves
 * each pattern detects its smuggled vocabulary).
 */

import { ValidationError } from "@payswap/protocol";

/**
 * The frozen guarantee-vocabulary pattern list. Each pattern is a regex over
 * ONE human-readable surface; matches are violations of the
 * no-guaranteed-returns law regardless of case or hyphen/space spelling.
 */
export const GUARANTEE_LANGUAGE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bguaranteed?\b/i,
  /\brisk[-\s]?free\b/i,
  /\briskless\b/i,
  /\bassured\b/i,
  /\bno[\s-]?risk\b/i,
  /\bcan(?:not|'t| not)\s+lose\b/i,
  /\bcertain\s+(?:return|yield|profit|gain)/i,
  /\bfoolproof\b/i,
  /\bsure\s+thing\b/i,
  /\bloss[-\s]?proof\b/i,
]);

/** One vocabulary violation (the matched surface snippet and its pattern). */
export interface GuaranteeLanguageViolation {
  /** The pattern source that matched. */
  readonly pattern: string;
  /** The matched text (the offending snippet, verbatim). */
  readonly matched: string;
}

/** The result of scanning one human-readable surface. */
export interface GuaranteeLanguageScan {
  /** True iff the surface contains no guarantee vocabulary. */
  readonly clean: boolean;
  readonly violations: readonly GuaranteeLanguageViolation[];
}

/**
 * Scans one human-readable surface for guarantee vocabulary. Deterministic:
 * the same text always yields the same violations in pattern order.
 */
export function scanForGuaranteeLanguage(text: string): GuaranteeLanguageScan {
  if (typeof text !== "string") {
    throw new ValidationError(
      "the guarantee-language scan requires a string surface (fail closed — never guessed)",
    );
  }
  const violations: GuaranteeLanguageViolation[] = [];
  for (const pattern of GUARANTEE_LANGUAGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      violations.push({ pattern: String(pattern), matched: match[0] });
    }
  }
  return Object.freeze({
    clean: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

/** Raised when a surface carries guarantee vocabulary (fail closed). */
export class GuaranteeLanguageError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "GuaranteeLanguageError";
  }
}

/**
 * Asserts one human-readable surface is free of guarantee vocabulary.
 * Throws `GuaranteeLanguageError` naming the surface and every violating
 * snippet — an opportunity that claims guaranteed returns cannot be
 * constructed at all (the language law is structural, not advisory).
 */
export function assertNoGuaranteeLanguage(surface: string, label: string): void {
  const scan = scanForGuaranteeLanguage(surface);
  if (!scan.clean) {
    const detail = scan.violations
      .map((violation) => `'${violation.matched}' (${violation.pattern})`)
      .join(", ");
    throw new GuaranteeLanguageError(
      `surface '${label}' violates the no-guaranteed-returns law: ${detail} — expected-return is an evidence-backed estimate with uncertainty bounds, never a claim (P4-W3-002 law)`,
    );
  }
}
