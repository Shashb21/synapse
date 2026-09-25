import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginPanel } from "@/components/workspaces/login-panel";
import { afterSignIn, safeNext } from "@/modules/auth/redirect";
import { currentSession, loginOptions } from "@/modules/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Sign in · Synapse IEGP" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next, "");
  const session = await currentSession().catch(() => null);
  if (session) redirect(afterSignIn(next));
  const options = loginOptions();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Synapse</p>
          <h1 className="mt-1 text-xl font-medium text-foreground">Synapse IEGP</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Plan integrated evidence generation with your team. Sign in to open your workspaces.
          </p>
        </div>
        <section className="border border-border bg-card/40 p-5" aria-labelledby="sign-in">
          <h2 id="sign-in" className="mb-4 text-[15px] font-medium text-foreground">
            Sign in
          </h2>
          <LoginPanel
            providers={options.providers}
            demo={options.demo}
            next={next}
            initialError={params.error?.trim() || null}
          />
        </section>
      </div>
    </main>
  );
}
