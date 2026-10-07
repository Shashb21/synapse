import { assertSessionSecret } from "@/modules/auth/secret";

/**
 * Runs once when a server instance starts, before it serves requests. A
 * production server without a strong SESSION_SECRET refuses to start rather
 * than sign workspace cookies with a guessable key.
 */
export function register() {
  assertSessionSecret();
}
