import { registerAccuracyModule } from "./kernel/registry";
import { uploadModule } from "./modules/upload/module";
import { parseModule } from "./modules/parse/module";
import { inventoryExtractModule } from "./modules/inventory-extract/module";
import { needExtractModule } from "./modules/need-extract/module";
import {
  mergeDedupeModule,
  pairGenerateModule,
  ganttProjectModule,
} from "./modules/merge-dedupe/module";
import { statusDeriveModule } from "./modules/status-derive/module";
import { completenessAuditModule } from "./modules/completeness-audit/module";
import {
  coverageDecideModule,
  coverageCriticModule,
} from "./modules/coverage-decide/module";
import { validationGateModule } from "./modules/validation-gate/module";
import {
  partialSplitModule,
  prioritizeModule,
  ideateModule,
} from "./modules/partial-split/module";

let registered = false;

export function registerAccuracyStack() {
  if (registered) return;
  registered = true;
  registerAccuracyModule(uploadModule);
  registerAccuracyModule(parseModule);
  registerAccuracyModule(inventoryExtractModule);
  registerAccuracyModule(needExtractModule);
  registerAccuracyModule(mergeDedupeModule);
  registerAccuracyModule(completenessAuditModule);
  registerAccuracyModule(pairGenerateModule);
  registerAccuracyModule(coverageDecideModule);
  registerAccuracyModule(coverageCriticModule);
  registerAccuracyModule(validationGateModule);
  registerAccuracyModule(partialSplitModule);
  registerAccuracyModule(statusDeriveModule);
  registerAccuracyModule(prioritizeModule);
  registerAccuracyModule(ideateModule);
  registerAccuracyModule(ganttProjectModule);
}

export * from "./kernel/contracts";
export { runAccuracyModule } from "./kernel/run";
export { listAccuracyModules, activeAccuracyModuleId } from "./kernel/registry";
export {
  accuracyRouteConfigs,
  setAccuracyRouteConfig,
  setAccuracyDefaultProvider,
  allRoutableRoles,
} from "./kernel/routing";
export { listAccuracyRuns } from "./kernel/observability";
export { listModelPrices, estimateCostUsd } from "./kernel/cost";
