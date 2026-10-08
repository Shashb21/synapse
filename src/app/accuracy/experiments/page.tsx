import { redirect } from "next/navigation";

export default async function LegacyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, entry);
  }
  redirect("/admin/accuracy/experiments" + (query.size ? `?${query}` : ""));
}
