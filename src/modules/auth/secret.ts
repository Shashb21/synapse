/**
 * The server secret that signs the workspace cookie (and anything else the app
 * signs). Production refuses to run without a strong one; development and tests
 * fall back to a fixed value so a fresh checkout works.
 *
 * No Node-only imports here: instrumentation.ts calls this on every runtime.
 */

export const MIN_SESSION_SECRET_LENGTH = 32;

/** Development/test only. Never accepted when NODE_ENV=production. */
export const DEV_SESSION_SECRET = "synapse-dev-workspace-secret";

export class MissingSessionSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSessionSecretError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * The signing secret. `SESSION_SECRET` (or `AUTH_SECRET`) must be set to at
 * least 32 characters in production; otherwise this throws.
 */
export function sessionSecret(env: Env = process.env): string {
  const configured = env.SESSION_SECRET?.trim() || env.AUTH_SECRET?.trim() || "";
  if (env.NODE_ENV !== "production") return configured || DEV_SESSION_SECRET;
  if (!configured) {
    throw new MissingSessionSecretError(
      "SESSION_SECRET is not set. Synapse will not run in production without it: set SESSION_SECRET to a random value of at least 32 characters (for example `openssl rand -base64 48`).",
    );
  }
  if (configured === DEV_SESSION_SECRET) {
    throw new MissingSessionSecretError(
      "SESSION_SECRET is the public development default. Set a random value of at least 32 characters in production.",
    );
  }
  if (configured.length < MIN_SESSION_SECRET_LENGTH) {
    throw new MissingSessionSecretError(
      `SESSION_SECRET is too short (${configured.length} characters). Production needs at least ${MIN_SESSION_SECRET_LENGTH}.`,
    );
  }
  return configured;
}

/** Startup check (instrumentation.ts): throws in production without a strong secret. */
export function assertSessionSecret(env: Env = process.env): void {
  // `next build` also runs with NODE_ENV=production; the secret is a runtime requirement.
  if (env.NEXT_PHASE === "phase-production-build") return;
  sessionSecret(env);
}
