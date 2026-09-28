import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for email + password sign-in. Node's scrypt, stored as
 * `scrypt$N$r$p$salt$hash` (salt and hash base64), so the cost can be raised
 * later without breaking existing hashes. Nothing here touches the database.
 */

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
export const MIN_PASSWORD_LENGTH = 12;
/** Longer than any sane password; stops a huge body from being hashed. */
export const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keylen, { N: n, r, p, maxmem: 256 * n * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), hash.toString("base64")].join("$");
}

/** Constant-time check of a password against a stored hash. A malformed hash never verifies. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map((value) => Number.parseInt(value, 10));
  if (![n, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;
  if (n > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A real hash of nothing anyone knows: verifying against it costs the same as a real check. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}

/** A short list of the passwords people pick first; any of these is refused. */
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "password1234",
  "password12345",
  "password123!",
  "passwordpassword",
  "qwertyuiopas",
  "qwerty123456",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "welcome123!",
  "changeme1234",
  "administrator",
  "admin1234567",
  "adminadmin12",
  "synapse12345",
  "synapsesynapse",
  "abc123456789",
  "aaaaaaaaaaaa",
  "111111111111",
  "000000000000",
  "trustno1trustno1",
  "football1234",
  "baseball1234",
  "sunshine1234",
  "princess1234",
  "monkey123456",
  "dragon123456",
  "master123456",
  "p@ssw0rd1234",
  "p@ssword1234",
  "correcthorsebatterystaple",
]);

/** Null when the password is acceptable, else the reason it is not. */
export function passwordPolicyError(password: string, email?: string | null): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  const lower = password.trim().toLowerCase();
  const address = email?.trim().toLowerCase();
  if (address && (lower === address || lower === address.split("@")[0])) {
    return "Your password can't be your email address.";
  }
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(lower)) {
    return "That password is too common. Choose something harder to guess.";
  }
  return null;
}

/** A random password an admin hands over once (URL-safe, 20 characters). */
export function temporaryPassword(): string {
  return randomBytes(15).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}
