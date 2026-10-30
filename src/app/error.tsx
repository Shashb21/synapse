"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Safe read recovery for workspace and owner pages whose data is unavailable. */
export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main className="mx-auto grid max-w-xl gap-4 p-6">
    <h1 className="text-xl font-semibold">This page could not be loaded</h1>
    <p role="alert" className="text-sm">We couldn’t load the current workspace information. Try loading this page again. If this continues, contact your Synapse administrator.</p>
    <div className="flex flex-wrap gap-3"><Button onClick={retry}>Try loading again</Button><Link href="/workspaces" className="self-center text-sm underline">Choose a workspace</Link></div>
  </main>;
}
