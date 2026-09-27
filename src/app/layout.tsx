import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiOffBanner, AiStatusProvider } from "@/components/platform/ai-status";
import { WalkthroughHost } from "@/components/walkthrough/walkthrough-host";
import { aiState } from "@/modules/kernel/ai-switch";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Synapse IEGP",
  description:
    "Digital integrated evidence generation plan: evidence needs, gaps, tactics, coverage, residuals, priority, and roadmap.",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The page must render before Postgres exists; AI counts as on until it is read.
  // Effective AI: the platform master switch AND the open workspace's setting.
  const ai = await aiState().catch(() => null);
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full`}
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <AiStatusProvider enabled={ai?.enabled ?? true} offBy={ai?.off_by ?? null}>
          <AiOffBanner />
          <TooltipProvider>{children}</TooltipProvider>
          <WalkthroughHost />
        </AiStatusProvider>
      </body>
    </html>
  );
}
