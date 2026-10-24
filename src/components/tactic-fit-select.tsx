"use client";

/** A library selection preview; changing or expanding it never submits a relationship. */
import { useState } from "react";
import { RelationshipFit } from "@/components/relationship-fit";
import type { RelationshipFitModel, TacticLibraryItem } from "@/lib/iegp/engine";

/** Keep the selected tactic and its gap-scoped explanation together before assignment. */
export function TacticFitSelect({ tactics, previews }: {
  tactics: TacticLibraryItem[];
  previews?: Record<string, RelationshipFitModel>;
}) {
  const [selectedId, setSelectedId] = useState(tactics[0]?.id ?? "");
  const selected = tactics.find(tactic => tactic.id === selectedId) ?? tactics[0];
  const fit = selected ? previews?.[selected.id] : undefined;
  return (
    <div>
      <label className="grid gap-1 text-callout text-muted-foreground">
        From tactic library
        <select name="tactic_id" required value={selected?.id ?? ""}
          onChange={event => setSelectedId(event.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground">
          {tactics.map(tactic => <option key={tactic.id} value={tactic.id}>
            {tactic.name} · {tactic.gaps.length ? `${tactic.gaps.length} gap${tactic.gaps.length === 1 ? "" : "s"}` : "not tagged yet"}
          </option>)}
        </select>
      </label>
      {fit && selected ? <RelationshipFit key={selected.id} fit={fit} tacticName={selected.name} /> : null}
    </div>
  );
}
