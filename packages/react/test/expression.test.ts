/** Display syntax rules of 06-patch-engine.md §3. */

import { describe, expect, it } from "vitest";
import { formatFieldValue } from "../src/inspector/expression.js";

describe("formatFieldValue", () => {
  it("shows a string literal verbatim, unquoted", () => {
    const display = formatFieldValue('"#security"');
    expect(display).toMatchObject({ kind: "string", text: "#security", friendly: true });
    expect(formatFieldValue("'#security'").text).toBe("#security");
  });

  it("wraps each interpolation of a template literal on its own", () => {
    const display = formatFieldValue("`Security PR: ${pr.title}`");
    expect(display.kind).toBe("template");
    expect(display.text).toBe("Security PR: {{ pr.title }}");
    expect(display.friendly).toBe(true);
  });

  it("handles several interpolations and nested braces", () => {
    expect(formatFieldValue("`${a} and ${b}`").text).toBe("{{ a }} and {{ b }}");
    expect(formatFieldValue("`x ${ { a: 1 }.a } y`").text).toBe("x {{ { a: 1 }.a }} y");
  });

  it("wraps a bare identifier and any other expression", () => {
    expect(formatFieldValue("pr").text).toBe("{{ pr }}");
    expect(formatFieldValue("files.length").text).toBe("{{ files.length }}");
    expect(formatFieldValue("pr").kind).toBe("expression");
  });

  it("keeps numbers and booleans as literals", () => {
    expect(formatFieldValue("42")).toMatchObject({ kind: "number", text: "42" });
    expect(formatFieldValue("-3.5").kind).toBe("number");
    expect(formatFieldValue("true")).toMatchObject({ kind: "boolean", text: "true" });
  });

  it("refuses the friendly form when the display would stop being 1-1", () => {
    // 06 §3 "Escaping/nhập nhằng": fall back to code, never invent an escape.
    expect(formatFieldValue('"literally {{ x }}"').friendly).toBe(false);
    expect(formatFieldValue("`a {{ b }} c`").friendly).toBe(false);
    expect(formatFieldValue("weird({{})").friendly).toBe(false);
  });

  it("renders a single-interpolation template and a bare expression the same way", () => {
    // Same display, different AST forms — the patcher never confuses them (06 §3).
    expect(formatFieldValue("`${pr.title}`").text).toBe("{{ pr.title }}");
    expect(formatFieldValue("pr.title").text).toBe("{{ pr.title }}");
    expect(formatFieldValue("`${pr.title}`").kind).toBe("template");
    expect(formatFieldValue("pr.title").kind).toBe("expression");
  });

  it("treats a missing value as empty", () => {
    expect(formatFieldValue(null)).toMatchObject({ kind: "empty", text: "" });
    expect(formatFieldValue("   ")).toMatchObject({ kind: "empty" });
  });
});
