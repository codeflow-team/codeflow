/**
 * The card's measured height *is* its rendered height.
 *
 * `.cf-node` is `height: 100%; overflow: hidden`, so a card is drawn inside
 * exactly the box ELK was given: a measurement one pixel short is not a tight
 * card, it is a line of text cut in half. These numbers were read off the DOM
 * with `getBoundingClientRect()` on the real canvas — every one of them is the
 * sum of the classes `flow/nodes.tsx` applies:
 *
 *   border 1+1
 *   header  pt-3 (12) + max(chip 24, title 16 + caption 17) + pb-2 (8)
 *   body    Σ rows + gap-0.5 between them + pb-3 (12)
 *
 * with `pb-3` moving up onto the header when there is no body, and onto the
 * `N steps inside` button's `mb-3` when the box is folded.
 *
 * The two invariants under the numbers matter more than the numbers:
 *
 * - top and bottom padding are the same (12), so a card looks deliberate;
 * - the height does not depend on diagnostics or on a run, because the caption
 *   line is reserved at the badge height. A run that resized every card it
 *   touched would be a run that redrew the whole diagram.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@codeflow/core";
import { measureNode } from "../src/layout/measure.js";
import { hasNodeBody, nodeSummaryRows, developerLines } from "../src/flow/summary.js";
import type { NodeDataLinks } from "../src/flow/data-links.js";
import { node } from "./fixtures.js";

/* The pieces, named as `measure.ts` and `nodes.tsx` name them. */
const BORDER = 2;
const PAD_TOP = 12;
const PAD_BOTTOM = 12;
const BLOCK_GAP = 8;
const HEADER_CONTENT = 16 + 17; // title `leading-4` + the reserved caption line
const ROW = 20;
const TAKES_ROW = 17;
const ROW_GAP = 2;
const SOURCE_LINE = 16;
const FOLD_ROW = 24;

/** The height an expanded/developer card comes out at, from its blocks. */
function card(body: number | null): number {
  return BORDER + PAD_TOP + HEADER_CONTENT + (body === null ? PAD_BOTTOM : BLOCK_GAP + body + PAD_BOTTOM);
}

function links(...lines: { from: string; value: string }[]): NodeDataLinks {
  return {
    incoming: lines.map((line, i) => ({
      edgeId: `e${String(i)}`,
      nodeId: `src${String(i)}`,
      nodeLabel: line.from,
      value: line.value,
    })),
    outgoing: [],
  };
}

const tool = (): WorkflowNode =>
  node({
    id: "n_tool",
    type: "tool",
    label: "Get New PRs",
    path: "flow/tool#0",
    data: { toolName: "github.getNewPRs", arguments: { repo: "input.repository" } },
    outputs: [{ id: "p", label: "prs" }],
  });

const bare = (): WorkflowNode =>
  node({ id: "n_loop", type: "loop", label: "For Each pr in prs", path: "flow/for#0", data: { kind: "for" } });

describe("card geometry — measured height is rendered height", () => {
  it("balances the card: the same 12px above the first line and under the last", () => {
    // Two settings rows plus one provenance row — the shape in the screenshot.
    const size = measureNode(tool(), "expanded", links({ from: "Trigger", value: "input.repository" }));
    expect(nodeSummaryRows(tool(), links({ from: "Trigger", value: "input.repository" }))).toHaveLength(3);
    expect(size.height).toBe(card(ROW + ROW + TAKES_ROW + 2 * ROW_GAP));
    expect(size.height).toBe(128);
  });

  it("counts the 2px `gap-0.5` between rows, which is what clipped the last one", () => {
    const one = measureNode(tool(), "expanded", null);
    const three = measureNode(tool(), "expanded", links(
      { from: "A", value: "a" },
      { from: "B", value: "b" },
    ));
    // Two settings rows -> four rows: two more `takes` lines and two more gaps.
    expect(three.height - one.height).toBe(2 * TAKES_ROW + 2 * ROW_GAP);
  });

  it("gives the header the bottom padding when the card has no body", () => {
    const loop = bare();
    expect(hasNodeBody(loop, "expanded", null)).toBe(false);
    expect(measureNode(loop, "expanded", null).height).toBe(card(null));
    expect(measureNode(loop, "expanded", null).height).toBe(59);
  });

  it("holds the beginner level to one line, badge or no badge", () => {
    // 10 + chip 24 + 10 + border. A diagnostic or a run badge rides *beside*
    // the title here, so nothing on the card can change this number.
    expect(measureNode(tool(), "compact", null).height).toBe(46);
    const chip = node({ id: "n_code", type: "code", label: "Custom Code", path: "flow/code#0", data: { text: "const a = 1;" } });
    expect(measureNode(chip, "compact", null).height).toBe(32);
  });

  it("measures the developer level one 16px line at a time", () => {
    const dev = measureNode(tool(), "developer", null);
    expect(dev.height).toBe(card(developerLines(tool()).length * SOURCE_LINE));
  });

  it("hands the bottom padding to the `N steps inside` button on a folded box", () => {
    const loop = bare();
    const shut = measureNode(loop, "expanded", null, 13);
    // header + its 8px gap + the summary row + the card's own bottom padding.
    expect(shut.height).toBe(BORDER + PAD_TOP + HEADER_CONTENT + BLOCK_GAP + FOLD_ROW + PAD_BOTTOM);
    expect(shut.height).toBe(91);
    expect(shut.height).toBeGreaterThan(measureNode(loop, "expanded", null).height);
  });

  it("keeps a folded box's rows and its summary in the same box", () => {
    const tryNode = node({
      id: "n_try",
      type: "try",
      label: "Try",
      path: "flow/try#0",
      data: { hasCatch: true, hasFinally: true, catchParam: "scanError" },
    });
    const shut = measureNode(tryNode, "expanded", null, 44);
    // Two rows, then the 8px gap the body keeps when it is not the last block.
    expect(shut.height).toBe(
      BORDER + PAD_TOP + HEADER_CONTENT + BLOCK_GAP + (ROW * 2 + ROW_GAP) + BLOCK_GAP + FOLD_ROW + PAD_BOTTOM,
    );
    expect(shut.height).toBe(141);
  });

  it("does not move when a step is folded at the beginner level either", () => {
    expect(measureNode(bare(), "compact", null, 13).height).toBe(46 + FOLD_ROW + PAD_BOTTOM);
  });
});
