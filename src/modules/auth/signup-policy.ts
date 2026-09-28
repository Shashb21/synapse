/** Whether self sign-up is open: ALLOW_SIGNUP defaults to allowed; "0" (or "false"/"no"/"off") closes it. */
export function signupAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ALLOW_SIGNUP?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}
