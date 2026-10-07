import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { Badge } from "@/components/ui/badge";
import { STAGES } from "@/modules/kernel/contracts";
import { manifests } from "@/modules/kernel/registry";
import {
  HILLCLIMB_STAGES,
  PROMPT_VARIANT_STAGES,
  promptVariantInstruction,
  promptVersionsFor,
} from "@/modules/kernel/prompt-versions";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CatalogPage() {
  await requireOwnerPage();
  const all = manifests();
  return (
    <AdminMain>
      <PageIntro kicker="Owner · platform-wide" title="Catalog">
        Every module registered with the kernel, and the prompt variants the hillclimb loop scores.
        Activate a version on Module versions.
      </PageIntro>

      <section className="mb-8 grid gap-2" aria-labelledby="modules">
        <h2 id="modules" className="text-[13px] font-semibold text-foreground">
          Modules ({all.length})
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                <th className="py-1 pr-3 font-normal">Stage</th>
                <th className="py-1 pr-3 font-normal">Module</th>
                <th className="py-1 pr-3 font-normal">Version</th>
                <th className="py-1 pr-3 font-normal">Kind</th>
                <th className="py-1 font-normal">Summary</th>
              </tr>
            </thead>
            <tbody>
              {all.map((manifest) => (
                <tr key={manifest.id} className="border-b border-border/60 align-top">
                  <td className="py-1.5 pr-3 text-foreground">
                    {manifest.stage} · {STAGES[manifest.stage].title}
                  </td>
                  <td className="py-1.5 pr-3 text-foreground">{manifest.id}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">v{manifest.version}</td>
                  <td className="py-1.5 pr-3">
                    <Badge variant="outline" className="text-[10px]">
                      {manifest.agentic ? (manifest.ai_optional ? "agentic · AI optional" : "agentic") : "mechanical"}
                    </Badge>
                  </td>
                  <td className="py-1.5 text-muted-foreground">{manifest.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-2" aria-labelledby="prompts">
        <h2 id="prompts" className="text-[13px] font-semibold text-foreground">
          Prompt variants
        </h2>
        <p className="text-[11px] text-muted-foreground">
          Hillclimb stages: {HILLCLIMB_STAGES.join(", ")}. Sweeps run from Runs &amp; traces.
        </p>
        <ul className="grid gap-1 text-[12px]" aria-label="Prompt versions by stage">
          {HILLCLIMB_STAGES.map((stage) => (
            <li key={stage} className="text-foreground">
              {stage} · {STAGES[stage].title}:{" "}
              <span className="text-muted-foreground">
                {promptVersionsFor(stage).join(", ")}
                {PROMPT_VARIANT_STAGES.includes(stage)
                  ? " · uses the S2 variant instructions below"
                  : " · no variant instructions of its own: every version runs the baseline prompt"}
              </span>
            </li>
          ))}
        </ul>
        {/* One instruction per version; the wording targets S2's gaps, and S3 reuses it (KAN-63). */}
        <h3 className="mt-2 text-[12px] font-semibold text-foreground">
          S2 · {STAGES.S2.title}: variant instructions
        </h3>
        <ul className="grid gap-2">
          {promptVersionsFor("S2").map((version) => (
            <li key={version} className="border border-border bg-card p-2 rounded-lg">
              <p className="text-[12px] text-foreground">{version}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {promptVariantInstruction(version) || "The baseline prompt, unchanged."}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </AdminMain>
  );
}
