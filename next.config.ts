import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mammoth", "xlsx", "jszip", "pptxgenjs", "docx"],
  allowedDevOrigins: ["127.0.0.1", "localhost", "172.30.0.2"],
};

export default nextConfig;
