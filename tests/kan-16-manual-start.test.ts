import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualStartAlongsideUpload } from "@/components/plan-cards";

/**
 * KAN-16: with AI on and nothing ingested, the first screen still offers the
 * manual path (Add gaps / Add tactics) next to Upload.
 */

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("manual start with AI on", () => {
  it("renders Add gaps and Add tactics with a heading that says upload is optional", () => {
    const html = renderToStaticMarkup(createElement(ManualStartAlongsideUpload, { gapCount: 0, tacticCount: 0 }));
    expect(html).toContain("Start by hand");
    expect(html).toContain("Add gaps");
    expect(html).toContain("Add tactics");
    expect(html).toContain("upload first");
    expect(html).toContain("Nothing added yet.");
  });

  it("counts what is already there", () => {
    const html = renderToStaticMarkup(createElement(ManualStartAlongsideUpload, { gapCount: 1, tacticCount: 3 }));
    expect(html).toContain("1 gap and 3 tactics so far.");
  });

  it("the Upload place renders it with AI on, above the ingest panel", () => {
    const page = src("src/app/page.tsx");
    expect(page).toMatch(/<AiOnly[\s\S]*?>\s*<ManualStartAlongsideUpload[\s\S]*?\/>\s*<IngestPanel/);
    expect(page).toContain("Or start by hand");
  });
});
