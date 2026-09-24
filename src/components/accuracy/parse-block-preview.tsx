import type { ParseBlockPreview as ParseBlockPreviewModel } from "@/accuracy/store/parse-preview";
import type { BlockProvenanceMeta, SourceStakeholder } from "@/accuracy/store/parse-store";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";

const ENDPOINT = "/api/accuracy/sources/blocks";

export type ParseBlockEditContext = {
  workspaceId: string;
  sourceFileId: string;
  identity: ActionIdentity;
  kinds: readonly string[];
};

type PreviewBlock = ParseBlockPreviewModel & { provenance?: BlockProvenanceMeta };

function originLabel(p: BlockProvenanceMeta | undefined): string {
  if (!p) return "";
  if (p.origin === "human") return "human-entered";
  return p.human ? "model, edited by a human" : "model";
}

/**
 * Sources parse-block preview. Renders stored `text` verbatim (whitespace preserved)
 * so copied quotes remain substring-validatable against `accuracy_parse_blocks`.
 * With `edit`, every block gets edit / split / merge / add-after / delete actions
 * (rationale required, audited; refused when a claim's quote would be orphaned).
 */
export function ParseBlockPreview({
  blocks,
  edit,
}: {
  blocks: PreviewBlock[];
  edit?: ParseBlockEditContext;
}) {
  const kindOptions = (edit?.kinds ?? []).map((k) => ({ value: k, label: k }));
  const addFirst = edit ? (
    <ActionDialog
      endpoint={ENDPOINT}
      payload={{ action: "add", workspace_id: edit.workspaceId, source_file_id: edit.sourceFileId }}
      label="Add block"
      description="Appended at the end, labelled human-entered and kept by every re-parse."
      fields={[
        { name: "text", label: "Text", type: "textarea", required: true },
        { name: "kind", label: "Kind", type: "select", options: kindOptions, defaultValue: "prose" },
        { name: "heading", label: "Heading" },
      ]}
      identity={edit.identity}
    />
  ) : null;

  if (blocks.length === 0) {
    return (
      <div className="mt-2">
        <p className="text-[11px] text-muted-foreground" data-testid="parse-block-preview-empty">
          No parse blocks to preview.
        </p>
        {addFirst}
      </div>
    );
  }

  const humanCount = blocks.filter((b) => b.provenance?.human).length;
  return (
    <details className="mt-2 border border-border/70 bg-background/40 p-2" data-testid="parse-block-preview">
      <summary className="cursor-pointer text-[12px] text-foreground">
        Preview {blocks.length} parse block{blocks.length === 1 ? "" : "s"} (verbatim)
        {humanCount ? ` · ${humanCount} human` : ""}
      </summary>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Quotes must be substrings of this text. One source file per preview — packs stay isolated.
        {edit ? " Human blocks are locked: a re-parse keeps them and replaces only model blocks." : ""}
      </p>
      {addFirst ? <div className="mt-2">{addFirst}</div> : null}
      <ol className="mt-2 grid max-h-[32rem] gap-2 overflow-auto">
        {blocks.map((block, index) => (
          <li
            key={block.id}
            className="border border-border/60 bg-card/30 p-2"
            data-testid="parse-block-item"
            data-block-id={block.id}
            data-source-file-id={block.source_file_id}
            data-origin={block.provenance?.origin}
          >
            <p className="text-[11px] text-muted-foreground">
              #{block.index} · {block.kind}
              {block.heading ? ` · ${block.heading}` : ""}
              {block.provenance ? ` · ${originLabel(block.provenance)}` : ""}
              {block.provenance?.edited_by ? ` · ${block.provenance.edited_by}` : ""}
              {block.provenance?.cited_by.length ? ` · quoted by ${block.provenance.cited_by.join(", ")}` : ""}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">{block.id}</p>
            <pre
              data-testid="parse-block-text"
              className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground"
            >
              {block.text}
            </pre>
            {block.provenance?.original_text && block.provenance.original_text !== block.text ? (
              <details className="mt-1 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">Model&apos;s original text</summary>
                <pre className="whitespace-pre-wrap font-sans">{block.provenance.original_text}</pre>
              </details>
            ) : null}
            {edit ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "edit", workspace_id: edit.workspaceId, block_id: block.id }}
                  label="Edit"
                  description="Refused if a claim's quote would no longer be in the text."
                  fields={[
                    { name: "text", label: "Text", type: "textarea", defaultValue: block.text },
                    { name: "kind", label: "Kind", type: "select", options: kindOptions, defaultValue: block.kind },
                    { name: "heading", label: "Heading", defaultValue: block.heading ?? "" },
                  ]}
                  identity={edit.identity}
                />
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "split", workspace_id: edit.workspaceId, block_id: block.id }}
                  label="Split"
                  description="The second block starts at the text you give. Cited quotes follow their half."
                  fields={[{ name: "at_text", label: "Second block starts with", required: true }]}
                  identity={edit.identity}
                />
                {index < blocks.length - 1 ? (
                  <ActionDialog
                    endpoint={ENDPOINT}
                    payload={{ action: "merge", workspace_id: edit.workspaceId, block_id: block.id }}
                    label="Merge with next"
                    identity={edit.identity}
                  />
                ) : null}
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{
                    action: "add",
                    workspace_id: edit.workspaceId,
                    source_file_id: edit.sourceFileId,
                    after_block_id: block.id,
                  }}
                  label="Add after"
                  fields={[
                    { name: "text", label: "Text", type: "textarea", required: true },
                    { name: "kind", label: "Kind", type: "select", options: kindOptions, defaultValue: "prose" },
                    { name: "heading", label: "Heading", defaultValue: block.heading ?? "" },
                  ]}
                  identity={edit.identity}
                />
                <ActionDialog
                  endpoint={ENDPOINT}
                  payload={{ action: "delete", workspace_id: edit.workspaceId, block_id: block.id }}
                  label="Delete"
                  description="Refused while a claim quotes this block. A re-parse will not bring it back."
                  identity={edit.identity}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Stakeholder classification (model + human override) and the units the model dropped. */
export function ParseSourceControls({
  edit,
  stakeholder,
  stakeholderOptions,
  dropped,
}: {
  edit: ParseBlockEditContext;
  stakeholder: SourceStakeholder;
  stakeholderOptions: readonly string[];
  dropped: { id: string; location: string; reason: string; text: string; restored_block_id: string | null }[];
}) {
  return (
    <div className="mt-2 grid gap-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Stakeholder function:{" "}
          <span className="text-foreground">{stakeholder.stakeholder_function ?? "not set"}</span>
          {stakeholder.set_by === "human"
            ? ` (set by ${stakeholder.override_by}: ${stakeholder.override_rationale})`
            : stakeholder.set_by === "llm"
              ? " (model)"
              : ""}
        </span>
        <ActionDialog
          endpoint={ENDPOINT}
          payload={{ action: "set_stakeholder", workspace_id: edit.workspaceId, source_file_id: edit.sourceFileId }}
          label="Set"
          title="Set stakeholder function"
          description="Overrides the model's classification. Later re-parses keep it."
          fields={[
            {
              name: "stakeholder_function",
              label: "Stakeholder function",
              type: "select",
              options: stakeholderOptions.map((v) => ({ value: v, label: v })),
              defaultValue: stakeholder.stakeholder_function ?? undefined,
            },
          ]}
          identity={edit.identity}
        />
      </div>
      {stakeholder.llm_function ? (
        <p>
          Model&apos;s classification: {stakeholder.llm_function} — {stakeholder.llm_rationale}
        </p>
      ) : null}
      {dropped.length > 0 ? (
        <details>
          <summary className="cursor-pointer">{dropped.length} unit(s) the model dropped as noise</summary>
          <ul className="mt-1 grid gap-1">
            {dropped.map((unit) => (
              <li key={unit.id} className="border border-border/60 p-2">
                <p>
                  {unit.location} · {unit.reason}
                  {unit.restored_block_id ? ` · restored as ${unit.restored_block_id}` : ""}
                </p>
                <pre className="whitespace-pre-wrap font-sans text-foreground">{unit.text}</pre>
                {!unit.restored_block_id ? (
                  <ActionDialog
                    endpoint={ENDPOINT}
                    payload={{ action: "restore_dropped", workspace_id: edit.workspaceId, dropped_id: unit.id }}
                    label="Restore as block"
                    identity={edit.identity}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
