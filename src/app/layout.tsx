import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiOffBanner, AiStatusProvider } from "@/components/platform/ai-status";
import { WalkthroughHost } from "@/components/walkthrough/walkthrough-host";
import { aiState } from "@/modules/kernel/ai-switch";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

/**
 * Light is the default. A saved "dark" choice is applied before first paint so
 * the page never flashes light; see components/theme-toggle.tsx.
 */
const THEME_SCRIPT = `try{if(localStorage.getItem("synapse-theme")==="dark")document.documentElement.classList.add("dark")}catch(e){}`;

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
    <html lang="en" className={`${jetbrainsMono.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
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
