import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";

export interface PaletteCommand {
  /** Unique id across the whole palette (used for option element ids). */
  id: string;
  label: string;
  /** Suffix chip (the reference's "Go to" group labels, e.g. "Build"). */
  group?: string;
  /** Extra text the fuzzy filter matches against (synonyms, keywords). */
  keywords?: string;
  disabled?: boolean;
  /** Executes the command. The palette closes itself after running. */
  run: () => void;
}

export interface PaletteSection {
  id: string;
  /** Section heading — the reference uses "Actions" (verb-first) + "Go to". */
  label: string;
  commands: PaletteCommand[];
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sections: PaletteSection[];
  /** Accessible name + visible (sr-only) heading. */
  label?: string;
  placeholder?: string;
  /** Honest empty result message. */
  emptyMessage?: string;
  /** Optional slot above the input (e.g. context breadcrumbs). */
  header?: ReactNode;
  id?: string;
  className?: string;
}

/** Case-insensitive subsequence match — "tw" matches "Create Twin". */
export function fuzzyMatch(query: string, text: string): boolean {
  if (query === "") {
    return true;
  }
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1;
    }
  }
  return qi === q.length;
}

/**
 * ⌘K command palette (the reference's unifying search/navigation surface):
 * combobox + listbox + grouped options, fuzzy filter, arrow-key navigation
 * with aria-activedescendant, Enter runs, Escape closes, focus trapped and
 * restored. Mounts only while open. Pure presentation — commands carry their
 * own behavior; nothing here knows about money or providers.
 */
export function CommandPalette({
  open,
  onClose,
  sections,
  label = "Command palette",
  placeholder = "Type a command or search…",
  emptyMessage = "No matching commands.",
  header,
  id,
  className,
}: CommandPaletteProps) {
  const baseId = useId("ps-palette", id);
  const paletteRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  useFocusTrap(paletteRef, open);

  const flat = useMemo(() => {
    const all: Array<{ section: PaletteSection; command: PaletteCommand }> = [];
    for (const section of sections) {
      for (const command of section.commands) {
        const haystack = [command.label, command.group, command.keywords]
          .filter(Boolean)
          .join(" ");
        if (fuzzyMatch(query, haystack)) {
          all.push({ section, command });
        }
      }
    }
    return all;
  }, [sections, query]);

  // Reset the active option when the result set or openness changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const count = flat.length;

  const moveActive = (delta: number): void => {
    if (count === 0) {
      return;
    }
    let index = activeIndex;
    for (let step = 0; step < count; step += 1) {
      index = (index + delta + count) % count;
      if (!flat[index]!.command.disabled) {
        setActiveIndex(index);
        return;
      }
    }
  };

  const runCommand = (entry: { command: PaletteCommand }): void => {
    if (entry.command.disabled) {
      return;
    }
    entry.command.run();
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(count - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (flat[activeIndex]) {
          runCommand(flat[activeIndex]!);
        }
        break;
      case "Escape":
        event.stopPropagation();
        onClose();
        break;
      default:
        break;
    }
  };

  // Group visible commands back under their sections (insertion order).
  const visibleSections: PaletteSection[] = [];
  for (const { section, command } of flat) {
    let visible = visibleSections.find((s) => s.id === section.id);
    if (!visible) {
      visible = { ...section, commands: [] };
      visibleSections.push(visible);
    }
    visible.commands.push(command);
  }

  const listboxId = `${baseId}-listbox`;
  const activeOptionId =
    flat[activeIndex] !== undefined ? `${baseId}-opt-${flat[activeIndex]!.command.id}` : undefined;

  return (
    <div className="ps-dialog-layer">
      <div className="ps-dialog-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={paletteRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        className={cx("ps-palette", className)}
      >
        <h2 id={`${baseId}-title`} className="ps-sr-only">
          {label}
        </h2>
        {header ? <div className="ps-palette__header">{header}</div> : null}
        <div className="ps-palette__input-row">
          <input
            ref={inputRef}
            role="combobox"
            type="text"
            className="ps-palette__input"
            value={query}
            placeholder={placeholder}
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className="ps-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            <span aria-hidden="true">&#215;</span>
          </button>
        </div>
        {count === 0 ? (
          <p className="ps-palette__empty">{emptyMessage}</p>
        ) : (
          <div id={listboxId} role="listbox" aria-label="Suggestions" className="ps-palette__list">
            {visibleSections.map((section, sectionIndex) => (
              <div key={section.id}>
                {sectionIndex > 0 ? <div className="ps-palette__separator" role="presentation" /> : null}
                <div role="group" aria-label={section.label} className="ps-palette__group">
                  <div className="ps-label ps-palette__group-label" aria-hidden="true">
                    {section.label}
                  </div>
                  {section.commands.map((command) => {
                    const index = flat.findIndex((f) => f.command.id === command.id);
                    const active = index === activeIndex;
                    return (
                      <div
                        key={command.id}
                        id={`${baseId}-opt-${command.id}`}
                        role="option"
                        aria-selected={active}
                        aria-disabled={command.disabled || undefined}
                        tabIndex={-1}
                        className={cx(
                          "ps-palette__option",
                          active && "ps-palette__option--active",
                          command.disabled && "ps-palette__option--disabled",
                        )}
                        onMouseEnter={() => {
                          if (!command.disabled) {
                            setActiveIndex(index);
                          }
                        }}
                        onClick={() => runCommand({ command })}
                      >
                        <span className="ps-palette__option-label">{command.label}</span>
                        {command.group ? (
                          <span className="ps-palette__option-group">{command.group}</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
