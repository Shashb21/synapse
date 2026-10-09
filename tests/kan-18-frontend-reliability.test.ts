import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import "@/modules";
import * as owner from "@/modules/auth/owner";
import { apiErrorResponse, readJsonBody } from "@/modules/auth/api-guard";
import { NETWORK_ERROR, postJson } from "@/lib/post-json";
import { residualRows } from "@/lib/iegp/residual-rows";
import { isPresenting } from "@/lib/room/presenting";
import { planFingerprint } from "@/modules/stages/s10-timeline/plan-fingerprint";
import { mappingRowKey } from "@/components/mapping-table-workbench";
import { POST as evalsPost } from "@/app/api/modules/evals/route";
import { POST as hillclimbPost } from "@/app/api/modules/hillclimb/route";
import { POST as learningPost } from "@/app/api/admin/learning/route";
import { POST as passwordLoginPost } from "@/app/api/auth/password/login/route";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { createBreakoutGroup, loadState, resetBlank, resetDemo } from "@/lib/iegp/store";
import { savePlan } from "@/modules/stages/s10-timeline/module";
import { isLiveGap } from "@/lib/iegp/engine";

/** KAN-18: the front-end reliability audit. */

const malformed = (url: string) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("postJson never throws (dialogs never stick on Saving…)", () => {
  it("turns a dropped connection into a failed result with a message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const res = await postJson("/api/iegp", { action: "x" });
    expect(res).toEqual({ ok: false, status: 0, json: { error: NETWORK_ERROR } });
  });

  it("keeps the status of a reply that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })));
    const res = await postJson("/api/iegp", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.json).toEqual({});
  });

  it("sends JSON, or a FormData body as is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await postJson("/a", { a: 1 })).json).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } });
    const form = new FormData();
    form.set("f", "1");
    await postJson("/b", form);
    expect(fetchMock.mock.calls[1]![1].body).toBe(form);
    expect(fetchMock.mock.calls[1]![1].headers).toBeUndefined();
  });
});

