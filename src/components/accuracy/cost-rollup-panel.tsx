import type { AccuracyCostRollup } from "@/accuracy/kernel/cost-rollup";
import { formatUsd } from "@/accuracy/kernel/cost-rollup";

export function CostRollupPanel({
  rollup,
  workspaceName,
}: {
  rollup: AccuracyCostRollup;
  workspaceName?: string;
}) {
  return (
    <section className="mb-6 grid gap-2" aria-labelledby="cost-rollup">
      <h2 id="cost-rollup" className="text-body font-semibold text-foreground">
        Estimated spend
        {workspaceName ? (
          <span className="ml-2 text-callout font-normal text-muted-foreground">· {workspaceName}</span>
        ) : null}
      </h2>
      <p className="text-callout text-muted-foreground">
        Rollup of recorded module-run estimates (provider calls do not return billing). Uses the
        live price table in the accuracy kernel.
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Estimated USD" value={formatUsd(rollup.cost_usd)} />
        <Stat label="Runs" value={String(rollup.run_count)} />
        <Stat
          label="Status"
          value={`${rollup.ok_count} ok · ${rollup.error_count} err · ${rollup.abandoned_count} abandoned`}
        />
        <Stat label="Tokens" value={rollup.total_tokens.toLocaleString()} />
      </div>
      {rollup.by_call_kind.length > 0 ? (
        <div className="overflow-x-auto border border-border">
          <table className="w-full text-left text-callout">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">Call kind</th>
                <th className="px-2 py-1.5 font-medium">Runs</th>
                <th className="px-2 py-1.5 font-medium">Est. USD</th>
                <th className="px-2 py-1.5 font-medium">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rollup.by_call_kind.map((row) => (
                <tr key={row.call_kind} className="border-t border-border">
                  <td className="px-2 py-1.5 font-mono text-caption">{row.call_kind}</td>
                  <td className="px-2 py-1.5">
                    {row.run_count}
                    {row.abandoned_count > 0 ? ` · ${row.abandoned_count} stale` : ""}
                  </td>
                  <td className="px-2 py-1.5">{formatUsd(row.cost_usd)}</td>
                  <td className="px-2 py-1.5">{row.total_tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-callout text-muted-foreground">No module runs recorded yet.</p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-card p-3 rounded-lg">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 text-body text-foreground">{value}</p>
    </div>
  );
}
