"use client";

/**
 * UX-005 — the universal SEARCH/COMMAND surface (contract 06, v1).
 *
 * ONE surface does BOTH (§1): the topbar search field finds resources and
 * executes intentions — "pay alice 100 usdc" and "the failed payment from
 * Tuesday" land in the same box. This component is the client half; every
 * RESULT is derived by the pure engine (`search-derivation.ts`) from
 * injected data, so nothing here fabricates a row:
 *
 * - the FIELD (§2): a topbar input with the visible "/" kbd hint, the
 *   rotating placeholder across both modes, "/" focusing it from anywhere
 *   (suppressed while a text input is focused — the CreateMenu chord
 *   discipline) and Esc restoring the prior focus (never a dead key);
 * - the RESULTS (§3): Commands (the six verbs parsed through the UX-002
 *   grammar — pre-filled, chips for ambiguity) · Resources (payments rows
 *   through the honest payments-plane read; honest states for the rest) ·
 *   Navigation (title + synonyms), plus the zero-state (§5: recents +
 *   "New payment" quick actions) and the no-result intent-turn (§5: the
 *   miss becomes a create-payment intent);
 * - the KEYBOARD MODEL (§5, consumed from `SEARCH_COMMAND_KEYBOARD_MODEL`):
 *   ↑/↓ within a group, ⇥ across groups (through the parsed command's
 *   disambiguation chips when it carries them), ⏎ executes the top hit —
 *   listbox semantics with aria-activedescendant and polite announcements.
 *
 * HONESTY (contract 07 + the work order): the resources read goes through
 * the server action, which reads the operator's OWN account through the
 * payments plane and keeps every non-ok outcome's honest status; recents
 * persist LOCALLY (localStorage, never the server); and NO command executes
 * anything here — every verb routes to its workflow's confirmation phase
 * PRE-FILLED (pre-fill only; the amount is exact minor units end to end).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { StatusChip } from "@payswap/design";
import type { ContactDirectoryEntry, DisambiguationChip, ProductRole } from "@payswap/ux";
import { SEARCH_COMMAND_KEYBOARD_MODEL } from "@payswap/ux";

import { queryPaymentsResources } from "./search-data";
import {
  deriveSearchResults,
  type CommandChoices,
  type SearchItem,
} from "./search-derivation";
import { loadRecents, recordRecent } from "./search-recents";
import type { SearchRecentEntry, SearchResourcesResult } from "./search-types";

/**
 * Placeholder examples rotating across both modes (contract 06 §2): the
 * first is the contract's own example; rotation advances once per OPEN
 * (deterministic — never random).
 */
const PLACEHOLDER_EXAMPLES: readonly string[] = Object.freeze([
  "Search payments, customers… or type a command like 'pay 25 USDC'",
  "Find a payment, a page… or 'request 50 EUR'",
  "Search your account… or 'convert 2 ETH to USDC'",
  "Find anything… or 'link 10 GHS'",
  "Search… or 'withdraw 100 USDC'",
]);

/**
 * The debounced delay before the honest resources read fires. UX timing
 * ONLY — it never stands in for settlement, reconciliation or any financial
 * timing (the runbook's law).
 */
const RESOURCES_DEBOUNCE_MS = 220;

export interface UniversalSearchProps {
  /** The role driving the navigation projection (rows are never re-axed). */
  readonly role: ProductRole | null;
  /**
   * The operator's contact directory (injected authority data; the honest
   * default is empty — no customer plane ships yet, so counterparty tokens
   * resolve to the inline "Add contact" chip).
   */
  readonly directory?: readonly ContactDirectoryEntry[];
  /**
   * The honest resources read (injectable for tests; the default is the
   * "use server" action that walks the payments plane for the operator's
   * own account).
   */
  readonly queryResources?: (query: string) => Promise<SearchResourcesResult>;
  /** The local recents storage (injectable for tests; default = browser). */
  readonly recentsStore?: Storage | null;
}

/** The same editable-target discipline the CreateMenu chords obey. */
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

