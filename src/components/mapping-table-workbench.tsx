"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MappingTableViewRow } from "@/lib/iegp/mapping-table";
import type { TacticLibraryItem } from "@/lib/iegp/engine";
import { LockForm } from "@/components/lock-form";
import { Button } from "@/components/ui/button";
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
  const [filter, setFilter] = useState<"all" | "proposal" | "open">("all");
  const filtered = useMemo(() => {
    if (filter === "proposal") return rows.filter((row) => row.source === "proposal");
    if (filter === "open") return rows.filter((row) => row.mapping_status === "open");
    return rows;
  }, [filter, rows]);

  if (rows.length === 0) {
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
          Accept or edit any row — rationale feeds S4 hillclimb.
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
              <MappingRowEditor key={row.gap_id} row={row} tactics={tactics} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MappingRowEditor({ row, tactics }: { row: MappingTableViewRow; tactics: TacticLibraryItem[] }) {
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
        <p className="mt-1 text-[10px] text-muted-foreground">Hold Ctrl/Cmd to pick several.</p>
      </td>
      <td className="px-3 py-3">
        <select
          className="h-8 w-full max-w-[10rem] rounded-md border border-input bg-transparent px-2 text-[12px]"
          value={status}
          onChange={(event) => setStatus(event.target.value as MappingTableViewRow["mapping_status"])}
        >
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
      </td>
      <td className="px-3 py-3">
        <LockForm label="Save row" action="save_mapping_row" confirmLabel="Save mapping row">
          <input type="hidden" name="gap_id" value={row.gap_id} />
          <input type="hidden" name="tactic_ids" value={tacticIds} />
          <input type="hidden" name="mapping_status" value={status} />
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
