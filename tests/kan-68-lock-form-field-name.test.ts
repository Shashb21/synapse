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
