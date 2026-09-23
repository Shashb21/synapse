"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [planLabel, setPlanLabel] = useState<"IEP" | "IEGP">("IEGP");
  const [error, setError] = useState<string | null>(null);

  function onNameChange(value: string) {
    setName(value);
    if (!slug || slug === slugify(name)) setSlug(slugify(value));
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/accuracy/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug, plan_label: planLabel }),
      });
      const body = (await res.json()) as { ok?: boolean; workspace_id?: string; error?: string };
      if (!res.ok || !body.ok || !body.workspace_id) {
        setError(body.error ?? "Create failed");
        return;
      }
      router.push(`/accuracy/ledger?workspace_id=${encodeURIComponent(body.workspace_id)}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 border border-border bg-card/40 p-3">
      <h3 className="text-[13px] font-medium text-foreground">Create workspace</h3>
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
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
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
