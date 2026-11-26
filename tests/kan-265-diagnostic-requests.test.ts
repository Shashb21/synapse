import { afterEach, expect, it, vi } from "vitest";
import {
  diagnosticRequestIdentity,
  diagnosticRequestBudget,
  DIAGNOSTIC_ATTEMPT_LIMIT,
  withinDiagnosticBudget,
} from "@/modules/kernel/diagnostic-requests";
import { evidenceHash } from "@/modules/kernel/decision-replay";
import { quotedRepair, repairUserMessage } from "@/modules/kernel/repair-guidance";
import { openAi } from "@/modules/llm/provider";
import type { ResolvedRoute } from "@/modules/kernel/contracts";

const route: ResolvedRoute = {
  stage: "S2",
  model: "fictional",
  provider_id: "fictional",
  provider_label: "Fixture",
  auth: "api_key",
  connected: true,
  degraded: false,
  params: { temperature: 0, max_tokens: 200 },
  fallbacks: [],
  reason: null,
};
afterEach(() => vi.unstubAllGlobals());

it("fingerprints complete first requests and ordered later role, template, policy and settings", () => {
  const first = { system: "Same system", user: "Instruction A", role: "proposer" as const, purpose: "first" };
  const identity = diagnosticRequestIdentity(first, route, "standard", true);
  expect(diagnosticRequestIdentity({ ...first, user: "Instruction B" }, route, "standard", true).wire).not.toBe(
    identity.wire,
  );
  expect(diagnosticRequestIdentity({ ...first, role: "critic" }, route, "standard", true)).toMatchObject({
    wire: identity.wire,
  });
  const review = {
    system: "Review",
    role: "critic" as const,
    purpose: "critique",
    dialogueFields: ["candidates"],
    user: JSON.stringify({ instruction: "Review each", candidates: [{ statement: "generated A" }] }),
  };
  const baseline = diagnosticRequestIdentity(review, route, "standard", false);
  const changedText = diagnosticRequestIdentity(
    { ...review, user: review.user.replace("generated A", "generated B") },
    route,
    "standard",
    false,
  );
  expect(changedText.actual).not.toBe(baseline.actual);
  expect(changedText.design).toBe(baseline.design);
  for (const variant of [
    diagnosticRequestIdentity(
      { ...review, user: review.user.replace("Review each", "Score each") },
      route,
      "standard",
      false,
    ),
    diagnosticRequestIdentity({ ...review, role: "reviser" }, route, "standard", false),
    diagnosticRequestIdentity(review, route, "single_pass", false),
    diagnosticRequestIdentity({ ...review, maxTokens: 80 }, route, "standard", false),
    diagnosticRequestIdentity(review, { ...route, params: { ...route.params, temperature: 0.5 } }, "standard", false),
  ])
    expect(variant.design).not.toBe(baseline.design);
  expect(evidenceHash([identity.design, baseline.design])).not.toBe(evidenceHash([baseline.design, identity.design]));
});

it.each([
  ["candidates", "problems"],
  ["rows", "problem"],
])("retains the authored repair instruction inside %s while masking generated wording", (collection, field) => {
  const identify = (instruction: string, generated: string) =>
    diagnosticRequestIdentity(
      {
        system: "Repair",
        purpose: "repair",
        role: "reviser",
        dialogueFields: [collection],
        ...repairUserMessage((describe) => {
          const repair = describe(quotedRepair(generated, (value) => `${instruction}. Invalid term: ${value}`));
          return { [collection]: [{ [field]: field === "problems" ? [repair] : repair, objection: generated }] };
        }),
      },
      route,
      "standard",
      false,
    );
  const initial = identify("Quote the source verbatim", "Model wording A");
  expect(identify("Supply the entire sentence", "Model wording A").design).not.toBe(initial.design);
  const generatedChange = identify("Quote the source verbatim", "Model wording B");
  expect(generatedChange.actual).not.toBe(initial.actual);
  expect(generatedChange.design).toBe(initial.design);
});

it("limits physical provider sends across roles and preserves the local parser limit", async () => {
  const budget = diagnosticRequestBudget();
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "{}" } }] }));
  vi.stubGlobal("fetch", fetch);
  const exhausted = withinDiagnosticBudget(budget, {
    check() {
      throw Error("Local parser limit");
    },
    consume: vi.fn(),
  });
  expect(() => exhausted.consume()).toThrow("Local parser limit");
  const local = { check: vi.fn(), consume: vi.fn() };
  const combined = withinDiagnosticBudget(budget, local);
  for (let i = 0; i < DIAGNOSTIC_ATTEMPT_LIMIT; i++) {
    await openAi.complete(
      { model: "gpt-4.1", system: "Test", user: "Fiction", temperature: 0, max_tokens: 10 },
      { api_key: "fixture" },
      { requestBudget: i % 2 ? budget : combined },
    );
  }
  await expect(
    openAi.complete(
      { model: "gpt-4.1", system: "Test", user: "Fiction", temperature: 0, max_tokens: 10 },
      { api_key: "fixture" },
      { requestBudget: combined },
    ),
  ).rejects.toThrow(/request limit/);
  expect(local.consume).toHaveBeenCalledTimes(DIAGNOSTIC_ATTEMPT_LIMIT / 2);
  expect(fetch).toHaveBeenCalledTimes(DIAGNOSTIC_ATTEMPT_LIMIT);
});
