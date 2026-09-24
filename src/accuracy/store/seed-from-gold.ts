import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrganization, createWorkspace, getWorkspace } from "./tenant";
import { insertClaim } from "./claim-store";
import { insertSourceFile } from "./source-store";
import { loadReferenceGold, getReferencePack, referencePackDir } from "../eval/reference-gold";
import { mimeForFilename } from "@/lib/ingest/local-parse";
import { planLabelFromPack } from "@/accuracy/domain/plan-label";
import {
  normalizeChapterSlug,
  siThemeFromGapId,
} from "@/accuracy/domain/ledger-filters";

export type SeedFromGoldResult = {
  org_id: string;
  workspace_id: string;
  source_file_id: string;
  gaps: number;
  tactics: number;
  parse_blocks: number;
  /** Why the reference source was not parsed (e.g. no LLM connected), or null. */
  parse_error: string | null;
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

  const plan_label = planLabelFromPack(pack);
  const org_id = await createOrganization(`${pack.asset} (eval)`);
  const workspace_id = await createWorkspace({
    org_id,
    name: args.workspaceName ?? `${pack.asset} ${plan_label}`,
    slug: `${slugify(args.packId)}-${Date.now().toString(36)}`,
    plan_label,
  });

  const sourcePath = join(referencePackDir(args.packId), pack.source_file);
  let source_file_id = "";
  let parse_blocks = 0;
  let parse_error: string | null = null;

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
      // Same path as an upload: the parse route's LLM structures the source.
      const [{ runAccuracyModule }, { registerAccuracyStack }] = await Promise.all([
        import("@/accuracy/kernel/run"),
        import("@/accuracy"),
      ]);
      registerAccuracyStack();
      try {
        const parsed = await runAccuracyModule<{ block_count: number }>({
          call_kind: "parse",
          agent_role: "proposer",
          input: {
            workspace_id,
            source_file_id,
            filename: sourceRel || pack.source_file,
            mime,
            content_base64: buffer.toString("base64"),
          },
          actor: { name: "Gold seed", function: "medical_affairs" },
          org_id,
          workspace_id,
        });
        parse_blocks = parsed.output.block_count;
      } catch (error) {
        parse_error = error instanceof Error ? error.message : String(error);
      }
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
      si_theme?: string;
      slide_cue?: string;
    };
    if (!g.statement?.trim()) continue;
    const si = siThemeFromGapId(g.id) ?? null;
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
        chapter: normalizeChapterSlug(g.chapter) ?? g.chapter ?? null,
        si_theme: g.si_theme ?? si?.slug ?? null,
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
      chapter?: string;
    };
    const statement = tac.title?.trim();
    if (!statement) continue;
    const external =
      tac.identifier ?? (typeof tac.number === "number" ? String(tac.number) : null);
    const linkedSi = (tac.gap_ids ?? [])
      .map((id) => siThemeFromGapId(id)?.slug)
      .find((slug): slug is string => Boolean(slug));
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
        chapter: normalizeChapterSlug(tac.chapter) ?? tac.chapter ?? null,
        si_theme: linkedSi ?? null,
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
    parse_error,
    pack_id: args.packId,
  };
}
