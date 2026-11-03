/** Authenticated GitHub Actions worker endpoint; each request performs at most one provider send. */
import { timingSafeEqual } from 'node:crypto';
import { deliveryConfiguration } from '@/modules/development/execution';
import { progressExecution } from '@/modules/development/worker';
import { json } from '@/app/api/admin/development/_shared';
export const runtime = 'nodejs';
export const maxDuration = 180;
/** Accept scheduler delivery using a dedicated server-held bearer secret. */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET?.trim() ?? '';
  const supplied = request.headers.get('authorization') ?? '';
  const wanted = `Bearer ${expected}`;
  if (expected.length < 24 || Buffer.byteLength(supplied) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(wanted))) return json({ code: 'worker_unauthorized', error: 'Worker authentication required.' }, 401);
  if (!deliveryConfiguration().available) return json({ code: 'delivery_unavailable', error: deliveryConfiguration().reason }, 503);
  try { return json(await progressExecution()); }
  catch { return json({ code: 'worker_unavailable', error: 'Worker storage is unavailable. A dispatched request will not be automatically resent.' }, 503); }
}
