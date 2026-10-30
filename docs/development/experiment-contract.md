# Development draft API (KAN-201, version 1)

Every operation is owner-only and responds with `Cache-Control: no-store`. This setup API never executes generation or evaluation. All snapshots live in additive shared `development_*` tables, independently of customer sources and shared routing/settings.

- `GET /api/admin/development`: `{ experiments: Experiment[] }` (newest first).
- `POST /api/admin/development`: strict JSON `{ name: string, source_workspace_id: string | null }`, returns `{ experiment }`, 201. Null means private uploads only. Workspace is immutable after creation.
- `GET /api/admin/development/:id`: `{ experiment }`, including documents.
- `PATCH /api/admin/development/:id`: `{ name: string, revision: number }`, returns `{ experiment }`. Every mutation increments revision. Supply the latest revision on **all** writes. A stale revision returns 409 `stale_revision`; reload before retrying.
- `GET /api/admin/development/workspaces`: `{ workspaces: {id,name}[] }`.
- `GET /api/admin/development/:id/sources`: `{ sources: {id,filename,status}[] }` in the bound workspace; empty for private-only drafts.
- `POST /api/admin/development/:id/sources`: `{ revision, source_file_id }`. Copies existing original bytes and existing nonempty parsed content. It never runs customer ingestion. Unparsed sources return actionable 422.
- `POST /api/admin/development/:id/source-upload`: `{ revision, filename, content_base64 }` for supported existing upload formats.
- `POST /api/admin/development/:id/reference-upload`: `{ revision, filename, content_base64, format: "pdf" | "structured", section, source_document_ids: string[] }`. Associations must identify source snapshots belonging to this experiment. At least one is required. Structured JSON's section and source IDs must exactly match the envelope.
- `GET /api/admin/development/:id/documents/:documentId`: `{ document, content_base64 }`. This is the only response that contains original bytes.

Mutation success responses contain `{ experiment }`. `Experiment` has `id,name,source_workspace_id,owner,revision,status:"draft",created_at,updated_at,documents: DevelopmentDocument[]`. Document metadata contains `id,experiment_id,role:"source"|"reference",origin:"workspace"|"private",filename,mime,bytes,sha256,parsed_sha256,parsed,parser:{name,version,model,prompt},created_by,created_at,original_owner,original_created_at,parsed_at,source_workspace_id,source_file_id,section,source_document_ids,review_status:"not_applicable"|"unreviewed"|"provisional",compatibility:"compatible"|"incompatible"`. References are evaluator-only. Provisional AI parsing is never human approval. Missing or incompatible optional references do not block future source generation; only compatible section references may support reference-based measures. A reference is compatible when its section-specific expected answers validate; a readable PDF whose semantic result cannot validate is retained as incompatible/provisional.

## Strict structured reference format

UTF-8 `.json`, maximum `MAX_UPLOAD_BYTES` (3 MiB), nonempty. Unknown keys, empty expected answers, duplicate record IDs, null required fields and invalid associations are rejected. Version 1:

```json
{
  "version": 1,
  "section": "gap_extraction",
  "source_document_ids": ["development-source-snapshot-id"],
  "expected_answers": [
    {
      "id": "g1",
      "statement": "Need comparative survival evidence",
      "source_document_id": "development-source-snapshot-id",
      "quote": "Need comparative survival evidence"
    }
  ]
}
```

All answer records are strict objects. Strings must be nonblank and at most 10,000 characters. Record IDs and associations are at most 200 characters. At most 2,000 answers and 100 source associations are accepted. Each record's source must be among the associated snapshots. Validated IDs and text are trimmed before saving the parsed representation, including PDF expected answers. The original uploaded bytes retain their exact whitespace and contents.

| section             | expected answer record                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `gap_extraction`    | `{id,statement,source_document_id,quote}`                                                                                       |
| `tactic_extraction` | `{id,title,description,source_document_id,quote}`                                                                               |
| `matching_coverage` | `{id,gap_id,tactic_id,relevance:"relevant"\|"irrelevant",coverage:"addressed"\|"partial"\|"open",rationale,source_document_id}` |
| `partial_splitting` | `{id,parent_gap_id,addressed_statement,residual_statement,tactic_ids:string[],source_document_id}`                              |

Original bytes and canonical parsed representation each have SHA-256 identities. `sha256` hashes the original file bytes. `parsed_sha256` is the lowercase hexadecimal SHA-256 digest of the UTF-8 bytes returned by `canonicalParsedJson(parsed)`. That serialization first applies JavaScript `JSON.stringify` followed by `JSON.parse`, matching persisted JSON semantics: undefined object properties are omitted, undefined array entries and non-finite numbers become null, and values with no JSON representation, BigInt or circular references are rejected. It then recursively emits compact JSON: object keys sorted lexicographically by JavaScript UTF-16 code units (including numeric-looking keys), array order retained, and primitive keys/values encoded using `JSON.stringify`. There is no whitespace or trailing newline. This same algorithm reproduces the identity from a reopened PostgreSQL JSON payload, regardless of object-key insertion order. For example, both `{ "b": 2, "a": 1 }` and `{ "a": 1, "b": 2 }` serialize as `{"a":1,"b":2}`. Structured imports use parser `development-structured-reference` version `1`, null model/prompt, unreviewed status. Workspace snapshots retain original parser/version and existing parsed blocks. Private source parsing reuses `extractRawUnits` / `parseWithLlm` and existing limits (2,000 units, 50 chunk calls, configurable via existing parse-limit environment variables); empty and malformed documents are refused. LLM preparation checks the platform ingestion AI switch, uses existing routing/completion provider policies and test stub, and retains actual model/provider call identities with prompt identity. PDF references first reuse document parsing then request a section-specific structured reference from the production completion boundary, saving provisional results. No uploaded reference is sent to source parsing or generation.

Errors: `{ error: string, code: string }`; 400 invalid JSON/schema/base64 or unsupported format, 401 signed out, 403 owner denied, 404 unknown draft/workspace/document/source, 409 stale revision or AI/provider unavailable, 413 oversize body/file, 422 empty/unparseable source/reference. Safe errors explain corrective action and never include raw exceptions or credentials. Failed parsing creates no partial document and does not consume a revision. Future KAN-202/204 execution must use immutable source-only snapshots for generation and separately bind evaluator-only references.
