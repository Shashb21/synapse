"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MappingTableViewRow } from "@/lib/iegp/mapping-table";
import type { TacticLibraryItem } from "@/lib/iegp/engine";
import { LockForm } from "@/components/lock-form";
import { Button } from "@/components/ui/button";
import { useAiEnabled } from "@/components/platform/ai-status";

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "partially_addressed", label: "Partially addressed" },
  { value: "addressed", label: "Addressed" },
] as const;

export function MappingTableWorkbench({
  rows,
  tactics,
}: {
  rows: MappingTableViewRow[];
  tactics: TacticLibraryItem[];
}) {
  const [filter, setFilter] = useState<"all" | "proposal" | "human" | "open">("all");
  const ai = useAiEnabled();
  const filtered = useMemo(() => {
    if (filter === "proposal") return rows.filter((row) => row.source === "proposal");
    if (filter === "human") return rows.filter((row) => row.source === "human");
    if (filter === "open") return rows.filter((row) => row.mapping_status === "open");
    return rows;
  }, [filter, rows]);

  if (rows.length === 0) {
    if (!ai) {
      return (
        <section className="border border-border bg-card/40 p-4 text-[13px] text-muted-foreground">
          No gaps to map yet. AI is off: add gaps and tactics by hand on{" "}
          <Link href="/?place=upload" className="text-foreground underline-offset-2 hover:underline">
            Start
          </Link>
          , then map them here or on Gaps.
        </section>
      );
    }
    return (
      <section className="border border-border bg-card/40 p-4 text-[13px] text-muted-foreground">
        Run gap and tactic extraction, then{" "}
        <Link href="/pipeline" className="text-foreground underline-offset-2 hover:underline">
          S4 mapping table
        </Link>{" "}
        on the pipeline to populate rows.
      </section>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { id: "all", label: "All gaps" },
            { id: "proposal", label: "Latest S4 proposal" },
            { id: "human", label: "Saved by a person" },
            { id: "open", label: "Open rows" },
          ] as const
        ).map((chip) => (
          <Button
            key={chip.id}
            type="button"
            size="sm"
            variant={filter === chip.id ? "default" : "outline"}
            onClick={() => setFilter(chip.id)}
          >
            {chip.label}
          </Button>
        ))}
        <span className="text-[11px] text-muted-foreground">
          {ai
            ? "Accept, reject or edit any row — a saved row wins over later S4 runs, and a removed or rejected tactic is never mapped again by S4. Rationale feeds S4 hillclimb."
            : "AI is off: pick the tactics and a status for each row and save it with a rationale."}
        </span>
      </div>

      <div className="overflow-x-auto border border-border bg-card/30">
        <table className="w-full min-w-[720px] border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Gap</th>
              <th className="px-3 py-2 font-medium">Tactic(s)</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Rationale</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <MappingRowEditor key={row.gap_id} row={row} tactics={tactics} ai={ai} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function tacticLabel(id: string, tactics: TacticLibraryItem[]) {
  return tactics.find((tactic) => tactic.id === id)?.name ?? id;
}

function RationaleField({ placeholder }: { placeholder: string }) {
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      Rationale (required)
      <textarea
        name="rationale"
        required
        minLength={3}
        placeholder={placeholder}
        className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
      />
    </label>
  );
}

