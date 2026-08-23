/**
 * Turning engine text into product text.
 *
 * The patch engine and the analyzer write for the person debugging them: their
 * messages cite the spec ("… — delete or edit that node first (06 §2)") and
 * identify themselves by code. That is the right thing for a library and the
 * wrong thing for the person who cannot read the code the flow is made of.
 *
 * Nothing is thrown away here. The message is split into the sentence a human
 * reads and the citation that follows it; the UI shows the sentence as the
 * headline and keeps the code and the citation as secondary detail. The
 * headline per error code is ours; the message underneath is always the
 * engine's own, unedited.
 */

import type { CodeFlowErrorCode } from "@codeflow/core";

const SPEC_REF = /\s*\((?:\d{2}\s*§[\w.§\s,–-]*)\)/g;

export interface SplitMessage {
  /** The message with its spec citations lifted out. */
  text: string;
  /** The citations, in the order they appeared: `["06 §2"]`. */
  refs: string[];
}

/** Split "… first (06 §2)." into a readable sentence plus its citations. */
export function splitSpecRefs(message: string): SplitMessage {
  const refs: string[] = [];
  const text = message
    .replace(SPEC_REF, (match) => {
      refs.push(match.trim().replace(/^\(|\)$/g, ""));
      return "";
    })
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  return { text, refs };
}

/**
 * A headline for a refusal, written for someone who is editing a workflow and
 * has never heard of a patch engine. The engine's own message is always shown
 * under it, so the headline explains rather than replaces.
 */
export function errorHeadline(code: CodeFlowErrorCode | "unknown" | string): string {
  switch (code) {
    case "patch-conflict":
      return "This step changed since the workflow was opened";
    case "patch-dependency":
      return "Another step still needs this one";
    case "patch-not-editable":
      return "This part cannot be changed here";
    case "patch-unsupported":
      return "That change is not supported yet";
    case "patch-invalid":
      return "The change was rejected, so nothing was saved";
    case "patch-node-not-found":
      return "This step is no longer in the flow";
    case "no-anchor":
      return "There is nowhere to add a step yet";
    default:
      return "That change could not be applied";
  }
}

/** Headline for a diagnostic the analyzer attached to a node or the flow. */
export function diagnosticHeadline(code: string): string {
  switch (code) {
    case "unresolved-tool":
      return "Unknown tool";
    case "needs-configuration":
      return "Needs configuration";
    case "unsupported-construct":
      return "Shown as code";
    case "hidden-call-in-expression":
      return "Hidden step inside an expression";
    case "tool-replace-reconfigure":
      return "Re-configure this step";
    case "output-type-changed":
      return "Output type changed";
    case "unresolved-library-function":
      return "Unknown function";
    case "invalid-flow-contract":
      return "This file is not a flow";
    case "parse-error":
      return "The file could not be read";
    default:
      return code.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

/** Plain-language name of a node type, for labels and empty states. */
export function nodeTypeName(type: string): string {
  switch (type) {
    case "trigger":
      return "Trigger";
    case "tool":
      return "Action";
    case "function":
      return "Function";
    case "condition":
      return "Decision";
    case "loop":
      return "Repeat";
    case "try":
      return "Error handling";
    case "parallel":
      return "In parallel";
    case "merge":
      return "Continue";
    case "jump":
      return "Skip";
    case "output":
      return "Finish";
    case "code":
      return "Custom code";
    case "unknown":
      return "Unrecognised step";
    default:
      return type;
  }
}
