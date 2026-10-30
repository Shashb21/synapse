/**
 * What a person is told when an AI step cannot run because no model is
 * connected. Client-safe: no server imports.
 *
 * Customers never see the owner control panel, so they get a plain message
 * that points at their administrator and the manual path. Only the platform
 * owner gets setup recovery and the link to /admin/control.
 */

export const NO_LLM_CODE = "no_llm";

/** Where the owner sees each provider's key status. Owner-only; never shown to customers. */
export const OWNER_CONTROL_HREF = "/admin/control";

export const NO_LLM_CUSTOMER_MESSAGE =
  "No AI model is connected. Ask your Synapse administrator to connect one, or carry on by hand.";

/** The owner's setup recovery; untrusted route diagnostics are never displayed. */
export function noLlmOwnerMessage(detail: string): string {
  void detail;
  return "No AI model is connected for this task. Open AI & routing, connect a provider and choose a model, then try again.";
}

export type NoLlmBody = {
  code: typeof NO_LLM_CODE;
  safe_error: true;
  error: string;
  /** Present only for the owner. */
  admin_href?: string;
};

/** The JSON body an API returns for a no-LLM failure, chosen by audience. */
export function noLlmBody(detail: string, owner: boolean): NoLlmBody {
  return owner
    ? { safe_error: true, code: NO_LLM_CODE, error: noLlmOwnerMessage(detail), admin_href: OWNER_CONTROL_HREF }
    : { safe_error: true, code: NO_LLM_CODE, error: NO_LLM_CUSTOMER_MESSAGE };
}
