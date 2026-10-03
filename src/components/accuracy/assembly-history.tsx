"use client";

/** On-demand immutable complete-proposal inspection in the ledger. */
import { useId, useState } from "react";
import type { Assembly, AssemblyCoverage, ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type AssemblyListState = { assemblies: Assembly[] } | null;

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "None recorded";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function payloadTitle(item: ResolvedAssemblyItem): string {
  const direct = item.claim_type === "gap" ? item.payload.statement : item.payload.name;
  if (typeof direct === "string" && direct.trim()) return direct;
  const generatedId = item.payload.id;
  return typeof generatedId === "string" && generatedId.trim() ? generatedId : item.id;
}

function coverageOverall(row: AssemblyCoverage): string {
  if (row.output && typeof row.output === "object" && "overall" in row.output) {
    return fieldValue((row.output as { overall?: unknown }).overall);
  }
  return "No structured result";
}

function mappedGapIds(assembly: Assembly): Set<string> {
  return new Set(assembly.mappings.map((mapping) => mapping.gap_version_id));
}

function statusText(status: Assembly["checks"]["status"]): string {
  return `Deterministic checks ${status}`;
}

function ListSummary({ assembly }: { assembly: Assembly }) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium text-foreground">{assembly.id}</p>
        <span className="text-[11px] text-[var(--unknown)]">Unapproved proposal</span>
      </div>
      <p className="text-muted-foreground">
        {statusText(assembly.checks.status)} · {assembly.linking_complete ? "Linking complete" : "Linking incomplete"}
      </p>
      <p className="break-words text-muted-foreground">
        Created: {assembly.created_at} · Sources: {assembly.source_file_ids.join(", ") || "None recorded"}
      </p>
    </div>
  );
}

function Lineage({ item }: { item: ResolvedAssemblyItem }) {
  return (
    <dl className="grid gap-1 text-muted-foreground">
      <div><dt className="inline">Version: </dt><dd className="inline">{item.id}</dd></div>
      <div><dt className="inline">Original claim: </dt><dd className="inline">{item.claim_id}</dd></div>
      <div><dt className="inline">Canonical claim: </dt><dd className="inline">{item.canonical_claim_id}</dd></div>
      <div><dt className="inline">Source: </dt><dd className="inline">{item.source_file_id}</dd></div>
      <div><dt className="inline">Run: </dt><dd className="inline">{item.run_id}</dd></div>
      <div><dt className="inline">Snapshot: </dt><dd className="inline">{item.snapshot_id ?? "Judged final output (no snapshot)"}</dd></div>
      <div><dt className="inline">Iteration: </dt><dd className="inline">{item.iteration ?? "Judged final output"}</dd></div>
      <div><dt className="inline">Item index: </dt><dd className="inline">{item.item_index}</dd></div>
      <div><dt className="inline">Selection reason: </dt><dd className="inline">{item.reason}</dd></div>
    </dl>
  );
}

