/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import mermaid from "mermaid";
import { splitSpec } from "@/app/sdlc/spec-body";

const DOCS = [
  "docs/sdlc/09-flow-high-level.md",
  "docs/sdlc/10-flow-technical.md",
];

describe("REQ-UX-008 mermaid flow diagrams", () => {
  it("parses every spec mermaid block on mermaid 12", async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
    for (const rel of DOCS) {
      const markdown = readFileSync(path.join(process.cwd(), rel), "utf8");
      const charts = splitSpec(markdown).filter((p) => p.kind === "mermaid");
      expect(charts.length, rel).toBeGreaterThan(0);
      for (const [i, part] of charts.entries()) {
        await expect(
          mermaid.parse(part.text),
          `${rel} diagram ${i}`,
        ).resolves.toBeTruthy();
      }
    }
  });
});
