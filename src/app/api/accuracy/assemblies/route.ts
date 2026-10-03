/** Authenticated, workspace-scoped inspection API for immutable extraction assemblies. */
import { NextResponse } from "next/server";
import { AssemblyError } from "@/accuracy/domain/assembly";
import { listAssemblies, readAssembly } from "@/accuracy/store/assembly-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badQuery(query: URLSearchParams): boolean {
  const allowed = new Set(["workspace_id", "assembly_id"]);
  const workspace_id = query.get("workspace_id")?.trim() ?? "";
  const assembly_id = query.get("assembly_id")?.trim();
  return !workspace_id
    || query.getAll("workspace_id").length !== 1
    || query.getAll("assembly_id").length > 1
    || (query.has("assembly_id") && !assembly_id)
    || [...query.keys()].some((key) => !allowed.has(key));
}

/** List assemblies for a workspace, or read one assembly when assembly_id is supplied. */
export async function GET(request: Request) {
  try {
    const session = await sessionContext();
    if (!session.signed_in) return NextResponse.json({ error: "Sign in to access assemblies" }, { status: 401 });
    const query = new URL(request.url).searchParams;
    if (badQuery(query)) return NextResponse.json({ error: "Supply one workspace_id and optionally one assembly_id" }, { status: 400 });
    const workspace_id = query.get("workspace_id")!.trim();
    const assembly_id = query.get("assembly_id")?.trim() ?? "";
    if (!session.session || !await getAuthorizedWorkspace({ workspace_id, subject: session.session.subject, role: session.role })) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (assembly_id) {
      const assembly = await readAssembly(workspace_id, assembly_id);
      if (!assembly) return NextResponse.json({ error: "Assembly not found" }, { status: 404 });
      return NextResponse.json({ assembly });
    }
    return NextResponse.json({ assemblies: await listAssemblies(workspace_id) });
  } catch (error) {
    if (error instanceof AssemblyError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: status === 404 ? "Assembly not found" : status === 409 ? "Assembly conflict" : "Invalid assembly request" }, { status });
    }
    console.error("Could not read assemblies", error);
    return NextResponse.json({ error: "Could not read assemblies" }, { status: 500 });
  }
}
