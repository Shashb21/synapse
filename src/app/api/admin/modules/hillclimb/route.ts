import { ownerGate } from "@/modules/auth/owner";
import { POST as runSweep } from "@/app/api/modules/hillclimb/route";
import { inAdminWorkspace, peekBody } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A hillclimb sweep, run from the owner console in the workspace the page showed. Owner only. */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  return inAdminWorkspace(await peekBody(request), () => runSweep(request));
}
