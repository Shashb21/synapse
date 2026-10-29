/** Regression proof for the dedicated learning browser server's port and cleanup. */
import { expect, test } from "vitest";
import { startLearningBrowserServer } from "../e2e/support/learning-provider";

test("learning browser server selects a usable port and closes its listener", async () => {
  const fixture = await startLearningBrowserServer();
  try {
    const url = new URL(fixture.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    const response = await fetch(`${fixture.url}/file.svg`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<svg");
  } finally {
    await fixture.close();
  }
  await fixture.close();
  await expect(fetch(`${fixture.url}/file.svg`)).rejects.toThrow();
}, 120_000);
