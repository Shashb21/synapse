/** Owner authorization, bounded request decoding, and safe no-store errors. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerAccess, ownerGate } from "@/modules/auth/owner";
import {
  NotOwnerError,
  UnknownWorkspaceError,
} from "@/modules/workspaces/admin-context";
import { BodyTooLargeError, readBodyText } from "@/lib/http/body-limit";
import { DevelopmentError } from "@/modules/development/schema";
export type DraftContext = {
  params: Promise<{
    id: string;
  }>;
};
/** Send a JSON response whose private experiment state cannot be cached. */
export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
/** Apply authorization before reading request bytes or private state. */
export async function guarded(
  fn: (actor: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const denied = await ownerGate();
    if (denied) {
      denied.headers.set("Cache-Control", "no-store");
      return denied;
    }
    const access = await ownerAccess();
    if (!access.owner)
      return json(
        {
          code: "owner_only",
          error: "Only the platform owner can use Development.",
        },
        403,
      );
    return await fn(access.email ?? access.actor.name);
  } catch (error) {
    if (error instanceof DevelopmentError || error instanceof BodyTooLargeError)
      return json({ code: error.code, error: error.message }, error.status);
    if (error instanceof UnknownWorkspaceError)
      return json(
        {
          code: "not_found",
          error:
            "That source workspace does not exist. Choose an available workspace.",
        },
        404,
      );
    if (error instanceof NotOwnerError)
      return json(
        {
          code: "owner_only",
          error: "Only the platform owner can use Development.",
        },
        403,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return json(
        {
          code: "invalid_input",
          error:
            "Check the request fields and send valid JSON using the documented Development format.",
        },
        400,
      );
    return json(
      {
        code: "development_unavailable",
        error:
          "Development could not complete this request. Reload the draft and retry; contact the administrator if it persists.",
      },
      503,
    );
  }
}
/** Validate a bounded JSON body before any parser or persistence operation. */
export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  return schema.parse(JSON.parse(await readBodyText(request)));
}
