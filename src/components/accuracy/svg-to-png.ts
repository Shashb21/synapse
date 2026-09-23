"use client";

import { svgMarkupForRaster, svgViewport } from "@/accuracy/modules/gantt-project/export-svg";

export async function svgMarkupToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const markup = svgMarkupForRaster(svg);
  const { width, height } = svgViewport(markup);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Canvas is unavailable in this browser."));
          return;
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.scale(scale, scale);
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob((result) => resolve(result), "image/png");
      };
      image.onerror = () => reject(new Error("Could not rasterise the Gantt chart."));
      image.src = url;
    });
    if (!blob) throw new Error("PNG encoding failed.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function triggerBlobDownload(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const download = document.createElement("a");
  download.href = href;
  download.download = fileName;
  document.body.appendChild(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}
