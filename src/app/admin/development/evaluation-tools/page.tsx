/** Owner-only discovery of retained historical evaluation tools; no provider or artifact access. */
import React from "react";
import Link from "next/link";
import { AdminMain } from "@/components/admin/admin-page";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";

/** Explain historical scope only after the existing owner authorization check. */
export default async function EvaluationToolsPage() {
  await requireOwnerPage();
  return (
    <AdminMain>
      <Link href="/admin/development" className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
        Back to Development
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Evaluation tools</h1>
      <div className="mt-4 max-w-prose space-y-6 text-sm">
        <section aria-labelledby="current-evaluation" className="space-y-2">
          <h2 id="current-evaluation" className="font-semibold">Current customer pipeline</h2>
          <p>Use Development experiments to run gap extraction, tactic extraction, matching and coverage, and partial splitting. Evaluate saved outputs, compare experiments and inspect costs in the existing experiment controls.</p>
        </section>
        <section aria-labelledby="historical-benchmark" className="space-y-2 border-t border-border pt-4">
          <h2 id="historical-benchmark" className="font-semibold">Historical benchmark</h2>
          <p>The retained KAN-100 benchmark measures the historical <code>need_extract</code> and <code>inventory_extract</code> stages. Its prompts, audit process and scoring identities are frozen. These results do not validate the current customer pipeline.</p>
          <p>Run the local command from the repository root with explicit private input files:</p>
          <pre className="overflow-x-auto border border-border p-3 text-xs"><code>npm run benchmark:kan100 -- review --config &lt;private-config.json&gt; --packs &lt;private-packs.json&gt; --runtime &lt;private-runtime.json&gt; --checkpoint &lt;private-checkpoint.json&gt; --approvals &lt;private-approvals.json&gt; --decisions &lt;private-decisions.json&gt;</code></pre>
          <p><code>review</code> uses completed saved extraction, audits and billing; it cannot call providers or load credentials. The separate <code>prepare</code> and <code>run</code> commands retain their existing prerequisites and cost controls. Private artifacts stay in local, Git-ignored storage.</p>
        </section>
        <section aria-labelledby="reference-packs" className="space-y-2 border-t border-border pt-4">
          <h2 id="reference-packs" className="font-semibold">Reference packs</h2>
          <p>Committed historical reference packs keep gold targets and recall separate for each pack. They are evaluator-only evidence. Customer experiments continue to use their own selected source snapshots and optional evaluation references.</p>
          <p>Repository guide: <code>docs/development/kan-210-inventory.md</code>. The guide records module locations, reference loading and verification commands.</p>
        </section>
      </div>
    </AdminMain>
  );
}
