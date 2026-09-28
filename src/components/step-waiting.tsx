import Link from "next/link";
import { Hourglass } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/**
 * Every place is open to look at, but some are waiting on an earlier step.
 * This banner says which step, what is limited until then, and links to it.
 */
export function StepWaiting({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <section
      role="status"
      data-testid="step-waiting"
      className="mb-6 flex flex-wrap items-start gap-3 border border-[var(--unknown)]/40 bg-[var(--unknown)]/5 p-4"
    >
      <Hourglass className="mt-0.5 size-4 shrink-0 text-[var(--unknown)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">{body}</p>
      </div>
      <Link href={href} className={buttonVariants({ size: "sm", variant: "outline" })}>
        {cta}
      </Link>
    </section>
  );
}
