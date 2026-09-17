import Link from "next/link";

const PRIMARY = [
  { href: "/", id: "plan", label: "Plan" },
] as const;

const SECONDARY = [
  { href: "/evals", id: "evals", label: "Eval" },
  { href: "/sdlc", id: "sdlc", label: "Spec" },
] as const;

export type ShellId =
  | "plan"
  | "needs"
  | "gaps"
  | "tactics"
  | "residuals"
  | "roadmap"
  | "sources"
  | "evals"
  | "sdlc";

export function AppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: ShellId;
}) {
  const links = [...PRIMARY, ...SECONDARY];
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-[1200px] items-center gap-6 px-4 py-2.5 sm:px-6">
          <Link href="/" className="text-[13px] font-medium text-foreground no-underline">
            Synapse IEGP
          </Link>
          <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[13px] no-underline ${
                  active === l.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export function PageIntro({
  kicker,
  title,
  children,
}: {
  kicker?: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      {kicker ? (
        <p className="mb-1 text-[11px] text-muted-foreground">{kicker}</p>
      ) : null}
      <h1 className="text-lg font-medium text-foreground">{title}</h1>
      {children ? (
        <div className="mt-2 max-w-3xl text-[13px] leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
