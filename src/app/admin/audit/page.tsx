import Link from "next/link";
import { requireOwnerPage } from "@/modules/auth/owner";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { runTraceHref } from "@/components/admin/admin-nav";
import { Badge } from "@/components/ui/badge";
import {
  AUDIT_CATEGORIES,
  AUDIT_PAGE_SIZE,
  auditFilterFrom,
  listAuditEvents,
  type AuditEvent,
  type AuditFilter,
} from "@/modules/kernel/audit";

export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<string, string> = {
  admin: "Admin",
  auth: "Sign-in",
  config: "Configuration",
  workspace: "Workspace",
  plan: "Plan",
  ai: "AI",
};

const INPUT = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-[13px] text-foreground";

function queryFor(filter: AuditFilter, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function formatAt(at: string): string {
  return at.replace("T", " ").slice(0, 19);
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** The top-level fields that differ between before and after, or the whole value when either is not an object. */
function changes(event: AuditEvent): { field: string; before: unknown; after: unknown }[] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  // A create (no before) or a delete (no after) still diffs field by field.
  const before = event.before === null && isObject(event.after) ? {} : event.before;
  const after = event.after === null && isObject(event.before) ? {} : event.after;
  if (!isObject(before) || !isObject(after)) {
    return before === null && after === null ? [] : [{ field: "value", before, after }];
  }
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwnerPage();
  const query = await searchParams;
  const filter = auditFilterFrom(query);
  const pageRaw = Array.isArray(query.page) ? query.page[0] : query.page;
  const page = Math.max(1, Number(pageRaw ?? "1") || 1);
  const { events, total } = await listAuditEvents(filter, { page, limit: AUDIT_PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const exportBase = `/api/admin/audit${queryFor(filter)}`;
  const joiner = exportBase.includes("?") ? "&" : "?";

  return (
    <AdminMain>
      <PageIntro kicker="Traceability · every change" title="Audit log">
        Every change and security event across Synapse: who did it, their role, when, what changed (before and after),
        why, and the request it came from. The log is append-only: nobody, including the owner console, can edit or
        delete an entry.
      </PageIntro>

      <form method="get" className="mb-4 grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Filter the audit log">
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Category
          <select name="category" defaultValue={filter.category ?? ""} className={INPUT}>
            <option value="">All</option>
            {AUDIT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Action contains
          <input name="action" defaultValue={filter.action ?? ""} placeholder="e.g. set_role" className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Who (email or name)
          <input name="actor" defaultValue={filter.actor ?? ""} className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Workspace id
          <input name="workspace_id" defaultValue={filter.workspace_id ?? ""} className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Entity type
          <input name="entity_type" defaultValue={filter.entity_type ?? ""} placeholder="e.g. user, route" className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Entity id
          <input name="entity_id" defaultValue={filter.entity_id ?? ""} className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Request id
          <input name="request_id" defaultValue={filter.request_id ?? ""} className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={filter.from ?? ""} className={INPUT} />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={filter.to ?? ""} className={INPUT} />
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className="h-8 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground">
            Filter
          </button>
          <Link href="/admin/audit" className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
            Clear
          </Link>
        </div>
      </form>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <p>
          {total === 0 ? "No events match." : `${total.toLocaleString("en-GB")} ${total === 1 ? "event" : "events"}, newest first.`}
        </p>
        <p className="flex gap-3">
          <a href={`${exportBase}${joiner}format=csv`} className="text-foreground underline-offset-2 hover:underline">
            Export CSV
          </a>
          <a href={`${exportBase}${joiner}format=json`} className="text-foreground underline-offset-2 hover:underline">
            Export JSON
          </a>
        </p>
      </div>

      <ol className="grid gap-2" aria-label="Audit events">
        {events.map((event) => {
          const diff = changes(event);
          return (
            <li key={event.id} className="rounded-lg border border-border bg-card">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3 text-[13px]">
                  <span className="font-mono text-[12px] text-muted-foreground">{formatAt(event.at)}</span>
                  <Badge variant="outline">{CATEGORY_LABELS[event.category] ?? event.category}</Badge>
                  <span className="font-medium text-foreground">{event.action}</span>
                  {event.entity_type ? (
                    <span className="text-muted-foreground">
                      {event.entity_type}
                      {event.entity_id ? ` ${event.entity_id}` : ""}
                    </span>
                  ) : null}
                  <span className="ml-auto text-muted-foreground">
                    {event.actor_name} · {event.actor_principal}
                    {event.actor_role ? ` · ${event.actor_role}` : ""}
                  </span>
                </summary>
                <div className="grid gap-3 border-t border-border p-3 text-[12px]">
                  {event.rationale ? (
                    <p>
                      <span className="text-muted-foreground">Why: </span>
                      {event.rationale}
                    </p>
                  ) : null}
                  {diff.length > 0 ? (
                    <table className="w-full table-fixed text-left">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="w-40 pb-1 font-medium">Field</th>
                          <th className="pb-1 font-medium">Before</th>
                          <th className="pb-1 font-medium">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.map((row) => (
                          <tr key={row.field} className="align-top">
                            <td className="py-1 pr-2 font-mono">{row.field}</td>
                            <td className="py-1 pr-2">
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{show(row.before)}</pre>
                            </td>
                            <td className="py-1">
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{show(row.after)}</pre>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-muted-foreground">No before/after values for this event.</p>
                  )}
                  {event.meta ? (
                    <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px]">{show(event.meta)}</pre>
                  ) : null}
                  <dl className="grid gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt className="inline">Event: </dt>
                      <dd className="inline font-mono">{event.id}</dd>
                    </div>
                    <div>
                      <dt className="inline">Request: </dt>
                      <dd className="inline font-mono">
                        {event.request_id ? (
                          <Link href={`/admin/audit${queryFor({ request_id: event.request_id })}`} className="underline-offset-2 hover:underline">
                            {event.request_id}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Workspace: </dt>
                      <dd className="inline font-mono">{event.workspace_id ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline">Customer: </dt>
                      <dd className="inline font-mono">{event.customer_id ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline">Run: </dt>
                      <dd className="inline font-mono">
                        {event.run_id ? (
                          <Link href={runTraceHref(event.run_id, event.workspace_id)} className="underline-offset-2 hover:underline">
                            {event.run_id}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">From: </dt>
                      <dd className="inline font-mono">{[event.ip, event.user_agent].filter(Boolean).join(" · ") || "—"}</dd>
                    </div>
                  </dl>
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      {pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-[12px]" aria-label="Audit log pages">
          {page > 1 ? (
            <Link href={`/admin/audit${queryFor(filter, { page: String(page - 1) })}`} className="underline-offset-2 hover:underline">
              Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={`/admin/audit${queryFor(filter, { page: String(page + 1) })}`} className="underline-offset-2 hover:underline">
              Older
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </AdminMain>
  );
}
