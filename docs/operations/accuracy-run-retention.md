# Accuracy run document retention

Parse implementations need the original bytes while processing. Run diagnostics retain
only `workspace_id`, `source_file_id`, `filename`, `mime`, SHA-256 `checksum` and decoded
`byte_count` when available. The recorder derives missing fingerprints without changing
parser input. All new structured run telemetry removes `content_base64` keys recursively
before truncation. Ordinary parsed text, model traces and source data remain available.

Historic reads project parse input and accepted-input step data inside PostgreSQL, so a
40 MiB upload is not transferred to the API process as base64. Historic missing checksums
or byte counts remain absent; reads do not decode old documents to backfill them. Other
structured fields have payload keys removed before return. This read protection does not
erase existing database rows, backups, write-ahead logs or replicas.

## Optional historic cleanup

Run this manually through an authenticated PostgreSQL client against the intended database.
Confirm the database and backup policy with its operator first. This is a maintenance
procedure, not an application migration. Use a maintenance window or batch by run ID for
large tables: updates acquire row locks and create write-ahead log traffic. No raw document
values are selected in the preview below. Keep a rollback window before commit.

The temporary function exists only in this connection and projects typed metadata. It
omits missing or malformed values. Do not copy unknown extra keys into the allowlist.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION pg_temp.safe_parse_run_metadata(payload jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(payload) = 'object'
                      THEN payload ELSE '{}'::jsonb END)
  WHERE (key IN ('workspace_id', 'source_file_id', 'filename', 'mime', 'checksum')
         AND jsonb_typeof(value) = 'string')
     OR (key = 'byte_count' AND CASE WHEN jsonb_typeof(value) = 'number'
         THEN (value::text)::numeric BETWEEN 0 AND 9007199254740991
          AND trunc((value::text)::numeric) = (value::text)::numeric
         ELSE false END);
$$;

-- Preview counts and safe identifiers; no raw input or preview strings are returned.
SELECT count(*) AS parse_runs,
       count(*) FILTER (WHERE input IS DISTINCT FROM pg_temp.safe_parse_run_metadata(input))
         AS inputs_to_replace,
       sum(pg_column_size(input)) AS current_input_storage_bytes
FROM accuracy_module_runs WHERE call_kind = 'parse';

SELECT id, workspace_id, pg_temp.safe_parse_run_metadata(input) AS safe_input,
       pg_column_size(input) AS current_input_storage_bytes
FROM accuracy_module_runs WHERE call_kind = 'parse'
ORDER BY started_at DESC LIMIT 20;

SELECT count(*) AS accepted_steps_to_replace
FROM accuracy_module_runs r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r.steps) = 'array' THEN r.steps ELSE '[]'::jsonb END
) AS s(step)
WHERE r.call_kind = 'parse' AND step->>'name' = 'input:accepted'
  AND step->'data' IS DISTINCT FROM pg_temp.safe_parse_run_metadata(r.input);

-- Replace historic inputs and every accepted-input data object, including old previews.
-- Other steps (parsed content, model traces, persistence results) are retained verbatim.
UPDATE accuracy_module_runs r
SET input = pg_temp.safe_parse_run_metadata(r.input),
    steps = CASE WHEN jsonb_typeof(r.steps) = 'array' THEN COALESCE((
      SELECT jsonb_agg(CASE WHEN step->>'name' = 'input:accepted'
        THEN (step - 'data') || jsonb_build_object('data', pg_temp.safe_parse_run_metadata(r.input))
        ELSE step END ORDER BY ordinal)
      FROM jsonb_array_elements(r.steps) WITH ORDINALITY AS entries(step, ordinal)
    ), '[]'::jsonb) ELSE r.steps END
WHERE r.call_kind = 'parse';

-- Verification: both counts must be zero before considering COMMIT.
SELECT count(*) AS unsafe_parse_inputs
FROM accuracy_module_runs
WHERE call_kind = 'parse'
  AND input IS DISTINCT FROM pg_temp.safe_parse_run_metadata(input);

SELECT count(*) AS unsafe_accepted_steps
FROM accuracy_module_runs r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r.steps) = 'array' THEN r.steps ELSE '[]'::jsonb END
) AS s(step)
WHERE r.call_kind = 'parse' AND step->>'name' = 'input:accepted'
  AND step->'data' IS DISTINCT FROM pg_temp.safe_parse_run_metadata(r.input);

-- Rehearsal default: undo all updates. Review counts before rerunning to commit.
ROLLBACK;
-- For an approved maintenance execution, replace ROLLBACK above with COMMIT.
```

This procedure changes only `accuracy_module_runs.input` and accepted-input step data for
parse runs. It preserves `accuracy_source_files`, parse blocks, claims, model traces and
all non-parse runs. After cleanup, verify an owner request to
`/api/accuracy/runs?workspace_id=<workspace>` retains status, timing, cost and safe file
metadata while omitting raw payloads and accepted-input previews. Compare a previously
large run with a small one: response size should follow metadata, not the uploaded bytes.

A committed update cannot be undone with `ROLLBACK`. Existing backups, snapshots, replicas
and archived write-ahead logs may still contain historical raw bytes until their normal
retention expires. A restore can reintroduce them; deploy the safe reader and repeat this
cleanup after a restore. Ordinary vacuum can reclaim obsolete storage over time; it does
not guarantee secure physical erasure. Do not shorten backup retention or run `VACUUM FULL`
without the database operator's separate maintenance plan.
