"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CustomTypeFields } from "@/components/custom-type-fields";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import {
  ACTOR_FUNCTIONS,
  FUNCTION_LABELS,
  TACTIC_STATUSES,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
  type ActorFunction,
  type TacticStatus,
  type TacticType,
} from "@/lib/iegp/enums";
import { tacticColor } from "@/lib/iegp/tactic-type-colors";

/** The fields the side panel edits (KAN-50). */
export type TacticEditModel = {
  id: string;
  name: string;
  type: TacticType;
  custom_type: CustomTacticType | null;
  status: TacticStatus;
  evidence_question: string;
  start_date: string | null;
  evidence_available: string | null;
  budget: string | null;
  owner: string;
  function: ActorFunction;
};

const FIELD = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

/** The plain fields that go through `modify_tactic`; status has its own lock. */
const TEXT_FIELDS = ["name", "type", "evidence_question", "start_date", "evidence_available", "budget", "owner", "function"] as const;

function customKey(value: CustomTacticType | null | undefined) {
  return value ? `${value.label.trim().toLowerCase()}|${value.color.toLowerCase()}` : "";
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/iegp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error ?? `Could not save (${res.status}).`;
}

/**
 * The design's tactic edit side panel: opens over Tactic Ideation, saves with a rationale
 * (filed as an edit record), and sends a status change through the tactic status lock.
 */
