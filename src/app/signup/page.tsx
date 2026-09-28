import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignupPanel } from "@/components/workspaces/signup-panel";
import { afterSignIn, safeNext } from "@/modules/auth/redirect";
import { currentSession } from "@/modules/auth/session";
import { signupAllowed } from "@/modules/auth/signup-policy";
import { MIN_PASSWORD_LENGTH } from "@/modules/auth/password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Create an account · Synapse IEGP" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next, "");
  const session = await currentSession().catch(() => null);
  if (session) redirect(afterSignIn(next));
  const open = signupAllowed();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Synapse</p>
          <h1 className="mt-1 text-xl font-medium text-foreground">Synapse IEGP</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">Create an account to plan evidence generation with your team.</p>
        </div>
        <section className="border border-border bg-card/40 p-5" aria-labelledby="sign-up">
          <h2 id="sign-up" className="mb-4 text-[15px] font-medium text-foreground">
            Create an account
          </h2>
          {open ? (
            <SignupPanel next={next} minLength={MIN_PASSWORD_LENGTH} />
          ) : (
            <p role="status" data-testid="signup-closed" className="text-[13px] text-muted-foreground">
              Self sign-up is closed on this deployment. Ask your Synapse administrator for an account.
            </p>
          )}
          <p className="mt-4 text-center text-[12px] text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
              className="text-foreground underline underline-offset-2"
            >
              Sign in
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
