import { describe, expect, it } from "vitest";
import { blocksFromLlamaResult } from "@/lib/ingest/llama-blocks";
import { extractJsonObject } from "@/lib/llm/anthropic";

describe("REQ-ING-004 LlamaCloud chart blocks", () => {
  it("turns markdown pages and chart items into source blocks without dropping numbers", () => {
    const blocks = blocksFromLlamaResult({
      markdown_full:
        "# Access\n\nShare erodes to 11% if two national accounts stay non-formulary.\n\n---\n\n# Chart\n\nPeak share by year",
      items: {
        pages: [
          {
            page: 2,
            items: [
              {
                type: "chart",
                heading: "Peak share",
                rows: [
                  ["Year", "Unrestricted", "Restricted"],
                  ["Y1", "6%", "4%"],
                  ["Y5", "18%", "11%"],
                ],
              },
            ],
          },
        ],
      },
    });
    expect(blocks.some((b) => b.kind === "chart")).toBe(true);
    expect(blocks.some((b) => /18%/.test(b.text))).toBe(true);
    expect(blocks.some((b) => b.location.ref.includes("Slide"))).toBe(true);
  });
});

describe("REQ-EXT Claude JSON", () => {
  it("parses fenced JSON from a Claude message", () => {
    const obj = extractJsonObject(
      'Here you go:\n```json\n{"insights":[{"statement":"Horizon signaled an outcomes-based contract.","evidence_quote":"Horizon signaled openness"}]}\n```',
    ) as { insights: { statement: string }[] };
    expect(obj.insights[0]?.statement).toMatch(/Horizon/);
  });
});
