"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  boardsFromFacilitatorTags,
  boardsFromPriorityBands,
  effectiveGapView,
  UNASSIGNED_BOARD_ID,
  type WorkshopGapLite,
  type WorkshopScene,
} from "@/accuracy/modules/workshop/readiness";
import type { CoverageOverallWrite, WorkshopActionKind } from "@/accuracy/modules/workshop/actions";
import type { WorkshopSnapshotRecord } from "@/accuracy/store/workshop-store";

type MenuKind = WorkshopActionKind | "split";

function statusLabel(status: string, parked: boolean): string {
  if (parked) return "Parked";
  if (status === "addressed") return "Addressed";
  if (status === "partial") return "Partial";
  return "Open";
}

function statusClass(status: string, parked: boolean): string {
  if (parked) return "text-muted-foreground";
  if (status === "addressed") return "text-[var(--known)]";
  if (status === "partial") return "text-[var(--opportunity)]";
  return "text-[var(--unknown)]";
}

export function WorkshopStage({
  workspaceId,
  workspaceName,
  workspaceSlug,
  snapshot: initial,
  exitHref,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  snapshot: WorkshopSnapshotRecord;
  exitHref: string;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [boardIndex, setBoardIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuKind, setMenuKind] = useState<MenuKind>("mark_addressed");
  const [rationale, setRationale] = useState("");
  const [tacticId, setTacticId] = useState("");
  const [overall, setOverall] = useState<CoverageOverallWrite>("covers");
  const [priority, setPriority] = useState<"high" | "medium" | "low">("high");
  const [tagLabel, setTagLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const scene = snapshot.payload.scene;
  const overlays = snapshot.payload.overlays;
  const boards = useMemo(
    () =>
      scene === "prioritize"
        ? boardsFromPriorityBands(snapshot.payload.inventory.gaps, overlays)
        : boardsFromFacilitatorTags(
            snapshot.payload.inventory.gaps,
            snapshot.payload.facilitator_tags,
            overlays,
          ),
    [scene, snapshot.payload.inventory.gaps, snapshot.payload.facilitator_tags, overlays],
  );
  const currentBoard = boards[Math.min(boardIndex, Math.max(boards.length - 1, 0))] ?? boards[0];
  const selected = snapshot.payload.inventory.gaps.find((gap) => gap.id === selectedId) ?? null;
  const selectedView = selected ? effectiveGapView(selected, overlays[selected.id]) : null;
  const tactics = snapshot.payload.inventory.tactics;
  const splitHref = `/accuracy/coverage?workspace_id=${encodeURIComponent(workspaceId)}`;

  useEffect(() => {
    setBoardIndex((i) => Math.min(i, Math.max(boards.length - 1, 0)));
  }, [boards.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        setBoardIndex((i) => Math.min(i + 1, boards.length - 1));
      } else if (event.key === "ArrowLeft") {
        setBoardIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Escape") {
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boards.length]);

  const openMenu = useCallback((gap: WorkshopGapLite) => {
    setSelectedId(gap.id);
    setError(null);
    setRationale("");
    setTacticId(tactics[0]?.id ?? "");
    setMenuKind(scene === "prioritize" ? "set_priority" : "mark_addressed");
    const viewed = effectiveGapView(gap, overlays[gap.id]);
    const band = String(viewed.priority ?? "").toLowerCase();
    setPriority(band === "medium" || band === "low" ? band : "high");
  }, [overlays, scene, tactics]);

  async function postJson(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string; snapshot?: WorkshopSnapshotRecord };
    if (!res.ok || !json.ok || !json.snapshot) {
      throw new Error(json.error ?? "Request failed");
    }
    setSnapshot(json.snapshot);
    return json.snapshot;
  }

  async function switchScene(next: WorkshopScene) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/accuracy/workshop", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          snapshot_id: snapshot.id,
          scene: next,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; snapshot?: WorkshopSnapshotRecord };
      if (!res.ok || !json.ok || !json.snapshot) {
        throw new Error(json.error ?? "Could not switch scene");
      }
      setSnapshot(json.snapshot);
      setBoardIndex(0);
      setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch scene");
    } finally {
      setPending(false);
    }
  }

  async function addTag(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await postJson("/api/accuracy/workshop/tags", {
        workspace_id: workspaceId,
        snapshot_id: snapshot.id,
        action: "add_tag",
        label: tagLabel,
      });
      setTagLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add board");
    } finally {
      setPending(false);
    }
  }

  async function assignTag(tag_id: string) {
    if (!selected) return;
    setError(null);
    setPending(true);
    try {
      await postJson("/api/accuracy/workshop/tags", {
        workspace_id: workspaceId,
        snapshot_id: snapshot.id,
        action: "assign",
        gap_id: selected.id,
        tag_id,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move gap");
    } finally {
      setPending(false);
    }
  }

  async function runAction() {
    if (!selected) return;
    if (menuKind === "split") return;
    setError(null);
    setPending(true);
    try {
      await postJson("/api/accuracy/workshop/actions", {
        workspace_id: workspaceId,
        snapshot_id: snapshot.id,
        kind: menuKind,
        gap_id: selected.id,
        rationale,
        tactic_id: tacticId || undefined,
        overall: menuKind === "remap" ? overall : undefined,
        priority: menuKind === "set_priority" ? priority : undefined,
      });
      setRationale("");
      setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-6 py-5 sm:px-10">
        <div>
          <p className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
            Synapse · Accuracy
          </p>
          <h1 className="mt-1 text-4xl font-medium tracking-tight sm:text-5xl">Workshop</h1>
          <p className="mt-2 max-w-2xl text-lg text-muted-foreground">
            {workspaceName}
            <span className="mx-2 text-border">·</span>
            frozen v{snapshot.version}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void switchScene("gaps")}
            className={`border px-3 py-2 text-[13px] ${
              scene === "gaps"
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground"
            }`}
          >
            Gaps
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void switchScene("prioritize")}
            className={`border px-3 py-2 text-[13px] ${
              scene === "prioritize"
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground"
            }`}
          >
            Prioritize
          </button>
          <Link
            href={`/accuracy/w/${encodeURIComponent(workspaceSlug)}/workshop`}
            className="border border-border px-3 py-2 text-[12px] text-muted-foreground no-underline"
          >
            /w/{workspaceSlug}
          </Link>
          <Link
            href={exitHref}
            className="border border-foreground px-3 py-2 text-[13px] text-foreground no-underline"
          >
            Exit to operator
          </Link>
        </div>
      </header>

      <p className="px-6 pt-4 text-[13px] text-muted-foreground sm:px-10">
        {scene === "gaps"
          ? "Boards are facilitator tags — not chapter or SI. Click a gap for mark addressed, remap, park, or split."
          : "Open gaps only. Set High / Medium / Low with a rationale. Ideation stays high-only after bands lock."}
        <span className="ml-2">Arrow keys move between boards.</span>
      </p>

      {scene === "gaps" ? (
        <form onSubmit={(event) => void addTag(event)} className="flex flex-wrap gap-2 px-6 pt-4 sm:px-10">
          <input
            value={tagLabel}
            onChange={(event) => setTagLabel(event.target.value)}
            placeholder="New facilitator board"
            className="min-w-56 border border-border bg-transparent px-3 py-2 text-[14px]"
            aria-label="New facilitator tag"
          />
          <button
            type="submit"
            disabled={pending}
            className="border border-border px-3 py-2 text-[13px] text-foreground"
          >
            Add board
          </button>
        </form>
      ) : null}

      {error && !selectedId ? (
        <p className="px-6 pt-3 text-[13px] text-destructive sm:px-10">{error}</p>
      ) : null}

      <nav aria-label="Workshop boards" className="flex gap-2 overflow-x-auto px-6 pt-6 sm:px-10">
        {boards.map((board, index) => (
          <button
            key={board.id}
            type="button"
            onClick={() => setBoardIndex(index)}
            className={`shrink-0 border px-4 py-2 text-left ${
              currentBoard?.id === board.id
                ? "border-foreground bg-card text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            <span className="block text-xl font-medium">{board.label}</span>
            <span className="text-[12px]">
              {board.gaps.length} gap{board.gaps.length === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </nav>

      <main className="flex-1 px-6 py-8 sm:px-10">
        <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">{currentBoard?.label}</h2>
        {currentBoard && currentBoard.gaps.length === 0 ? (
          <p className="mt-8 max-w-xl text-2xl leading-snug text-muted-foreground">
            {scene === "gaps" && currentBoard.id === UNASSIGNED_BOARD_ID
              ? "Every gap is on a facilitator board."
              : "Nothing on this board yet."}
          </p>
        ) : (
          <ul className="mt-8 grid gap-4">
            {currentBoard?.gaps.map((gap) => (
              <li key={gap.id}>
                <button
                  type="button"
                  onClick={() => openMenu(gap)}
                  className="w-full border border-border bg-card/30 px-5 py-6 text-left hover:border-foreground"
                >
                  <p className="text-2xl leading-snug sm:text-3xl">{gap.statement}</p>
                  <p className="mt-3 flex flex-wrap gap-4 text-[13px]">
                    <span className={statusClass(gap.coverage_status, gap.parked)}>
                      {statusLabel(gap.coverage_status, gap.parked)}
                    </span>
                    {gap.priority ? (
                      <span className="capitalize text-muted-foreground">{gap.priority}</span>
                    ) : null}
                    <span className="font-mono text-muted-foreground">{gap.id}</span>
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      {selected && selectedView ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="workshop-gap-title"
        >
          <div className="max-h-[90dvh] w-full max-w-3xl overflow-y-auto border border-border bg-background p-6 sm:p-8">
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Adapt · rationale required
            </p>
            <h3 id="workshop-gap-title" className="mt-2 text-3xl leading-snug">
              {selectedView.statement}
            </h3>
            <p className={`mt-2 text-[14px] ${statusClass(selectedView.coverage_status, selectedView.parked)}`}>
              {statusLabel(selectedView.coverage_status, selectedView.parked)}
              {selectedView.priority ? ` · ${selectedView.priority}` : ""}
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              {(
                [
                  ["mark_addressed", "Mark addressed"],
                  ["remap", "Remap"],
                  ["park", "Park"],
                  ["set_priority", "Set priority"],
                  ["split", "Split / rewrite"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setMenuKind(kind)}
                  className={`border px-3 py-2 text-[13px] ${
                    menuKind === kind
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {scene === "gaps" ? (
              <label className="mt-5 grid gap-1 text-[13px] text-muted-foreground">
                Move to board
                <select
                  className="border border-border bg-background px-3 py-2 text-[14px] text-foreground"
                  value={
                    snapshot.payload.facilitator_tags.assignments[selected.id] ?? UNASSIGNED_BOARD_ID
                  }
                  onChange={(event) => void assignTag(event.target.value)}
                >
                  <option value={UNASSIGNED_BOARD_ID}>Unassigned</option>
                  {snapshot.payload.facilitator_tags.tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {menuKind === "split" ? (
              <p className="mt-5 text-[15px] text-muted-foreground">
                Partial residuals stay on Coverage for split or rewrite. Workshop does not silently
                rewrite the ledger.
              </p>
            ) : null}

            {menuKind === "mark_addressed" || menuKind === "remap" ? (
              <label className="mt-5 grid gap-1 text-[13px] text-muted-foreground">
                Tactic in this freeze
                <select
                  className="border border-border bg-background px-3 py-2 text-[14px] text-foreground"
                  value={tacticId}
                  onChange={(event) => setTacticId(event.target.value)}
                >
                  {tactics.length === 0 ? <option value="">No tactics in snapshot</option> : null}
                  {tactics.map((tactic) => (
                    <option key={tactic.id} value={tactic.id}>
                      {tactic.statement}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {menuKind === "remap" ? (
              <label className="mt-4 grid gap-1 text-[13px] text-muted-foreground">
                Coverage overall
                <select
                  className="border border-border bg-background px-3 py-2 text-[14px] text-foreground"
                  value={overall}
                  onChange={(event) => setOverall(event.target.value as CoverageOverallWrite)}
                >
                  <option value="covers">Covers</option>
                  <option value="partial">Partial</option>
                  <option value="none">None</option>
                  <option value="unknown">Unknown</option>
                </select>
              </label>
            ) : null}

            {menuKind === "set_priority" ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {(["high", "medium", "low"] as const).map((band) => (
                  <button
                    key={band}
                    type="button"
                    onClick={() => setPriority(band)}
                    className={`border px-3 py-2 text-[13px] capitalize ${
                      priority === band
                        ? "border-foreground bg-foreground text-background"
                        : "border-border"
                    }`}
                  >
                    {band}
                  </button>
                ))}
              </div>
            ) : null}

            {menuKind !== "split" ? (
              <label className="mt-5 grid gap-1 text-[13px] text-muted-foreground">
                Rationale (required)
                <textarea
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  rows={3}
                  className="border border-border bg-transparent px-3 py-2 text-[15px] text-foreground"
                  placeholder="Why this decision — hillclimb needs the before/after"
                />
              </label>
            ) : null}

            {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}

            <div className="mt-6 flex flex-wrap gap-2">
              {menuKind === "split" ? (
                <Link
                  href={splitHref}
                  className="border border-foreground bg-foreground px-4 py-2 text-[13px] text-background no-underline"
                >
                  Open Coverage
                </Link>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void runAction()}
                  className="border border-foreground bg-foreground px-4 py-2 text-[13px] text-background disabled:opacity-50"
                >
                  {pending ? "Writing…" : "Commit with rationale"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="border border-border px-4 py-2 text-[13px]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
