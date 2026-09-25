import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { ModuleActivation } from "@/components/admin/module-activation";
import { STAGES } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ModuleVersionsPage() {
  await requireOwnerPage();
  const wiring = await stageWiring();
  return (
    <AdminMain>
      <PageIntro kicker="Owner · platform-wide" title="Module versions">
        Which module each stage runs. Versions are independent: switching one stage never touches its
        neighbours, and every run records the version it used.
      </PageIntro>
      <div className="grid gap-2 md:grid-cols-2">
        {wiring.map((row) => (
          <article key={row.stage} className="grid gap-2 border border-border bg-card/40 p-3" data-testid={`module-${row.stage}`}>
            <h2 className="text-[13px] font-medium text-foreground">
              {row.stage} · {STAGES[row.stage].title}
            </h2>
            <dl className="grid gap-1 text-[11px] text-muted-foreground">
              <div className="flex justify-between gap-2">
                <dt>Active</dt>
                <dd className="truncate text-foreground">
                  {row.active ? `${row.active.id} v${row.active.version}` : "none registered"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Activated</dt>
                <dd className="truncate text-foreground">
                  {row.activated_by ? `${row.activated_by} · ${row.activated_at?.slice(0, 16).replace("T", " ")}` : "default"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Eval harness</dt>
                <dd className="text-foreground">{row.has_evals ? "yes" : "no"}</dd>
              </div>
            </dl>
            <ModuleActivation
              stage={row.stage}
              activeId={row.active?.id ?? null}
              options={row.available.map((manifest) => ({
                id: manifest.id,
                version: manifest.version,
                title: manifest.title,
              }))}
            />
          </article>
        ))}
      </div>
    </AdminMain>
  );
}
