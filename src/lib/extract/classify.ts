import type { InsightClass } from "@/lib/schema";

const UNKNOWN_RES = [
  /\bunknown\b/i,
  /\bunclear\b/i,
  /\bnot (?:been |yet )?(?:known|measured|modeled|fielded|quantified|tested)\b/i,
  /\bhas not been\b/i,
  /\bhave not\b/i,
  /\bdo not have\b/i,
  /\bwe don['’]?t have\b/i,
  /\bremains un(?:known|quantified|measured)\b/i,
  /\bopen question/i,
  /\binsufficient\b/i,
  /\bunanswered\b/i,
  /\bno payer-ready\b/i,
  /\bno reliable\b/i,
  /\bis not modeled\b/i,
  /\bis not measured\b/i,
  /\bwithout specifying\b/i,
  /\bimpact of .+ is not\b/i,
  /\bwhether\b/i,
  /\bremains unspecified\b/i,
  /\bis outstanding\b/i,
  /\bhas not been (?:scheduled|filed|proposed|pooled|confirmed)\b/i,
];

const OPPORTUNITY_RES = [
  /\bopportunity\b/i,
  /\brecommend(?:ed|ation)?\b/i,
  /\bstand up\b/i,
  /\bclose the (?:gap|evidence)\b/i,
  /\bprotocol amendment\b/i,
  /\bshould (?:stand|shift|fund|amend|fund|fund|consider)\b/i,
  /\bsignaled openness\b/i,
  /\bshift \d+%?\b/i,
  /\bfund a\b/i,
  /\ballow concurrent\b/i,
  /\bconvene an?\b/i,
  /\brequest a type b\b/i,
  /\bopen two additional\b/i,
];

export function classifyStatement(
  statement: string,
  heading?: string,
): InsightClass {
  const blob = `${heading ?? ""} ${statement}`;
  if (OPPORTUNITY_RES.some((r) => r.test(blob))) return "opportunity";
  if (UNKNOWN_RES.some((r) => r.test(blob))) return "unknown";
  if (/gap|open question|unresolved|need data|need rwe/i.test(blob)) {
    return "unknown";
  }
  return "known";
}

export function headingSuggestsGaps(heading?: string): boolean {
  if (!heading) return false;
  return /open question|unknown|gap|risk|unresolved|need to know/i.test(
    heading,
  );
}