export function TacticEditPanel({
  tactic,
  identity,
  inUse,
  onClose,
}: {
  tactic: TacticEditModel | null;
  identity: ActionIdentity;
  inUse: CustomTacticType[];
  onClose: () => void;
}) {
  return (
    <Sheet open={tactic !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[420px]" data-testid="tactic-panel">
        {tactic ? (
          // Keyed so reopening on another tactic starts from its own values.
          <PanelForm key={tactic.id} tactic={tactic} identity={identity} inUse={inUse} onClose={onClose} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PanelForm({
  tactic,
  identity,
  inUse,
  onClose,
}: {
  tactic: TacticEditModel;
  identity: ActionIdentity;
  inUse: CustomTacticType[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Close once the refreshed page data has arrived, so the row already shows the edit.
  const [refreshing, startRefresh] = useTransition();
  const closeAfterRefresh = useRef(false);
  useEffect(() => {
    if (!refreshing && closeAfterRefresh.current) {
      closeAfterRefresh.current = false;
      onClose();
    }
  }, [refreshing, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (name: string) => String(data.get(name) ?? "").trim();
    const current: Record<string, string> = {
      name: tactic.name,
      type: tactic.type,
      evidence_question: tactic.evidence_question,
      start_date: tactic.start_date ?? "",
      evidence_available: tactic.evidence_available ?? "",
      budget: tactic.budget ?? "",
      owner: tactic.owner,
      function: tactic.function,
    };
    const fields: Record<string, string> = {};
    for (const field of TEXT_FIELDS) {
      // A month-only date ("2026-01") can't show in a date input; left blank, it stays as stored.
      const monthOnly = (field === "start_date" || field === "evidence_available") && /^\d{4}-\d{2}$/.test(current[field]!);
      if (monthOnly && !read(field)) continue;
      if (read(field) !== current[field]) fields[field] = read(field);
    }
    const customPosted = data.has("custom_type_label");
    const nextCustom = customPosted && read("custom_type_label")
      ? { label: read("custom_type_label"), color: read("custom_type_color") }
      : customPosted
        ? null
        : tactic.custom_type;
    const customChanged = customKey(nextCustom) !== customKey(tactic.custom_type);
    const status = read("status");
    const statusChanged = status !== tactic.status;
    const rationale = read("rationale");

    if (Object.keys(fields).length === 0 && !customChanged && !statusChanged) {
      setError("Nothing changed.");
      return;
    }
    if (rationale.length < 3) {
      setError("A short rationale is required. It is stored with the edit.");
      return;
    }
    setPending(true);
    setError(null);
    const actor = { actor_name: identity.actor_name, actor_function: identity.actor_function };
    let failure: string | null = null;
    if (Object.keys(fields).length > 0 || customChanged) {
      failure = await post({
        action: "modify_tactic",
        tactic_id: tactic.id,
        ...fields,
        ...(customChanged
          ? { custom_type_label: nextCustom?.label ?? "", custom_type_color: nextCustom?.color ?? "" }
          : {}),
        rationale,
        ...actor,
      });
    }
    if (!failure && statusChanged) {
      failure = await post({ action: "lock_tactic", tactic_id: tactic.id, status, note: rationale, ...actor });
    }
    setPending(false);
    if (failure) {
      setError(failure);
      router.refresh();
      return;
    }
    closeAfterRefresh.current = true;
    startRefresh(() => router.refresh());
  }

  const color = tacticColor(tactic);
  return (
    <form onSubmit={submit} className="flex min-h-full flex-col" aria-label={`Edit ${tactic.name}`}>
      <SheetHeader className="border-b border-border">
        <div className="flex items-center gap-2 pr-8">
          <span className="font-mono text-[11px] font-medium" style={{ color }}>
            {tactic.id}
          </span>
          <span className="rounded-sm bg-muted px-1.5 py-px text-[10px] capitalize text-foreground">{tactic.status}</span>
        </div>
        <SheetTitle className="text-[14px] font-bold tracking-tight">{tactic.name}</SheetTitle>
        <SheetDescription className="text-[11px]">
          Every change needs a rationale and is kept on the edit record.{" "}
          <Link href={`/tactics/${tactic.id}`} className="text-foreground">
            Open full page ↗
          </Link>
        </SheetDescription>
      </SheetHeader>

      <div className="grid flex-1 gap-3 px-4 py-3">
        <label className={LABEL}>
          Tactic name
          <input name="name" required defaultValue={tactic.name} className={FIELD} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className={LABEL}>
            Type
            <select name="type" defaultValue={tactic.type} className={FIELD}>
              {TACTIC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TACTIC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Status
            <select name="status" defaultValue={tactic.status} className={FIELD}>
              {TACTIC_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>
        <CustomTypeFields initial={tactic.custom_type} inUse={inUse} clearable />
        <label className={LABEL}>
          Evidence question (objective)
          <textarea
            name="evidence_question"
            required
            rows={3}
            defaultValue={tactic.evidence_question}
            className="w-full resize-none rounded-lg border border-input bg-card px-2.5 py-1.5 text-[12px] font-normal normal-case tracking-normal text-foreground"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className={LABEL}>
            Start date
            <input name="start_date" type="date" defaultValue={tactic.start_date ?? ""} className={FIELD} />
          </label>
          <label className={LABEL}>
            Evidence available
            <input name="evidence_available" type="date" defaultValue={tactic.evidence_available ?? ""} className={FIELD} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className={LABEL}>
            Budget
            <input name="budget" placeholder="e.g. $500K" maxLength={60} defaultValue={tactic.budget ?? ""} className={FIELD} />
          </label>
          <label className={LABEL}>
            Lead function
            <select name="function" defaultValue={tactic.function} className={FIELD}>
              {ACTOR_FUNCTIONS.map((fn) => (
                <option key={fn} value={fn}>
                  {FUNCTION_LABELS[fn]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={LABEL}>
          Lead (owner)
          <input name="owner" required defaultValue={tactic.owner} className={FIELD} />
        </label>
        <label className={LABEL}>
          Why? (required)
          <textarea
            name="rationale"
            rows={2}
            placeholder="What changed and why — stored with the edit"
            className="w-full resize-none rounded-lg border border-input bg-card px-2.5 py-1.5 text-[12px] font-normal normal-case tracking-normal text-foreground"
          />
        </label>
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-popover px-4 py-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || refreshing}>
          {pending || refreshing ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {pending || refreshing ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
