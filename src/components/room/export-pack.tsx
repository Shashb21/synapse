"use client";

import { useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GanttChart } from "@/components/timeline/gantt-chart";
import { GAP_STATUS_LABELS, type GapStatus } from "@/lib/iegp/enums";
import type { PlanColumn, PlanGapCard, ReviewGapCard } from "@/lib/iegp/engine";
import type { TimelineModel } from "@/modules/stages/s10-timeline/build";

/**
 * The leave-behind .pptx (kept from the retired chaptered presentation). The
 * Gantt is rendered off-screen only so it can be rasterised into the deck.
 */
export type ExportPackData = {
  assetName: string;
  inn: string;
  indication: string;
  geography: string;
  gaps: ReviewGapCard[];
  board: Record<PlanColumn, PlanGapCard[]>;
  timelineModel: TimelineModel;
  today: string;
};

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

async function rasterize(svg: SVGSVGElement | null): Promise<string | null> {
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

export function ExportPackButton({ data }: { data: ExportPackData }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportPack() {
    setPending(true);
    setError(null);
    try {
      const { default: PptxGenJS } = await import("pptxgenjs");
      const pptx = new PptxGenJS();

      const title = pptx.addSlide();
      title.addText(data.assetName, { x: 0.5, y: 1.2, fontSize: 32, bold: true });
      title.addText(`${data.inn} · ${data.indication} · ${data.geography}`, {
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

      const ganttImage = await rasterize(svgRef.current);
      if (ganttImage) {
        const ganttSlide = pptx.addSlide();
        ganttSlide.addText("Timeline", { x: 0.5, y: 0.3, fontSize: 24, bold: true });
        ganttSlide.addImage({ data: ganttImage, x: 0.3, y: 0.9, w: 9.4, h: 5 });
      }

      await pptx.writeFile({ fileName: `${data.assetName.replace(/\s+/g, "-")}-IEGP.pptx` });
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
        Export .pptx
      </Button>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      <div aria-hidden className="pointer-events-none fixed -left-[10000px] top-0 opacity-0">
        <GanttChart model={data.timelineModel} today={data.today} selectedId={null} onSelect={() => {}} svgRef={svgRef} />
      </div>
    </div>
  );
}
