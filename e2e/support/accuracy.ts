import { expect, type APIRequestContext } from "@playwright/test";

/** BGB pack: local PPTX parse, no LlamaParse / live LLM required. */
export const HAPPY_PATH_PACK_ID = "beone-bgb-58067-prmt5i";

export type SeedFromGoldResult = {
  ok: boolean;
  workspace_id: string;
  org_id: string;
  source_file_id: string;
  gaps: number;
  tactics: number;
  parse_blocks: number;
  pack_id: string;
};

/**
 * Seed a workspace from BeOne reference gold via the accuracy API.
 * Uses SYNAPSE_TEST_STUB_LLM (Playwright webServer) and local PPTX parse only.
 */
export async function seedAccuracyFromGold(
  request: APIRequestContext,
  opts: {
    pack_id?: string;
    workspace_name?: string;
    parse_source?: boolean;
  } = {},
): Promise<SeedFromGoldResult> {
  const pack_id = opts.pack_id ?? HAPPY_PATH_PACK_ID;
  const response = await request.post("/api/accuracy/seed", {
    headers: { "content-type": "application/json" },
    data: {
      pack_id,
      workspace_name: opts.workspace_name ?? `E2E Happy ${Date.now().toString(36)}`,
      parse_source: opts.parse_source ?? true,
    },
  });
  const text = await response.text();
  expect(response.ok(), `seed failed: ${response.status()} ${text}`).toBeTruthy();
  const body = JSON.parse(text) as SeedFromGoldResult;
  expect(body.ok).toBe(true);
  expect(body.workspace_id).toBeTruthy();
  expect(body.gaps).toBeGreaterThan(0);
  expect(body.tactics).toBeGreaterThan(0);
  if (opts.parse_source !== false) {
    expect(body.parse_blocks).toBeGreaterThan(0);
  }
  return body;
}

export function workspaceUrl(path: string, workspaceId: string): string {
  const base = path.startsWith("/") ? path : `/${path}`;
  return `${base}?workspace_id=${encodeURIComponent(workspaceId)}`;
}
