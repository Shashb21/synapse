import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/auth/owner', () => ({ requireOwnerPage: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('not found'); }) }));
import { requireOwnerPage } from '@/modules/auth/owner';
import { notFound } from 'next/navigation';
import RetiredAccuracyPage from '@/app/admin/[...missing]/page';

describe('retired Admin Accuracy paths', () => {
  it('checks owner authorization before not-found', async () => {
    vi.mocked(requireOwnerPage).mockRejectedValueOnce(new Error('denied'));
    await expect(RetiredAccuracyPage()).rejects.toThrow('denied');
    expect(notFound).not.toHaveBeenCalled();
    vi.mocked(requireOwnerPage).mockResolvedValueOnce({} as Awaited<ReturnType<typeof requireOwnerPage>>);
    await expect(RetiredAccuracyPage()).rejects.toThrow('not found');
    expect(notFound).toHaveBeenCalledOnce();
  });
});
