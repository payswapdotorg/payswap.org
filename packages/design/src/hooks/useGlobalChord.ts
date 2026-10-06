"use client";

import { useEffect, useRef } from "react";

/**
 * Chord map: sequence string → handler. A chord is a space- (or +-) separated
 * single-key sequence, e.g. `"c p"` = press `c`, then `p`.
 */
export type ChordMap = Record<string, () => void>;

/** How long a partially-typed chord stays armed before it resets. */
const CHORD_WINDOW_MS = 1500;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function parseChord(chord: string): string[] {
  return chord
    .trim()
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
}

/**
 * Global keyboard-chord listener (contract 01 §6 / 03 §2.9 — CreateMenu's
 * visible chords are active globally). A chord is a SEQUENCE of single keys,
 * e.g. `c p`: pressing `c` arms the chord for a short window; pressing `p`
 * within it fires the handler. Behavior:
 *  - never fires while a modifier (ctrl/meta/alt) is held — those are
 *    shortcuts, not chords;
 *  - never fires while typing in an editable surface (input, textarea,
 *    select, contenteditable);
 *  - `Escape` resets any armed sequence;
 *  - the sequence auto-resets after {@link CHORD_WINDOW_MS} of inactivity;
 *  - handler identity may change between renders; only the latest is invoked
 *    (same posture as `useCommandKey`).
 *
 * The timeout here is keyboard-sequencing UX ONLY — it never stands in for
 * settlement, reconciliation, or any financial timing.
 */
export function useGlobalChord(chords: ChordMap, enabled = true): void {
  const chordsRef = useRef(chords);
  chordsRef.current = chords;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let buffer: string[] = [];
    let timer: number | undefined;

    const reset = (): void => {
      buffer = [];
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        reset();
        return;
      }
      if (isEditableTarget(event.target)) {
        reset();
        return;
      }
      if (event.key === "Escape") {
        reset();
        return;
      }
      if (event.key.length !== 1) {
        return;
      }
      const key = event.key.toLowerCase();

      const sequences = Object.entries(chordsRef.current).map(
        ([chord, handler]) => ({ keys: parseChord(chord), handler }),
      );
      const candidate = [...buffer, key];

      const completed = sequences.find(
        (seq) =>
          seq.keys.length === candidate.length &&
          seq.keys.every((k, i) => k === candidate[i]),
      );
      if (completed) {
        event.preventDefault();
        reset();
        completed.handler();
        return;
      }

      const partial = sequences.some(
        (seq) =>
          seq.keys.length > candidate.length &&
          seq.keys.every((k, i) => k === candidate[i]),
      );
      if (partial) {
        buffer = candidate;
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
        timer = window.setTimeout(reset, CHORD_WINDOW_MS);
        return;
      }

      // Not a continuation — but the key may start a fresh chord ("c" after
      // a dead prefix should still arm "c p").
      const starter = sequences.some(
        (seq) => seq.keys[0] === key && seq.keys.length > 1,
      );
      if (starter) {
        buffer = [key];
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
        timer = window.setTimeout(reset, CHORD_WINDOW_MS);
        return;
      }
      reset();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      reset();
    };
  }, [enabled]);
}
