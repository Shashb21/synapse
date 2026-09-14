import { AppShell } from "@/components/insight-card";
import Link from "next/link";

const DOCS = [
  {
    href: "/docs/sdlc/01-requirements.md",
    id: "REQ",
    title: "Requirements",
    body: "Product requirements with stable IDs (REQ-ING, REQ-EXT, REQ-KNO, REQ-EVA, REQ-REG, REQ-OPS).",
  },
  {
    href: "/docs/sdlc/02-architecture.md",
    id: "ARCH",
    title: "Architecture",
    body: "CIR JSON, theme_links join table, why catalog multi-label beats semantic clustering, three-model eval loop.",
  },
  {
    href: "/docs/sdlc/03-design.md",
    id: "DES",
    title: "Design",
    body: "Extractor strategies, clustering, known/unknown/opportunity classification, and dashboard IA.",
  },
  {
    href: "/docs/sdlc/04-tdd.md",
    id: "TDD",
    title: "TDD plan",
    body: "Review → accept → write → pass. Every test maps to a requirement ID.",
  },
  {
    href: "/docs/sdlc/05-process.md",
    id: "PRC",
    title: "SDLC & tooling",
    body: "Where Origin, Cloud Agent, and Grokbot sit in the development loop.",
  },
  {
    href: "/docs/sdlc/06-eval-protocol.md",
    id: "EVA",
    title: "Eval protocol",
    body: "Partial, wrong, missed, new — scoring, safety gates, and hill-climb promotion.",
  },
];

export default function SdlcPage() {
  return (
    <AppShell active="sdlc">
      <h2 className="font-heading text-3xl text-primary">
        Architecture, requirements, and TDD
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        This engine was built under a documented SDLC. Requirement IDs are the
        spine: design cites them, tests name them, CI regressions fail on them.
      </p>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {DOCS.map((doc) => (
          <a
            key={doc.id}
            href={doc.href}
            className="rounded-xl border border-border/80 bg-card p-4 hover:border-primary/30"
          >
            <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
              {doc.id}
            </p>
            <h3 className="font-heading text-xl text-primary">{doc.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{doc.body}</p>
          </a>
        ))}
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        Source of truth lives in{" "}
        <code className="rounded bg-muted px-1 py-0.5">docs/sdlc/</code>. Run{" "}
        <code className="rounded bg-muted px-1 py-0.5">npm test</code> then{" "}
        <code className="rounded bg-muted px-1 py-0.5">npm run test:e2e</code>{" "}
        before merging. See also the{" "}
        <Link className="underline" href="/evals">
          eval lab
        </Link>
        .
      </p>
    </AppShell>
  );
}
