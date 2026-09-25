import Link from "next/link";

/** Rendered with a 403 whenever forbidden() is called — today, only by the owner console gate. */
export default function Forbidden() {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center gap-3 px-6 py-16" data-testid="owner-only">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">403</p>
      <h1 className="text-lg font-medium text-foreground">Owner only</h1>
      <p className="text-[13px] leading-5 text-muted-foreground">
        This is the platform owner&apos;s control panel. It is not part of your workspace. If you are the
        owner, sign in with your owner account.
      </p>
      <p className="flex gap-4 text-[13px]">
        <Link href="/" className="text-foreground underline-offset-2 hover:underline">
          Back to your plan
        </Link>
        <Link href="/login" className="text-muted-foreground underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
