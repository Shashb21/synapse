import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@/modules";
import { GET as roomGet, POST as roomPost } from "@/app/api/room/route";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { PresenterConsole } from "@/components/room/presenter-console";
import { AudienceView } from "@/components/room/audience-view";
import { keyStep } from "@/components/room/keys";
import { PRESENT_CSS } from "@/components/room/present-frame";
import {
  ROOM_SLIDES,
  isShowableHref,
  nextSlideOf,
  presentHref,
  slideIndex,
  stepSlide,
  stripPresent,
} from "@/lib/room/slides";
import { getRoomState, listRoomNotes, saveRoomNote, setRoomState } from "@/lib/room/store";
import { createWorkspace, withWorkspace } from "@/modules/workspaces/store";

const unique = () => Math.random().toString(36).slice(2, 8);

describe("room slides", () => {
  it("are the real app pages in plan order", () => {
    expect(ROOM_SLIDES.map((slide) => slide.id)).toEqual([
      "context",
      "gaps",
      "mappings",
      "prioritize",
      "tactics",
      "ideation",
      "timeline",
    ]);
    expect(ROOM_SLIDES.map((slide) => slide.href)).toEqual([
      "/setup",
      "/?place=gaps",
      "/mappings",
      "/?place=plan",
      "/?place=tactics",
      "/ideation",
      "/timeline",
    ]);
    // Never the owner's accuracy tool, never a bespoke presentation screen.
    for (const slide of ROOM_SLIDES) {
      expect(slide.href.startsWith("/accuracy")).toBe(false);
      expect(slide.href.startsWith("/presentation")).toBe(false);
      expect(isShowableHref(slide.href)).toBe(true);
    }
  });

  it("steps like PowerPoint: clamped at both ends", () => {
    expect(stepSlide("context", -1).id).toBe("context");
    expect(stepSlide("context", 1).id).toBe("gaps");
    expect(stepSlide("timeline", 1).id).toBe("timeline");
    expect(nextSlideOf("ideation")?.id).toBe("timeline");
    expect(nextSlideOf("timeline")).toBeNull();
    expect(slideIndex("nope")).toBe(0);
  });

  it("maps presenter keys", () => {
    for (const key of ["ArrowRight", "ArrowDown", "PageDown", " "]) expect(keyStep(key)).toBe(1);
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp"]) expect(keyStep(key)).toBe(-1);
    expect(keyStep("Escape")).toBe("end");
    expect(keyStep("a")).toBeNull();
  });

  it("flags pages chrome-free with ?present=1 and strips it back", () => {
    expect(presentHref("/?place=gaps")).toBe("/?place=gaps&present=1");
    expect(presentHref("/timeline")).toBe("/timeline?present=1");
    expect(stripPresent("/?place=gaps&present=1")).toBe("/?place=gaps");
    expect(stripPresent("/timeline?present=1")).toBe("/timeline");
    expect(PRESENT_CSS).toContain("data-app-chrome");
  });

  it("only shows same-origin app pages, never the room itself or the accuracy app", () => {
    expect(isShowableHref("/gaps/G-001")).toBe(true);
    for (const bad of ["https://evil.example", "//evil.example", "/room", "/room/audience", "/api/room", "/accuracy/workshop", "", 3]) {
      expect(isShowableHref(bad)).toBe(false);
    }
  });
});

