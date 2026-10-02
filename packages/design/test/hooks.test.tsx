import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { useFocusTrap } from "../src/hooks/useFocusTrap.js";
import { useCommandKey } from "../src/hooks/useCommandKey.js";
import { useReducedMotion } from "../src/hooks/useReducedMotion.js";
import { useId } from "../src/hooks/useId.js";

/* ---------- useFocusTrap ---------- */

describe("useFocusTrap", () => {
  function Trap({ active }: { active: boolean }) {
    const [ref] = useState<React.RefObject<HTMLDivElement | null>>({
      current: null,
    });
    useFocusTrap(ref, active);
    return (
      <div ref={ref} tabIndex={-1} data-testid="trap">
        <button>first</button>
        <button>second</button>
        <button>third</button>
      </div>
    );
  }

  it("moves focus into the container when activated", () => {
    render(<Trap active />);
    expect(screen.getByText("first")).toHaveFocus();
  });

  it("wraps Tab from last to first", async () => {
    const user = userEvent.setup();
    render(<Trap active />);
    await user.tab();
    expect(screen.getByText("second")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("third")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("first")).toHaveFocus();
  });

  it("wraps Shift+Tab from first to last", async () => {
    const user = userEvent.setup();
    render(<Trap active />);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByText("third")).toHaveFocus();
  });

  it("keeps a button outside the trap unreachable while active", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>outside</button>
        <Trap active />
      </>,
    );
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    // never lands on the outside button
    expect(screen.getByText("outside")).not.toHaveFocus();
  });

  it("restores focus to the previously focused element on deactivate", async () => {
    const user = userEvent.setup();
    function Host() {
      const [active, setActive] = useState(false);
      return (
        <>
          <button onClick={() => setActive(true)}>open</button>
          <Trap active={active} />
          <button onClick={() => setActive(false)}>close-host</button>
          <button data-testid="closer" onClick={() => setActive(false)}>
            close
          </button>
        </>
      );
    }
    render(<Host />);
    await user.click(screen.getByText("open"));
    expect(screen.getByText("first")).toHaveFocus();
    await user.click(screen.getByTestId("closer"));
    expect(screen.getByText("open")).toHaveFocus();
  });
});

/* ---------- useCommandKey ---------- */

describe("useCommandKey", () => {
  it("fires on meta+K (⌘K)", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    function Host() {
      useCommandKey(handler);
      return <div>host</div>;
    }
    render(<Host />);
    await user.keyboard("{Meta>}k{/Meta}");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fires on ctrl+K", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    function Host() {
      useCommandKey(handler);
      return <div>host</div>;
    }
    render(<Host />);
    await user.keyboard("{Control>}k{/Control}");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not fire on plain k or other modifiers", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    function Host() {
      useCommandKey(handler);
      return <div>host</div>;
    }
    render(<Host />);
    await user.keyboard("k");
    await user.keyboard("{Alt>}k{/Alt}");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    function Host() {
      useCommandKey(handler, false);
      return <div>host</div>;
    }
    render(<Host />);
    await user.keyboard("{Control>}k{/Control}");
    expect(handler).not.toHaveBeenCalled();
  });
});

/* ---------- useReducedMotion ---------- */

describe("useReducedMotion", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  function mockMatchMedia(matches: boolean, listeners: Array<(e: unknown) => void>) {
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      addEventListener: (_: string, cb: (e: unknown) => void) => {
        listeners.push(cb);
      },
      removeEventListener: () => {},
      addListener: (cb: (e: unknown) => void) => {
        listeners.push(cb);
      },
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia;
  }

  it("reports true when the media query matches", () => {
    mockMatchMedia(true, []);
    function Host() {
      const reduced = useReducedMotion();
      return <div data-testid="reduced">{String(reduced)}</div>;
    }
    render(<Host />);
    expect(screen.getByTestId("reduced")).toHaveTextContent("true");
  });

  it("reports false when the media query does not match", () => {
    mockMatchMedia(false, []);
    function Host() {
      const reduced = useReducedMotion();
      return <div data-testid="reduced">{String(reduced)}</div>;
    }
    render(<Host />);
    expect(screen.getByTestId("reduced")).toHaveTextContent("false");
  });

  it("reacts to changes in the media query", () => {
    const listeners: Array<(e: unknown) => void> = [];
    mockMatchMedia(false, listeners);
    let mediaMatches = false;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return mediaMatches;
      },
      media: query,
      addEventListener: (_: string, cb: (e: unknown) => void) => {
        listeners.push(cb);
      },
      removeEventListener: () => {},
      addListener: (cb: (e: unknown) => void) => {
        listeners.push(cb);
      },
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia;

    function Host() {
      const reduced = useReducedMotion();
      return <div data-testid="reduced">{String(reduced)}</div>;
    }
    render(<Host />);
    expect(screen.getByTestId("reduced")).toHaveTextContent("false");
    mediaMatches = true;
    act(() => {
      for (const cb of listeners) {
        cb({ matches: true });
      }
    });
    expect(screen.getByTestId("reduced")).toHaveTextContent("true");
  });
});

/* ---------- useId ---------- */

describe("useId", () => {
  it("prefers a consumer-provided id", () => {
    function Host() {
      const id = useId("ps", "my-id");
      return <div data-testid="host" id={id} />;
    }
    render(<Host />);
    expect(screen.getByTestId("host")).toHaveAttribute("id", "my-id");
  });

  it("generates unique ids per instance", () => {
    function Host() {
      const a = useId("ps");
      const b = useId("ps");
      return (
        <div data-testid="host" data-a={a} data-b={b} />
      );
    }
    render(<Host />);
    const host = screen.getByTestId("host");
    expect(host.getAttribute("data-a")).toMatch(/^ps-/);
    expect(host.getAttribute("data-a")).not.toBe(host.getAttribute("data-b"));
  });
});
