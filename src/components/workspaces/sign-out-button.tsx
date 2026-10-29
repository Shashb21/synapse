"use client";

import { postJson } from "@/lib/post-json";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = await postJson("/api/auth/logout", {});
        setPending(false);
        if (!result.ok) { setError("Sign-out could not be confirmed. Reload this page to check your session before leaving a shared device."); return; }
        window.location.assign("/login");
      }}
    >
      <LogOut className="size-3.5" aria-hidden />
      Sign out
    </Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error} <a href="/login" className="underline">Check sign-in state</a></p> : null}
    </div>
  );
}