describe("room storage", () => {
  it("keeps speaker notes and the current slide per workspace", async () => {
    const owner = `room-${unique()}@example.com`;
    const a = await createWorkspace({ name: `Room A ${unique()}`, owner });
    const b = await createWorkspace({ name: `Room B ${unique()}`, owner });

    await withWorkspace(a.id, async () => {
      await saveRoomNote("gaps", "Open with the comparative-effectiveness gap.");
      await saveRoomNote("gaps", "Open with the elderly RWD gap.");
      await setRoomState({ slide_id: "prioritize" });
    });
    await withWorkspace(b.id, () => saveRoomNote("timeline", "Only in B"));

    const notesA = await withWorkspace(a.id, listRoomNotes);
    const notesB = await withWorkspace(b.id, listRoomNotes);
    expect(notesA).toEqual({ gaps: "Open with the elderly RWD gap." });
    expect(notesB).toEqual({ timeline: "Only in B" });

    const stateA = await withWorkspace(a.id, getRoomState);
    const stateB = await withWorkspace(b.id, getRoomState);
    expect(stateA.slide_id).toBe("prioritize");
    expect(stateA.href).toBe("/?place=plan");
    expect(stateA.rev).toBe(1);
    // A workspace that never presented starts on the first slide.
    expect(stateB).toMatchObject({ slide_id: "context", href: "/setup", rev: 0 });
  }, 60_000);

  it("follows the presenter into a page and bumps rev on every change", async () => {
    const ws = await createWorkspace({ name: `Room C ${unique()}`, owner: `room-${unique()}@example.com` });
    await withWorkspace(ws.id, async () => {
      const first = await setRoomState({ slide_id: "gaps" });
      const into = await setRoomState({ href: "/gaps/G-001" });
      expect(into).toMatchObject({ slide_id: "gaps", href: "/gaps/G-001", rev: first.rev + 1 });
      const bumped = await setRoomState({});
      expect(bumped).toMatchObject({ href: "/gaps/G-001", rev: first.rev + 2 });
      // Changing slide resets to that slide's own page.
      const moved = await setRoomState({ slide_id: "timeline" });
      expect(moved.href).toBe("/timeline");
      await expect(setRoomState({ slide_id: "accuracy" })).rejects.toThrow(/Unknown slide/);
      await expect(setRoomState({ href: "/accuracy/workshop" })).rejects.toThrow(/cannot be shown/);
      await expect(saveRoomNote("nope", "x")).rejects.toThrow(/Unknown slide/);
    });
  }, 60_000);

  it("serves the state and notes over /api/room", async () => {
    const ws = await createWorkspace({ name: `Room D ${unique()}`, owner: `room-${unique()}@example.com` });
    await withWorkspace(ws.id, async () => {
      const post = (body: unknown) =>
        roomPost(new Request("http://x/api/room", { method: "POST", body: JSON.stringify(body) }));
      expect((await post({ op: "note", slide_id: "mappings", notes: "Walk the table" })).status).toBe(200);
      const moved = await (await post({ op: "slide", slide_id: "mappings" })).json();
      expect(moved.state.slide_id).toBe("mappings");
      expect((await post({ op: "location", href: "https://evil.example" })).status).toBe(400);
      expect((await post({ op: "nope" })).status).toBe(400);
      const res = await roomGet(new Request("http://x/api/room?notes=1"));
      const json = await res.json();
      expect(json.state).toMatchObject({ slide_id: "mappings", href: "/mappings" });
      expect(json.notes).toEqual({ mappings: "Walk the table" });
    });
  }, 60_000);
});

describe("room console render", () => {
  const baseProps = {
    workspaceKey: "ws-test",
    workspaceName: "Velmara EU",
    initialState: { slide_id: "gaps", href: "/?place=gaps", rev: 3, updated_at: null },
    initialNotes: { gaps: "Lead with the RWD gap" },
    breakouts: [{ id: "BG-1", name: "Comparative effectiveness", note: null, gapCount: 2 }],
  };

  function render(ai = true) {
    return renderToStaticMarkup(
      createElement(AiStatusProvider, { enabled: ai }, createElement(PresenterConsole, baseProps)),
    );
  }

  it("shows the current page live, the next slide, notes, the slide list and the audience button", () => {
    const html = render();
    expect(html).toContain('data-testid="room-current-frame"');
    expect(html).toContain('src="/?place=gaps&amp;present=1"');
    expect(html).toContain("2 / 7");
    expect(html).toContain("Next: Mappings");
    expect(html).toContain('src="/mappings?present=1"');
    expect(html).toContain("Lead with the RWD gap");
    expect(html).toContain("Open audience window");
    for (const slide of ROOM_SLIDES) expect(html).toContain(slide.title);
    expect(html).toContain('href="/breakouts/BG-1"');
    expect(html).toContain("Comparative effectiveness");
    expect(html).not.toContain("/accuracy");
    expect(html).not.toContain("AI off");
  });

  it("works with AI off", () => {
    const html = render(false);
    expect(html).toContain("AI off");
    expect(html).toContain('data-testid="room-current-frame"');
  });

  it("renders the audience window as the current page with no chrome", () => {
    const html = renderToStaticMarkup(
      createElement(AudienceView, { workspaceKey: "ws-test", initialState: baseProps.initialState }),
    );
    expect(html).toContain('data-testid="audience-frame"');
    expect(html).toContain('src="/?place=gaps&amp;present=1"');
    expect(html).not.toContain("Speaker notes");
  });
});
