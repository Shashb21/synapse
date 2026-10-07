import Link from "next/link";
import type { ProvenanceSpan } from "@/accuracy/store/quote-validator";
import type { GapStructuredFields, TacticStructuredFields } from "@/accuracy/domain/structured-fields";

export function ClaimEvidence({ workspaceId, spans }: { workspaceId: string; spans: ProvenanceSpan[] }) {
  return <ul className="grid gap-1 text-[11px] text-muted-foreground">
    {spans.map((span, index) => <li key={`${span.block_id}:${index}`}>
      <q>{span.quote}</q>{" "}
      <Link className="underline" href={`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}&block_id=${encodeURIComponent(span.block_id)}#${encodeURIComponent(span.block_id)}`}>
        Source {span.source_file_id} · block {span.block_id}
      </Link>
    </li>)}
  </ul>;
}

function factText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(factText).join("; ");
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if ("source_label" in row) return `${row.source_label} (${row.evidence_domain})`;
    if ("title" in row) return `${row.title} (${row.resolution}${row.document_id ? ` · ${row.document_id}` : ""})`;
    if ("quote" in row) {
      const quote = row.quote as ProvenanceSpan;
      const speaker = row.speaker as { state: string; value?: string; reason?: string };
      const role = row.role as typeof speaker;
      return `${quote.quote} — speaker: ${speaker.state === "known" ? speaker.value : `Unknown (${speaker.reason})`}; role: ${role.state === "known" ? role.value : `Unknown (${role.reason})`}`;
    }
  }
  return "";
}

export function StructuredClaimFacts({ workspaceId, fields }: { workspaceId: string; fields: GapStructuredFields | TacticStructuredFields }) {
  return <details className="mt-2 text-[12px]" open>
    <summary>Structured facts and source evidence</summary>
    <dl className="mt-2 grid gap-2">
      {Object.entries(fields).filter(([key]) => key !== "version").map(([key, field]) => {
        const label = key.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
        return <div key={key}>
          <dt className="inline font-medium">{label}: </dt>
          <dd className="inline">{field.state === "known" ? factText(field.value) : `Unknown (${field.reason})`}</dd>
          {field.state === "known" ? <ClaimEvidence workspaceId={workspaceId} spans={field.provenance} /> : null}
          {key === "supporting_documents" && field.state === "known" && Array.isArray(field.value) ? field.value.map((doc: { title: string; source_file_id?: string | null }, index: number) => doc.source_file_id ?
            <Link key={index} className="ml-2 underline" href={`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}&source_file_id=${encodeURIComponent(doc.source_file_id)}#source-${encodeURIComponent(doc.source_file_id)}`}>{doc.title}</Link> : null) : null}
        </div>;
      })}
    </dl>
  </details>;
}
