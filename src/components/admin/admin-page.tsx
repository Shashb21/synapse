/** Content frame for an owner-console page that has no sub-navigation of its own. */
export function AdminMain({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-6">{children}</main>;
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
      {kicker ? <p className="mb-1 text-[11px] text-muted-foreground">{kicker}</p> : null}
      <h1 className="text-lg font-medium text-foreground">{title}</h1>
      {children ? (
        <div className="mt-2 max-w-3xl text-[13px] leading-5 text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}
