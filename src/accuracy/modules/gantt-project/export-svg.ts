import type { GanttActivity } from "./engine";

function toDay(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"]/g, "");
}

/** Render validated Gantt activities as a standalone SVG document string. */
export function activitiesToSvg(activities: GanttActivity[]): string {
  const width = 960;
  const rowH = 36;
  const height = Math.max(80, 48 + activities.length * rowH);
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
  const bars = activities
    .map((activity, index) => {
      const x = 160 + ((toDay(activity.start) - min) / span) * (width - 180);
      const w = Math.max(((toDay(activity.end) - toDay(activity.start)) / span) * (width - 180), 8);
      const y = 28 + index * rowH;
      const label = escapeXml(activity.tactic_id);
      const readout = activity.readout ? ` · readout ${activity.readout.slice(0, 10)}` : "";
      return `<text x="8" y="${y + 14}" font-size="11" fill="#111">${label}</text>
<rect x="${x}" y="${y}" width="${w}" height="16" rx="2" fill="#333"/>
<text x="${x + 4}" y="${y + 12}" font-size="9" fill="#fff">${activity.start.slice(0, 10)} → ${activity.end.slice(0, 10)}${readout}</text>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="8" y="18" font-size="13" font-weight="600" fill="#111">Synapse accuracy Gantt</text>
  ${bars}
</svg>`;
}