/** Accept or reject each tactic of an S4 proposal row, one pair at a time. */
function ProposalDecisions({ row }: { row: MappingTableViewRow }) {
  const bearing = row.mappings.filter((mapping) => mapping.coverage !== "not_relevant");
  if (bearing.length === 0) return null;
  return (
    <ul className="mt-2 grid gap-2">
      {bearing.map((mapping) => {
        const decision = row.decisions[mapping.tactic_id];
        const pair = { gap_id: row.gap_id, tactic_id: mapping.tactic_id };
        return (
          <li key={mapping.tactic_id} className="border border-border/70 p-2">
            <p className="text-[11px] text-foreground">
              {mapping.tactic_name} · S4 coverage{" "}
              {mapping.coverage.replaceAll("_", " ")} ({mapping.confidence})
            </p>
            <p className="text-[10px] text-muted-foreground">{mapping.rationale}</p>
            {decision ? (
              <p className="mt-1 text-[10px] text-[var(--chart-3)]">
                {decision.status === "accepted" ? "Accepted" : "Rejected"} by {decision.actor_name ?? "a person"}
                {decision.note ? `: ${decision.note}` : ""}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-1">
              {decision?.status === "accepted" ? null : (
                <LockForm
                  label="Accept"
                  action="accept_mapping"
                  extra={{
                    ...pair,
                    overall: mapping.coverage,
                    dimensions: JSON.stringify(mapping.dimensions ?? {}),
                  }}
                  confirmLabel="Accept mapping"
                  description="Maps this tactic to the gap with the S4 verdict (or marks an already committed pair as accepted). You can still edit coverage on the gap page."
                >
                  <RationaleField placeholder="Why this tactic bears on the gap" />
                </LockForm>
              )}
              {decision?.status === "rejected" ? null : (
                <LockForm
                  label="Reject"
                  action="reject_mapping"
                  extra={pair}
                  confirmLabel="Reject mapping"
                  description="Records the pair as rejected (and removes it if S4 already committed it). S4 will not map it again."
                >
                  <RationaleField placeholder="Why this tactic does not bear on the gap" />
                </LockForm>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MappingRowEditor({
  row,
  tactics,
  ai,
}: {
  row: MappingTableViewRow;
  tactics: TacticLibraryItem[];
  ai: boolean;
}) {
  const [tacticIds, setTacticIds] = useState(row.tactic_ids.join(","));
  const [status, setStatus] = useState(row.mapping_status);
  const [rationale, setRationale] = useState("");

  return (
    <tr className="border-b border-border/70 align-top">
      <td className="px-3 py-3">
        <Link href={`/gaps/${row.gap_id}`} className="font-medium text-foreground no-underline hover:underline">
          {row.gap_name}
        </Link>
        <p className="mt-1 text-[11px] text-muted-foreground">{row.gap_id}</p>
        {row.source === "proposal" ? (
          <span className="mt-1 inline-block text-[10px] text-[var(--chart-3)]">S4 proposal</span>
        ) : null}
        {row.source === "human" ? (
          <span className="mt-1 inline-block text-[10px] text-[var(--chart-3)]">
            Saved by {row.human_lock?.actor_name ?? "a person"}
          </span>
        ) : null}
        {row.source === "human" && row.unreviewed_tactic_ids.length > 0 ? (
          <p className="mt-1 text-[10px] text-amber-300" role="status">
            Mapped after your save, not yet reviewed:{" "}
            {row.unreviewed_tactic_ids.map((id) => tacticLabel(id, tactics)).join(", ")}
          </p>
        ) : null}
      </td>
      <td className="px-3 py-3">
        <select
          multiple
          className="min-h-[4.5rem] w-full max-w-xs rounded-md border border-input bg-transparent px-2 py-1 text-[12px]"
          value={tacticIds.split(",").filter(Boolean)}
          onChange={(event) => {
            const selected = [...event.target.selectedOptions].map((option) => option.value);
            setTacticIds(selected.join(","));
          }}
        >
          {tactics.map((tactic) => (
            <option key={tactic.id} value={tactic.id}>
              {tactic.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Hold Ctrl/Cmd to pick several. Deselecting a mapped tactic removes it and records it as rejected.
        </p>
      </td>
      <td className="px-3 py-3">
        <select
          className="h-8 w-full max-w-[10rem] rounded-md border border-input bg-transparent px-2 text-[12px]"
          value={status ?? ""}
          onChange={(event) => setStatus(event.target.value as MappingTableViewRow["mapping_status"])}
        >
          {/* S4 has not given this gap a verdict; a person must pick one to save. */}
          {status ? null : (
            <option value="" disabled>
              Not mapped yet
            </option>
          )}
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-3 text-[11px] text-muted-foreground">
        <ul className="list-disc pl-4">
          {row.rationale.slice(0, 2).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {row.source === "proposal" ? <ProposalDecisions row={row} /> : null}
        <Link href={`/gaps/${row.gap_id}`} className="mt-2 inline-block text-[10px] underline-offset-2 hover:underline">
          Set coverage and dimensions on the gap page
        </Link>
      </td>
      <td className="px-3 py-3">
        {status ? null : (
          <p className="mb-2 text-[11px] text-muted-foreground">
            {ai ? "Pick a status or run S4 before saving." : "Pick a status before saving."}
          </p>
        )}
        <LockForm label="Save row" action="save_mapping_row" confirmLabel="Save mapping row">
          <input type="hidden" name="gap_id" value={row.gap_id} />
          <input type="hidden" name="tactic_ids" value={tacticIds} />
          <input type="hidden" name="mapping_status" value={status ?? ""} />
          <input type="hidden" name="before" value={JSON.stringify({ tactic_ids: row.tactic_ids, status: row.mapping_status })} />
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Rationale (required)
            <textarea
              name="rationale"
              required
              minLength={3}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="Why you accept or change this row"
              className="min-h-14 w-full max-w-xs rounded-md border border-input bg-transparent px-2 py-1 text-[12px]"
            />
          </label>
        </LockForm>
      </td>
    </tr>
  );
}
