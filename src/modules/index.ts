/**
 * Module wiring. Importing this file registers every stage implementation with
 * the kernel. Adding, versioning or replacing a module is a change here plus the
 * module's own directory — never a change to a sibling stage.
 */
import "@/modules/stages/s0-upload/module";
import "@/modules/stages/s1-parse/module";
import "@/modules/stages/s2-gap-extract/module";
import "@/modules/stages/s3-tactic-extract/module";
import "@/modules/stages/s4-kg-mapping/module";
import "@/modules/stages/s5-validation/module";
import "@/modules/stages/s6-partial-split/module";
import "@/modules/stages/s7-consolidation/module";
import "@/modules/stages/s8-prioritization/module";
import "@/modules/stages/s9-ideation/module";
import "@/modules/stages/s10-timeline/module";

export { runStage } from "@/modules/kernel/run";
export { STAGES, STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
export { stageWiring, activateModule, manifests } from "@/modules/kernel/registry";
