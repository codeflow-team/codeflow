import { describe, expect, it } from "vitest";

import { CodeFlowError } from "../src/errors.js";
import { createRegistry } from "../src/registry/index.js";
import { normalizeEditableFields } from "../src/registry/validate.js";
import type { FunctionDefinition } from "../src/registry/definitions.js";

function baseFunction(overrides: Partial<FunctionDefinition> = {}): FunctionDefinition {
  return {
    name: "isAuthChange",
    label: "Is Auth Change",
    inputSchema: { files: "File[]" },
    outputSchema: "boolean",
    code: "export function isAuthChange(files: File[]) { return true; }",
    modulePath: "@flows/lib",
    ...overrides,
  };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CodeFlowError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("registerFunction — name validation (05 §4)", () => {
  it("rejects a name containing a dot (that shape belongs to a tool)", () => {
    const registry = createRegistry();
    expect(errorCode(() => registry.registerFunction(baseFunction({ name: "github.getFiles" })))).toBe(
      "invalid-function-name",
    );
    expect(() => registry.registerFunction(baseFunction({ name: "github.getFiles" }))).toThrow(
      /must not contain a dot/,
    );
  });

  it("rejects names that are not valid TypeScript identifiers", () => {
    const registry = createRegistry();
    for (const name of ["", "1stFunction", "has space", "has-dash", "class"]) {
      expect(errorCode(() => registry.registerFunction(baseFunction({ name })))).toBe(
        "invalid-function-name",
      );
    }
  });

  it("accepts a valid identifier", () => {
    const registry = createRegistry();
    registry.registerFunction(baseFunction());
    expect(registry.getFunction("isAuthChange")?.label).toBe("Is Auth Change");
    expect(registry.listFunctions()).toHaveLength(1);
  });
});

describe("registerFunction — inputSchema validation (05 §4)", () => {
  it("rejects a bare TS type ref: it carries no parameter names", () => {
    const registry = createRegistry();
    expect(errorCode(() => registry.registerFunction(baseFunction({ inputSchema: "File[]" })))).toBe(
      "invalid-schema",
    );
  });

  it("rejects keys that cannot be parameter names", () => {
    const registry = createRegistry();
    expect(
      errorCode(() => registry.registerFunction(baseFunction({ inputSchema: { "not a param": "string" } }))),
    ).toBe("invalid-schema");
  });

  it("accepts a JSON Schema object and reads its properties as parameters", () => {
    const registry = createRegistry();
    registry.registerFunction(
      baseFunction({
        inputSchema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] },
      }),
    );
    expect(registry.getFunction("isAuthChange")).toBeDefined();
  });

  it("rejects an empty module path", () => {
    const registry = createRegistry();
    expect(errorCode(() => registry.registerFunction(baseFunction({ modulePath: "  " })))).toBe(
      "invalid-module-path",
    );
  });
});

describe("registerTool — name validation (05 §1)", () => {
  it("requires a namespace", () => {
    const registry = createRegistry();
    expect(
      errorCode(() => registry.registerTool({ name: "send", label: "Send", inputSchema: {} })),
    ).toBe("invalid-tool-name");
  });

  it("rejects invalid segments", () => {
    const registry = createRegistry();
    expect(
      errorCode(() => registry.registerTool({ name: "slack.2send", label: "Send", inputSchema: {} })),
    ).toBe("invalid-tool-name");
  });

  it("accepts namespace.method and exposes the namespace", () => {
    const registry = createRegistry();
    registry.registerTool({ name: "slack.send", label: "Send", inputSchema: { channel: "string" } });
    registry.registerTool({ name: "github.getFiles", label: "Files", inputSchema: { pr: "PR" } });
    expect(registry.listToolNamespaces()).toEqual(["github", "slack"]);
    expect(registry.listTools().map((t) => t.name)).toEqual(["github.getFiles", "slack.send"]);
  });
});

