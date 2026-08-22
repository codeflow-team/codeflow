/** Patch engine — workflow → code (06-patch-engine.md). */

export { computePatch, buildProvenance } from "./patch.js";
export type { ComputePatchInput, ComputedPatch } from "./patch.js";

export { planPatch } from "./plan.js";
export type { PlanInput, PatchPlan, InsertSpec } from "./plan.js";

export { applyEdits, toPatches, mapOffset, assertNoOverlap, sortEdits } from "./edits.js";
export type { TextEdit } from "./edits.js";

export { detectStyle } from "./style.js";
export type { SourceStyle } from "./style.js";

export { renderStringLiteral, isFieldValue } from "./values.js";
export type { FieldValue, LiteralValue, ResolvedValue, OriginalForm } from "./values.js";

export { suggestVariableName } from "./statement-edits.js";
