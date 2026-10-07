"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        window.location.assign("/login");
      }}
    >
      <LogOut className="size-3.5" aria-hidden />
      Sign out
    </Button>
  );
}
