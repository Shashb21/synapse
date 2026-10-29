import type { GanttActivity } from "./engine";
import type { GanttCatalogEntry } from "./snapshot-hash";

export function ganttExportFileName(args: {
  workspace_id: string;
  version?: number | null;
  ext: "svg" | "png";
}): string {
  const ver = args.version != null ? `v${args.version}` : "draft";
  return `synapse-gantt-${args.workspace_id}-${ver}.${args.ext}`;
}

export function svgViewport(svg: string): { width: number; height: number } {
  const widthMatch = /width="(\d+(?:\.\d+)?)"/.exec(svg);
  const heightMatch = /height="(\d+(?:\.\d+)?)"/.exec(svg);
  return {
    width: Number(widthMatch?.[1] ?? 960),
    height: Number(heightMatch?.[1] ?? 80),
  };
}

/** PNG rasterization paints this markup; strip the XML declaration for Image(). */
export function svgMarkupForRaster(svg: string): string {
  return svg.replace(/^\s*<\?xml[^>]*>\s*/i, "");
}

function toDay(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wrap full labels, including unbroken words, without splitting Unicode code points. */
function wrapLabel(value: string, maxCharacters: number): string[] {
  let remaining = Array.from(value.replace(/\s+/gu, " ").trim());
  const lines: string[] = [];
  while (remaining.length > maxCharacters) {
    const space = remaining.slice(0, maxCharacters + 1).lastIndexOf(" ");
    const split = space > 0 ? space : maxCharacters;
    lines.push(remaining.slice(0, split).join(""));
    remaining = remaining.slice(split + (space > 0 ? 1 : 0));
  }
  lines.push(remaining.join(""));
  return lines;
}

/** Render validated Gantt activities as a standalone SVG document string. */
export function activitiesToSvg(activities: GanttActivity[], catalog: GanttCatalogEntry[] = []): string {
  const width = 960;
  const labelX = 8;
  const labelFontSize = 11;
  const labelLineHeight = 16;
  // Budget a full em per code point, conservatively allowing for wide glyphs.
  const labelCharacters = Math.floor((width - 2 * labelX) / labelFontSize);
  if (activities.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80" viewBox="0 0 ${width} 80">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="8" y="18" font-size="13" font-weight="600" fill="#111">Synapse accuracy Gantt</text>
  <text x="8" y="44" font-size="12" fill="#666">No activities</text>
</svg>`;
  }
  const starts = activities.map((a) => toDay(a.start));
  const ends = activities.flatMap((a) => [toDay(a.end), a.readout ? toDay(a.readout) : toDay(a.end)]);
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const span = Math.max(max - min, 1);
  let nextRowY = 28;
  const bars = activities
    .map((activity) => {
      const x = 160 + ((toDay(activity.start) - min) / span) * (width - 180);
      const w = Math.max(((toDay(activity.end) - toDay(activity.start)) / span) * (width - 180), 8);
      const label = catalog.find((row) => row.id === activity.tactic_id)?.statement ?? activity.tactic_id;
      const lines = wrapLabel(label, labelCharacters);
      const labels = lines.map((line, index) =>
        `<text x="${labelX}" y="${nextRowY + 12 + index * labelLineHeight}" font-size="${labelFontSize}" fill="#111">${escapeXml(line)}</text>`,
      ).join("\n");
      const y = nextRowY + lines.length * labelLineHeight + 12;
      nextRowY = y + 16 + 12;
      const readout = activity.readout ? ` · readout ${activity.readout.slice(0, 10)}` : "";
      return `${labels}
<rect x="${x}" y="${y}" width="${w}" height="16" rx="2" fill="#333"/>
<text x="${x + 4}" y="${y + 12}" font-size="9" fill="#fff">${activity.start.slice(0, 10)} → ${activity.end.slice(0, 10)}${readout}</text>`;
    })
    .join("\n");
  const height = Math.max(80, nextRowY);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="8" y="18" font-size="13" font-weight="600" fill="#111">Synapse accuracy Gantt</text>
  ${bars}
</svg>`;
}
