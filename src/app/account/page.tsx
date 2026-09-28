import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { WorkspacesFrame } from "@/components/workspaces/workspaces-frame";
import { ChangePasswordForm } from "@/components/workspaces/change-password-form";
import { ownerAccess } from "@/modules/auth/owner";
import { MIN_PASSWORD_LENGTH } from "@/modules/auth/password";
import { accountForSession } from "@/modules/auth/password-login";
import { identityProvider } from "@/modules/auth/idp";
import { roleLabel, currentSession } from "@/modules/auth/session";
import { FUNCTION_LABELS } from "@/lib/iegp/enums";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Your account · Synapse IEGP" };

function signInMethod(providerId: string): string {
  if (providerId === "password") return "Email and password";
  if (providerId === "demo") return "Demo sign-in (development only)";
  return identityProvider(providerId)?.label ?? providerId;
}

/** Who you are signed in as, and (for an email and password account) a password change. */
export default async function AccountPage() {
  const session = await currentSession().catch(() => null);
  if (!session) redirect("/login?next=/account");
  const [account, access] = await Promise.all([accountForSession(session), ownerAccess()]);

  const rows: [string, string][] = [
    ["Name", account?.name ?? session.actor.name],
    ["Email", account?.email ?? session.email ?? "Not provided by your sign-in"],
    ["Role", roleLabel(account?.role ?? session.role)],
    ["Function", FUNCTION_LABELS[account?.actor_function ?? session.actor.function]],
    ["Signed in with", signInMethod(session.provider_id)],
  ];
  if (account) rows.push(["Email verified", account.email_verified ? "Yes" : "Not yet (an administrator verifies it)"]);

  return (
    <WorkspacesFrame person={{ name: session.actor.name, email: session.email }}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-medium text-foreground">Your account</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">How Synapse knows you.</p>
        </div>
        <div className="flex gap-3 text-[12px]">
          <Link href="/workspaces" className="text-foreground underline underline-offset-2">
            Workspaces
          </Link>
          {access.owner ? (
            <Link href="/admin" className="text-foreground underline underline-offset-2" data-testid="account-admin-link">
              Admin
            </Link>
          ) : null}
        </div>
      </div>
      <section className="border border-border bg-card/40 p-5" aria-labelledby="profile">
        <h2 id="profile" className="mb-3 text-[15px] font-medium text-foreground">
          Profile
        </h2>
        <dl className="grid gap-2 text-[13px]" data-testid="account-profile">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap justify-between gap-2 border-b border-border/60 pb-2 last:border-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="mt-6 border border-border bg-card/40 p-5" aria-labelledby="password">
        <h2 id="password" className="mb-3 text-[15px] font-medium text-foreground">
          Password
        </h2>
        {account ? (
          <ChangePasswordForm minLength={MIN_PASSWORD_LENGTH} />
        ) : (
          <p className="text-[13px] text-muted-foreground">
            You signed in with {signInMethod(session.provider_id)}, so there is no Synapse password to change.
          </p>
        )}
      </section>
    </WorkspacesFrame>
  );
}
