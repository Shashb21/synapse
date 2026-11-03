/** Append-only experiment-local rubric versions, serialized against stale concurrent edits. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { DevelopmentError } from './schema';
import { getExperiment, ensureDevelopmentTables } from './store';
import { balancedProfile, profileInputSchema, type EvaluationProfile, type ProfileInput } from './profile-schema';
let ready: Promise<void> | undefined;
/** Install additive profile storage and database-level history protection. */
export async function ensureProfileTables(): Promise<void> {
  ready ??= (async () => {
    await ensureDevelopmentTables();
    await sharedDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('development-profile-schema'))`);
      await tx.execute(sql`create table if not exists development_profiles (id text not null, experiment_id text not null references development_experiments(id), version integer not null, record jsonb not null, primary key(id,version))`);
      await tx.execute(sql`create or replace function development_profile_immutable() returns trigger language plpgsql as $$ begin raise exception 'profile versions are immutable'; end $$`);
      await tx.execute(sql`do $$ begin if not exists(select 1 from pg_trigger where tgname='development_profile_immutable_trigger') then create trigger development_profile_immutable_trigger before update or delete on development_profiles for each row execute function development_profile_immutable(); end if; end $$`);
    });
  })().catch(error => { ready = undefined; throw error; });
  await ready;
}
/** Return all immutable versions alongside the balanced built-in. */
export async function listProfiles(experimentId: string): Promise<EvaluationProfile[]> {
  await getExperiment(experimentId); await ensureProfileTables();
  const rows = await sharedDb().execute(sql`select record from development_profiles where experiment_id=${experimentId} order by id,version desc`);
  return [structuredClone(balancedProfile), ...rows.map(row => row.record as EvaluationProfile)];
}
/** Fetch an exact version within this experiment, never accepting a foreign ID. */
export async function getProfile(experimentId: string, id: string, version: number): Promise<EvaluationProfile> {
  const profile = (await listProfiles(experimentId)).find(profile => profile.id === id && profile.version === version);
  if (!profile) throw new DevelopmentError(404, 'profile_not_found', 'That profile version does not belong to this experiment.');
  return profile;
}
/** Save As omits identity; an edit appends only if the supplied base version is still latest. */
export async function saveProfile(experimentId: string, raw: ProfileInput): Promise<EvaluationProfile> {
  const input = profileInputSchema.parse(raw);
  await getExperiment(experimentId); await ensureProfileTables();
  if (input.profile_id === balancedProfile.id) throw new DevelopmentError(409, 'immutable_profile', 'Balanced is immutable. Use Save As to create a custom profile.');
  const id = input.profile_id ?? randomUUID();
  const record = await sharedDb().transaction(async tx => {
    await tx.execute(sql`select id from development_experiments where id=${experimentId} for update`);
    const versions = await tx.execute(sql`select version from development_profiles where id=${id} and experiment_id=${experimentId} order by version desc limit 1`);
    if (input.profile_id && !versions[0]) throw new DevelopmentError(404, 'profile_not_found', 'That custom profile does not belong to this experiment.');
    if (input.profile_id && versions[0].version !== input.base_version) throw new DevelopmentError(409, 'profile_conflict', 'This profile changed. Reload its latest version before saving.');
    const record: EvaluationProfile = { id, version: input.base_version ? input.base_version + 1 : 1, builtin: false, name: input.name, defaults: input.defaults, sections: input.sections, created_at: new Date().toISOString() };
    await tx.execute(sql`insert into development_profiles(id,experiment_id,version,record) values(${id},${experimentId},${record.version},${JSON.stringify(record)}::jsonb)`);
    return record;
  });
  return record;
}
