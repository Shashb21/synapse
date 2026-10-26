/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SourceUploadForm } from "@/components/accuracy/source-upload-form";
import { accuracyUploadFormatError } from "@/accuracy/modules/parse/upload-formats";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Accuracy source upload form", () => {
  it("offers exactly the supported extensions and explains legacy PPT conversion", () => {
    act(() => root.render(createElement(SourceUploadForm, { workspaceId: "workspace" })));

    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.accept.split(",")).toEqual([
      ".pptx", ".docx", ".xlsx", ".xls", ".pdf", ".txt", ".md",
    ]);
    expect(host.textContent).toContain("PPTX, DOCX, XLSX, XLS, PDF, TXT, or Markdown (.md)");
    expect(host.textContent).toContain(
      "Legacy .ppt files are not supported. Save the file as .pptx and upload it again.",
    );
  });

  it("lists every supported format when submitted without a file", async () => {
    act(() => root.render(createElement(SourceUploadForm, { workspaceId: "workspace" })));

    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(host.textContent).toContain(
      "Choose a PPTX, DOCX, XLSX, XLS, PDF, TXT, or Markdown (.md) file.",
    );
  });
});

describe("Accuracy upload format eligibility", () => {
  it.each([
    "source.pptx", "source.docx", "source.xlsx", "source.xls", "source.pdf", "source.txt", "source.md",
    "source.PPTX", "source.DOCX", "source.XLSX", "source.XLS", "source.PDF", "source.TXT", "source.MD",
  ])("allows %s", (filename) => {
    expect(accuracyUploadFormatError(filename)).toBeNull();
  });

  it.each(["deck.ppt", "deck.PPT"])("explains how to convert %s", (filename) => {
    expect(accuracyUploadFormatError(filename)).toBe(
      "Legacy .ppt files are not supported. Save the file as .pptx and upload it again.",
    );
  });

  it.each(["notes.doc", "deck.key", "program.exe", "README", "", "source.pptx.exe"])(
    "lists the supported extensions for unsupported filename %s",
    (filename) => {
      expect(accuracyUploadFormatError(filename)).toContain(
        ".pptx, .docx, .xlsx, .xls, .pdf, .txt, .md",
      );
    },
  );
});
