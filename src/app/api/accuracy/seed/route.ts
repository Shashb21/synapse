import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { listReferencePacks } from "@/accuracy/eval/reference-gold";
import { seedWorkspaceFromGold } from "@/accuracy/store/seed-from-gold";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import { aiOffFromError, aiOffResponse } from "@/app/api/accuracy/_lib/ai-off";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  pack_id: z.string().min(1),
  workspace_name: z.string().min(2).max(120).optional(),
  parse_source: z.boolean().optional(),
});

export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  return NextResponse.json({
    packs: listReferencePacks().map((p) => ({
      id: p.id,
      asset: p.asset,
      source_file: p.source_file,
    })),
  });
}

export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await req.json());
    // An explicit parse request is an AI step: refuse it before creating anything.
    // Without one, AI off seeds the gold claims and skips the parse (parse_skipped).
    if (body.parse_source === true && !(await aiEnabled())) return aiOffResponse();
    const result = await seedWorkspaceFromGold({
      packId: body.pack_id,
      workspaceName: body.workspace_name,
      parseSource: body.parse_source,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    const message = error instanceof Error ? error.message : "Seed failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
