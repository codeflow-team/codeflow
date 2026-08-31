/**
 * Sample values, and display shortening.
 *
 * `sampleFromSchema` used to live here. It now lives in `@codeflow/core`
 * (model/sample.ts) because the UI needs the same answer this runner gives: the
 * runner stubs a tool with a sample value, and the node editor shows a sample
 * under a binding nothing has observed yet. Two implementations would let the
 * picture disagree with the run for one and the same schema. It is re-exported
 * here so this module stays the one import site for the worker.
 *
 * `preview` stays local: shortening for display is this runner's policy, and
 * core deliberately refuses to have an opinion about how much of a value is
 * worth sending (run/types.ts).
 */

export { sampleFromSchema } from "@codeflow/core";
export type { JsonSchemaish } from "@codeflow/core";

/** Shorten anything for display, without pretending it was not shortened. */
export function preview(value: unknown, maxChars = 600): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return String(value);
  if (text.length <= maxChars) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return { __truncated: true, chars: text.length, text: `${text.slice(0, maxChars)}…` };
}
