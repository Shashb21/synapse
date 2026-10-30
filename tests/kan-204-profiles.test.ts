/** Profiles use immutable versions so historical assessments retain their original rubric. */
import { expect, it } from 'vitest';
import { createExperiment } from '@/modules/development/store';
import { balancedProfile, profileInputSchema, effectiveCriteria } from '@/modules/development/profile-schema';
import { listProfiles, saveProfile } from '@/modules/development/profile-store';
import { evaluationConfigSchema } from '@/modules/development/evaluation-schema';
it('supplies five anchored equal-weight criteria for each section and round trips immutable custom versions', async () => {
  const experiment = await createExperiment('Profile proof', null, 'owner');
  expect((await listProfiles(experiment.id))[0]).toEqual(balancedProfile);
  for (const section of ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'] as const) {
    const criteria = effectiveCriteria(balancedProfile, section);
    expect(criteria).toHaveLength(5);
    expect(criteria.every(c => Object.keys(c.anchors).length === 5 && c.weight === 1)).toBe(true);
  }
  const input = { name: 'My rubric', defaults: balancedProfile.defaults, sections: balancedProfile.sections };
  const first = await saveProfile(experiment.id, profileInputSchema.parse(input));
  const second = await saveProfile(experiment.id, profileInputSchema.parse({ ...input, profile_id: first.id, base_version: 1, name: 'Edited rubric' }));
  expect(second.version).toBe(2);
  expect((await listProfiles(experiment.id)).find(p => p.id === first.id && p.version === 1)?.name).toBe('My rubric');
  const concurrent = await Promise.allSettled([saveProfile(experiment.id, profileInputSchema.parse({ ...input, profile_id: first.id, base_version: 2 })), saveProfile(experiment.id, profileInputSchema.parse({ ...input, profile_id: first.id, base_version: 2 }))]);
  expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  await expect(saveProfile(experiment.id, profileInputSchema.parse({ ...input, profile_id: 'balanced', base_version: 1 }))).rejects.toMatchObject({ code: 'immutable_profile' });
  const foreign = await createExperiment('Other owner draft', null, 'owner');
  await expect(saveProfile(foreign.id, profileInputSchema.parse({ ...input, profile_id: first.id, base_version: 3 }))).rejects.toMatchObject({ status: 404 });
});
it('rejects empty weights, duplicate identities, bad anchors, nonfinite thresholds and section/method typos', () => {
  const c = balancedProfile.defaults[0];
  for (const defaults of [[{ ...c, weight: 0 }], [c, c], [{ ...c, threshold: Infinity }], [{ ...c, anchors: { '0': 'none' } }]]) expect(profileInputSchema.safeParse({ name: 'Invalid', defaults }).success).toBe(false);
  expect(evaluationConfigSchema.safeParse({ sections: { gap_extraction: { method: 'accuracy' } } }).success).toBe(false);
  expect(evaluationConfigSchema.safeParse({ sections: { unknown: { method: 'rubric' } } }).success).toBe(false);
});
