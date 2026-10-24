/** Present a readable page title and supporting context in the existing type system. */
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
        <p className="mb-0.5 text-caption font-semibold text-muted-foreground">{kicker}</p>
      ) : null}
      <h1 className="break-words text-xl font-bold leading-tight tracking-tight sm:text-2xl text-foreground">{title}</h1>
      {children ? (
        <div className="mt-1 max-w-[75ch] text-sm leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
