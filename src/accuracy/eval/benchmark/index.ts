export { runBenchmarkCli } from './scripts/kan100-benchmark';
export type { CliContext, CliResult } from './scripts/kan100-benchmark';
export { runBenchmarkBatch } from './batch';
export type { BatchServices, BatchResult, BatchHumanReview, ReviewVerificationRequest } from './batch';
export { benchmarkConfigSchema } from './contracts';
export type { BenchmarkConfig, BenchmarkRoute, BaselineRouteSnapshot } from './contracts';
export { checkPreflight } from './preflight';
export { freezeReferencePack } from './inputs';
export type { FrozenReferencePack, FreezeReferencePackInput } from './inputs';

export { renderBenchmarkReport } from './report';
export type { BenchmarkReportInput, BenchmarkReport } from './report';
