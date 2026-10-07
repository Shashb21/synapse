/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { fieldName } from "@/components/lock-form";

/** KAN-68: the required-field message names a field by its label, not its hint. */
describe("LockForm field names", () => {
  const control = (html: string) => {
    document.body.innerHTML = html;
    return document.querySelector("input, select, textarea") as HTMLInputElement;
  };

  it("uses the label's words before the control and leaves the hint out", () => {
    const el = control(
      `<label>Title <input name="name" required /><span>A short name for the gap, as it shows in lists.</span></label>`,
    );
    expect(fieldName(el)).toBe("Title");
  });

  it("drops a required marker, and falls back to the whole label or the placeholder", () => {
    expect(fieldName(control(`<label>Domain * <select name="domain"><option>Efficacy</option></select></label>`))).toBe(
      "Domain",
    );
    expect(fieldName(control(`<label><input name="x" /><span>Owner</span></label>`))).toBe("Owner");
    expect(fieldName(control(`<input name="x" placeholder="Plan owner…" />`))).toBe("Plan owner");
  });
});

describe("ActionDialog trigger names", () => {
  it("names a shared button by its dialog title when the title starts with the label", async () => {
    const { triggerName } = await import("@/components/platform/action-dialog");
    expect(triggerName("Set dates", "Set dates for ZEL-301")).toBe("Set dates for ZEL-301");
    expect(triggerName("Set dates", "Set dates")).toBeUndefined();
    expect(triggerName("Edit", "Change the owner")).toBeUndefined();
    expect(triggerName("Add activity")).toBeUndefined();
  });
});
