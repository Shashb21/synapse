import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Accuracy lab · Synapse Admin",
  description: "Multi-tenant accuracy-first IEGP workspaces, routing, and runs.",
};

export default function AccuracyLayout({ children }: { children: ReactNode }) {
  return children;
}
