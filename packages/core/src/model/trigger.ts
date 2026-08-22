/** Analyze options and trigger metadata — 03-data-model.md §9. */

import type { ProvenanceMap } from "./provenance.js";

export interface TriggerMetadata {
  kind: "webhook" | "cron" | "manual" | (string & {});
  label?: string;
  /** e.g. a cron expression */
  config?: Record<string, unknown>;
}

export interface AnalyzeOptions {
  /** Supplied by the host/runtime — it does not live in the code. */
  trigger?: TriggerMetadata;
  /** Overrides the document path used in source mappings. */
  file?: string;
  /**
   * Patch provenance for a session re-analyze — 03 §5.2 step 0. Supplied by the
   * patch engine; absent for every source change that came from outside.
   */
  provenance?: ProvenanceMap;
}
