"use client";

import { useState, type RefObject } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Serialises the chart SVG and paints it onto a canvas so the user gets a PNG of
 * exactly what is on screen. The chart carries literal colours and no
 * foreignObject, so the serialised markup renders standalone.
 */
export function ExportImageButton({
  svgRef,
  fileName,
  disabledReason,
}: {
  svgRef: RefObject<SVGSVGElement | null>;
  fileName: string;
  disabledReason?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportPng() {
    const svg = svgRef.current;
    if (!svg) {
      setError("Chart is not ready yet.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
      const width = Number(svg.getAttribute("width") ?? svg.clientWidth);
      const height = Number(svg.getAttribute("height") ?? svg.clientHeight);
      const markup = new XMLSerializer().serializeToString(clone);
      const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
      const scale = 2;
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(width * scale);
          canvas.height = Math.round(height * scale);
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Canvas is unavailable in this browser."));
            return;
          }
          context.scale(scale, scale);
          context.drawImage(image, 0, 0, width, height);
          canvas.toBlob((result) => resolve(result), "image/png");
        };
        image.onerror = () => reject(new Error("Could not rasterise the chart."));
        image.src = url;
      });
      URL.revokeObjectURL(url);
      if (!blob) throw new Error("PNG encoding failed.");
      const download = document.createElement("a");
      download.href = URL.createObjectURL(blob);
      download.download = fileName;
      document.body.appendChild(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(download.href), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending || Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => void exportPng()}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
        Export PNG
      </Button>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      {disabledReason ? <p className="text-[11px] text-muted-foreground">{disabledReason}</p> : null}
    </div>
  );
}
