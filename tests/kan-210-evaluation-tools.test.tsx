/** The historical tools page is read-only and retains the existing owner gate. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { listReferencePacks, loadReferenceGold, referencePackDir, scorePackRecall } from '@/modules/development/evaluation/reference-gold';
import * as owner from '@/modules/auth/owner';
import ToolsPage from '@/app/admin/development/evaluation-tools/page';

vi.mock('@/modules/auth/owner', () => ({ requireOwnerPage: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('Development historical tools', () => {
  it('keeps reference exports, repository-root resolution and pack separation compatible', () => {
    // Arrange / Act: load committed packs through their Development home.
    const packs = listReferencePacks();
    for (const pack of packs) {
      expect(referencePackDir(pack.id)).toBe(`${process.cwd()}/reference/${pack.id}`);
      expect(loadReferenceGold(pack.id).packId).toBe(pack.id);
      expect(scorePackRecall(pack.id)).toBeDefined();
    }
    expect(() => loadReferenceGold('unknown-synthetic-pack')).toThrow('Unknown reference pack');
  });

  it('makes historical scope and local review discoverable without adding a file API or dispatch controls', async () => {
    const html = renderToStaticMarkup(await ToolsPage());
    expect(owner.requireOwnerPage).toHaveBeenCalledOnce();
    for (const label of ['Historical benchmark', 'need_extract', 'inventory_extract', 'current customer pipeline', 'benchmark:kan100', 'Reference packs', 'review', '/admin/development']) expect(html).toContain(label);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(readFileSync('src/components/development/development-evaluation.tsx', 'utf8')).toContain('/admin/development/evaluation-tools');
  });

  it('refuses the tools page before rendering content when owner authorization fails', async () => {
    vi.mocked(owner.requireOwnerPage).mockRejectedValueOnce(new Error('Owner only'));
    await expect(ToolsPage()).rejects.toThrow('Owner only');
  });
});
