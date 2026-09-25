import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AI & routing · Synapse Admin",
  description: "OAuth login for LLM providers and per-stage routing. Grok default, Claude one-click.",
};

export default function ControlLayout({ children }: { children: ReactNode }) {
  return children;
}
