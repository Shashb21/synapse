/** Availability summary reports stored preferences and credential presence without live calls. */
import { describe, expect, it } from "vitest";
import { buildAiSummary, credentialFeedback } from "@/components/platform/ai-availability";
import { noAiSections } from "@/modules/kernel/ai-sections";
import { STAGE_IDS, STAGES } from "@/modules/kernel/contracts";
const keys = [
  { id: "xai-grok", label: "xAI · Grok", auth: "api_key" as const, default_model: "grok-4", status: "missing" as const },
  { id: "anthropic-claude", label: "Anthropic · Claude", auth: "api_key" as const, default_model: "claude-sonnet", status: "configured" as const },
];
const routes = STAGE_IDS.filter(stage => STAGES[stage].kind === "agentic").map(stage => ({ stage, provider_id: "xai-grok", model: "grok-4", fallbacks: ["anthropic-claude"] }));
const enabled = { ...noAiSections(), gap_extraction: true };
const input = { master: true, sections: enabled, routes, providers: keys };
describe("KAN-193 customer availability", () => {
  it("keeps stored section counts while the master switch is off", () => {
    const summary = buildAiSummary({ ...input, master: false });
    expect(summary.master).toBe("Off");
    expect(summary.sections).toContain("1 of 8 enabled");
    expect(summary.customer).toContain("Off for every customer");
    expect(summary.customer).toContain("stored");
    expect(summary.action.href).toBe("#ai-switch");
  });
  it("does not call customer AI enabled when every section is off", () => {
    const summary = buildAiSummary({ ...input, sections: noAiSections() });
    expect(summary.customer).toContain("No customer AI sections enabled");
    expect(summary.action.href).toBe("#ai-switch");
  });
  it("distinguishes configured fallback from a missing primary", () => {
    const summary = buildAiSummary(input);
    expect(summary.customer).toContain("1 section permitted");
    expect(summary.credentials).toContain("1 enabled model stage uses a configured fallback");
    expect(summary.credentials).toContain("unverified");
    expect(summary.action.href).toBe("#providers");
  });
  it("names enabled model routes without any usable credentials", () => {
    const summary = buildAiSummary({ ...input, providers: keys.map(key => ({ ...key, status: "missing" as const })) });
    expect(summary.credentials).toContain("1 enabled model stage has no configured provider");
    expect(summary.action.href).toBe("#providers");
  });
  it("does not block ingestion-only permission on unused model keys", () => {
    const summary = buildAiSummary({ ...input, sections: { ...noAiSections(), ingestion: true }, providers: [] });
    expect(summary.customer).toContain("1 section permitted");
    expect(summary.credentials).toContain("Enabled sections do not call a model");
    expect(summary.action.href).toBe("#ai-switch");
  });
  it("reports mixed providers and models using model stages only", () => {
    const summary = buildAiSummary({ ...input, routes: [...routes.map((route, index) => index ? route : { ...route, provider_id: "anthropic-claude", model: "claude-sonnet" }), { stage: "S0", provider_id: "other", model: "unused", fallbacks: [] }] });
    expect(summary.routing).toContain("Mixed providers and models");
    expect(summary.routing).toContain(`${routes.length} model stages`);
    expect(summary.routing).not.toContain("unused");
  });
  it("reports mixed models without claiming providers differ", () => {
    const summary = buildAiSummary({ ...input, routes: routes.map((route, index) => index ? route : { ...route, model: "other-saved-model" }) });
    expect(summary.routing).toContain("Mixed models");
    expect(summary.routing).not.toContain("Mixed providers");
  });
  it.each(["master", "sections", "routes", "providers"] as const)("keeps failed %s reads unknown", field => {
    const summary = buildAiSummary({ ...input, [field]: null });
    expect(Object.values(summary).join(" ")).toContain("unavailable");
    expect(summary.action.label).toContain("Review");
  });
  it("does not accept error text or secret-bearing route labels in the summary", () => {
    const summary = buildAiSummary({ ...input, routes: routes.map(route => ({ ...route, provider_id: "sk-secret", model: "sk-secret" })) });
    expect(JSON.stringify(summary)).not.toContain("sk-secret");
  });
});
describe("KAN-193 credential selection feedback", () => {
  it("checks draft fallback order and uses a configured permitted fallback", () => {
    expect(credentialFeedback(routes[0], keys)).toContain("configured fallback Anthropic · Claude");
    expect(credentialFeedback({ ...routes[0], fallbacks: [] }, keys)).toContain("No configured provider");
    expect(credentialFeedback({ ...routes[0], fallbacks: ["deterministic-local", "unknown"] }, keys)).toContain("No configured provider");
  });
  it("reports edited primary and unknown credential metadata honestly", () => {
    expect(credentialFeedback({ ...routes[0], provider_id: "anthropic-claude" }, keys)).toContain("Primary key configured");
    expect(credentialFeedback(routes[0], null)).toContain("unavailable");
  });
});
