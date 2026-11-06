/** Protect unknown Admin URLs before showing the standard not-found page. */
import { notFound } from 'next/navigation';
import { requireOwnerPage } from '@/modules/auth/owner';

/** Require owner access even when no Admin page matches the requested path. */
export default async function MissingAdminPage(): Promise<never> {
  await requireOwnerPage();
  notFound();
}
