"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

const KEY = "synapse-theme";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** True while the dark theme is on. Light is the server default. */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}

/** Light by default; this flips to dark and remembers the choice on this device. */
export function ThemeToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const dark = useIsDark();

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // Storage can be blocked; the choice then lasts for this page only.
    }
  }

  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={label}
      title={label}
      onClick={toggle}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 text-[11px] text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        compact ? "h-8 w-8 justify-center" : "h-8",
        className,
      )}
    >
      {dark ? <Sun className="size-3.5" aria-hidden /> : <Moon className="size-3.5" aria-hidden />}
      {compact ? null : <span>{dark ? "Light theme" : "Dark theme"}</span>}
    </button>
  );
}
