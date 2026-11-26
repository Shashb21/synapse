/** Shared server-side model limits for a stage or its enclosing ingestion request. */
import { AsyncLocalStorage } from "node:async_hooks";
import { modelRunTimeoutMs } from "./model-timeout";
import { TrustedApplicationError } from "./stage-errors";

/** Local stop before another send, distinct from a provider response. */
export class ModelRunStop extends TrustedApplicationError {
  constructor(reason: "cancelled" | "deadline" | "attempt_limit") {
    const message = {
      cancelled: "The model run was cancelled.",
      deadline: "The model run reached its time limit.",
      attempt_limit: "The model run reached its request limit.",
    }[reason];
    super(message, reason, reason === "attempt_limit" ? 422 : 408);
  }
}

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback;
}

/** Owns the deadline, active HTTP slots and physical sends for one execution. */
class ModelRun {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly concurrency = limit("SYNAPSE_RUN_CONCURRENCY", 4);
  readonly maxAttempts = limit("SYNAPSE_RUN_MAX_ATTEMPTS", 200);
  readonly deadline = Date.now() + modelRunTimeoutMs();
  private sent = 0;
  private active = 0;
  private queue = new Set<() => void>();

  /** Refuse expired runs even if the event loop has not delivered the timer yet. */
  check(): void {
    if (Date.now() >= this.deadline && !this.signal.aborted) this.cancel(new ModelRunStop("deadline"));
    this.signal.throwIfAborted();
  }

  checkAttempt(): void {
    this.check();
    if (this.sent >= this.maxAttempts) {
      const reason = new ModelRunStop("attempt_limit");
      this.cancel(reason);
      throw reason;
    }
  }

  /** Wake all queued tasks on cancellation, including tasks whose callers already returned. */
  cancel(reason = new ModelRunStop("cancelled")): void {
    this.controller.abort(reason);
    for (const wake of this.queue) wake();
    this.queue.clear();
  }

  /** Own a slot only during the outbound request and response-body read. */
  async dispatch<T>(send: () => Promise<T>, reserve?: () => void, beforeRequest?: () => Promise<void>): Promise<T> {
    this.checkAttempt();
    while (this.active >= this.concurrency) {
      await new Promise<void>(resolve => this.queue.add(resolve));
      this.checkAttempt();
    }
    this.active++;
    try {
      if (beforeRequest) {
        await beforeRequest();
        this.checkAttempt();
      }
      // A narrower document allowance may reject work while it waits for a slot.
      reserve?.();
      this.sent++;
      return await send();
    } finally {
      this.active--;
      const next = this.queue.values().next().value;
      if (next) {
        this.queue.delete(next);
        next();
      }
      if (this.sent >= this.maxAttempts) {
        for (const wake of this.queue) wake();
        this.queue.clear();
      }
    }
  }
}

// Route-handler and stage chunks can be evaluated by separate Next module loaders.
const shared = globalThis as typeof globalThis & { synapseModelRuns?: AsyncLocalStorage<ModelRun> };
const scope = shared.synapseModelRuns ??= new AsyncLocalStorage<ModelRun>();

/** The enclosing run, if the caller is a live stage or ingestion request. */
export function currentModelRun() { return scope.getStore(); }

/** Nested stages share the enclosing request's remaining limits. */
export async function withModelRun<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const current = currentModelRun();
  if (current) {
    current.check();
    return operation();
  }
  const run = new ModelRun();
  const cancel = () => run.cancel();
  const timer = setTimeout(() => run.cancel(new ModelRunStop("deadline")), Math.max(0, run.deadline - Date.now()));
  timer.unref();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    run.check();
    return await scope.run(run, operation);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}
