import { expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { matchesSuppliedJudgementRecords, suppliedJudgementRecords } from "@/lib/iegp/judgement-references";

function context() {
  const state = buildSeed();
  const gap = state.gaps[0];
  state.gaps = [gap];
  state.sources = [state.sources[0], { ...state.sources[0], id: "SOURCE-OTHER", title: "Second supplied source" }];
  const need = state.needs[0];
  state.needs = [
    { ...need, id: "NEED-B", source_id: state.sources[0].id, source_quote: "Second quotation\nwith its original second line" },
    { ...need, id: "NEED-A", source_id: state.sources[0].id, source_quote: "First quotation" },
    { ...need, id: "NEED-C", source_id: state.sources[1].id, source_quote: "Other source quotation" },
  ];
  state.need_gap_links = state.needs.map(need => ({ need_id: need.id, gap_id: gap.id, role: "supporting" as const }));
  return state;
}
it("supplies identical support when source and quotation rows are reordered", () => {
  const original = context();
  const reordered = { ...original, sources: [...original.sources].reverse(), needs: [...original.needs].reverse() };
  expect(suppliedJudgementRecords(reordered, [original.gaps[0].id])).toEqual(suppliedJudgementRecords(original, [original.gaps[0].id]));
  expect(suppliedJudgementRecords(original, [original.gaps[0].id]).find(row => row.entity_id === original.sources[0].id)!.excerpt).toBe("First quotation\nSecond quotation\nwith its original second line");
});

it("compares legacy whole quotations without changing their whitespace, line order or multiplicity", () => {
  const original = context();
  const gapIds = [original.gaps[0].id];
  const legacy = suppliedJudgementRecords(original, gapIds).reverse().map(record => record.entity_type === "source" ? {
    ...record, excerpt: original.needs.filter(need => need.source_id === record.entity_id).map(need => need.source_quote).join("\n"),
  } : record);
  const reordered = { ...original, sources: [...original.sources].reverse(), needs: [...original.needs].reverse() };
  expect(matchesSuppliedJudgementRecords(reordered, gapIds, legacy)).toBe(true);
  expect(matchesSuppliedJudgementRecords(reordered, gapIds, suppliedJudgementRecords(original, gapIds))).toBe(true);
  const changedLines = structuredClone(reordered);
  changedLines.needs.find(need => need.id === "NEED-B")!.source_quote = "with its original second line\nSecond quotation";
  expect(matchesSuppliedJudgementRecords(changedLines, gapIds, legacy)).toBe(false);
  const missingQuotation = { ...original, needs: original.needs.filter(need => need.id !== "NEED-A") };
  expect(matchesSuppliedJudgementRecords(missingQuotation, gapIds, legacy)).toBe(false);
  const changedGap = structuredClone(original);
  changedGap.gaps[0].statement += " Substantive scientific change.";
  expect(matchesSuppliedJudgementRecords(changedGap, gapIds, legacy)).toBe(false);
  expect(matchesSuppliedJudgementRecords(original, gapIds, legacy.map(record => ({ ...record, href: "/foreign-record" })))).toBe(false);
  expect(matchesSuppliedJudgementRecords(original, gapIds, [])).toBe(false);
});

it("retains duplicate quotations and resolves ambiguous legacy quotation boundaries exactly", () => {
  const state = context();
  state.needs[0].source_quote = "A";
  state.needs[1].source_quote = "A\nB";
  state.needs.push({ ...state.needs[0], id: "NEED-D" });
  state.need_gap_links.push({ need_id: "NEED-D", gap_id: state.gaps[0].id, role: "supporting" });
  const stored = suppliedJudgementRecords(state, [state.gaps[0].id]).map(record => record.entity_id === state.sources[0].id ? { ...record, excerpt: "A\nA\nB\nA" } : record);
  expect(matchesSuppliedJudgementRecords(state, [state.gaps[0].id], stored)).toBe(true);
  expect(matchesSuppliedJudgementRecords({ ...state, needs: state.needs.filter(need => need.id !== "NEED-D") }, [state.gaps[0].id], stored)).toBe(false);
});
