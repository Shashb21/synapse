/** Browser runner terminal outcomes: callers can always leave their pending state. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { postIngest } from "@/lib/ingest/post-ingest";

const job_id = "a".repeat(64);
const payload = { action: "ingest", title: "Notes", text: "Source text" };
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function progress(completed: number, total = 5) {
  return { job_id, completed, total, done: completed === total, stage: completed === total ? null : `S${completed}` };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("KAN-110 browser ingestion", () => {
  it("sends uploaded bytes once and reports success only after the final checkpoint", async () => {
    const fetch = vi.fn();
    for (let completed = 1; completed <= 5; completed++) fetch.mockResolvedValueOnce(reply(progress(completed)));
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    expect(await postIngest(payload, update)).toMatchObject({ ok: true, json: { done: true, completed: 5 } });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ ...payload, incremental: "true" });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "ingest", ingest_job_id: job_id, incremental: "true" });
    expect(update).toHaveBeenLastCalledWith("Mapping tactics to gaps… (5 of 5)");
  });

  it("preserves server stage failures so the form can show the correct remedy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ safe_error: true, error: "Mapping unavailable", stage: "S4" }, 502)));
    expect(await postIngest(payload, vi.fn())).toMatchObject({ ok: false, status: 502, json: { safe_error: true, error: "Mapping unavailable", stage: "S4" } });
  });

  it.each([
    null,
    { ...progress(5), stage: "S4" },
    { ...progress(5), done: false, stage: "S4" },
    { ...progress(1), job_id: "bad" },
    { ...progress(1), completed: 1.5 },
  ])("terminates malformed success replies without claiming success: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(body)));
    expect(await postIngest(payload, vi.fn())).toMatchObject({ ok: false, json: { error: expect.stringContaining("Could not confirm") } });
  });

  it("rejects inconsistent totals and stalled progress", async () => {
    for (const second of [progress(2, 4), progress(1)]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(progress(1))).mockResolvedValueOnce(reply(second)));
      expect(await postIngest(payload, vi.fn())).toMatchObject({ ok: false, json: { error: expect.stringContaining("Could not confirm") } });
    }
  });

  it("turns an empty server error and a dropped connection into visible failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(null, 500)));
    expect(await postIngest(payload, vi.fn())).toMatchObject({ ok: false, json: { error: expect.any(String) } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await postIngest(payload, vi.fn())).toMatchObject({ ok: false, json: { error: expect.stringContaining("Check your connection") } });
  });

  it("waits for a competing stage then continues with its saved result", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ code: "ingest_busy" }, 409)).mockResolvedValueOnce(reply(progress(5))));
    const update = vi.fn();
    const running = postIngest(payload, update);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toMatchObject({ ok: true, json: { done: true } });
    expect(update).toHaveBeenCalledWith("An ingestion step is already running. Waiting to continue…");
  });

  it("returns a paused outcome when its component aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); }));
    expect(await postIngest(payload, vi.fn(), controller.signal)).toMatchObject({ ok: false, json: { error: expect.stringContaining("paused") } });
  });

  it("returns an actionable timeout instead of remaining pending", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { timeout.abort(); throw new DOMException("Timeout", "TimeoutError"); }));
    expect(await postIngest(payload, vi.fn())).toMatchObject({ ok: false, json: { error: expect.stringContaining("taking longer") } });
  });
});
