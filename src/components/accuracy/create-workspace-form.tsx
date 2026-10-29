"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useAiEnabled } from "@/components/platform/ai-status";
import { postJson } from "@/lib/post-json";

export function CreateWorkspaceForm() {
  const router = useRouter();
  const aiOn = useAiEnabled();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [planLabel, setPlanLabel] = useState<"IEP" | "IEGP">("IEGP");
  const [error, setError] = useState<string | null>(null);
  const [checkRequired, setCheckRequired] = useState(false);

  function onNameChange(value: string) {
    setName(value);
    if (!slug || slug === slugify(name)) setSlug(slugify(value));
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || checkRequired) return;
    setError(null);
    startTransition(async () => {
      const res = await postJson("/api/accuracy/workspaces", { name, slug, plan_label: planLabel });
      const body = res.json as { ok?: boolean; workspace_id?: string; error?: string };
      if (!res.ok || !body.ok || !body.workspace_id) {
        setCheckRequired(res.outcome !== "rejected");
        setError(body.error ?? "We couldn’t confirm the new workspace. Reload the workspace list before creating it again.");
        return;
      }
      // AI off: land on hand entry of gaps (there is nothing to upload or extract).
      router.push(
        `/admin/accuracy/ledger?workspace_id=${encodeURIComponent(body.workspace_id)}${aiOn ? "" : "&add=gap"}`,
      );
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 border border-border bg-card p-3 rounded-lg">
      <h3 className="text-[12px] font-semibold text-foreground">Create workspace</h3>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Name</span>
        <input
          className="border border-border bg-background px-2 py-1.5 text-[13px]"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          required
          minLength={2}
        />
      </label>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Slug</span>
        <input
          className="border border-border bg-background px-2 py-1.5 font-mono text-[12px]"
          value={slug}
          onChange={(e) => setSlug(slugify(e.target.value))}
          pattern="[a-z0-9-]+"
          required
          minLength={2}
        />
      </label>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Plan label</span>
        <select
          className="border border-border bg-background px-2 py-1.5 text-[13px]"
          value={planLabel}
          onChange={(e) => setPlanLabel(e.target.value === "IEP" ? "IEP" : "IEGP")}
        >
          <option value="IEGP">IEGP</option>
          <option value="IEP">IEP</option>
        </select>
      </label>
      {checkRequired ? <button type="button" onClick={() => window.location.reload()} className="text-sm underline">Check workspace list</button> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button
        type="submit"
        disabled={pending || checkRequired}
        className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[12px] text-background disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
