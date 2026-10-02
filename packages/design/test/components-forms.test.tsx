import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Field } from "../src/components/Field.js";
import { Input } from "../src/components/Input.js";
import { Select } from "../src/components/Select.js";

/* ---------- Field + Input wiring ---------- */

describe("Field", () => {
  it("associates the label with the nested control (htmlFor === control id)", () => {
    render(
      <Field label="Reference">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Reference");
    expect(input).toHaveClass("ps-input");
    const label = document.querySelector("label")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(label).toHaveClass("ps-field__label");
  });

  it("respects a consumer-provided control id", () => {
    render(
      <Field id="ref-input" label="Reference">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText("Reference")).toHaveAttribute("id", "ref-input");
  });

  it("wires hint via aria-describedby on the control", () => {
    render(
      <Field label="Amount" hint="Observed value only — never an authority">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Amount");
    const hint = screen.getByText(/observed value only/i);
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint).toHaveClass("ps-field__hint");
  });

  it("error: renders the message with role=alert, marks the control aria-invalid + described", () => {
    render(
      <Field label="Recipient" error="Enter a valid recipient reference">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Recipient");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent(/valid recipient reference/i);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    expect(input).toHaveClass("ps-input--invalid");
  });

  it("combines hint + error ids in aria-describedby", () => {
    render(
      <Field label="X" hint="hint text" error="error text">
        <Input />
      </Field>,
    );
    const describedBy = screen.getByLabelText("X").getAttribute("aria-describedby") ?? "";
    const hintId = screen.getByText("hint text").id;
    const errorId = screen.getByRole("alert").id;
    expect(describedBy).toContain(hintId);
    expect(describedBy).toContain(errorId);
  });

  it("preserves consumer aria-describedby alongside field wiring", () => {
    render(
      <Field label="X" hint="hint">
        <Input aria-describedby="external-desc" />
      </Field>,
    );
    const describedBy = screen.getByLabelText("X").getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain("external-desc");
    expect(describedBy).toContain(screen.getByText("hint").id);
  });

  it("required: visible marker plus a screen-reader (required) note", () => {
    render(
      <Field label="Workspace" required>
        <Input />
      </Field>,
    );
    expect(screen.getByText("(required)")).toHaveClass("ps-sr-only");
    expect(document.querySelector(".ps-field__required")).toBeInTheDocument();
    // label text still resolves to the control
    expect(screen.getByLabelText(/workspace/i)).toBeInTheDocument();
  });
});

/* ---------- Input ---------- */

describe("Input", () => {
  it("renders a native textbox", () => {
    render(<Input placeholder="Search…" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("type", "text");
  });

  it("types and reports values (controlled)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input value="a" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "b");
    expect(onChange).toHaveBeenCalled();
    expect(input).toHaveValue("a");
  });

  it("disabled input cannot be typed into", async () => {
    const user = userEvent.setup();
    render(<Input disabled placeholder="no" />);
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    await user.type(input, "x");
    expect(input).toHaveValue("");
  });

  it("standalone (no Field): no aria wiring, no crash, invalid prop honored", () => {
    render(<Input invalid aria-label="Standalone" />);
    const input = screen.getByLabelText("Standalone");
    expect(input).toHaveClass("ps-input", "ps-input--invalid");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("explicit invalid=false overrides a field error for the visual marker", () => {
    render(
      <Field label="X" error="boom">
        <Input invalid={false} />
      </Field>,
    );
    const input = screen.getByLabelText("X");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveClass("ps-input--invalid");
  });
});

/* ---------- Select ---------- */

describe("Select", () => {
  it("renders a native combobox with options", () => {
    render(
      <Select aria-label="Rail">
        <option value="a">Option A</option>
        <option value="b">Option B</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Rail" });
    expect(select).toHaveClass("ps-select");
    expect(screen.getByRole("option", { name: "Option A" })).toBeInTheDocument();
  });

  it("changes selection via keyboard-visible user interaction", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select aria-label="Rail" onChange={onChange}>
        <option value="a">Option A</option>
        <option value="b">Option B</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Rail" });
    await user.selectOptions(select, "b");
    expect(select).toHaveValue("b");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("wires label, hint and error exactly like Input inside a Field", () => {
    render(
      <Field label="Direction" hint="one of the supported directions" error="pick one">
        <Select>
          <option value="">—</option>
        </Select>
      </Field>,
    );
    const select = screen.getByLabelText("Direction");
    expect(select).toHaveAttribute("aria-invalid", "true");
    const describedBy = select.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain(screen.getByText(/supported directions/i).id);
    expect(describedBy).toContain(screen.getByRole("alert").id);
    expect(select).toHaveClass("ps-select--invalid");
  });

  it("disabled select blocks interaction", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select aria-label="Frozen" disabled onChange={onChange}>
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Frozen" });
    expect(select).toBeDisabled();
    await user.selectOptions(select, "a");
    expect(onChange).not.toHaveBeenCalled();
  });
});