describe("API errors keep a meaningful status", () => {
  it("malformed JSON is a 400 invalid_json on routes that used to 500", async () => {
    vi.spyOn(owner, "ownerGate").mockResolvedValue(null);
    for (const res of [
      await evalsPost(malformed("/api/modules/evals")),
      await hillclimbPost(malformed("/api/modules/hillclimb")),
      await learningPost(malformed("/api/admin/learning")),
      await passwordLoginPost(malformed("/api/auth/password/login")),
      await iegpPost(malformed("/api/iegp")),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_json");
    }
  });

  it("an empty body is {} only where allowed", async () => {
    const empty = () => new Request("http://localhost/x", { method: "POST" });
    await expect(readJsonBody(empty(), { allowEmpty: true })).resolves.toEqual({});
    await expect(readJsonBody(empty())).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  it("maps parse, schema and not-found errors instead of flattening them", async () => {
    const syntax = await apiErrorResponse(new SyntaxError("Unexpected token"));
    expect(syntax.status).toBe(400);
    expect((await syntax.json()).code).toBe("invalid_json");

    const schema = z.object({ stage: z.enum(["S2"]) }).safeParse({ stage: "S9" });
    const invalid = await apiErrorResponse(schema.error);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request", error: expect.stringMatching(/^stage: /) });

    for (const message of ["Gap not found", "Breakout group not found", "Activity ACT-1 not found."]) {
      const res = await apiErrorResponse(new Error(message));
      expect(res.status, message).toBe(404);
      expect((await res.json()).code).toBe("not_found");
    }
    // A sentence that merely mentions "not found" stays a 400.
    expect((await apiErrorResponse(new Error("The quote was not found in the source, so check the block and try again"))).status).toBe(400);
  });
});

describe("pure helpers", () => {
  it("residualRows lists a residual whose parent gap is gone instead of crashing", () => {
    const lock = { locked: true } as never;
    const rows = residualRows({
      gaps: [{ id: "GAP-1", name: "Beta" }, { id: "GAP-2", name: "Alpha" }] as never,
      residuals: [
        { id: "R1", gap_id: "GAP-1" },
        { id: "R2", gap_id: "GAP-GONE" },
        { id: "R3", gap_id: "GAP-2" },
      ] as never,
      priorities: [{ residual_id: "R1", band: "high", lock }] as never,
    });
    expect(rows.map((row) => row.r.id)).toEqual(["R1", "R2", "R3"]);
    expect(rows[1]!.gap).toBeNull();
  });

  it("planFingerprint changes when a date moves, not only when the count does", () => {
    const row = {
      id: "A1",
      tactic_name: "RWE study",
      band: "high" as const,
      tactic_status: "planned" as never,
      start_date: "2026-01-01",
      end_date: "2026-06-01",
      readout_date: null,
      depends_on: ["B", "A"],
    };
    const saved = planFingerprint([row]);
    expect(planFingerprint([{ ...row, depends_on: ["A", "B"] }])).toBe(saved);
    expect(planFingerprint([{ ...row, end_date: "2026-07-01" }])).not.toBe(saved);
    expect(planFingerprint([{ ...row, depends_on: [] }])).not.toBe(saved);
  });

  it("mappingRowKey changes when a save changes the row, so its editor starts over", () => {
    const row = { gap_id: "GAP-1", source: "proposal" as const, mapping_status: "open" as const, tactic_ids: ["T2", "T1"] };
    expect(mappingRowKey({ ...row, tactic_ids: ["T1", "T2"] })).toBe(mappingRowKey(row));
    expect(mappingRowKey({ ...row, source: "human" })).not.toBe(mappingRowKey(row));
    expect(mappingRowKey({ ...row, mapping_status: "addressed" })).not.toBe(mappingRowKey(row));
    expect(mappingRowKey({ ...row, tactic_ids: ["T1"] })).not.toBe(mappingRowKey(row));
  });

  it("isPresenting: ?present=1 or a frame is a Room slide", () => {
    const win = (search: string, framed: boolean) => {
      const w: Record<string, unknown> = { location: { search } };
      w.self = w;
      w.top = framed ? {} : w;
      return w as unknown as Window;
    };
    expect(isPresenting(win("", false))).toBe(false);
    expect(isPresenting(win("?place=plan&present=1", false))).toBe(true);
    expect(isPresenting(win("", true))).toBe(true);
    expect(isPresenting(undefined)).toBe(false);
  });
});

describe("store guards", () => {
  const ACTOR = { actor_name: "KAN-18 Test", actor_function: "medical_affairs" as const };
  let liveIds: string[] = [];

  beforeAll(async () => {
    await resetDemo();
    liveIds = (await loadState()).gaps.filter(isLiveGap).map((gap) => gap.id);
  }, 60_000);

  it("a breakout group with a bad starting gap creates nothing (no half-made group)", async () => {
    const before = (await loadState()).breakout_groups.length;
    await expect(createBreakoutGroup({ name: "Half made", gap_ids: [liveIds[0]!, "GAP-NOPE"], ...ACTOR })).rejects.toThrow(
      /not found/,
    );
    expect((await loadState()).breakout_groups.length).toBe(before);

    const id = await createBreakoutGroup({ name: "Whole", gap_ids: liveIds.slice(0, 2), ...ACTOR });
    const state = await loadState();
    expect(state.breakout_group_gaps.filter((row) => row.group_id === id).map((row) => row.gap_id).sort()).toEqual(
      liveIds.slice(0, 2).sort(),
    );
  });

  it("refuses to save an empty timeline as final; a draft snapshot is still allowed", async () => {
    await resetBlank();
    const actor = { name: ACTOR.actor_name, function: ACTOR.actor_function };
    await expect(savePlan({ status: "final", note: "Signing off nothing", actor })).rejects.toThrow(/nothing to save as final/);
    await expect(savePlan({ status: "draft", note: "Empty draft", actor })).resolves.toMatchObject({ status: "draft" });
  }, 60_000);
});
