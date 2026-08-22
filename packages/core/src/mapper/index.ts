export {
  normalizeAst,
  fingerprintNode,
  fingerprintNodes,
  fingerprintSynthetic,
  fingerprintText,
} from "./fingerprint.js";

export { coldNodeId, computeEdgeId, computeGraphId } from "./ids.js";

export { PathScope, FLOW_ROOT, withRole, callSegment } from "./semantic-path.js";

export {
  positionAt,
  mappingFromRange,
  mappingForNode,
  mappingForStatements,
  mappingForSynthetic,
  mappingForPoint,
} from "./source-mapping.js";
export type { RangeInput } from "./source-mapping.js";
