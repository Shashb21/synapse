/** Print a deterministic KAN-255 summary from owner-exported saved comparison evidence. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizePairedReleaseEvidence, type PairedReleaseEvidence } from '@/modules/development/release-summary';

/** Load an explicitly supplied local evidence export without contacting a provider or database. */
async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: tsx scripts/summarize-kan-255-release.ts <saved-comparisons.json>');
  const parsed: unknown = JSON.parse(await readFile(resolve(input), 'utf8'));
  const trials = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { trials?: unknown }).trials) ? (parsed as { trials: unknown[] }).trials : null);
  if (!trials) throw new Error('The evidence file must be a JSON array or an object with a trials array.');
  if (trials.some(trial => !trial || typeof trial !== 'object' || typeof (trial as { trial_id?: unknown }).trial_id !== 'string' || !(trial as { comparison?: unknown }).comparison)) {
    throw new Error('Every evidence entry must contain a string trial_id and a saved comparison object.');
  }
  process.stdout.write(`${JSON.stringify(summarizePairedReleaseEvidence(trials as PairedReleaseEvidence[]), null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Unable to summarize evidence.'}\n`); process.exitCode = 1; });
