import { sql } from "drizzle-orm";
import { sharedDb } from "./db";
import { TrustedApplicationError } from "./stage-errors";
import { newId } from "./ids";
import type { Observation, RevisionEvaluation } from "./prompt-revision-evals";

export type SealedBatch = Pick<RevisionEvaluation, "calls" | "failures"> & {
  observations: Observation[];
  interrupted: boolean;
  disqualified: boolean;
};

export type Attempt = { workspace: string; revision: string; token: string };

/** A renewable, fenced claim. No connection is retained while a provider runs. */
export async function claimRevisionBatch(
  workspace: string,
  revision: string,
): Promise<{ attempt: Attempt; sealed?: SealedBatch } | { bound: RevisionEvaluation }> {
  const token = newId("pra");
  const rows = await sharedDb().execute(sql`insert into prompt_revision_attempts (workspace_id,revision_id,token,lease_until)
    values (${workspace},${revision},${token},now()+interval '30 minutes')
    on conflict (workspace_id,revision_id) do update set token=excluded.token,lease_until=excluded.lease_until
    where prompt_revision_attempts.bound_id is null and (prompt_revision_attempts.regression is null or prompt_revision_attempts.sealed_result is not null)
    and (prompt_revision_attempts.token is null or prompt_revision_attempts.lease_until<now()) returning token,sealed_result`);
  if (rows.length)
    return { attempt: { workspace, revision, token }, sealed: rows[0].sealed_result as SealedBatch | undefined };
  const bound = await sharedDb().execute(sql`select e.evidence,a.regression from prompt_revision_attempts a
    left join prompt_revision_evaluations e on e.id=a.bound_id and e.revision_id=a.revision_id and e.workspace_id=a.workspace_id
    where a.workspace_id=${workspace} and a.revision_id=${revision}`);
  if (bound[0]?.evidence) return { bound: bound[0].evidence as RevisionEvaluation };
  if (bound[0]?.regression)
    throw new TrustedApplicationError(
      "This candidate regressed or missed the improvement margin on a completed repeat. Generate a new candidate.",
    );
  throw new TrustedApplicationError("An evaluation of this candidate is already in progress.");
}

export async function refreshRevisionBatch(
  attempt: Attempt,
  regression?: Pick<Observation, "case_id" | "repeat"> | { repeat: number; reason: "completed_repeat_below_margin" },
) {
  const rows = await sharedDb().execute(sql`update prompt_revision_attempts set lease_until=now()+interval '30 minutes',
    regression=coalesce(regression,${regression ? JSON.stringify(regression) : null}::jsonb)
    where workspace_id=${attempt.workspace} and revision_id=${attempt.revision} and token=${attempt.token} and bound_id is null returning token`);
  if (!rows.length) throw new TrustedApplicationError("This evaluation lost its claim. Reload the candidate.");
}

/** Before postflight I/O, persist exactly what can be finalized. Reclaimed sealed claims can only replay this receipt. */
export async function sealRevisionBatch(attempt: Attempt, measured: SealedBatch) {
  const rows = await sharedDb()
    .execute(sql`update prompt_revision_attempts set sealed_result=${JSON.stringify(measured)}::jsonb
    where workspace_id=${attempt.workspace} and revision_id=${attempt.revision} and token=${attempt.token} and bound_id is null and sealed_result is null returning token`);
  if (!rows.length) throw new TrustedApplicationError("This evaluation lost its claim. Reload the candidate.");
}
export async function releaseSealedBatch(attempt: Attempt) {
  await sharedDb().execute(sql`update prompt_revision_attempts set token=null
    where workspace_id=${attempt.workspace} and revision_id=${attempt.revision} and token=${attempt.token} and sealed_result is not null and bound_id is null`);
}

export function pairRegressed(left: Observation, right: Observation) {
  return Object.keys(left.metrics).some((name) => right.metrics[name] < left.metrics[name]);
}
