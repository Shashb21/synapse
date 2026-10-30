/** Owner-only immutable rubric history and append-only custom profile saves. */
import { listProfiles, saveProfile } from '@/modules/development/profile-store';
import { profileInputSchema } from '@/modules/development/profile-schema';
import { body, guarded, json, type DraftContext } from '../../_shared';
/** Read the built-in and experiment-local profile versions. */
export async function GET(_request: Request, context: DraftContext) {
  return guarded(async () => json({ profiles: await listProfiles((await context.params).id), default_profile: { id: 'balanced', version: 1 } }));
}
/** Omit profile identity to Save As; supply exact base version to append an edit. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async () => json({ profile: await saveProfile((await context.params).id, await body(request, profileInputSchema)) }, 201));
}
