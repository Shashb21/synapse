"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const ROLES = [
  { id: "interview", label: "Interview" },
  { id: "medical", label: "Medical" },
  { id: "heor", label: "HEOR" },
  { id: "publications", label: "Publications" },
  { id: "iis", label: "IIS" },
  { id: "other", label: "Other" },
] as const;

export function SourceUploadForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [docRole, setDocRole] = useState<string>("medical");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSummary(null);
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) {
      setError("Choose a PPTX, DOCX, XLSX, or PDF file.");
      return;
    }

    const body = new FormData();
    body.set("workspace_id", workspaceId);
    body.set("doc_role", docRole);
    body.set("file", file);

    startTransition(async () => {
      const res = await fetch("/api/accuracy/sources/upload", {
        method: "POST",
        body,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        filename?: string;
        block_count?: number;
        parser?: string;
        parse_error?: string | null;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Upload failed");
        return;
      }
      if (json.parse_error) {
        setSummary(
          `Registered ${json.filename} (${json.parser}) but parse failed: ${json.parse_error}`,
        );
      } else {
        setSummary(
          `Uploaded ${json.filename} → ${json.block_count ?? 0} blocks (${json.parser})`,
        );
      }
      form.reset();
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mb-4 grid gap-3 border border-dashed border-border bg-card/30 p-3"
    >
      <h3 className="text-[13px] font-medium text-foreground">Upload source</h3>
      <p className="text-[12px] text-muted-foreground">
        PPTX/DOCX/XLSX parse locally. PDF needs <code>LLAMA_CLOUD_API_KEY</code>.
      </p>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Doc role</span>
        <select
          className="border border-border bg-background px-2 py-1.5 text-[13px]"
          value={docRole}
          onChange={(e) => setDocRole(e.target.value)}
        >
          {ROLES.map((role) => (
            <option key={role.id} value={role.id}>
              {role.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">File</span>
        <input
          name="file"
          type="file"
          accept=".pptx,.ppt,.docx,.xlsx,.xls,.pdf,.txt,.md"
          className="text-[12px]"
          required
        />
      </label>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      {summary ? <p className="text-[12px] text-muted-foreground">{summary}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[12px] text-background disabled:opacity-50"
      >
        {pending ? "Uploading…" : "Upload & parse"}
      </button>
    </form>
  );
}
