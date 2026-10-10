import { totalsOf, type LlmCallRecord } from "@/modules/kernel/llm-calls";

/** An estimated cost; "unknown" when no call had a known price, flagged when some lacked one. */
export function formatCost(cost_usd: number | null, unpriced = 0): string {
  if (cost_usd === null) return unpriced > 0 ? "unknown" : "—";
  const amount = cost_usd < 0.01 ? `$${cost_usd.toFixed(4)}` : `$${cost_usd.toFixed(2)}`;
  return unpriced > 0 ? `${amount} + ${unpriced} unpriced` : amount;
}

function tokens(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString("en-US");
}

/** A run's model calls in one line: how many, tokens in and out, estimated cost. */
export function LlmTotalsLine({ calls }: { calls: Pick<LlmCallRecord, "usage" | "cost_usd">[] }) {
  if (calls.length === 0) {
    return <p className="mt-2 text-[12px] text-muted-foreground">No model calls in this run.</p>;
  }
  const totals = totalsOf(calls);
  return (
    <dl className="mt-2 grid gap-1 text-[12px] text-muted-foreground sm:grid-cols-4">
      <div>
        <dt>Calls</dt>
        <dd className="text-foreground">{totals.calls}</dd>
      </div>
      <div>
        <dt>Input tokens</dt>
        <dd className="text-foreground">{tokens(totals.input_tokens)}</dd>
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd className="text-foreground">{tokens(totals.output_tokens)}</dd>
      </div>
      <div>
        <dt>Est. cost</dt>
        <dd className="text-foreground">{formatCost(totals.cost_usd, totals.unpriced)}</dd>
      </div>
    </dl>
  );
}

function Text({ label, value }: { label: string; value: string | null }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[12px] text-muted-foreground">
        {label}
        {value === null ? "" : ` · ${value.length.toLocaleString("en-US")} characters`}
      </summary>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-2 text-[12px] leading-5 text-foreground">
        {value ?? "No reply."}
      </pre>
    </details>
  );
}

/**
 * Every model call of a run (KAN-91): the prompts and reply, collapsible and
 * whole, with provider, model, parameters, tokens, estimated cost and latency.
 */
export function LlmCallList({ calls }: { calls: LlmCallRecord[] }) {
  if (calls.length === 0) return null;
  return (
    <section className="mt-6 grid gap-2" aria-labelledby="llm-calls-heading" data-testid="llm-calls">
      <h2 id="llm-calls-heading" className="text-[13px] font-semibold text-foreground">
        Model calls
      </h2>
      <p className="text-[12px] text-muted-foreground">
        Each call as sent and received. Secrets are removed before a prompt is stored; cost is an estimate from the
        price table.
      </p>
      <ol className="grid gap-2">
        {calls.map((call) => (
          <li key={call.id} id={call.id} className="rounded-lg border border-border bg-card p-3" data-testid="llm-call">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] text-foreground">
                {call.purpose}
                {call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}
              </h3>
              <span className={call.status === "error" ? "text-[12px] text-destructive" : "text-[12px] text-muted-foreground"}>
                {call.status === "error" ? "failed" : "ok"} · {call.latency_ms.toLocaleString("en-US")} ms
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {call.provider_id} · {call.model} · {call.params.temperature === null ? "temperature not sent" : `temperature ${call.params.temperature}`} · max {tokens(call.params.max_tokens)} tokens
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Tokens in {tokens(call.usage?.input_tokens)} · out {tokens(call.usage?.output_tokens)}
              {call.usage?.reasoning_tokens ? ` (reasoning ${tokens(call.usage.reasoning_tokens)})` : ""} · est. cost{" "}
              {formatCost(call.cost_usd, call.cost_usd === null ? 1 : 0)}
            </p>
            {call.error ? <p className="mt-1 text-[12px] text-destructive">{call.error}</p> : null}
            <Text label="System prompt" value={call.system_prompt} />
            <Text label="User prompt" value={call.user_prompt} />
            <Text label="Reply" value={call.reply} />
          </li>
        ))}
      </ol>
    </section>
  );
}
