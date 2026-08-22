/**
 * Display syntax for editable field values — 06-patch-engine.md §3.
 *
 * `{{ }}` is a *display* form of a TypeScript expression, never a second
 * expression language (00 §6.7). The mapping is 1-1; when it stops being 1-1
 * (a string literal that already contains `{{`, an expression the scanner cannot
 * split unambiguously) we refuse the friendly form and fall back to raw code —
 * the degradation path the spec prescribes, not an invented escape syntax.
 */

export type FieldDisplayKind =
  | "string"
  | "template"
  | "expression"
  | "number"
  | "boolean"
  | "null"
  | "empty";

export interface FieldDisplay {
  kind: FieldDisplayKind;
  /** What the inspector shows. For `friendly: false` this is the raw source. */
  text: string;
  /**
   * False when the friendly rendering would be ambiguous — the field then has to
   * be shown/edited as code (06 §3, "Escaping/nhập nhằng").
   */
  friendly: boolean;
  /** Original source text of the expression, verbatim. */
  raw: string;
}

const AMBIGUOUS = /\{\{|\}\}/;

/** Format one raw TypeScript expression for display. */
export function formatFieldValue(raw: string | null | undefined): FieldDisplay {
  if (raw === null || raw === undefined) return { kind: "empty", text: "", friendly: true, raw: "" };
  const source = raw.trim();
  if (source.length === 0) return { kind: "empty", text: "", friendly: true, raw };

  const quoted = readStringLiteral(source);
  if (quoted !== null) {
    // String literal → shown verbatim, unquoted (06 §3, `"#security"` → `#security`).
    return { kind: "string", text: quoted, friendly: !AMBIGUOUS.test(quoted), raw: source };
  }

  if (source.startsWith("`") && source.endsWith("`") && source.length >= 2) {
    const template = readTemplateLiteral(source);
    if (template !== null) return { kind: "template", text: template.text, friendly: template.friendly, raw: source };
    return { kind: "template", text: source, friendly: false, raw: source };
  }

  if (/^-?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:e[+-]?\d+)?$/i.test(source)) {
    return { kind: "number", text: source, friendly: true, raw: source };
  }
  if (source === "true" || source === "false") {
    return { kind: "boolean", text: source, friendly: true, raw: source };
  }
  if (source === "null" || source === "undefined") {
    return { kind: "null", text: source, friendly: true, raw: source };
  }

  // Anything else is a TypeScript expression → `{{ expr }}` (bare identifier included).
  return {
    kind: "expression",
    text: `{{ ${source} }}`,
    friendly: !AMBIGUOUS.test(source),
    raw: source,
  };
}

/** Unquote a single/double-quoted string literal, or `null` when `source` is not one. */
function readStringLiteral(source: string): string | null {
  const quote = source[0];
  if (quote !== '"' && quote !== "'") return null;
  if (source.length < 2 || source[source.length - 1] !== quote) return null;

  let out = "";
  for (let i = 1; i < source.length - 1; i++) {
    const char = source[i];
    if (char === "\\") {
      const next = source[i + 1];
      if (next === undefined) return null;
      out += unescape(next);
      i++;
      continue;
    }
    // An unescaped closing quote before the end means this is not one literal.
    if (char === quote) return null;
    out += char;
  }
  return out;
}

function unescape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "0":
      return "\0";
    default:
      return char;
  }
}

interface TemplateResult {
  text: string;
  friendly: boolean;
}

/**
 * `` `Security PR: ${pr.title}` `` → `Security PR: {{ pr.title }}` — every
 * interpolation wrapped on its own (06 §3).
 */
function readTemplateLiteral(source: string): TemplateResult | null {
  const body = source.slice(1, -1);
  let text = "";
  /** Only the literal (non-interpolated) parts — where a stray `{{` is ambiguous. */
  let literal = "";
  let friendly = true;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      const next = body[i + 1];
      if (next === undefined) return null;
      text += unescape(next);
      literal += unescape(next);
      i++;
      continue;
    }
    if (char === "$" && body[i + 1] === "{") {
      const end = findInterpolationEnd(body, i + 2);
      if (end === -1) return null;
      const expression = body.slice(i + 2, end).trim();
      if (AMBIGUOUS.test(expression)) friendly = false;
      text += `{{ ${expression} }}`;
      i = end;
      continue;
    }
    if (char === "`") return null; // unescaped backtick — not a single template
    text += char;
    literal += char;
  }

  if (AMBIGUOUS.test(literal)) friendly = false;
  return { text, friendly };
}

/** Index of the `}` closing an interpolation opened at `start`, or -1. */
function findInterpolationEnd(body: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
