import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { AiHarness } from "@/components/admin/ai-harness";
import { requireOwnerPage } from "@/modules/auth/owner";
import { AI_SECTIONS, noAiSections } from "@/modules/kernel/ai-sections";
import { aiSections } from "@/modules/kernel/ai-switch";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { DOMAIN_LABELS, EVIDENCE_DOMAINS } from "@/lib/iegp/enums";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AiHarnessPage() {
  await requireOwnerPage();
  const sections = await aiSections().catch(() => noAiSections());
  return (
    <AdminMain>
      <PageIntro kicker="Owner · test bench" title="AI harness">
        Run each AI use case on its own against the live routed model, on a Velmara sample or on your own input, and
        read what it produced. Nothing is scored. Every run happens in a private sandbox reset to the Velmara demo, so no
        customer data is touched, and it runs whether or not customers have that section on. Each run is traced in Runs
        &amp; traces.
      </PageIntro>
      <AiHarness
        cases={AI_SECTIONS.map((section) => ({
          id: section.id,
          label: section.label,
          stages: section.stages,
          detail: section.detail,
          built: section.built,
          customersOn: sections[section.id],
        }))}
        demoFiles={DEMO_PACK.map((file) => ({ id: file.id, title: file.title }))}
        domains={EVIDENCE_DOMAINS.map((domain) => ({ value: domain, label: DOMAIN_LABELS[domain] }))}
      />
    </AdminMain>
  );
}
