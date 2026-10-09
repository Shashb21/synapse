import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import {
  auditCsv,
  getAuditEvent,
  listAuditEvents,
  recordAudit,
  redactAuditSecrets,
  REDACTED,
  SYSTEM_ACTOR,
} from "@/modules/kernel/audit";
import { requestIdFor } from "@/modules/kernel/request-id";

/** KAN-87: the platform audit log is append-only, redacted, filterable and exportable. */
const tag = `kan87-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe("KAN-87 audit log", () => {
  it("records who, what, before/after and why, and reads it back", async () => {
    const event = await recordAudit({
      category: "config",
      action: "set_route",
      entity_type: "route",
      entity_id: tag,
      before: { provider_id: "a", params: { max_tokens: 8192 } },
      after: { provider_id: "b", params: { max_tokens: 16000 } },
      rationale: "  switch provider  ",
      actor: { principal: "owner@synapse.test", name: "Owner", role: "operator" },
      workspace_id: null,
    });
    const stored = await getAuditEvent(event.id);
    expect(stored).toMatchObject({
      category: "config",
      action: "set_route",
      actor_principal: "owner@synapse.test",
      actor_role: "operator",
      entity_id: tag,
      rationale: "switch provider",
      before: { provider_id: "a", params: { max_tokens: 8192 } },
      after: { provider_id: "b", params: { max_tokens: 16000 } },
    });
    expect(Date.parse(stored!.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses UPDATE, DELETE and TRUNCATE at the database level", async () => {
    const event = await recordAudit({ category: "admin", action: "probe", entity_id: tag, actor: SYSTEM_ACTOR, workspace_id: null });
    // Drizzle wraps the database error; the refusal is its cause.
    const refusal = (query: Promise<unknown>) =>
      query.then(
        () => "allowed",
        (error: { message?: string; cause?: { message?: string } }) => `${error.cause?.message ?? ""} ${error.message ?? ""}`,
      );
    expect(await refusal(sharedDb().execute(sql`UPDATE audit_events SET action = 'tampered' WHERE id = ${event.id}`))).toMatch(
      /append-only: UPDATE/,
    );
    expect(await refusal(sharedDb().execute(sql`DELETE FROM audit_events WHERE id = ${event.id}`))).toMatch(/append-only: DELETE/);
    expect(await refusal(sharedDb().execute(sql`TRUNCATE audit_events`))).toMatch(/append-only: TRUNCATE/);
    expect((await getAuditEvent(event.id))?.action).toBe("probe");
  });

  it("never stores secrets in before, after or meta", async () => {
    expect(
      redactAuditSecrets({
        password: "p",
        nested: { api_key: "k", client_secret: "s", access_token: "t" },
        max_tokens: 5,
        keyword: "x",
      }),
    ).toEqual({
      password: REDACTED,
      nested: { api_key: REDACTED, client_secret: REDACTED, access_token: REDACTED },
      max_tokens: 5,
      keyword: "x",
    });
    const event = await recordAudit({
      category: "admin",
      action: "reset_password",
      entity_id: tag,
      after: { temporary_password: "hunter2-hunter2" },
      meta: { authorization: "Bearer x" },
      actor: SYSTEM_ACTOR,
      workspace_id: null,
    });
    expect(JSON.stringify(event)).not.toContain("hunter2");
    expect(JSON.stringify(event)).not.toContain("Bearer");
  });

  it("filters by category, entity and action, newest first, and exports CSV safely", async () => {
    await recordAudit({ category: "workspace", action: "rename", entity_type: "workspace", entity_id: tag, actor: SYSTEM_ACTOR, workspace_id: null });
    await recordAudit({
      category: "workspace",
      action: "member_remove",
      entity_type: "workspace",
      entity_id: tag,
      actor: SYSTEM_ACTOR,
      rationale: "=HYPERLINK(1)",
      workspace_id: null,
    });
    const { events, total } = await listAuditEvents({ category: "workspace", entity_id: tag });
    expect(total).toBe(2);
    expect(events.map((e) => e.action)).toEqual(["member_remove", "rename"]);
    expect((await listAuditEvents({ entity_id: tag, action: "renam" })).total).toBe(1);
    const csv = auditCsv(events);
    expect(csv.split("\r\n")[0]).toMatch(/^id,at,category,action/);
    expect(csv).toContain("'=HYPERLINK(1)");
  });

  it("keeps a sane incoming request id and replaces anything else", () => {
    expect(requestIdFor("abcd-1234-efgh")).toBe("abcd-1234-efgh");
    expect(requestIdFor("bad id with spaces")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFor(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
