import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Synapse",
  description:
    "Cross-functional biopharma insights terminal: themes first, then constituent insights with sources and cross-theme links.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistMono.variable} dark h-full`}>
      <body className="min-h-full flex flex-col bg-background text-foreground font-mono">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
