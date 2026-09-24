"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import type { TimelineActivity } from "@/modules/stages/s10-timeline/build";

/**
 * A user sets what an activity waits on by hand: tick the upstream activities,
 * optionally say why for each, and give a rationale. The list is locked, so no
 * rebuild asks the model for it again. Ticking nothing clears it.
 */
export function DependencyDialog({
  activity,
  activities,
  identity,
}: {
  activity: TimelineActivity;
  activities: TimelineActivity[];
  identity: ActionIdentity;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set(activity.depends_on));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState("");
  const [actorName, setActorName] = useState(identity.signed_in ? identity.actor_name : "");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(identity.actor_function);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = activities.filter((row) => row.id !== activity.id);

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setChosen(new Set(activity.depends_on));
      setReasons({});
      setRationale("");
      setError(null);
    }
  }

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setError(null);
    if (rationale.trim().length < 3) {
      setError("A short rationale is required. It is stored with the edit and feeds hillclimb.");
      return;
    }
    if (!identity.signed_in && !actorName.trim()) {
      setError("Type your name so the edit has an actor.");
      return;
    }
    const depends_on = others.filter((row) => chosen.has(row.id)).map((row) => row.id);
    setPending(true);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_dependencies",
        id: activity.id,
        depends_on,
        reasons: Object.fromEntries(depends_on.map((id) => [id, reasons[id] ?? ""]).filter(([, text]) => text.trim())),
        rationale: rationale.trim(),
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: actorFunction,
      }),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Action failed");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Edit dependencies</DialogTrigger>
      <DialogContent className="z-[60] sm:max-w-md">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Dependencies of {activity.tactic_name}</DialogTitle>
            <DialogDescription>
              Tick what this activity must wait for. Your list is kept on every rebuild and the model is not asked
              for it again. Tick nothing to say it waits on nothing.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            {others.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No other dated activity to wait on.</p>
            ) : (
              <ul className="grid max-h-64 gap-2 overflow-y-auto">
                {others.map((row) => (
                  <li key={row.id} className="grid gap-1">
                    <label className="flex items-start gap-2 text-[12px] text-foreground">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={chosen.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                      <span>
                        {row.tactic_name}{" "}
                        <span className="text-muted-foreground">
                          · readout {row.readout_date ?? row.end_date}
                        </span>
                      </span>
                    </label>
                    {chosen.has(row.id) ? (
                      <Input
                        aria-label={`Why it waits on ${row.tactic_name}`}
                        placeholder="Why it waits on this (optional)"
                        value={reasons[row.id] ?? ""}
                        onChange={(event) => setReasons((current) => ({ ...current, [row.id]: event.target.value }))}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Rationale (required)
              <Textarea
                name="rationale"
                rows={3}
                placeholder="Why this decision, in one line"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
              />
            </label>
            {!identity.signed_in ? (
              <div className="grid gap-2 border-t border-border pt-3">
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Name
                  <Input value={actorName} placeholder="Your name" onChange={(event) => setActorName(event.target.value)} />
                </label>
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Function
                  <select
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                    value={actorFunction}
                    onChange={(event) => setActorFunction(event.target.value as ActorFunction)}
                  >
                    {ACTOR_FUNCTIONS.map((fn) => (
                      <option key={fn} value={fn}>
                        {FUNCTION_LABELS[fn]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save dependencies"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