describe("conflict checks (05 §4 — save over an existing name is rejected)", () => {
  it("rejects a duplicate tool unless overwrite is set", () => {
    const registry = createRegistry();
    const def = { name: "slack.send", label: "Send", inputSchema: {} };
    registry.registerTool(def);
    expect(errorCode(() => registry.registerTool(def))).toBe("duplicate-tool");
    registry.registerTool({ ...def, label: "Send Message" }, { overwrite: true });
    expect(registry.getTool("slack.send")?.label).toBe("Send Message");
  });

  it("rejects a duplicate function unless overwrite is set", () => {
    const registry = createRegistry();
    registry.registerFunction(baseFunction());
    expect(errorCode(() => registry.registerFunction(baseFunction()))).toBe("duplicate-function");
    registry.registerFunction(baseFunction({ label: "Auth?" }), { overwrite: true });
    expect(registry.getFunction("isAuthChange")?.label).toBe("Auth?");
  });

  it("rejects a duplicate node type unless overwrite is set", () => {
    const registry = createRegistry();
    registry.registerNode({ type: "http.request", label: "HTTP Request" });
    expect(errorCode(() => registry.registerNode({ type: "http.request", label: "X" }))).toBe(
      "duplicate-node",
    );
  });
});

describe("registerNode (05 §5)", () => {
  it("refuses to shadow a core node type", () => {
    const registry = createRegistry();
    for (const type of ["tool", "condition", "code", "unknown"]) {
      expect(errorCode(() => registry.registerNode({ type, label: "X" }))).toBe("invalid-node-type");
    }
  });

  it("registers a new type", () => {
    const registry = createRegistry();
    registry.registerNode({ type: "approval", label: "Approval", editableFields: ["approver"] });
    expect(registry.getNode("approval")?.editableFields).toEqual([{ name: "approver" }]);
    expect(registry.listNodes()).toHaveLength(1);
  });
});

describe("editable field normalization (06 §1)", () => {
  it('normalizes the "channel" shorthand to { name: "channel" }', () => {
    expect(normalizeEditableFields(["channel", "message"])).toEqual([
      { name: "channel" },
      { name: "message" },
    ]);
  });

  it("keeps the long form and copies options", () => {
    const options = ["#a", "#b"];
    const [field] = normalizeEditableFields([
      { name: "channel", label: "Channel", editor: "select", options },
    ]);
    expect(field).toEqual({ name: "channel", label: "Channel", editor: "select", options });
    expect(field?.options).not.toBe(options);
  });

  it("normalizes on register, so definitions always expose EditableField[]", () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "slack.send",
      label: "Send",
      inputSchema: { channel: "string" },
      editableFields: ["channel", { name: "message", editor: "expression" }],
    });
    expect(registry.getTool("slack.send")?.editableFields).toEqual([
      { name: "channel" },
      { name: "message", editor: "expression" },
    ]);
  });

  it("defaults to an empty array when omitted", () => {
    const registry = createRegistry();
    registry.registerTool({ name: "slack.send", label: "Send", inputSchema: {} });
    expect(registry.getTool("slack.send")?.editableFields).toEqual([]);
  });

  it("rejects empty and duplicate field names", () => {
    expect(errorCode(() => normalizeEditableFields([""]))).toBe("invalid-editable-field");
    expect(errorCode(() => normalizeEditableFields(["a", "a"]))).toBe("invalid-editable-field");
  });
});

describe("registry lookups", () => {
  it("returns undefined for unknown entries — an empty registry is valid (principle 6b)", () => {
    const registry = createRegistry();
    expect(registry.getTool("github.getFiles")).toBeUndefined();
    expect(registry.getFunction("isAuthChange")).toBeUndefined();
    expect(registry.listTools()).toEqual([]);
    expect(registry.listAnalyzers()).toEqual([]);
  });

  it("groups library functions by module path", () => {
    const registry = createRegistry();
    registry.registerFunction(baseFunction());
    registry.registerFunction(baseFunction({ name: "normalize", modulePath: "@flows/lib" }));
    expect(registry.listFunctionModulePaths()).toEqual(["@flows/lib"]);
    expect(registry.listFunctionsByModule("@flows/lib").map((f) => f.name)).toEqual([
      "isAuthChange",
      "normalize",
    ]);
  });

  it("supports unregistering (tool removed → calls degrade to unknown, 05 §2)", () => {
    const registry = createRegistry();
    registry.registerTool({ name: "slack.send", label: "Send", inputSchema: {} });
    expect(registry.unregisterTool("slack.send")).toBe(true);
    expect(registry.unregisterTool("slack.send")).toBe(false);
    expect(registry.getTool("slack.send")).toBeUndefined();
  });

  it("collects analyzers registered through registerAnalyzer", () => {
    const registry = createRegistry();
    const analyzer = () => null;
    registry.registerAnalyzer(analyzer);
    expect(registry.listAnalyzers()).toEqual([analyzer]);
  });
});
