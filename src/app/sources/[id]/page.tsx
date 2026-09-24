import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import {
  generationOf,
  listDroppedSourceUnits,
  listSourceBlocks,
  readSourceStakeholder,
} from "@/lib/iegp/source-blocks";
import { loadState } from "@/lib/iegp/store";
import { listEdits } from "@/modules/kernel/edit-records";
import { sessionContext } from "@/modules/auth/session";

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/sources/blocks";

function label(fn: string | null) {
  return fn ? (FUNCTION_LABELS[fn as ActorFunction] ?? fn) : "—";
}

export default async function SourceBlocksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await loadState();
  const source = state.sources.find((s) => s.id === id);
  if (!source) notFound();
  const [blocks, dropped, stakeholder, identityContext, since] = await Promise.all([
    listSourceBlocks(id),
    listDroppedSourceUnits(id),
    readSourceStakeholder(id),
    sessionContext(),
    generationOf(id),
  ]);
  const edits = (await listEdits({ stage: "S1", limit: 500 })).filter(
    (edit) => (edit.entity_id === id || edit.entity_id.startsWith(`${id}-`)) && edit.at >= (since ?? ""),
  );
  const identity: ActionIdentity = {
    signed_in: identityContext.signed_in,
    actor_name: identityContext.actor.name,
    actor_function: identityContext.actor.function,
  };
  const functionOptions = ACTOR_FUNCTIONS.map((fn) => ({ value: fn, label: FUNCTION_LABELS[fn] }));
  const humanCount = blocks.filter((b) => b.human).length;

  return (
    <AppShell active="sources">
      <PageIntro kicker={`Source ${source.id} · ${source.filename}`} title={source.title}>
        Blocks in reading order. Edit, split, merge, delete or add a block by hand; every change needs a
        rationale and is kept on the audit trail. Human blocks are locked: a re-parse of this file keeps
        them and only replaces model blocks. An edit that would orphan a need&apos;s quote is refused.{" "}
        <Link href="/sources" className="underline-offset-2 hover:underline">
          All sources
        </Link>
      </PageIntro>

      <section className="mb-4 border border-border bg-card/40 p-3" aria-labelledby="stakeholder">
        <h2 id="stakeholder" className="text-[13px] font-medium text-foreground">
          Stakeholder function
        </h2>
        <p className="mt-1 text-[12px] text-foreground">
          {label(stakeholder.stakeholder_function)}{" "}
          <span className="text-[11px] text-muted-foreground">
            ({stakeholder.set_by === "human" ? `set by ${stakeholder.override_by}` : "chosen at upload"})
          </span>
        </p>
        {stakeholder.override_rationale ? (
          <p className="text-[11px] text-muted-foreground">Why: {stakeholder.override_rationale}</p>
        ) : null}
        <p className="mt-1 text-[11px] text-muted-foreground">
          Model&apos;s classification: {stakeholder.llm_function ?? "none (not parsed by a model)"}
          {stakeholder.llm_rationale ? ` — ${stakeholder.llm_rationale}` : ""}
        </p>
        <div className="mt-2">
          <ActionDialog
            endpoint={ENDPOINT}
            payload={{ action: "set_stakeholder", source_id: id }}
            label="Set stakeholder function"
            description="Overrides the upload choice and the model's classification. Later re-parses keep it."
            fields={[
              {
                name: "stakeholder_function",
                label: "Stakeholder function",
                type: "select",
                options: functionOptions,
                defaultValue: stakeholder.stakeholder_function,
              },
            ]}
            identity={identity}
          />
        </div>
      </section>

      <section className="mb-4 border border-border bg-card/40 p-3" aria-labelledby="blocks">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="blocks" className="text-[13px] font-medium text-foreground">
            {blocks.length} block(s) · {humanCount} human
          </h2>
          <ActionDialog
            endpoint={ENDPOINT}
            payload={{ action: "add", source_id: id, after_block_id: null }}
            label="Add block at top"
            fields={[
              { name: "text", label: "Text", type: "textarea", required: true },
              { name: "heading", label: "Heading", defaultValue: source.title },
            ]}
            identity={identity}
          />
        </div>
        <ol className="mt-2 grid gap-2">
          {blocks.map((block, index) => (
            <li key={block.id} className="border border-border/60 bg-background/40 p-2" data-block-id={block.id}>
              <p className="text-[11px] text-muted-foreground">
                #{index + 1} · {block.heading} · {block.location}
                {" · "}
                <span className={block.human ? "text-foreground" : undefined}>
                  {block.origin === "human" ? "human-entered" : block.human ? "model, edited by a human" : "model"}
                </span>
                {block.edited_by ? ` · ${block.edited_by}` : ""}
                {block.cited_by.length ? ` · quoted by ${block.cited_by.join(", ")}` : ""}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">{block.id}</p>
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground">
                {block.text}
              </pre>
              {block.original_text && block.original_text !== block.text ? (
                <details className="mt-1 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer">Model&apos;s original text</summary>
                  <pre className="whitespace-pre-wrap font-sans">{block.original_text}</pre>
                </details>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "edit", block_id: block.id }}
                  label="Edit"
                  fields={[
                    { name: "text", label: "Text", type: "textarea", defaultValue: block.text },
                    { name: "heading", label: "Heading", defaultValue: block.heading },
                    { name: "location", label: "Location", defaultValue: block.location },
                  ]}
                  identity={identity}
                />
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "split", block_id: block.id }}
                  label="Split"
                  description="The second block starts at the text you give. A cited quote may not straddle the split."
                  fields={[{ name: "at_text", label: "Second block starts with", required: true }]}
                  identity={identity}
                />
                {index < blocks.length - 1 ? (
                  <ActionDialog
                    endpoint={ENDPOINT}
                    payload={{ action: "merge", block_id: block.id }}
                    label="Merge with next"
                    identity={identity}
                  />
                ) : null}
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "add", source_id: id, after_block_id: block.id }}
                  label="Add after"
                  fields={[
                    { name: "text", label: "Text", type: "textarea", required: true },
                    { name: "heading", label: "Heading", defaultValue: block.heading },
                  ]}
                  identity={identity}
                />
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "delete", block_id: block.id }}
                  label="Delete"
                  description="Refused while a need quotes this block. A re-parse will not bring it back."
                  identity={identity}
                />
              </div>
            </li>
          ))}
        </ol>
      </section>

      {dropped.length > 0 ? (
        <section className="mb-4 border border-border bg-card/40 p-3" aria-labelledby="dropped">
          <h2 id="dropped" className="text-[13px] font-medium text-foreground">
            Dropped by the model as noise
          </h2>
          <ul className="mt-2 grid gap-2">
            {dropped.map((unit) => (
              <li key={unit.id} className="border border-border/60 p-2 text-[12px]">
                <p className="text-[11px] text-muted-foreground">
                  {unit.location} · {unit.reason}
                  {unit.restored_block_id ? ` · restored as ${unit.restored_block_id}` : ""}
                </p>
                <pre className="whitespace-pre-wrap font-sans">{unit.text}</pre>
                {!unit.restored_block_id ? (
                  <ActionDialog
                    endpoint={ENDPOINT}
                    payload={{ action: "restore_dropped", dropped_id: unit.id }}
                    label="Restore as block"
                    identity={identity}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="border border-border bg-card/40 p-3" aria-labelledby="trail">
        <h2 id="trail" className="text-[13px] font-medium text-foreground">
          Edit trail
        </h2>
        {edits.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">No human edits yet.</p>
        ) : (
          <ul className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
            {edits.map((edit) => (
              <li key={edit.id}>
                {edit.at.slice(0, 16).replace("T", " ")} · {edit.actor.name} · {edit.action} {edit.field} on{" "}
                {edit.entity_id} — {edit.rationale}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
