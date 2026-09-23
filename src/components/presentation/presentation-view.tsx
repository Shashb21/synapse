"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GapBadge, PriorityBadge, TacticBadge } from "@/components/iegp-badges";
import { GanttChart } from "@/components/timeline/gantt-chart";
import { DOMAIN_LABELS, GAP_STATUS_LABELS, type GapStatus } from "@/lib/iegp/enums";
import type { PlanColumn, PlanGapCard, ReviewGapCard } from "@/lib/iegp/engine";
import type { TimelineModel } from "@/modules/stages/s10-timeline/build";

export type PresentationContext = {
  assetName: string;
  inn: string;
  indication: string;
  geography: string;
  objectives: { id: string; name: string; description: string }[];
  gapsCount: number;
  partialCount: number;
  unconfirmedCount: number;
  readyForPrioritize: boolean;
};

export type PresentationData = {
  context: PresentationContext;
  gaps: ReviewGapCard[];
  board: Record<PlanColumn, PlanGapCard[]>;
  addressed: PlanGapCard[];
  timelineModel: TimelineModel;
  today: string;
};

const CHAPTERS = ["Context", "Gaps", "Tactics", "Timeline"] as const;
type Chapter = (typeof CHAPTERS)[number];

const STATUS_ORDER: GapStatus[] = ["validated_open", "validated_partial", "validated_addressed"];
const COLUMNS: { id: PlanColumn; title: string }[] = [
  { id: "high", title: "High" },
  { id: "medium", title: "Medium" },
  { id: "low", title: "Low" },
];

function statusCounts(gaps: ReviewGapCard[]) {
  const counts: Record<GapStatus, number> = {
    candidate: 0,
    validated_open: 0,
    validated_partial: 0,
    validated_addressed: 0,
    excluded: 0,
  };
  for (const gap of gaps) counts[gap.gap_status] += 1;
  return counts;
}

