/**
 * Node sizing — the "render-measure by content/mode" step ELK needs before it
 * can place anything (07 §1). Deterministic and DOM-free so the layout adapter
 * stays unit-testable.
 */

import type { WorkflowNode } from "@codeflow/core";
import {
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

/* -------------------------------------------------------------------------- *
 * Card geometry.
 *
 * Every constant below is a number the *DOM* produces: the pixel value of a
 * class in `flow/nodes.tsx` or of a rule in `styles.css`, with the class named
 * in its comment. That pairing is the whole contract — `.cf-node` is
 * `height: 100%; overflow: hidden`, so a card renders inside exactly the box
 * ELK was given, and a measurement one pixel short is a line of text cut in
 * half rather than a slightly tight card.
 *
 * Two rules keep the pairing true as the card gains furniture:
 *
 * - **the header is a fixed shape.** The caption line is reserved at the badge
 *   height whether or not a badge is on it, so a diagnostic appearing — or a
 *   run putting `×12` and a duration on every step — cannot change the size the
 *   layout was computed at. A run must not reflow the canvas.
 * - **the last block owns the bottom padding.** `PAD_TOP` at the top and
 *   `PAD_BOTTOM` under the last row are the same number, and the 8px under the
 *   header is a *gap between blocks*, not the card's own padding.
 * -------------------------------------------------------------------------- */

/** `.cf-node` / `.cf-container` carry a 1px border on all four sides. */
const BORDER_Y = 2;
/** Header `pt-3`. */
const PAD_TOP = 12;
/** Bottom padding of whichever block ends the card — `pb-3` on the body,
 *  `mb-3` on a folded container's summary, `pb-3` on a header with no body. */
const PAD_BOTTOM = 12;
/** Header `pb-2` — the gap down to the next block, not the card's padding. */
const BLOCK_GAP = 8;
/** `.cf-node__chip` — 1.5rem, and 1.125rem in the chip form. */
const CHIP = 24;
const CHIP_MINOR = 18;
/** The title line — `leading-4` at 13px (11px in the chip form). */
const TITLE_LINE = 16;
/**
 * The caption line under the title, held at the badge height on purpose.
 *
 * `Action`, `NEEDS SETUP` and `142ms ×12` all ride this line. Sizing it to the
 * caption alone and letting a badge push it taller is what made a run resize
 * every card it touched — and a card that grows after ELK has placed it is a
 * card whose last row is drawn outside its own box. 17px is
 * `.cf-run-badge`'s height and `StatusBadge`'s `h-[17px]`.
 */
const CAPTION_LINE = 17;
/** Compact header `py-2.5`; the chip form's header `py-1.5`. */
const COMPACT_PAD_Y = 10;
const MINOR_PAD_Y = 6;
/**
 * A `code` step at the beginner level is drawn as a chip, not as a card.
 *
 * Twenty-one "Custom Code" boxes on an 87-step flow is a fifth of the diagram
 * spent on the part that is *not* a business step — the fold, the reshape, the
 * bit of TypeScript between two tool calls. They still have to be there (hiding
 * them would be the diagram lying about what runs), but they have no business
 * being the same size and weight as "Send Slack message".
 */
const MIN_WIDTH_MINOR = 132;
/** A settings row — `text-[11.5px] leading-5`. */
const ROW_HEIGHT = 20;
/** A provenance line sits under the settings and reads at a smaller size. */
const TAKES_ROW_HEIGHT = 17;
/** `dl` `gap-0.5` between two rows. */
const ROW_GAP = 2;
/** One line of verbatim source at the developer level — `leading-4`. */
const SOURCE_LINE = 16;
/** Horizontal chrome: 12px padding + 24px chip + 10px gap + 12px padding. */
const PADDING_X = 58;
const ROW_PADDING_X = 34;
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
 *
 * The row itself is `py-1` around a `leading-4` line; the padding under it is
 * `PAD_BOTTOM`, same as any other last block.
 */
const FOLD_ROW_HEIGHT = 24;
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
  /**
   * Height of a registered renderer's body, when one draws this node
   * (`flow/renderer.ts`). It *replaces* the summary rows — the renderer owns
   * the block under the header — and it is a declared number rather than a
   * measured one, because nothing here can measure a host's component.
   */
  customBodyHeight?: number | null,
): NodeSize {
  const minor = isMinorNode(node, mode);
  const width = measureWidth(node, mode, links);
  const custom =
    customBodyHeight === undefined || customBodyHeight === null || mode === "compact"
      ? null
      : customBodyHeight;
  const body = custom ?? bodyHeight(node, mode, links);

  if (collapsedInner === undefined || collapsedInner === null) {
    return {
      width,
      height:
        BORDER_Y +
        headerTop(mode, minor) +
        // No body: the header is the last block and owns the bottom padding.
        (body === null ? headerPadBottom(mode, minor) : BLOCK_GAP + body + PAD_BOTTOM),
    };
  }

  /*
   * Folded: the `12 steps inside` button is the last block, so it — not the
   * body — carries the bottom padding, and the body's own padding shrinks back
   * to the gap it is: 8px between the last row and the summary.
   */
  const label = insideLabel(collapsedInner);
  return {
    width: clamp(
      Math.max(width, ROW_PADDING_X + (label.length + 4) * ROW_CHAR),
      FOLD_MIN_WIDTH,
      MAX_WIDTH,
    ),
    height:
      BORDER_Y +
      headerTop(mode, minor) +
      // Something always follows the header here, so it never gets PAD_BOTTOM.
      (mode === "compact" ? COMPACT_PAD_Y : BLOCK_GAP) +
      (body === null ? 0 : body + BLOCK_GAP) +
      FOLD_ROW_HEIGHT +
      PAD_BOTTOM,
  };
}

