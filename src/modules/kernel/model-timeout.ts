/** Shared time limit for model execution and the ingestion claim that owns its result. */
export function modelRunTimeoutMs(): number {
  const configured = Number(process.env.SYNAPSE_RUN_TIMEOUT_MS);
  // Node timers accept positive signed 32-bit millisecond counts.
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647
    ? configured
    : 180_000;
}