function SelectedItem({ item }: { item: ResolvedAssemblyItem }) {
  return (
    <li className="border-b border-border pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{payloadTitle(item)}</p>
        <Badge variant="secondary" className="text-[10px]">{item.claim_type}</Badge>
      </div>
      <Lineage item={item} />
      <dl className="mt-2 grid gap-1">
        {Object.entries(item.payload).map(([field, value]) => (
          <div key={field}>
            <dt className="font-medium">{field}</dt>
            <dd className="whitespace-pre-wrap break-words text-muted-foreground">{fieldValue(value)}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

function AssemblyDetail({ assembly }: { assembly: Assembly }) {
  const selectedMappedGapIds = mappedGapIds(assembly);
  const gaps = assembly.items.filter((item) => item.claim_type === "gap");
  const uncovered = gaps.filter((gap) => !selectedMappedGapIds.has(gap.id));

  return (
    <div className="mt-3 grid gap-4 border-t border-border pt-3">
      <section className="grid gap-1" aria-label={`Proposal identity ${assembly.id}`}>
        <p className="font-medium">Unapproved proposal</p>
        <p className="break-words text-muted-foreground">Fingerprint: {assembly.fingerprint}</p>
        <p className="break-words text-muted-foreground">Source scope: {assembly.source_file_ids.join(", ") || "None recorded"}</p>
        <p className="text-muted-foreground">Actor: {assembly.actor.name} ({assembly.actor.function})</p>
        <p className="text-muted-foreground">{assembly.linking_complete ? "Linking complete" : "Linking incomplete"}</p>
      </section>

      <section className="grid gap-2" aria-label="Selected generated items">
        <p className="font-medium">Selected generated items</p>
        {assembly.items.length === 0 ? (
          <p className="text-muted-foreground">No generated gaps or tactics were selected.</p>
        ) : (
          <ol className="grid gap-3">
            {assembly.items.map((item) => <SelectedItem key={item.id} item={item} />)}
          </ol>
        )}
      </section>

      <section className="grid gap-2" aria-label="Mappings and uncovered gaps">
        <p className="font-medium">Mappings and uncovered gaps</p>
        {assembly.mappings.length === 0 ? (
          <p className="text-muted-foreground">No supported mappings recorded.</p>
        ) : (
          <ul className="grid gap-1">
            {assembly.mappings.map((mapping) => (
              <li key={`${mapping.gap_version_id}:${mapping.tactic_version_id}`}>
                Mapping: {mapping.gap_version_id} -&gt; {mapping.tactic_version_id}
              </li>
            ))}
          </ul>
        )}
        {uncovered.length === 0 ? (
          <p className="text-muted-foreground">No uncovered selected gaps.</p>
        ) : (
          <ul className="grid gap-1">
            {uncovered.map((gap) => <li key={gap.id}>Uncovered gap: {gap.id}</li>)}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-label="Coverage outcomes">
        <p className="font-medium">Coverage outcomes</p>
        {assembly.coverage.length === 0 ? (
          <p className="text-muted-foreground">No coverage outcomes recorded.</p>
        ) : (
          <ul className="grid gap-2">
            {assembly.coverage.map((row) => (
              <li key={`${row.run_id}:${row.gap_version_id}:${row.tactic_version_id}`} className="border-b border-border pb-2">
                <p>{row.gap_version_id} -&gt; {row.tactic_version_id} · {coverageOverall(row)}</p>
                <p className="text-muted-foreground">Run: {row.run_id} · Mode: {row.mode}</p>
                {row.mode === "stub" ? <p className="text-[var(--unknown)]">Stub coverage advisory</p> : null}
                {row.output && typeof row.output === "object" && "rationale" in row.output ? (
                  <p className="text-muted-foreground">Rationale: {fieldValue((row.output as { rationale?: unknown }).rationale)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-label="Deterministic check findings">
        <p className="font-medium">{statusText(assembly.checks.status)}</p>
        <p className="text-muted-foreground">Checker: {assembly.checks.checker_version}</p>
        {assembly.checks.findings.length === 0 ? (
          <p className="text-muted-foreground">No deterministic findings.</p>
        ) : (
          <ul className="grid gap-2">
            {assembly.checks.findings.map((finding) => (
              <li key={`${finding.code}:${finding.item_version_ids.join(":")}:${finding.message}`} className="border-b border-border pb-2">
                <p className="font-medium">{finding.code} · {finding.severity}</p>
                <p>{finding.message}</p>
                <p className="text-muted-foreground">Items: {finding.item_version_ids.join(", ") || "Whole assembly"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Render saved agent assemblies without approval or human-edit controls. */
export function AssemblyHistory({ workspaceId }: { workspaceId: string }) {
  const listPanelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [list, setList] = useState<AssemblyListState>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [openAssemblyId, setOpenAssemblyId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Assembly>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<Record<string, string>>({});

  async function loadList() {
    setListLoading(true);
    setListError(null);
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId });
      const response = await fetch(`/api/accuracy/assemblies?${query}`, { cache: "no-store" });
      const body = await response.json() as { assemblies?: Assembly[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load complete proposals");
      setList({ assemblies: body.assemblies ?? [] });
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Could not load complete proposals");
    } finally {
      setListLoading(false);
    }
  }

  async function loadDetail(assemblyId: string) {
    setDetailLoading(assemblyId);
    setDetailError((current) => ({ ...current, [assemblyId]: "" }));
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId, assembly_id: assemblyId });
      const response = await fetch(`/api/accuracy/assemblies?${query}`, { cache: "no-store" });
      const body = await response.json() as { assembly?: Assembly; error?: string };
      if (!response.ok || !body.assembly) throw new Error(body.error ?? "Could not load proposal");
      setDetails((current) => ({ ...current, [assemblyId]: body.assembly! }));
    } catch (cause) {
      setDetailError((current) => ({ ...current, [assemblyId]: cause instanceof Error ? cause.message : "Could not load proposal" }));
    } finally {
      setDetailLoading(null);
    }
  }

  function toggleList() {
    setExpanded((current) => {
      const next = !current;
      if (next && !list && !listLoading) void loadList();
      return next;
    });
  }

  function toggleDetail(assemblyId: string) {
    const next = openAssemblyId === assemblyId ? null : assemblyId;
    setOpenAssemblyId(next);
    if (next && !details[assemblyId] && detailLoading !== assemblyId) void loadDetail(assemblyId);
  }

  return (
    <section className="mb-6 grid gap-2 text-[12px]" aria-label="Complete assembly proposals">
      <div>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-controls={listPanelId}
          onClick={toggleList}
        >
          Complete proposals
        </Button>
      </div>
      {expanded ? (
        <div id={listPanelId} className="grid gap-3 border-t border-border pt-3">
          {listLoading ? <p role="status">Loading complete proposals…</p> : null}
          {listError ? (
            <div>
              <p role="alert" className="text-destructive">{listError}</p>
              <Button size="sm" variant="outline" disabled={listLoading} onClick={() => void loadList()}>Retry proposals</Button>
            </div>
          ) : null}
          {list && list.assemblies.length === 0 ? (
            <p className="text-muted-foreground">No complete proposals recorded for this workspace.</p>
          ) : null}
          {list && list.assemblies.length > 0 ? (
            <ul className="grid gap-3">
              {list.assemblies.map((assembly) => {
                const detailId = `${listPanelId}-${assembly.id}`;
                const open = openAssemblyId === assembly.id;
                return (
                  <li key={assembly.id} className="border border-border bg-card/40 p-3">
                    <ListSummary assembly={assembly} />
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-expanded={open}
                        aria-controls={detailId}
                        disabled={detailLoading !== null && detailLoading !== assembly.id}
                        onClick={() => toggleDetail(assembly.id)}
                      >
                        Inspect proposal {assembly.id}
                      </Button>
                    </div>
                    {open ? (
                      <div id={detailId}>
                        {detailLoading === assembly.id ? <p role="status" className="mt-2">Loading proposal detail…</p> : null}
                        {detailError[assembly.id] ? (
                          <div className="mt-2">
                            <p role="alert" className="text-destructive">{detailError[assembly.id]}</p>
                            <Button size="sm" variant="outline" disabled={detailLoading !== null} onClick={() => void loadDetail(assembly.id)}>Retry proposal</Button>
                          </div>
                        ) : null}
                        {details[assembly.id] ? <AssemblyDetail assembly={details[assembly.id]} /> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
