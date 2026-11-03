/** Route regressions for owned corrections, final-save recovery, and missing claims. */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
import "@/modules";
import { POST as planPost } from "@/app/api/plan/route";
import { resetDemo } from "@/lib/iegp/store";
import { addTimelineActivity, timelineModel } from "@/modules/stages/s10-timeline/module";
import { setAiEnabled } from "@/modules/kernel/ai-switch";

const actor = { name: "Error regression", function: "medical_affairs" as const };
/** Arrange a JSON request for the public route handler. */
function request(path: string, body: unknown, method = "POST") {
  return new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
afterEach(async () => { await setAiEnabled({ enabled: true, actor_name: actor.name, rationale: "Restore switch after regression" }); });

describe("KAN-197 owned route failures", () => {
  it.each([true, false])("keeps final-save correction when AI enabled=%s", async (enabled) => {
    await resetDemo();
    const pending = (await timelineModel()).pending;
    expect(pending.length).toBeGreaterThan(1);
    await addTimelineActivity({ tactic_id: pending[0].tactic_id, expansion_id: pending[0].expansion_id, start_date: "2027-01-01", end_date: "2027-06-01", rationale: "Date one activity", actor });
    await setAiEnabled({ enabled, actor_name: actor.name, rationale: "Check manual recovery" });
    const response = await planPost(request("/api/plan", { action: "save_plan", status: "final", rationale: "Check final blockers", actor_name: actor.name, actor_function: actor.function }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ safe_error: true, code: "timeline_unscheduled" });
    expect(body.error).toMatch(/Date each|Date them by hand/);
    expect(body.error).toContain("remove");
    expect(body.error).not.toContain(pending[1].tactic_name);
    if (!enabled) expect(body.error).not.toMatch(/Rebuild|AI & routing/);
  });

});
