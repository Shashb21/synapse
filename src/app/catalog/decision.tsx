"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CatalogDecision({
  proposalId,
}: {
  proposalId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"accepted" | "rejected" | null>(null);

  async function decide(decision: "accepted" | "rejected") {
    setBusy(decision);
    await fetch("/api/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposal_id: proposalId, decision }),
    });
    router.refresh();
    setBusy(null);
  }

  return (
    <div className="mt-3 flex gap-2">
      <Button
        size="sm"
        disabled={busy !== null}
        onClick={() => void decide("accepted")}
      >
        {busy === "accepted" ? "Accepting…" : "Accept into catalog"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void decide("rejected")}
      >
        {busy === "rejected" ? "Rejecting…" : "Reject"}
      </Button>
    </div>
  );
}
