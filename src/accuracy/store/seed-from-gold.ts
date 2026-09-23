import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrganization, createWorkspace, getWorkspace } from "./tenant";
import { insertClaim } from "./claim-store";
import { insertSourceFile } from "./source-store";
import { persistParseBlocks, blocksFromParsedDocument } from "./parse-store";
import { loadReferenceGold, getReferencePack, referencePackDir } from "../eval/reference-gold";
import { parseLocalDocument, mimeForFilename } from "@/lib/ingest/local-parse";

export type SeedFromGoldResult = {
  org_id: string;
  workspace_id: string;
  source_file_id: string;
  gaps: number;
  tactics: number;
  parse_blocks: number;
  pack_id: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** Create a workspace and load gold gap/tactic statements (+ optional local PPTX parse). */
export async function seedWorkspaceFromGold(args: {
  packId: string;
  workspaceName?: string;
  parseSource?: boolean;
}): Promise<SeedFromGoldResult> {
  const pack = getReferencePack(args.packId);
  if (!pack) throw new Error(`Unknown reference pack: ${args.packId}`);
  const gold = loadReferenceGold(args.packId);
  const sourceRel = pack.source_file?.replace(/^sources\//, "") ?? pack.source_file;

  const org_id = await createOrganization(`${pack.asset} (eval)`);
  const workspace_id = await createWorkspace({
    org_id,
    name: args.workspaceName ?? `${pack.asset} IEGP`,
    slug: `${slugify(args.packId)}-${Date.now().toString(36)}`,
  });

  const sourcePath = join(referencePackDir(args.packId), pack.source_file);
  let source_file_id = "";
  let parse_blocks = 0;

  try {
    const buffer = readFileSync(sourcePath);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    const mime = mimeForFilename(sourceRel || pack.source_file);
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: sourceRel || pack.source_file,
      mime,
      checksum,
      doc_role: "medical",
      reference_pack_id: args.packId,
    });
    source_file_id = source.id;

    if (args.parseSource !== false) {
      const document = await parseLocalDocument({
        filename: sourceRel || pack.source_file,
        buffer,
        mime,
      });
      const blocks = blocksFromParsedDocument({
        workspace_id,
        source_file_id,
        blocks: document.blocks.map((b, index) => ({
          ...b,
          id: `${source_file_id}-B${String(index + 1).padStart(3, "0")}`,
        })),
      });
      await persistParseBlocks({
        workspace_id,
        source_file_id,
        parser: "local_structured",
        blocks,
      });
      parse_blocks = blocks.length;
    }
  } catch (error) {
    if (!source_file_id) {
      const source = await insertSourceFile({
        workspace_id,
        org_id,
        filename: sourceRel || pack.source_file,
        mime: mimeForFilename(sourceRel || pack.source_file),
        checksum: `missing-${args.packId}`,
        doc_role: "medical",
        reference_pack_id: args.packId,
      });
      source_file_id = source.id;
    }
    if (process.env.NODE_ENV !== "production") {
      console.warn("seed-from-gold: source parse skipped", error);
    }
  }

  let gaps = 0;
  for (const row of gold.gaps.gaps) {
    if (!row || typeof row !== "object") continue;
    const g = row as {
      id?: string;
      statement?: string;
      priority?: string;
      priority_band?: string;
      chapter?: string;
      slide_cue?: string;
    };
    if (!g.statement?.trim()) continue;
    await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: g.statement.trim(),
      status: "draft",
      source_file_id,
      metadata: {
        source_badge: pack.source_file,
        external_id: g.id ?? null,
        priority: g.priority ?? g.priority_band ?? null,
        chapter: g.chapter ?? null,
        slide_cue: g.slide_cue ?? null,
        reference_pack_id: args.packId,
      },
    });
    gaps += 1;
  }

  let tactics = 0;
  for (const row of gold.tactics.tactics) {
    if (!row || typeof row !== "object") continue;
    const tac = row as {
      number?: number;
      identifier?: string;
      title?: string;
      lead_function?: string;
      gap_ids?: string[];
      origin?: string;
      slide_cue?: string;
      tactic_type?: string;
    };
    const statement = tac.title?.trim();
    if (!statement) continue;
    const external =
      tac.identifier ?? (typeof tac.number === "number" ? String(tac.number) : null);
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement,
      status: "draft",
      source_file_id,
      metadata: {
        source_badge: pack.source_file,
        origin: tac.origin ?? "inventory",
        external_id: external,
        number: tac.number ?? null,
        lead_function: tac.lead_function ?? null,
        gap_ids: tac.gap_ids ?? [],
        slide_cue: tac.slide_cue ?? null,
        tactic_type: tac.tactic_type ?? null,
        reference_pack_id: args.packId,
        start: null,
        end: null,
      },
    });
    tactics += 1;
  }

  const ws = await getWorkspace(workspace_id);
  if (!ws) throw new Error("Seed failed: workspace missing after create");

  return {
    org_id,
    workspace_id,
    source_file_id,
    gaps,
    tactics,
    parse_blocks,
    pack_id: args.packId,
  };
}
