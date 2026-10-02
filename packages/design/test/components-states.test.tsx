import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Skeleton } from "../src/components/Skeleton.js";
import {
  EmptyState,
  ErrorState,
  UnknownState,
  AuthRequiredState,
} from "../src/components/States.js";
import { Toast, ToastViewport } from "../src/components/Toast.js";
import { KeyValue } from "../src/components/KeyValue.js";
import { Button } from "../src/components/Button.js";

/* ---------- Skeleton ---------- */

describe("Skeleton", () => {
  it("announces loading politely and hides the shimmer from AT", () => {
    render(<Skeleton count={2} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading…");
    const lines = document.querySelectorAll(".ps-skeleton");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("renders the requested number of lines", () => {
    render(<Skeleton count={4} announce={null} />);
    expect(document.querySelectorAll(".ps-skeleton")).toHaveLength(4);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

/* ---------- EmptyState ---------- */

describe("EmptyState", () => {
  it("renders a polite empty truth with an optional action", () => {
    render(
      <EmptyState
        title="No evidence yet"
        description="Evidence appears here once records are attached."
        action={<Button>Attach evidence</Button>}
      />,
    );
    expect(screen.getByRole("status")).toHaveClass("ps-state", "ps-state--neutral");
    expect(screen.getByRole("heading", { level: 3, name: "No evidence yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach evidence" })).toBeInTheDocument();
  });
});

/* ---------- ErrorState ---------- */

describe("ErrorState", () => {
  it("announces assertively, styles danger, and retries", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Request failed"
        description="The request could not be completed."
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("ps-state--danger");
    expect(alert).not.toHaveClass("ps-state--unknown");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

/* ---------- UnknownState (the core law) ---------- */

describe("UnknownState", () => {
  it("uses reconciliation language and NEVER failure language or styling", () => {
    render(
      <UnknownState description="The rail has not reported an outcome yet; reconciliation is running." />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveClass("ps-state--unknown");
    expect(status).not.toHaveClass("ps-state--danger");
    expect(status.textContent?.toLowerCase()).not.toContain("fail");
    expect(
      screen.getByRole("heading", { level: 3, name: /outcome not yet known/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/reconciliation is running/i)).toBeInTheDocument();
  });

  it("carries an explicit UNKNOWN pill (never color-alone) distinct from danger", () => {
    render(<UnknownState />);
    const pill = document.querySelector(".ps-pill");
    expect(pill).toHaveAttribute("data-tone", "unknown");
    expect(pill).toHaveClass("ps-pill--unknown");
    expect(pill).not.toHaveClass("ps-pill--failed");
    expect(pill).not.toHaveClass("ps-pill--blocked");
  });

  it("renders a custom action when provided", () => {
    render(
      <UnknownState action={<Button variant="ghost">Check again later</Button>} />,
    );
    expect(screen.getByRole("button", { name: "Check again later" })).toBeInTheDocument();
  });
});

/* ---------- AuthRequiredState ---------- */

describe("AuthRequiredState", () => {
  it("renders the honest gate: title, reason, Retry, doctrine line", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<AuthRequiredState onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("ps-state--neutral");
    expect(screen.getByRole("heading", { level: 3, name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Authentication required")).toBeInTheDocument();
    expect(screen.getByText(/nothing is simulated/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("supports custom title/reason/doctrine", () => {
    render(
      <AuthRequiredState
        title="Overview data unavailable"
        reason="Session expired"
        doctrine="Sign in again to see live state."
      />,
    );
    expect(screen.getByText("Overview data unavailable")).toBeInTheDocument();
    expect(screen.getByText("Session expired")).toBeInTheDocument();
    expect(screen.getByText("Sign in again to see live state.")).toBeInTheDocument();
  });
});

/* ---------- Toast ---------- */

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("info/success are polite status; error is an assertive alert", () => {
    const { unmount } = render(<Toast tone="info">Saved</Toast>);
    expect(screen.getByRole("status")).toHaveClass("ps-toast", "ps-toast--info");
    unmount();
    render(<Toast tone="success">Confirmed</Toast>);
    expect(screen.getByRole("status")).toHaveClass("ps-toast--success");
    unmount();
    render(<Toast tone="error">Could not save</Toast>);
    expect(screen.getByRole("alert")).toHaveClass("ps-toast--error");
  });

  it("auto-dismisses after the duration", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast tone="info" duration={5000} onDismiss={onDismiss}>
        x
      </Toast>,
    );
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("pauses on focus-within and resumes the remaining time on blur", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast tone="success" duration={5000} onDismiss={onDismiss}>
        x
      </Toast>,
    );
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    // pause mid-countdown
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.focus(dismissButton);
    act(() => {
      vi.advanceTimersByTime(6000); // paused — nothing fires
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(dismissButton);
    act(() => {
      vi.advanceTimersByTime(2999); // ~3000ms remained
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("duration=0 never auto-dismisses; the dismiss button works", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast tone="error" duration={0} onDismiss={onDismiss}>
        x
      </Toast>,
    );
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ToastViewport is a single labelled notifications region", () => {
    render(
      <ToastViewport>
        <Toast tone="info">one</Toast>
      </ToastViewport>,
    );
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveClass("ps-toast-viewport");
    expect(region).toContainElement(screen.getByRole("status"));
  });
});

/* ---------- KeyValue ---------- */

describe("KeyValue", () => {
  it("renders metadata rows as a definition list", () => {
    render(
      <KeyValue
        entries={[
          { key: "Version", value: "v0" },
          { key: "Confidence" },
          { key: "Evidence", value: "0 assets" },
        ]}
      />,
    );
    const dl = document.querySelector("dl")!;
    expect(dl).toHaveClass("ps-kv");
    expect(screen.getByText("Version")).toHaveClass("ps-kv__key");
    expect(screen.getByText("v0")).toHaveClass("ps-kv__value");
  });

  it("missing values render an honest em-dash, never a fake number", () => {
    render(<KeyValue entries={[{ key: "Confidence" }]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("mono entries get the mono class (ids/hashes)", () => {
    render(
      <KeyValue
        entries={[{ key: "Id", value: "cmuq7ut610002fl", mono: true }]}
      />,
    );
    expect(screen.getByText("cmuq7ut610002fl").className).toContain("ps-mono");
  });

  it("date entries flow through the pure application-supplied formatter", () => {
    const formatDate = vi.fn((input: string | number) => `about ${input} hours ago`);
    render(
      <KeyValue
        entries={[{ key: "Created", date: "18" }]}
        formatDate={formatDate}
      />,
    );
    expect(formatDate).toHaveBeenCalledWith("18");
    expect(screen.getByText("about 18 hours ago")).toBeInTheDocument();
  });

  it("dense mode adds the compact class", () => {
    const { container } = render(
      <KeyValue dense entries={[{ key: "A", value: "1" }]} />,
    );
    expect(container.querySelector("dl")).toHaveClass("ps-kv--dense");
  });
});
