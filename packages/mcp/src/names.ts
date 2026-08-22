/**
 * MCP tool name → CodeFlow tool name (05-registry.md §3).
 *
 * The mapping is "almost 1-1", and the *almost* lives here. A CodeFlow tool name
 * is `<namespace>.<method>` where every segment is a valid TypeScript identifier,
 * because the name becomes a property path inside the generated `Tools` interface
 * (05 §2) — `tools.github.getIssue(…)`. MCP puts no such constraint on its tool
 * names: `get-issue`, `get_issue`, `search.repos`, `2fa_check`, `delete` and
 * `列出文件` are all legal there.
 *
 * So the method segment is slugged, deterministically, and the original name is
 * kept on the definition (`mcp.toolName`) — nothing about the MCP identity is
 * lost, it just stops being the thing TypeScript has to parse.
 *
 * The identifier rules mirror `@codeflow/core`'s `validateToolName`; they are
 * re-stated instead of imported so the adapter keeps a **type-only** dependency
 * on core (02 §2 — core must never depend on MCP, and this direction stays thin).
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Reserved words cannot be a property-access segment safely, so they get suffixed. */
const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "implements", "interface", "let", "package",
  "private", "protected", "public", "static", "yield", "await",
]);

export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/**
 * Split a name into words. Separators (`-`, `_`, `.`, `/`, spaces, anything else
 * non-alphanumeric) are dropped, and camelCase / acronym boundaries are treated
 * as separators too, so `getFiles`, `get-files` and `GET_FILES` all become
 * `["get", "Files"]`-ish word lists and therefore slug and humanize identically.
 */
export function words(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function lower(word: string): string {
  return word.toLowerCase();
}

function capitalize(word: string): string {
  // An all-caps word is an acronym or SCREAMING_CASE, and reads better title-cased
  // (`FILES` → `Files`); anything else keeps the casing the author chose.
  const rest = word === word.toUpperCase() ? word.slice(1).toLowerCase() : word.slice(1);
  return `${word.charAt(0).toUpperCase()}${rest}`;
}

/**
 * `get-issue` → `getIssue`, `GET_FILES` → `getFiles`, `getFiles` → `getFiles`,
 * `2fa_check` → `_2faCheck`, `delete` → `delete_`, `!!!` → `tool`.
 *
 * Total and deterministic: every input produces a valid TS identifier, and the
 * same input always produces the same one.
 */
export function slugifyMethod(raw: string): string {
  const parts = words(raw);
  if (parts.length === 0) return "tool";

  const camel = parts
    .map((word, index) => (index === 0 ? lower(word) : capitalize(word)))
    .join("");

  // A leading digit is the only way the join can still be invalid.
  const prefixed = /^[0-9]/.test(camel) ? `_${camel}` : camel;
  return RESERVED.has(prefixed) ? `${prefixed}_` : prefixed;
}

/**
 * Slug a namespace. Dots are kept as segment separators (`acme.github` stays two
 * segments), everything else goes through `slugifyMethod`.
 */
export function slugifyNamespace(raw: string): string {
  const segments = raw
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(slugifyMethod);
  return segments.length === 0 ? "mcp" : segments.join(".");
}

/** `get-issue` → `Get Issue`, `getFiles` → `Get Files`, `GET_FILES` → `Get Files`. */
export function humanize(raw: string): string {
  const parts = words(raw);
  return parts.length === 0 ? raw : parts.map(capitalize).join(" ");
}

/**
 * Make `method` unique within `taken`, by appending the smallest integer ≥ 2 that
 * frees it. Two MCP tools can slug to the same identifier (`get-issue` and
 * `get_issue`), and silently dropping one would make a tool unreachable.
 */
export function uniqueMethod(method: string, taken: ReadonlySet<string>): string {
  if (!taken.has(method)) return method;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${method}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
