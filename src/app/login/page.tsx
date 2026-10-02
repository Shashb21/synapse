import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { LoginPanel } from "@/components/workspaces/login-panel";
import { ownerAccess } from "@/modules/auth/owner";
import { afterOwnerSignIn, afterSignIn, safeNext } from "@/modules/auth/redirect";
import { currentSession, LOGIN_ERROR_MESSAGES, loginOptions } from "@/modules/auth/session";

/** A known `?error=` code gets its fixed message; any other text is shown as sent. */
function loginErrorMessage(raw: string | undefined): string | null {
  const error = raw?.trim();
  if (!error) return null;
  return Object.hasOwn(LOGIN_ERROR_MESSAGES, error) ? LOGIN_ERROR_MESSAGES[error] : error;
}

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
  if (session) redirect((await ownerAccess()).owner ? afterOwnerSignIn(next) : afterSignIn(next));
  const options = loginOptions();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <BrandMark className="mx-auto size-9 rounded-lg text-[15px]" />
          <h1 className="mt-3 text-base font-bold tracking-tight text-foreground">Synapse IEGP</h1>
          <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
            Plan integrated evidence generation with your team. Sign in to open your workspaces.
          </p>
        </div>
        <section className="border border-border bg-card p-5 rounded-lg" aria-labelledby="sign-in">
          <h2 id="sign-in" className="mb-4 text-[13px] font-semibold text-foreground">
            Sign in
          </h2>
          <LoginPanel
            providers={options.providers}
            demo={options.demo}
            next={next}
            initialError={loginErrorMessage(params.error)}
          />
        </section>
      </div>
    </main>
  );
}
