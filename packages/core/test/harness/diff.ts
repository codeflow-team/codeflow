/**
 * Unified text diff for the round-trip suite — 11-testing.md §3.4.
 *
 * The expected diffs of the fixture corpus are reviewed by hand, so the format
 * has to be the familiar one: `@@` hunk headers, three lines of context, one
 * `-`/`+` line per changed line. Written here rather than pulled in as a
 * dependency — the core package has exactly one runtime dependency and the
 * tests keep it that way.
 *
 * Line-based on purpose: a diff that only reported *offsets* could hide a
 * whitespace change, and I3 is precisely about whitespace not moving.
 */

const CONTEXT = 3;

interface Line {
  text: string;
  /** The file ends without a newline after this line. */
  noNewline: boolean;
}

function toLines(source: string): Line[] {
  if (source.length === 0) return [];
  const parts = source.split("\n");
  const endsWithNewline = parts[parts.length - 1] === "";
  if (endsWithNewline) parts.pop();
  return parts.map((text, index) => ({
    text,
    noNewline: !endsWithNewline && index === parts.length - 1,
  }));
}

/** Longest common subsequence of two line arrays, as index pairs. */
function lcs(a: readonly Line[], b: readonly Line[]): Array<[number, number]> {
  const rows = a.length;
  const columns = b.length;
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i].text === b[j].text
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (a[i].text === b[j].text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

type Op = { kind: " " | "-" | "+"; line: Line; a: number; b: number };

function operations(a: readonly Line[], b: readonly Line[]): Op[] {
  const common = lcs(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj] of common) {
    while (i < ai) {
      ops.push({ kind: "-", line: a[i], a: i, b: j });
      i++;
    }
    while (j < bj) {
      ops.push({ kind: "+", line: b[j], a: i, b: j });
      j++;
    }
    ops.push({ kind: " ", line: a[i], a: i, b: j });
    i++;
    j++;
  }
  while (i < a.length) {
    ops.push({ kind: "-", line: a[i], a: i, b: j });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "+", line: b[j], a: i, b: j });
    j++;
  }
  return ops;
}

function render(op: Op): string[] {
  const rendered = [`${op.kind}${op.line.text}`];
  if (op.line.noNewline) rendered.push("\\ No newline at end of file");
  return rendered;
}

/**
 * Unified diff of two revisions. Empty string when they are byte-identical —
 * the shape an "empty edit changed nothing" assertion wants (I4).
 */
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = toLines(before);
  const b = toLines(after);
  const ops = operations(a, b);

  const changed = ops
    .map((op, index) => (op.kind === " " ? -1 : index))
    .filter((index) => index !== -1);
  if (changed.length === 0) return "";

  // Group changed operations into hunks, merging groups closer than 2×context.
  const groups: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (const index of changed.slice(1)) {
    if (index - end <= CONTEXT * 2) end = index;
    else {
      groups.push([start, end]);
      start = index;
      end = index;
    }
  }
  groups.push([start, end]);

  const out: string[] = [];
  for (const [from, to] of groups) {
    const first = Math.max(0, from - CONTEXT);
    const last = Math.min(ops.length - 1, to + CONTEXT);
    const slice = ops.slice(first, last + 1);

    const aCount = slice.filter((op) => op.kind !== "+").length;
    const bCount = slice.filter((op) => op.kind !== "-").length;
    const aStart = aCount === 0 ? slice[0].a : slice.find((op) => op.kind !== "+")!.a + 1;
    const bStart = bCount === 0 ? slice[0].b : slice.find((op) => op.kind !== "-")!.b + 1;

    out.push(`@@ -${String(aStart)},${String(aCount)} +${String(bStart)},${String(bCount)} @@`);
    for (const op of slice) out.push(...render(op));
  }
  return `${out.join("\n")}\n`;
}
