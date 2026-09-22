import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mammoth", "xlsx", "jszip", "pptxgenjs", "docx"],
  async redirects() {
    return [
      { source: "/control-panel", destination: "/control", permanent: true },
      { source: "/settings/control", destination: "/control", permanent: false },
    ];
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