/** Everything down to, but not including, the header's bottom padding. */
function headerTop(mode: DisclosureMode, minor: boolean): number {
  if (minor) return MINOR_PAD_Y + CHIP_MINOR;
  // Nothing rides under the title at the beginner level — a diagnostic or a run
  // badge sits *beside* it — so the chip is the tallest thing on the line.
  if (mode === "compact") return COMPACT_PAD_Y + CHIP;
  return PAD_TOP + Math.max(CHIP, TITLE_LINE + CAPTION_LINE);
}

/** The header's own bottom padding, for a card whose header is its last block. */
function headerPadBottom(mode: DisclosureMode, minor: boolean): number {
  if (minor) return MINOR_PAD_Y;
  if (mode === "compact") return COMPACT_PAD_Y;
  return PAD_BOTTOM;
}

/**
 * The block under the header, without its own bottom padding — or `null` when
 * the level draws no body at all.
 */
function bodyHeight(
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
): number | null {
  if (mode === "compact") return null;
  if (mode === "developer") return developerLines(node).length * SOURCE_LINE;

  const rows = nodeSummaryRows(node, links);
  if (rows.length === 0) return null;
  return (
    rows.reduce((total, row) => total + (row.kind === "takes" ? TAKES_ROW_HEIGHT : ROW_HEIGHT), 0) +
    (rows.length - 1) * ROW_GAP
  );
}

function measureWidth(
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
): number {
  // The caption sits *under* the title now, so it competes for width instead of
  // adding to it; its face is smaller, hence the 0.55 factor.
  const caption = nodeCaption(node, mode);
  const titleChars = Math.max(nodeTitle(node, mode).length, (caption?.length ?? 0) * 0.55);
  const chevron = node.type === "loop" || node.type === "try" ? FOLD_CHEVRON_ROOM : 0;
  const headerWidth = PADDING_X + BADGE_ROOM + chevron + titleChars * CHAR;

  if (mode === "compact") {
    if (isMinorNode(node, mode)) return clamp(30 + titleChars * 6.1, MIN_WIDTH_MINOR, 260);
    return clamp(headerWidth, MIN_WIDTH, MAX_WIDTH);
  }

  if (mode === "developer") {
    const widest = developerLines(node).reduce((max, line) => Math.max(max, line.length), 0);
    return clamp(Math.max(headerWidth, ROW_PADDING_X + widest * MONO_CHAR), MIN_WIDTH, MONO_MAX_WIDTH);
  }

  const rowWidth = nodeSummaryRows(node, links).reduce(
    (max, row) =>
      Math.max(
        max,
        ROW_PADDING_X +
          (row.key.length + row.value.length + 3) * (row.kind === "takes" ? ROW_CHAR * 0.92 : ROW_CHAR),
      ),
    0,
  );
  return clamp(Math.max(headerWidth, rowWidth), MIN_WIDTH, MAX_WIDTH);
}

export type Measurer = (
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
  collapsedInner?: number | null,
  customBodyHeight?: number | null,
) => NodeSize;
