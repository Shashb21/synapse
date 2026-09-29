/** A page's kicker, title and lead, in the design's type scale (KAN-8). Shared by the app, admin and lab. */
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
    <div className="mb-4">
      {kicker ? (
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{kicker}</p>
      ) : null}
      <h1 className="text-base font-bold tracking-tight text-foreground">{title}</h1>
      {children ? (
        <div className="mt-1 max-w-4xl text-[12px] leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