function domainCounts(gaps: ReviewGapCard[]) {
  const map = new Map<string, number>();
  for (const gap of gaps) {
    map.set(gap.domain, (map.get(gap.domain) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function PresentationView({ data }: { data: PresentationData }) {
  const [chapterIndex, setChapterIndex] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const chapter: Chapter = CHAPTERS[chapterIndex];

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight") setChapterIndex((i) => Math.min(i + 1, CHAPTERS.length - 1));
      else if (event.key === "ArrowLeft") setChapterIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(() => statusCounts(data.gaps), [data.gaps]);
  const domains = useMemo(() => domainCounts(data.gaps), [data.gaps]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1.5" aria-label="Chapters">
          {CHAPTERS.map((label, i) => (
            <Button
              key={label}
              type="button"
              size="sm"
              variant={i === chapterIndex ? "default" : "outline"}
              onClick={() => setChapterIndex(i)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <ExportPackButton data={data} svgRef={svgRef} />
      </div>
      <p className="text-[11px] text-muted-foreground">← → moves between chapters.</p>

      <section className={chapter === "Context" ? "grid gap-4" : "hidden"} aria-hidden={chapter !== "Context"}>
        <h2 className="text-[28px] font-medium leading-9 text-foreground">{data.context.assetName}</h2>
        <p className="text-[16px] text-muted-foreground">
          {data.context.inn} · {data.context.indication} · {data.context.geography}
        </p>
        <div className="mt-2 flex flex-wrap gap-4 text-[14px]">
          <span>{data.context.gapsCount} gaps</span>
          <span>{data.context.partialCount} partial</span>
          <span>{data.context.unconfirmedCount} unconfirmed</span>
          <span className="font-medium">
            {data.context.readyForPrioritize ? "Ready for Prioritize" : "Not ready for Prioritize"}
          </span>
        </div>
        {data.context.objectives.length > 0 ? (
          <div className="mt-2">
            <h3 className="mb-2 text-[16px] font-medium text-foreground">Objectives</h3>
            <ul className="grid gap-2">
              {data.context.objectives.map((objective) => (
                <li key={objective.id} className="border border-border bg-card/40 p-3 text-[14px]">
                  <p className="font-medium text-foreground">{objective.name}</p>
                  <p className="mt-1 text-muted-foreground">{objective.description}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className={chapter === "Gaps" ? "grid gap-4" : "hidden"} aria-hidden={chapter !== "Gaps"}>
        <div className="flex flex-wrap gap-4">
          {STATUS_ORDER.map((status) => (
            <div key={status} className="border border-border bg-card/40 px-4 py-3">
              <p className="text-[24px] font-medium text-foreground">{counts[status]}</p>
              <p className="text-[13px] text-muted-foreground">{GAP_STATUS_LABELS[status]}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-2">
          {domains.map(([domain, count]) => (
            <p key={domain} className="text-[14px] text-foreground">
              {DOMAIN_LABELS[domain as keyof typeof DOMAIN_LABELS]}{" "}
              <span className="text-muted-foreground">— {count}</span>
            </p>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {data.gaps.map((gap) => (
            <article key={gap.gap_id} className="border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <GapBadge status={gap.gap_status} />
                <span className="text-[12px] text-muted-foreground">{DOMAIN_LABELS[gap.domain]}</span>
              </div>
              <p className="mt-2 text-[15px] leading-6 text-foreground">{gap.gap_name}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={chapter === "Tactics" ? "grid gap-6" : "hidden"} aria-hidden={chapter !== "Tactics"}>
        {COLUMNS.map((col) => (
          <div key={col.id}>
            <h3 className="mb-2 text-[18px] font-medium text-foreground">
              {col.title} <span className="text-[13px] font-normal text-muted-foreground">({data.board[col.id].length})</span>
            </h3>
            {data.board[col.id].length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No gaps in this band.</p>
            ) : (
              <div className="grid gap-2">
                {data.board[col.id].map((card) => (
                  <div key={card.gap_id} className="border border-border bg-card/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <PriorityBadge band={col.id === "high" ? "high" : col.id === "medium" ? "medium" : "low"} />
                      <p className="text-[14px] text-foreground">{card.gap_name}</p>
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {card.tactics.map((tactic) => (
                        <li key={tactic.id} className="flex items-center gap-1.5 text-[12px]">
                          {tactic.name}
                          <TacticBadge status={tactic.status} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className={chapter === "Timeline" ? "grid gap-3" : "hidden"} aria-hidden={chapter !== "Timeline"}>
        <div className="overflow-x-auto border border-border bg-card/40 p-3">
          <GanttChart model={data.timelineModel} today={data.today} selectedId={null} onSelect={() => {}} svgRef={svgRef} />
        </div>
      </section>
    </div>
  );
}

function ExportPackButton({
  data,
  svgRef,
}: {
  data: PresentationData;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rasterizeGantt(): Promise<string | null> {
    const svg = svgRef.current;
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const width = Number(svg.getAttribute("width") ?? svg.clientWidth);
    const height = Number(svg.getAttribute("height") ?? svg.clientHeight);
    const markup = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
    try {
      return await new Promise<string>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = width * 2;
          canvas.height = height * 2;
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Canvas unavailable"));
            return;
          }
          context.scale(2, 2);
          context.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = () => reject(new Error("Could not rasterise the Gantt chart."));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function exportPack() {
    setPending(true);
    setError(null);
    try {
      const { default: PptxGenJS } = await import("pptxgenjs");
      const pptx = new PptxGenJS();

      const title = pptx.addSlide();
      title.addText(data.context.assetName, { x: 0.5, y: 1.2, fontSize: 32, bold: true });
      title.addText(`${data.context.inn} · ${data.context.indication} · ${data.context.geography}`, {
        x: 0.5,
        y: 2,
        fontSize: 16,
        color: "666666",
      });
      title.addText("Integrated Evidence Generation Plan", { x: 0.5, y: 2.6, fontSize: 14, color: "999999" });

      const counts = statusCounts(data.gaps);
      const gapsSlide = pptx.addSlide();
      gapsSlide.addText("Evidence gaps", { x: 0.5, y: 0.4, fontSize: 24, bold: true });
      gapsSlide.addText(
        STATUS_ORDER.map((status) => `${GAP_STATUS_LABELS[status]}: ${counts[status]}`).join("\n"),
        { x: 0.5, y: 1.2, fontSize: 16, w: 9 },
      );

      const tacticsSlide = pptx.addSlide();
      tacticsSlide.addText("Tactics by priority", { x: 0.5, y: 0.4, fontSize: 24, bold: true });
      const lines: string[] = [];
      for (const col of COLUMNS) {
        lines.push(`${col.title} (${data.board[col.id].length})`);
        for (const card of data.board[col.id]) {
          lines.push(`  ${card.gap_name}: ${card.tactics.map((t) => t.name).join(", ") || "no tactics yet"}`);
        }
      }
      tacticsSlide.addText(lines.join("\n") || "No prioritized gaps yet.", { x: 0.5, y: 1.2, fontSize: 12, w: 9 });

      const ganttImage = await rasterizeGantt();
      if (ganttImage) {
        const ganttSlide = pptx.addSlide();
        ganttSlide.addText("Timeline", { x: 0.5, y: 0.3, fontSize: 24, bold: true });
        ganttSlide.addImage({ data: ganttImage, x: 0.3, y: 0.9, w: 9.4, h: 5 });
      }

      await pptx.writeFile({ fileName: `${data.context.assetName.replace(/\s+/g, "-")}-IEGP.pptx` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void exportPack()}>
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
        Export pack (.pptx)
      </Button>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
