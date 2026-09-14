import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mammoth", "xlsx", "jszip", "pptxgenjs", "docx"],
};

export default nextConfig;
