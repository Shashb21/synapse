import { describe, expect, it } from "vitest";
import { parseLocalDocument } from "@/lib/ingest/local-parse";

describe("local text parse", () => {
  it("parses utf8 text locally", async () => {
    const document = await parseLocalDocument({
      filename: "memo.txt",
      mime: "text/plain",
      buffer: Buffer.from("Need OS evidence\n\nRegistry gap remains"),
    });
    expect(document.parser).toBe("local");
    expect(document.blocks.map((b) => b.text)).toEqual([
      "Need OS evidence",
      "Registry gap remains",
    ]);
  });
});
