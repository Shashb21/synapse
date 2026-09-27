import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Every <LockForm …> opening tag in src, with the file it sits in. */
function lockFormTags(): { file: string; tag: string }[] {
  const out: { file: string; tag: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".tsx") && !full.endsWith("lock-form.tsx")) {
        const src = readFileSync(full, "utf8");
        for (const match of src.matchAll(/<LockForm\b[\s\S]*?(?<!=)>/g)) {
          out.push({ file: path.relative(process.cwd(), full), tag: match[0] });
        }
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  return out;
}

const actionOf = (tag: string) => /action="([^"]+)"/.exec(tag)?.[1] ?? "";

describe("LockForm note field", () => {
  it("no longer shows the Addressed-override note in every dialog", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/lock-form.tsx"), "utf8");
    expect(src).not.toContain("required to override Addressed");
    // The note textarea renders only when a caller passes `note`.
    expect(src).toMatch(/\{note \? \(/);
    // The request still carries a note, empty when the dialog has none.
    expect(src).toContain('note: String(formData.get("note") || "")');
  });

  it("only actions that store a note pass one", () => {
    const withNote = new Set(
      lockFormTags()
        .filter(({ tag }) => /\bnote=\{\{/.test(tag))
        .map(({ tag }) => actionOf(tag)),
    );
    expect([...withNote].sort()).toEqual(
      ["confirm_coverage_review", "lock_dimension", "lock_need", "lock_overall", "lock_priority", "validate_gap"].sort(),
    );
    for (const { file, tag } of lockFormTags()) {
      const action = actionOf(tag);
      if (["create_tactic", "create_gap", "assign_tactic", "record_missed_tactic", "unlock_tactics"].includes(action)) {
        expect(tag, `${file} ${action}`).not.toMatch(/\bnote=\{\{/);
      }
    }
  });

  it("the coverage locks the API rejects without a rationale mark the note required", () => {
    const tags = lockFormTags().filter(({ tag }) => ["lock_dimension", "lock_overall"].includes(actionOf(tag)));
    expect(tags.length).toBe(2);
    for (const { tag } of tags) expect(tag).toContain("required: true");
  });
});
