import { expect, test } from '@playwright/test';

/** Exercise real routing and authorization without selecting a workspace or invoking providers. */
test.describe('retired Accuracy routes', () => {
  for (const identity of ['signed-out', 'customer'] as const) {
    for (const path of ['/accuracy', '/accuracy/nested?workspace_id=ignored', '/api/accuracy', '/api/accuracy/nested?workspace_id=ignored']) {
      test(`${identity} receives not-found for all methods on ${path}`, async ({ playwright, baseURL, page, context }) => {
        const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [{ name: 'synapse_test_as', value: 'customer', domain: new URL(baseURL!).hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] } });
        try {
          await context.addCookies([{ name: 'synapse_test_as', value: 'customer', url: baseURL! }]);
          const request = identity === 'signed-out' ? anonymous : page.request;
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            const response = await request.fetch(path, { method, maxRedirects: 0 });
            expect(response.status(), `${method} ${path}`).toBe(404);
            expect(response.headers().location).toBeUndefined();
          }
        } finally {
          await anonymous.dispose();
        }
      });
    }
  }

  test('Admin paths check authorization before not-found', async ({ playwright, baseURL, page, context, request }) => {
    for (const path of ['/admin/accuracy', '/admin/accuracy/nested?workspace_id=ignored']) {
      expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(404);
    }
    await context.addCookies([{ name: 'synapse_test_as', value: 'customer', url: baseURL! }]);
    for (const path of ['/admin/accuracy', '/admin/accuracy/nested?workspace_id=ignored']) {
      expect((await page.request.get(path, { maxRedirects: 0 })).status()).toBe(403);
    }
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [{ name: 'synapse_test_as', value: 'customer', domain: new URL(baseURL!).hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] } });
    for (const path of ['/admin/accuracy', '/admin/accuracy/nested?workspace_id=ignored']) {
      const response = await anonymous.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toContain('/login?next=');
    }
    await anonymous.dispose();
  });
});
