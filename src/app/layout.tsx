import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { aiEnabled } from "@/modules/kernel/ai-switch";
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
  const ai = await aiEnabled().catch(() => true);
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full`}
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <AiStatusProvider enabled={ai}>
          {ai ? null : (
            <p
              role="status"
              data-testid="ai-off-banner"
              className="border-b border-border bg-card/60 px-4 py-1.5 text-center text-[12px] text-muted-foreground"
            >
              AI is off. Everything is entered and edited by hand; no suggestions or automatic AI steps run.
            </p>
          )}
          <TooltipProvider>{children}</TooltipProvider>
        </AiStatusProvider>
      </body>
    </html>
  );
}
