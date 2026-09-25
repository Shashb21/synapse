import type { NextConfig } from "next";

/**
 * The lab surfaces moved into the owner console (/admin). Old URLs keep working
 * for bookmarks; they land on the owner-gated page, never a customer one.
 */
export const ADMIN_REDIRECTS: { source: string; destination: string }[] = [
  { source: "/accuracy/control", destination: "/admin/accuracy/routing" },
  { source: "/accuracy", destination: "/admin/accuracy" },
  { source: "/accuracy/:path*", destination: "/admin/accuracy/:path*" },
  { source: "/control", destination: "/admin/control" },
  { source: "/control-panel", destination: "/admin/control" },
  { source: "/settings/control", destination: "/admin/control" },
  { source: "/pipeline", destination: "/admin/pipeline" },
  { source: "/runs", destination: "/admin/runs" },
  { source: "/runs/:path*", destination: "/admin/runs/:path*" },
  { source: "/evals", destination: "/admin/evals" },
  { source: "/catalog", destination: "/admin/catalog" },
  { source: "/sdlc", destination: "/admin/sdlc" },
  { source: "/docs", destination: "/admin/docs" },
  { source: "/docs/:path*", destination: "/admin/docs/:path*" },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["mammoth", "xlsx", "jszip", "pptxgenjs", "docx"],
  experimental: {
    // forbidden() renders the Owner only page (403) for /admin.
    authInterrupts: true,
  },
  async redirects() {
    // Temporary (307/308 off) so the paths stay free if they are ever reused.
    return ADMIN_REDIRECTS.map((rule) => ({ ...rule, permanent: false }));
  },
  // Preview is proxied from Cursor hosts; Next 16 403s /_next/* unless those
  // hostnames are listed (scheme and port are ignored).
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "172.30.0.2",
    "172.17.0.1",
    "*.cursor.com",
    "**.cursor.com",
    "*.cursor.sh",
    "**.cursor.sh",
    "*.cursorusercontent.com",
    "**.cursorusercontent.com",
  ],
};

export default nextConfig;
