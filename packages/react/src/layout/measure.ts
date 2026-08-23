/**
 * Node sizing — the "render-measure by content/mode" step ELK needs before it
 * can place anything (07 §1). Deterministic and DOM-free so the layout adapter
 * stays unit-testable.
 */

import type { WorkflowNode } from "@codeflow/core";
import {
  DEVELOPER_MAX_LINES,
  developerLines,
  nodeCaption,
  nodeSummaryRows,
  nodeTitle,
  type DisclosureMode,
} from "../flow/summary.js";
import type { NodeDataLinks } from "../flow/data-links.js";
import { insideLabel } from "../flow/collapse.js";

export interface NodeSize {
  width: number;
  height: number;
}

/**
 * Approximate advance widths: the title face at 13px, the row face at 11.5px,
 * and the mono face at 11px. These track the type scale in `styles.css` — a
 * change there is a change here.
 */
const CHAR = 7.1;
const ROW_CHAR = 6.45;
const MONO_CHAR = 6.6;

/** Title row: 12px top padding + 24px chip + caption line + 8px bottom. */
const HEADER_HEIGHT = 46;
const HEADER_HEIGHT_COMPACT = 44;
/**
 * A `code` step at the beginner level is drawn as a chip, not as a card.
 *
 * Twenty-one "Custom Code" boxes on an 87-step flow is a fifth of the diagram
 * spent on the part that is *not* a business step — the fold, the reshape, the
 * bit of TypeScript between two tool calls. They still have to be there (hiding
 * them would be the diagram lying about what runs), but they have no business
 * being the same size and weight as "Send Slack message".
 */
const HEADER_HEIGHT_COMPACT_MINOR = 32;
const MIN_WIDTH_MINOR = 132;
const ROW_HEIGHT = 20;
/** A provenance line sits under the settings and reads at a smaller size. */
const TAKES_ROW_HEIGHT = 17;
/** Horizontal chrome: 12px padding + 24px chip + 10px gap + 12px padding. */
const PADDING_X = 58;
const ROW_PADDING_X = 34;
const PADDING_Y = 10;
/** Room the delete affordance takes on the title line when selected. */
const BADGE_ROOM = 20;

const MIN_WIDTH = 184;
const MAX_WIDTH = 440;
const MONO_MAX_WIDTH = 470;

/**
 * The `12 steps inside` line on a folded container, and the width it earns.
 *
 * A folded box is a *summary of twelve things*, so it is drawn at least as wide
 * as a comfortable card — shrinking it to the width of its title would make the
 * one box that stands for the most content the smallest thing on the canvas.
 */
const FOLD_ROW_HEIGHT = 34;
const FOLD_MIN_WIDTH = 236;
/**
 * Room on a container's title line for its fold chevron.
 *
 * Every `loop` and `try` carries one, open or shut, so the title has to be
 * measured against a header that is that much narrower — otherwise "For Each
 * testCase in cases" truncates to "For Each testCase i…" on the one box that
 * is standing in for seventy-five steps.
 */
const FOLD_CHEVRON_ROOM = 34;

/**
 * Padding a container reserves around its children.
 *
 * `top` is only a floor: the real inset follows the container's own header
 * (`elk-graph.ts`). The sides are wide enough that a child's selection ring and
 * an edge label inside the body do not touch the container's border.
 */
export const CONTAINER_PADDING = { top: 66, left: 26, bottom: 30, right: 26 };
export const CONTAINER_MIN_SIZE = { width: 300, height: 160 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** True for the "machinery" steps drawn as a quiet chip at the beginner level. */
export function isMinorNode(node: WorkflowNode, mode: DisclosureMode): boolean {
  return mode === "compact" && node.type === "code";
}

/**
 * Size of one node, at a given level, with a given amount of provenance on it.
 *
 * `collapsedInner` is the number of steps folded inside this container, or
 * `null` for everything else: a folded box is drawn as a *card* (header plus a
 * `12 steps inside` line) rather than as a frame around children, so it has to
 * be measured as one.
 */
export function measureNode(
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
  collapsedInner?: number | null,
): NodeSize {
  const open = measureOpen(node, mode, links);
  if (collapsedInner === undefined || collapsedInner === null) return open;

  const label = insideLabel(collapsedInner);
  const bare = open.height <= (mode === "compact" ? HEADER_HEIGHT_COMPACT : HEADER_HEIGHT);
  return {
    width: clamp(
      Math.max(open.width, ROW_PADDING_X + (label.length + 4) * ROW_CHAR),
      FOLD_MIN_WIDTH,
      MAX_WIDTH,
    ),
    height: open.height + FOLD_ROW_HEIGHT + (bare ? PADDING_Y : 0),
  };
}

function measureOpen(
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
): NodeSize {
  // The caption sits *under* the title now, so it competes for width instead of
  // adding to it; its face is smaller, hence the 0.55 factor.
  const caption = nodeCaption(node, mode);
  const titleChars = Math.max(nodeTitle(node, mode).length, (caption?.length ?? 0) * 0.55);
  const chevron = node.type === "loop" || node.type === "try" ? FOLD_CHEVRON_ROOM : 0;
  const headerWidth = PADDING_X + BADGE_ROOM + chevron + titleChars * CHAR;

  if (mode === "compact") {
    if (isMinorNode(node, mode)) {
      return {
        width: clamp(30 + titleChars * 6.1, MIN_WIDTH_MINOR, 260),
        height: HEADER_HEIGHT_COMPACT_MINOR,
      };
    }
    return { width: clamp(headerWidth, MIN_WIDTH, MAX_WIDTH), height: HEADER_HEIGHT_COMPACT };
  }

  if (mode === "developer") {
    const lines = developerLines(node);
    const widest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return {
      width: clamp(Math.max(headerWidth, ROW_PADDING_X + widest * MONO_CHAR), MIN_WIDTH, MONO_MAX_WIDTH),
      height: HEADER_HEIGHT + Math.min(lines.length, DEVELOPER_MAX_LINES + 1) * 16 + PADDING_Y,
    };
  }

  const rows = nodeSummaryRows(node, links);
  const rowWidth = rows.reduce(
    (max, row) =>
      Math.max(
        max,
        ROW_PADDING_X +
          (row.key.length + row.value.length + 3) * (row.kind === "takes" ? ROW_CHAR * 0.92 : ROW_CHAR),
      ),
    0,
  );
  const height = rows.reduce((total, row) => total + (row.kind === "takes" ? TAKES_ROW_HEIGHT : ROW_HEIGHT), 0);
  return {
    width: clamp(Math.max(headerWidth, rowWidth), MIN_WIDTH, MAX_WIDTH),
    height: HEADER_HEIGHT + height + (rows.length > 0 ? PADDING_Y : 0),
  };
}

export type Measurer = (
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
  collapsedInner?: number | null,
) => NodeSize;
