import { ACTOR_FUNCTIONS, type ActorFunction } from "@/lib/iegp/enums";
import type { Actor } from "@/modules/kernel/contracts";
import { sessionContext } from "./session";
import type { Role } from "./roles";

export type RequestIdentity = {
  actor: Actor;
  role: Role;
  signed_in: boolean;
  demo: boolean;
};

/**
 * Identity for an API call. A session always wins. In demo mode (no identity
 * provider configured) the typed name the UI already collects is the actor, so
 * the existing gates keep working.
 */
export async function requestIdentity(body?: Record<string, unknown>): Promise<RequestIdentity> {
  const context = await sessionContext();
  if (context.signed_in) {
    return { actor: context.actor, role: context.role, signed_in: true, demo: context.demo };
  }
  const name = typeof body?.actor_name === "string" ? body.actor_name.trim() : "";
  const fn = typeof body?.actor_function === "string" ? body.actor_function.trim() : "";
  if (!context.demo) {
    return context.session
      ? { actor: context.actor, role: context.role, signed_in: true, demo: false }
      : { actor: context.actor, role: context.role, signed_in: false, demo: false };
  }
  return {
    actor: {
      name: name || context.actor.name,
      function: ACTOR_FUNCTIONS.includes(fn as ActorFunction)
        ? (fn as ActorFunction)
        : context.actor.function,
    },
    role: context.role,
    signed_in: false,
    demo: true,
  };
}
