/**
 * States that must never change a box — 07 §5, applied to geometry.
 *
 * A panel that moves under the pointer is a panel the user cannot aim at. The
 * rule this module encodes is narrow and absolute: **hover, focus and drag-over
 * may change how an element looks, never how much room it takes.** Colour, ring,
 * shadow and opacity are free; display, size, padding, border *width* and the
 * typography that reflows text are not.
 *
 * The bug it was written for: the "insert this value" affordance on a row of the
 * node editor's left pane was `hidden group-hover:inline-flex`, so hovering a row
 * added a flex item to a `items-baseline` line and made the row one pixel taller
 * — every row below it stepped down, and the whole pane jittered as the pointer
 * moved. The fix is the pair below: the affordance is always in the flow and is
 * revealed with opacity.
 *
 * Pure and DOM-free: `layoutShiftingStateClasses` is a string check, which is
 * what lets a node-environment test assert the rule over the real component
 * sources instead of trusting a comment.
 */

/**
 * Reveal an affordance on hover/focus **without** changing the box.
 *
 * `opacity` is not a layout property, so the element keeps its space whether it
 * is visible or not. Pair it with `self-center` inside a baseline-aligned row:
 * an icon-only control has no text baseline, so baseline alignment would hang it
 * below the row's own baseline and grow the line.
 */
export const REVEAL_ON_HOVER =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100";

/** State variants that fire from the pointer/keyboard rather than from data. */
const STATE_VARIANTS = new Set([
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "group-hover",
  "group-focus",
  "group-focus-within",
  "group-active",
  "peer-hover",
  "peer-focus",
  "peer-focus-visible",
]);

/**
 * Utilities that change the box, as Tailwind writes them.
 *
 * Deliberately not "anything that starts with `border`": `border-line` and
 * `border-dashed` are paint, `border-2` is geometry. Same for `text-`: a colour
 * is fine, a size is not.
 */
const LAYOUT_UTILITIES: RegExp[] = [
  // display
  /^(hidden|block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|inline-table|flow-root|contents|list-item)$/,
  // sizing
  /^(w|h|size|min-w|min-h|max-w|max-h|basis)-/,
  // spacing
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me)-/,
  /^(gap|gap-x|gap-y|space-x|space-y)-/,
  // border *width* — `border`, `border-2`, `border-t-4`, `border-x-2`
  /^border$/,
  /^border(-[trblxyse])?-\d+$/,
  // typography that reflows
  /^text-(xs|sm|base|lg|xl|\d?xl|\[[^\]]*(px|rem|em|ch)\])$/,
  /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[[^\]]*\])$/,
  /^(leading|tracking)-/,
  // flow
  /^(flex-(row|col|wrap|nowrap|wrap-reverse|1|auto|initial|none)|grow|shrink|order)(-|$)/,
  /^(absolute|relative|fixed|sticky|static)$/,
  /^(whitespace|break|truncate)/,
];

/**
 * The classes in `className` that would resize the element in a pointer state.
 *
 * Returns them rather than a boolean so a failing test names the offender. An
 * empty array is the invariant: "no hover/focus/drag state changes this box".
 */
export function layoutShiftingStateClasses(className: string): string[] {
  const found: string[] = [];
  for (const token of className.split(/\s+/)) {
    if (token.length === 0) continue;
    const parts = token.split(":");
    if (parts.length < 2) continue;
    const utility = parts[parts.length - 1];
    const variants = parts.slice(0, -1).map((variant) => variant.replace(/^(!|-)/, ""));
    if (!variants.some((variant) => STATE_VARIANTS.has(variant))) continue;
    if (LAYOUT_UTILITIES.some((pattern) => pattern.test(utility))) found.push(token);
  }
  return found;
}
