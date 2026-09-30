import { beforeAll } from "vitest";
import { setAiEnabled, setAiSection } from "@/modules/kernel/ai-switch";
import { AI_SECTION_IDS } from "@/modules/kernel/ai-sections";

/**
 * Every AI section starts off on a fresh platform (KAN-53). The unit suite runs with AI on,
 * as the admin would set it; specs about AI off turn it off themselves and restore it.
 */
beforeAll(async () => {
  try {
    await setAiEnabled({ enabled: true, actor_name: "vitest" });
    for (const section of AI_SECTION_IDS) await setAiSection({ section, enabled: true, actor_name: "vitest" });
  } catch {
    // Tests that never touch Postgres run without it.
  }
});
