/**
 * Node sizing — the "render-measure by content/mode" step ELK needs before it
 * can place anything (07 §1). Deterministic and DOM-free so the layout adapter
 * stays unit-testable.
 */

import type { WorkflowNode } from "@codeflow/core";
import {
  DEVELOPER_MAX_LINES,
  developerLines,
  nodeKindLabel,
  nodeSummaryRows,
  type DisclosureMode,
} from "../flow/summary.js";

export interface NodeSize {
  width: number;
  height: number;
}

/** Approximate advance width of the UI font at 12px, and of the mono font at 11px. */
const CHAR = 6.9;
const MONO_CHAR = 6.6;

const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 18;
const PADDING_X = 28;
const PADDING_Y = 10;

const MIN_WIDTH = 168;
const MAX_WIDTH = 430;
const MONO_MAX_WIDTH = 460;

/** Padding a container reserves for its header before its children start. */
export const CONTAINER_PADDING = { top: 56, left: 20, bottom: 22, right: 20 };
export const CONTAINER_MIN_SIZE = { width: 260, height: 140 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function measureNode(node: WorkflowNode, mode: DisclosureMode): NodeSize {
  // icon + label, and — outside compact — the type caption rendered beside it.
  const captionChars = mode === "compact" ? 0 : nodeKindLabel(node).length + 2;
  const headerWidth = PADDING_X + 22 + (node.label.length + captionChars) * CHAR;

  if (mode === "compact") {
    return { width: clamp(headerWidth, MIN_WIDTH, MAX_WIDTH), height: HEADER_HEIGHT + PADDING_Y };
  }

  if (mode === "developer") {
    const lines = developerLines(node);
    const widest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return {
      width: clamp(Math.max(headerWidth, PADDING_X + widest * MONO_CHAR), MIN_WIDTH, MONO_MAX_WIDTH),
      height: HEADER_HEIGHT + PADDING_Y + Math.min(lines.length, DEVELOPER_MAX_LINES + 1) * 16 + 6,
    };
  }

  const rows = nodeSummaryRows(node);
  const rowWidth = rows.reduce((max, row) => Math.max(max, (row.key.length + row.value.length + 3) * CHAR), 0);
  return {
    width: clamp(Math.max(headerWidth, PADDING_X + rowWidth), MIN_WIDTH, MAX_WIDTH),
    height: HEADER_HEIGHT + PADDING_Y + rows.length * ROW_HEIGHT + (rows.length > 0 ? 6 : 0),
  };
}

export type Measurer = (node: WorkflowNode, mode: DisclosureMode) => NodeSize;
