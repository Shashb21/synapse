/**
 * `npm run create-test-customer` (KAN-59) — creates the test customer account:
 * a password account on a test-only email that holds the one seat of the
 * "Synapse Test" customer, so the customer side of the app can be tested
 * without SSO. Run it again to reset that account's password.
 *
 * Interactive:      npm run create-test-customer
 * Non-interactive:  printf '%s\n' "$PASSWORD" | npm run create-test-customer -- --email tester@synapse.test
 *
 * The password is never printed, logged or taken from a command-line flag.
 * DATABASE_URL comes from the environment or .env* files (loaded like Next does).
 */
import { createInterface } from "node:readline";
import { loadEnvConfig } from "@next/env";

type Flags = { email?: string; name?: string; help?: boolean };

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [key, inline] = arg.split("=", 2);
    const value = () => inline ?? argv[++i];
    if (key === "--email") flags.email = value();
    else if (key === "--name") flags.name = value();
    else if (key === "--help" || key === "-h") flags.help = true;
    else if (key === "--password") {
      throw new Error("Do not pass the password as a flag (it would end up in shell history). Pipe it on stdin instead.");
    } else throw new Error(`Unknown option ${arg}. Use --email and --name.`);
  }
  return flags;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Reads a line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(
      "Usage: npm run create-test-customer [-- --email <test email> --name <name>]\n" +
        "The email defaults to tester@synapse.test and must be on a test-only domain.\n" +
        "Prompts for anything missing. Without a terminal, pipe the password on stdin.",
    );
    return 0;
  }
  loadEnvConfig(process.cwd());

  const interactive = Boolean(process.stdin.isTTY);
  let email = flags.email?.trim() ?? "";
  let name = flags.name?.trim() ?? "";
  let password: string;

  if (interactive) {
    if (!email) email = await ask("Test email (Enter for tester@synapse.test): ");
    if (!name) name = await ask("Name (optional): ");
    password = await askHidden("Password (at least 12 characters): ");
    const confirm = await askHidden("Confirm password: ");
    if (password !== confirm) throw new Error("The passwords do not match. Nothing was changed.");
  } else {
    const lines = await readStdinLines();
    password = lines[0] ?? "";
    if (!password) throw new Error("No password on stdin. Nothing was changed.");
  }

  // Imported after the env is loaded: the database module reads DATABASE_URL on load.
  const { ensureTestCustomer } = await import("../src/modules/auth/admin-setup");
  const { created, account, customer } = await ensureTestCustomer({ email, name, password });
  console.log(
    created
      ? `Created test customer ${account.email}, holding a seat at ${customer.name} (${customer.seats_used}/${customer.seats} seats). Sign in at /login.`
      : `Updated ${account.email}: its password has been reset and other sessions signed out. Seat at ${customer.name}: ${customer.seats_used}/${customer.seats}.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`create-test-customer: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
