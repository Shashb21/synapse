import { ownerGate } from "@/modules/auth/owner";
import { POST as runEvals } from "@/app/api/modules/evals/route";
import { inAdminWorkspace, peekBody } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A stage's eval harness, run from the owner console in the workspace the page showed. Owner only. */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  return inAdminWorkspace(await peekBody(request), () => runEvals(request));
}