export function UniversalSearch({
  role,
  directory = [],
  queryResources = queryPaymentsResources,
  recentsStore,
}: UniversalSearchProps) {
  const router = useRouter();
  const surfaceId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipStripRef = useRef<HTMLDivElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const requestIdRef = useRef(0);
  // The injected recents store, synced in an effect (NEVER written during
  // render — the react-compiler law); events read the fresh value from here.
  const storeRef = useRef<Storage | null>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [resources, setResources] = useState<SearchResourcesResult | null>(null);
  const [choices, setChoices] = useState<CommandChoices>({});
  const [recents, setRecents] = useState<readonly SearchRecentEntry[]>([]);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [placeholderTick, setPlaceholderTick] = useState(0);

  // The derived result model (pure; the component owns only state + DOM).
  const results = useMemo(
    () =>
      deriveSearchResults({
        query,
        role,
        directory,
        choices,
        resources,
        recents,
      }),
    [query, role, directory, choices, resources, recents],
  );

  const flat = useMemo(
    () =>
      results.groups.flatMap((group) =>
        group.items.map((item) => ({ group, item })),
      ),
    [results],
  );

  // The active index is CLAMPED AT RENDER (never re-synced from an effect —
  // the react-compiler law): a shrunk result set keeps the nearest valid
  // selection without a cascading render.
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const activeEntry = flat[activeIndex] ?? null;

  // The selection announcement is DERIVED (never effect-synced); the state
  // holds only EVENT messages (opened/chose/no-destination), reset on open.
  const selectionAnnouncement =
    activeEntry !== null ? `${activeEntry.group.label}: ${spokenLabel(activeEntry.item)}` : null;
  const announcementText = announcement ?? selectionAnnouncement;

  // The injected store sync (effect, not render).
  useEffect(() => {
    storeRef.current = recentsStore ?? null;
  }, [recentsStore]);

  // Recents load once, client-side only (localStorage, never the server).
  useEffect(() => {
    setRecents(loadRecents(storeRef.current));
  }, []);

  // Track the last focus OUTSIDE the surface — Esc restores it (contract 06
  // §2: "Esc restores the prior focus", never a dead key).
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (rootRef.current?.contains(target)) {
        return;
      }
      priorFocusRef.current = target;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  // "/" focuses the search from anywhere (contract 06 §2), suppressed while
  // a text input is focused — the same discipline as the CreateMenu chords.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.key !== SEARCH_COMMAND_KEYBOARD_MODEL.focusFromAnywhere) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Close on any pointer press outside the surface.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // The debounced honest resources read (only while a query is typed). A
  // later query invalidates earlier answers; a rejected read is the honest
  // network-error state — never fabricated rows.
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length === 0) {
      return;
    }
    const requestId = (requestIdRef.current += 1);
    const timer = window.setTimeout(() => {
      queryResources(trimmed)
        .then((result) => {
          if (requestIdRef.current === requestId) {
            setResources(result);
          }
        })
        .catch(() => {
          if (requestIdRef.current === requestId) {
            setResources({
              status: "network-error",
              message: "The payments search read did not complete.",
            });
          }
        });
    }, RESOURCES_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, open, queryResources]);

  /** Open the surface (rotating the placeholder once per open). */
  const openSurface = useCallback((): void => {
    setOpen(true);
    setPlaceholderTick((tick) => tick + 1);
    // A fresh open clears any event message — the derived selection
    // announcement takes over again (never a stale "Opened …").
    setAnnouncement(null);
  }, []);

  /** Close; restore the prior focus when asked (Esc, execution). */
  const closeSurface = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) {
      const prior = priorFocusRef.current;
      if (prior !== null && document.contains(prior)) {
        prior.focus();
        return;
      }
      inputRef.current?.blur();
    }
  }, []);

  /** Execute one result: record the recent, route, close. Pre-fill only. */
  const execute = useCallback(
    (item: SearchItem): void => {
      const href = itemHref(item);
      if (href === null) {
        // The honest state with no destination (e.g. preview-no-session):
        // never a dead end — the state line itself teaches the next step.
        setAnnouncement(`${spokenLabel(item)} — this state has no destination yet.`);
        return;
      }
      const entry = recentEntryFor(item);
      if (entry !== null) {
        setRecents(recordRecent(entry, Date.now(), storeRef.current));
      }
      setAnnouncement(`Opened ${spokenLabel(item)}`);
      closeSurface(true);
      router.push(href);
    },
    [closeSurface, router],
  );

  /** Pick a disambiguation chip (a choice, never a guess). */
  const pickChip = useCallback((chip: DisambiguationChip): void => {
    setChoices((current) => {
      if (chip.kind === "counterparty-candidate" || chip.kind === "add-contact") {
        return { ...current, counterpartyName: chip.kind === "add-contact" ? chip.value : chip.label };
      }
      return { ...current, asset: chip.value };
    });
    setAnnouncement(`Chose ${chip.label}`);
  }, []);

  /** Move ↑/↓ WITHIN the active group (wrapping inside the group). */
  const moveWithinGroup = useCallback(
    (delta: number): void => {
      if (flat.length === 0) {
        return;
      }
      const current = flat[activeIndex] ?? flat[0]!;
      let start = activeIndex;
      while (start > 0 && flat[start - 1]!.group.id === current.group.id) {
        start -= 1;
      }
      let end = activeIndex;
      while (end < flat.length - 1 && flat[end + 1]!.group.id === current.group.id) {
        end += 1;
      }
      const span = end - start + 1;
      const next = start + (((activeIndex - start + delta) % span) + span) % span;
      setActive(next);
    },
    [activeIndex, flat],
  );

  /** Move ⇥ ACROSS groups (to the next/previous group's first item). */
  const moveAcrossGroups = useCallback(
    (delta: number): void => {
      if (flat.length === 0) {
        return;
      }
      const current = flat[activeIndex] ?? flat[0]!;
      const groupIds: string[] = [];
      for (const entry of flat) {
        if (groupIds[groupIds.length - 1] !== entry.group.id) {
          groupIds.push(entry.group.id);
        }
      }
      const currentIndex = Math.max(0, groupIds.indexOf(current.group.id));
      const nextGroupId = groupIds[(currentIndex + delta + groupIds.length) % groupIds.length]!;
      const nextIndex = flat.findIndex((entry) => entry.group.id === nextGroupId);
      if (nextIndex >= 0) {
        setActive(nextIndex);
      }
    },
    [activeIndex, flat],
  );

  const focusChip = useCallback((index: number): boolean => {
    const chips = chipStripRef.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-chip-index]",
    );
    const target = chips?.[index];
    if (target === undefined) {
      return false;
    }
    target.focus();
    setAnnouncement(`Disambiguation: ${target.getAttribute("data-chip-label") ?? ""}`);
    return true;
  }, []);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveWithinGroup(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveWithinGroup(-1);
        break;
      case "Tab": {
        event.preventDefault();
        // ⇥ across groups — but the parsed command's disambiguation chips
        // come first (they are part of resolving the typed intent), so the
        // keyboard path resolves "which Alice?" without a pointer.
        if (!event.shiftKey && focusChip(0)) {
          break;
        }
        moveAcrossGroups(event.shiftKey ? -1 : 1);
        break;
      }
      case "Home":
        event.preventDefault();
        if (flat.length > 0) {
          setActive(0);
        }
        break;
      case "End":
        event.preventDefault();
        if (flat.length > 0) {
          setActive(flat.length - 1);
        }
        break;
      case "Enter":
        event.preventDefault();
        if (activeEntry !== null) {
          execute(activeEntry.item);
        }
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeSurface(true);
        break;
      default:
        break;
    }
  };

  const onChipKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
    chip: DisambiguationChip,
  ): void => {
    const chips = chipStripRef.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-chip-index]",
    );
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        pickChip(chip);
        inputRef.current?.focus();
        break;
      case "Tab": {
        event.preventDefault();
        if (event.shiftKey) {
          if (index > 0 && focusChip(index - 1)) {
            break;
          }
          inputRef.current?.focus();
          break;
        }
        if (chips !== undefined && index + 1 < chips.length && focusChip(index + 1)) {
          break;
        }
        inputRef.current?.focus();
        moveAcrossGroups(1);
        break;
      }
      case "Escape":
        event.preventDefault();
        inputRef.current?.focus();
        break;
      case "ArrowUp":
      case "ArrowDown":
        event.preventDefault();
        inputRef.current?.focus();
        break;
      default:
        break;
    }
  };

  const onQueryChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
    // A changed query invalidates the previous parse: the read goes back to
    // pending (the old rows must never render against the new text) and any
    // picked chip resets (the choice belonged to the previous parse).
    setResources(null);
    setChoices({});
    setActive(0);
  };

  const listboxId = `${surfaceId}-listbox`;
  const optionId = (item: SearchItem): string => `${surfaceId}-opt-${item.id}`;
  const activeOptionId =
    open && activeEntry !== null ? optionId(activeEntry.item) : undefined;

  return (
    <div
      ref={rootRef}
      data-testid="search-root"
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        flex: "0 1 22rem",
        minWidth: "10rem",
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next === null || !rootRef.current?.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--ps-space-2)",
          width: "100%",
          padding: "var(--ps-space-2) var(--ps-space-3)",
          border: "1px solid var(--ps-border)",
          borderRadius: "var(--ps-radius-md)",
          backgroundColor: "var(--ps-surface-sunken)",
          minHeight: "36px",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search or type a command"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          data-testid="search-input"
          value={query}
          placeholder={
            PLACEHOLDER_EXAMPLES[placeholderTick % PLACEHOLDER_EXAMPLES.length]
          }
          autoComplete="off"
          spellCheck={false}
          onChange={onQueryChange}
          onFocus={() => {
            if (!open) {
              openSurface();
            }
          }}
          onKeyDown={onInputKeyDown}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            border: "none",
            background: "transparent",
            font: "inherit",
            fontSize: "var(--ps-text-sm)",
            color: "var(--ps-fg)",
            outline: "none",
          }}
        />
        <kbd className="ps-topbar__kbd" aria-hidden="true" data-testid="search-kbd-hint">
          /
        </kbd>
      </div>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Search and command results"
          aria-busy={results.resourcesPending || undefined}
          data-testid="search-menu"
          className="ps-palette__list"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: "min(34rem, calc(100vw - 2rem))",
            maxHeight: "60vh",
            overflowY: "auto",
            backgroundColor: "var(--ps-surface)",
            border: "1px solid var(--ps-border)",
            borderRadius: "var(--ps-radius-md)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
            zIndex: 300,
          }}
        >
          {results.groups.map((group, groupIndex) => (
            <div key={group.id}>
              {groupIndex > 0 ? (
                <div className="ps-palette__separator" role="presentation" />
              ) : null}
              <div
                role="group"
                aria-label={group.label}
                data-testid={`search.group.${group.id}`}
                className="ps-palette__group"
              >
                <div className="ps-label ps-palette__group-label" aria-hidden="true">
                  {group.label}
                </div>
                {group.items.length === 0 && results.resourcesPending ? (
                  <div
                    role="presentation"
                    data-testid="search.pending"
                    style={{
                      padding: "var(--ps-space-2) var(--ps-space-3)",
                      fontSize: "var(--ps-text-sm)",
                      color: "var(--ps-fg-muted)",
                    }}
                  >
                    Searching your payments…
                  </div>
                ) : null}
                {group.items.map((item) => {
                  const isActive = activeEntry?.item === item;
                  const disabled = itemHref(item) === null;
                  return (
                    <div
                      key={item.id}
                      id={optionId(item)}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={disabled || undefined}
                      tabIndex={-1}
                      data-testid={item.testId}
                      className={
                        "ps-palette__option" +
                        (isActive ? " ps-palette__option--active" : "") +
                        (disabled ? " ps-palette__option--disabled" : "")
                      }
                      style={{ flexDirection: "column", alignItems: "stretch" }}
                      onClick={() => {
                        execute(item);
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "var(--ps-space-3)",
                        }}
                      >
                        <span className="ps-palette__option-label">
                          {primaryLabel(item)}
                        </span>
                        <span className="ps-palette__option-group">{trailingChip(item)}</span>
                      </div>
                      {secondaryLine(item) !== null ? (
                        <div
                          data-testid={`${item.testId}.detail`}
                          style={{
                            fontSize: "var(--ps-text-2xs)",
                            color: "var(--ps-fg-muted)",
                          }}
                        >
                          {secondaryLine(item)}
                        </div>
                      ) : null}
                      {isActive && item.kind === "command" && item.chips.length > 0 ? (
                        <div
                          ref={chipStripRef}
                          role="group"
                          aria-label="Disambiguation"
                          data-testid="search.disambiguation"
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "var(--ps-space-1)",
                            marginTop: "var(--ps-space-1)",
                          }}
                        >
                          {item.chips.map((chip, chipIndex) => (
                            <button
                              key={`${chip.kind}-${chip.value}-${chipIndex}`}
                              type="button"
                              data-chip-index={chipIndex}
                              data-chip-label={chip.label}
                              data-testid={`search.chip.${chipIndex}`}
                              className="ps-chip"
                              style={{
                                cursor: "pointer",
                                fontSize: "var(--ps-text-2xs)",
                                border: "1px solid var(--ps-border-strong)",
                                backgroundColor: "var(--ps-surface)",
                                borderRadius: "var(--ps-radius-sm)",
                                padding: "0 var(--ps-space-2)",
                                minHeight: "24px",
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                pickChip(chip);
                              }}
                              onKeyDown={(event) => {
                                onChipKeyDown(event, chipIndex, chip);
                              }}
                            >
                              {chip.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Screen-reader announcements (contract 06 §5). */}
      <p
        className="ps-sr-only"
        role="status"
        aria-live="polite"
        data-testid="search-announce"
      >
        {announcementText}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure per-item render helpers (labels stay derived, never invented)
// ---------------------------------------------------------------------------

function primaryLabel(item: SearchItem): ReactNode {
  switch (item.kind) {
    case "payment":
      return (
        <>
          <StatusChip state={item.row.state} detail={item.row.stateDetail} />
          <span style={{ marginLeft: "var(--ps-space-2)" }}>
            {item.row.amount} — {item.row.counterparty}
          </span>
        </>
      );
    default:
      return item.label;
  }
}

function trailingChip(item: SearchItem): string {
  switch (item.kind) {
    case "command":
      return "Command";
    case "payment":
      return "Payment";
    case "resource-state":
      return "Honest state";
    case "navigation":
      return item.group;
    case "quick":
    case "recent":
    case "suggestion":
      return item.kind === "recent" ? "Recent" : item.kind === "suggestion" ? "Suggestion" : "Go";
  }
}

function secondaryLine(item: SearchItem): string | null {
  switch (item.kind) {
    case "command":
      return item.prefillLine ?? item.detail;
    case "payment": {
      const parts = [item.row.maskedId, item.row.createdAt];
      if (item.row.methodLine !== undefined) {
        parts.push(item.row.methodLine);
      }
      if (item.row.description !== undefined) {
        parts.push(item.row.description);
      }
      return parts.join(" · ");
    }
    case "resource-state":
      return item.stateLine;
    case "navigation":
      return item.href;
    case "quick":
    case "recent":
    case "suggestion":
      return item.detail ?? item.href;
  }
}

function spokenLabel(item: SearchItem): string {
  switch (item.kind) {
    case "payment":
      return `Payment ${item.row.amount} ${item.row.counterparty} ${item.row.state}`;
    default:
      return item.label;
  }
}

function itemHref(item: SearchItem): string | null {
  switch (item.kind) {
    case "command":
    case "payment":
    case "navigation":
    case "quick":
    case "recent":
    case "suggestion":
      return item.href;
    case "resource-state":
      return item.href;
  }
}

function recentEntryFor(item: SearchItem): Omit<SearchRecentEntry, "at"> | null {
  switch (item.kind) {
    case "command":
      return {
        id: item.id,
        label: item.label,
        detail: item.prefillLine ?? item.detail,
        href: item.href,
      };
    case "payment":
      return {
        id: item.id,
        label: `${item.row.amount} — ${item.row.counterparty}`,
        detail: item.row.maskedId,
        href: item.href,
      };
    case "resource-state":
      return item.href === null
        ? null
        : { id: item.id, label: item.label, href: item.href };
    case "navigation":
      return { id: item.id, label: item.label, detail: item.group, href: item.href };
    case "quick":
    case "recent":
    case "suggestion":
      return {
        id: item.id,
        label: item.label,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        href: item.href,
      };
  }
}
