/** Content frame for an owner-console page that has no sub-navigation of its own. */
export function AdminMain({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-6">{children}</main>;
}

export { PageIntro } from "@/components/page-intro";
