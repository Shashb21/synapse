import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const guard = vi.hoisted(() => ({ signedIn: true }));

vi.mock("@/modules/auth/api-guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/auth/api-guard")>();
  return {
    ...real,
    requireCustomerContext: async () => {
      if (!guard.signedIn) throw Object.assign(new Error("Sign in to continue."), { status: 401, code: "sign_in_required" });
      return {} as never;
    },
  };
});

import { GET } from "@/app/api/demo/files/route";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";

/** KAN-139: the demo's input documents download as one ZIP. */
describe("GET /api/demo/files", () => {
  it("returns a ZIP of every demo-pack file, byte for byte", async () => {
    guard.signedIn = true;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="velmara-demo-files.zip"');
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(DEMO_PACK.map((f) => f.filename).sort());
    for (const file of DEMO_PACK) expect(await zip.file(file.filename)!.async("string")).toBe(file.text);
  });

  it("is refused when signed out", async () => {
    guard.signedIn = false;
    const res = await GET();
    expect(res.status).not.toBe(200);
    expect(res.headers.get("content-type")).not.toBe("application/zip");
  });
});
