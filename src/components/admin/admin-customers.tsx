"use client";

import { useState } from "react";
import { Building2, Loader2, Plus, Save, UserMinus, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Customer, SeatAssignment } from "@/modules/auth/customers";

type Detail = { customer: Customer; seats: SeatAssignment[] };

async function call<T>(url: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (HTTP ${res.status}).`);
  return json;
}

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function seatsLabel(customer: Customer): string {
  return `${customer.seats_used} / ${customer.seats}`;
}

function ErrorNote({ error, testId }: { error: string | null; testId: string }) {
  if (!error) return null;
  return (
    <p role="alert" data-testid={testId} className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
      {error}
    </p>
  );
}

const fieldLabel = "grid gap-1 text-[11px] text-muted-foreground";

/** Create a customer: name, email domains, seats sold. */
function CreateCustomerForm({ onCreated }: { onCreated: (customer: Customer) => void }) {
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [seats, setSeats] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      aria-label="Create a customer"
      className="grid gap-2 border border-border bg-card p-4 rounded-lg"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { customer } = await call<{ customer: Customer }>("/api/admin/customers", "POST", {
            name,
            email_domains: domains,
            seats: Number(seats),
          });
          setName("");
          setDomains("");
          setSeats("10");
          onCreated(customer);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not create the customer.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_110px_auto] sm:items-end">
        <label className={fieldLabel}>
          Customer name
          <Input value={name} required placeholder="e.g. Velmara Pharma" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={fieldLabel}>
          Email domains (optional)
          <Input value={domains} placeholder="velmara.com, velmara.eu" onChange={(e) => setDomains(e.target.value)} />
        </label>
        <label className={fieldLabel}>
          Seats
          <Input type="number" min={0} step={1} value={seats} required onChange={(e) => setSeats(e.target.value)} />
        </label>
        <Button type="submit" disabled={busy || name.trim().length < 2 || seats === ""}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" aria-hidden />}
          Create customer
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        With domains set, only emails on them can hold a seat. Leave empty to allow any domain.
      </p>
      <ErrorNote error={error} testId="create-customer-error" />
    </form>
  );
}

/** One customer: edit it, see its seats, assign (one or a pasted list) and unassign. */
function CustomerPanel({
  detail,
  maxBulk,
  onChange,
  onClose,
}: {
  detail: Detail;
  maxBulk: number;
  onChange: (detail: Detail) => void;
  onClose: () => void;
}) {
  const { customer, seats } = detail;
  const [name, setName] = useState(customer.name);
  const [domains, setDomains] = useState(customer.email_domains.join(", "));
  const [seatCount, setSeatCount] = useState(String(customer.seats));
  const [active, setActive] = useState(customer.active);
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const remaining = Math.max(0, customer.seats - customer.seats_used);

  async function save() {
    setBusy("save");
    setEditError(null);
    setNotice(null);
    try {
      const next = await call<Detail>(`/api/admin/customers/${customer.id}`, "PATCH", {
        name,
        email_domains: domains,
        seats: Number(seatCount),
        active,
      });
      onChange(next);
      setNotice("Saved.");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  async function assign() {
    setBusy("assign");
    setSeatError(null);
    setNotice(null);
    try {
      const result = await call<Detail & { assigned: string[]; already: string[] }>(
        `/api/admin/customers/${customer.id}/seats`,
        "POST",
        { emails },
      );
      onChange({ customer: result.customer, seats: result.seats });
      setEmails("");
      const parts = [`Assigned ${result.assigned.length} seat${result.assigned.length === 1 ? "" : "s"}.`];
      if (result.already.length > 0) parts.push(`${result.already.length} already had one.`);
      setNotice(parts.join(" "));
    } catch (err) {
      setSeatError(err instanceof Error ? err.message : "Could not assign seats.");
    } finally {
      setBusy(null);
    }
  }

  async function unassign(email: string) {
    setBusy(`unassign:${email}`);
    setSeatError(null);
    setNotice(null);
    try {
      onChange(await call<Detail>(`/api/admin/customers/${customer.id}/seats`, "DELETE", { email }));
      setNotice(`Unassigned ${email}. They are signed out.`);
    } catch (err) {
      setSeatError(err instanceof Error ? err.message : "Could not unassign the seat.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="customer-heading"
      data-testid="customer-panel"
      className="grid gap-4 border border-border bg-card p-4 rounded-lg"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="customer-heading" className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <Building2 className="size-4 text-muted-foreground" aria-hidden />
            {customer.name}
            {customer.active ? null : <Badge variant="secondary">Inactive</Badge>}
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground" data-testid="customer-seat-summary">
            {customer.seats_used} of {customer.seats} seats assigned · {remaining} remaining
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close customer">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <form
        aria-label="Edit customer"
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_110px_auto_auto] sm:items-end">
          <label className={fieldLabel}>
            Name
            <Input value={name} required onChange={(e) => setName(e.target.value)} />
          </label>
          <label className={fieldLabel}>
            Email domains
            <Input value={domains} placeholder="any domain" onChange={(e) => setDomains(e.target.value)} />
          </label>
          <label className={fieldLabel}>
            Seats sold
            <Input type="number" min={0} step={1} value={seatCount} required onChange={(e) => setSeatCount(e.target.value)} />
          </label>
          <label className="flex h-8 items-center gap-1.5 text-[12px] text-foreground">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
          <Button type="submit" variant="outline" disabled={busy !== null || name.trim().length < 2 || seatCount === ""}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" aria-hidden />}
            Save
          </Button>
        </div>
        {!active && customer.active ? (
          <p className="text-[11px] text-muted-foreground">Saving as inactive signs every seat holder out at once.</p>
        ) : null}
        <ErrorNote error={editError} testId="edit-customer-error" />
      </form>

      <form
        aria-label="Assign seats"
        className="grid gap-2 border-t border-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void assign();
        }}
      >
        <label className={fieldLabel}>
          Assign seats: one email, or paste several (commas, spaces or new lines; up to {maxBulk})
          <Textarea
            value={emails}
            rows={3}
            placeholder={customer.email_domains[0] ? `alex@${customer.email_domains[0]}` : "alex@example.com"}
            onChange={(e) => setEmails(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy !== null || !emails.trim()}>
            {busy === "assign" ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" aria-hidden />}
            Assign seats
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {remaining} seat{remaining === 1 ? "" : "s"} remaining. All or nothing: nothing is assigned if they don&apos;t all
            fit.
          </span>
        </div>
        <ErrorNote error={seatError} testId="seat-error" />
      </form>

      {notice ? (
        <p role="status" data-testid="customer-notice" className="text-[12px] text-foreground">
          {notice}
        </p>
      ) : null}

      <div className="overflow-x-auto border border-border">
        <table className="w-full min-w-[560px] text-left text-[12px]" aria-label="Seats">
          <thead className="bg-muted/40 text-[11px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Assigned by</th>
              <th className="px-3 py-2 font-medium">Assigned</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {seats.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                  No seats assigned yet.
                </td>
              </tr>
            ) : null}
            {seats.map((seat) => (
              <tr key={seat.email} data-testid="seat-row" className="border-t border-border">
                <td className="px-3 py-2 text-foreground">{seat.email}</td>
                <td className="px-3 py-2 text-muted-foreground">{seat.assigned_by}</td>
                <td className="px-3 py-2 text-muted-foreground">{when(seat.assigned_at)}</td>
                <td className="px-3 py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    aria-label={`Unassign ${seat.email}`}
                    onClick={() => void unassign(seat.email)}
                  >
                    {busy === `unassign:${seat.email}` ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <UserMinus className="size-3.5" aria-hidden />
                    )}
                    Unassign
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The Customers page: every customer with seats used / sold; open one to manage its seats. */
export function AdminCustomers({ initialCustomers, maxBulk }: { initialCustomers: Customer[]; maxBulk: number }) {
  const [customers, setCustomers] = useState(initialCustomers);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function upsert(customer: Customer) {
    setCustomers((list) =>
      list.some((c) => c.id === customer.id) ? list.map((c) => (c.id === customer.id ? customer : c)) : [...list, customer],
    );
  }

  async function open(id: string) {
    setLoading(id);
    setError(null);
    try {
      const next = await call<Detail>(`/api/admin/customers/${id}`, "GET");
      upsert(next.customer);
      setDetail(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the customer.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="grid gap-6">
      <CreateCustomerForm
        onCreated={(customer) => {
          upsert(customer);
          setDetail({ customer, seats: [] });
        }}
      />
      <ErrorNote error={error} testId="customers-error" />

      <div className="overflow-x-auto border border-border">
        <table className="w-full min-w-[640px] text-left text-[12px]" aria-label="Customers">
          <thead className="bg-muted/40 text-[11px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Email domains</th>
              <th className="px-3 py-2 font-medium">Seats used / total</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-muted-foreground">
                  No customers yet. Create one above, then assign its seats.
                </td>
              </tr>
            ) : null}
            {customers.map((customer) => (
              <tr
                key={customer.id}
                data-testid="customer-row"
                className={`border-t border-border ${detail?.customer.id === customer.id ? "bg-muted/30" : ""}`}
              >
                <td className="px-3 py-2 font-medium text-foreground">{customer.name}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {customer.email_domains.length ? customer.email_domains.join(", ") : "Any domain"}
                </td>
                <td className="px-3 py-2 text-foreground" data-testid="customer-seats">
                  {seatsLabel(customer)}
                </td>
                <td className="px-3 py-2">{customer.active ? "Active" : "Inactive"}</td>
                <td className="px-3 py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading !== null}
                    aria-label={`Manage ${customer.name}`}
                    onClick={() => void open(customer.id)}
                  >
                    {loading === customer.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Manage
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail ? (
        <CustomerPanel
          key={detail.customer.id}
          detail={detail}
          maxBulk={maxBulk}
          onChange={(next) => {
            upsert(next.customer);
            setDetail(next);
          }}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}
