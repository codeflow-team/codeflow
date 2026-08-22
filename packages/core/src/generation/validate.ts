/**
 * `validate` — scoring AI output against the conformance ladder of
 * 10-ai-codegen.md §5.
 *
 * The ladder is cumulative and each rung is *measurable from artifacts that
 * already exist*: the analyzer's own `Diagnostic[]` and the graph it produces.
 * There is no separate error system for AI (10 §5) — the same diagnostics the
 * UI shows a human are what gets fed back to the model, so improving one
 * improves the other.
 *
 * ```text
 * invalid ── does not parse, or breaks the flow contract
 *   L0    ── parses, contract holds, no value import of a types-only artifact
 *   L1    ── L0 + every tool / library call resolves (nothing invented)
 *   L2    ── L1 + no call hidden in an expression or in a code node
 * ```
 *
 * Where the boundary sits, precisely, and why:
 *
 * - **invalid**: syntactic errors, or an `invalid-flow-contract` error (no
 *   default export, not `async`, wrong parameter count). Nothing below can be
 *   measured on a file that does not parse.
 * - **L0**: value-import discipline. 10 §5 is explicit that an import outside
 *   the allowlist *that still resolves* is a **warning plus degradation**, not a
 *   hard fail — so an unknown value import (`zod`, `./helpers`) keeps L0 and
 *   emits `foreign-value-import`; core cannot resolve modules (it is
 *   browser-safe and never touches a file system), so it never claims the
 *   import is missing. The one hard fail is a **value import from
 *   `generated/*`**: those artifacts are `.d.ts` — a value import of one cannot
 *   resolve *by construction*, in any workspace, and it is a mistake models make.
 * - **L1**: nothing invented. `unresolved-tool` (analyzer) and
 *   `unresolved-library-function` (here — a named value import from a library
 *   module that the registry does not define) both drop the result to L0, as
 *   does any `unknown` node in the graph.
 * - **L2**: "no unintended custom-code node; hidden-call diagnostics = 0"
 *   (10 §5). Intent is not observable, so it is approximated by *what the code
 *   node costs the reader*: a code node that contains **a call** hides a step
 *   that should have been a node — either a tool call written somewhere the
 *   analyzer cannot see it, or logic that 01 §3 rules 4–5 say belongs in a named
 *   function. A code node with **no call** is plumbing (`let attempt = 0;`,
 *   `attempt += 1;`, `delivered = true;`) and is tolerated: the style guide
 *   itself *requires* a counter for every `while` (rule 7), so scoring it as a
 *   defect would make L2 unreachable for correct code. So L2 = zero
 *   `hidden-call-in-expression`, zero `unsupported-optional-chaining`, zero
 *   call-bearing code nodes (`inline-logic-in-code-node`).
 *   `unbounded-loop-risk` and `multiple-exports` stay warnings that do *not*
 *   block L2: the first is about a runtime risk rather than the projection, the
 *   second is already scored by 01 §4 as "only the default export is analyzed".
 */

import { SyntaxKind } from "ts-morph";

import { analyzeSource } from "../analyzer/analyze.js";
import { positionAt } from "../mapper/source-mapping.js";
import type { Diagnostic, ValidationResult, WorkflowGraph } from "../model/index.js";
import { TsMorphParser, type TsSyntaxTree } from "../parser/ts-morph-parser.js";
import type { RegistryLookup } from "../registry/lookup.js";

/**
 * Module specifiers whose *values* a flow may import (10 §5). The tools artifact
 * is deliberately absent: it is types-only, and only `import type` may name it.
 * A host extends this per validation call.
 */
export const DEFAULT_ALLOWED_VALUE_IMPORTS = ["@flows/lib"];

/** `../generated/tools`, `./generated/tools.js`, `generated/lib` … */
const GENERATED_MODULE = /(^|\/)generated\/[A-Za-z0-9_.-]+$/;

function isGeneratedModule(specifier: string): boolean {
  return GENERATED_MODULE.test(specifier.replace(/\.(js|ts|d\.ts)$/, ""));
}

export interface ValidateFlowOptions {
  /** Document path used in diagnostics. */
  file?: string;
  /**
   * Extra module specifiers whose values may be imported — 10 §5 ("host mở rộng
   * được — vd cho phép `zod`"). Registered library module paths are always
   * allowed and need not be repeated.
   */
  allowedValueImports?: string[];
  /** Reuse a warm parser instead of building one per call. */
  parser?: TsMorphParser;
  /**
   * Optional type-check — "type-check pass (khi môi trường validate có type
   * checker)" (10 §5). Core deliberately has none: it parses with `noLib` and
   * `noResolve` so analysis stays browser-safe and fast (02 §3), and a flow's
   * imports point at workspace artifacts that do not exist in memory. A host
   * that *has* a configured project (the CLI, an editor) passes one in; any
   * `error` it returns drops the result below L0.
   */
  typeCheck?: (source: string, file: string) => Diagnostic[];
}

/** The graph is analyzed anyway; hand it to the caller rather than throw it away. */
export interface FlowValidationResult extends ValidationResult {
  /** `null` when the source does not parse. */
  graph: WorkflowGraph | null;
}

function importDiagnostics(
  tree: TsSyntaxTree,
  registry: RegistryLookup,
  file: string,
  allowed: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const modulePaths = new Set([...registry.listFunctionModulePaths(), ...allowed]);

  for (const declaration of tree.sourceFile.getImportDeclarations()) {
    // Type-only imports may come from anywhere in the workspace (10 §5).
    if (declaration.isTypeOnly()) continue;

    const specifier = declaration.getModuleSpecifierValue();
    const named = declaration.getNamedImports().filter((imported) => !imported.isTypeOnly());
    const defaultImport = declaration.getDefaultImport();
    const namespaceImport = declaration.getNamespaceImport();
    // `import { type Tools } from "…"` — per-specifier type-only, no value crosses.
    const typeOnlyPerSpecifier =
      declaration.getNamedImports().length > 0 &&
      named.length === 0 &&
      defaultImport === undefined &&
      namespaceImport === undefined;
    if (typeOnlyPerSpecifier) continue;

    const source = {
      file,
      start: positionAt(tree.sourceFile, declaration.getStart()),
      end: positionAt(tree.sourceFile, declaration.getEnd()),
      semanticPath: `flow.imports[${specifier}]`,
      fingerprint: "",
    };

    if (isGeneratedModule(specifier)) {
      diagnostics.push({
        severity: "error",
        code: "invalid-import",
        message: `\`${specifier}\` is a generated \`.d.ts\` artifact and has no runtime value — write \`import type { Tools } from "${specifier}";\` instead (10 §5).`,
        source,
      });
      continue;
    }

    if (modulePaths.has(specifier)) {
      // A library module: every named import must be a registered function, or
      // the call it feeds resolves to nothing (05 §4).
      for (const specifierNode of named) {
        const imported = specifierNode.getName();
        const definition = registry.getFunction(imported);
        if (definition !== undefined && definition.modulePath === specifier) continue;
        const known = registry
          .listFunctionsByModule(specifier)
          .map((fn) => fn.name)
          .slice(0, 8);
        diagnostics.push({
          severity: "error",
          code: "unresolved-library-function",
          message: `\`${imported}\` is not a function of \`${specifier}\` — ${
            known.length === 0
              ? "that module exports nothing; write the logic inline or use a tool"
              : `available: ${known.map((name) => `\`${name}\``).join(", ")}`
          } (05 §4).`,
          source,
        });
      }
      if (namespaceImport !== undefined || defaultImport !== undefined) {
        diagnostics.push({
          severity: "warning",
          code: "foreign-value-import",
          message: `\`${specifier}\` has no default or namespace export — import the functions by name (\`import { isAuthChange } from "${specifier}"\`) so each call becomes a function node (05 §4).`,
          source,
        });
      }
      continue;
    }

    diagnostics.push({
      severity: "warning",
      code: "foreign-value-import",
      message: `Value import from \`${specifier}\`, which is outside the allowed list (${[
        ...modulePaths,
      ]
        .sort()
        .map((path) => `\`${path}\``)
        .join(", ")}). Statements using it degrade to opaque code nodes — move the logic into a library function or a tool (01 §4, 10 §5).`,
      source,
    });
  }

  return diagnostics;
}

/**
 * Code nodes that swallow a call — the measurable half of "custom-code node
 * *ngoài ý muốn*" (10 §5). A call inside a code node is a step the reader of the
 * graph never sees: either a tool call the analyzer could not reach (assigned to
 * an outer variable, buried in an expression) or a `.map().filter()` chain that
 * 01 §3 rules 4–5 want extracted into a named function.
 */
function inlineLogicDiagnostics(tree: TsSyntaxTree, graph: WorkflowGraph): Diagnostic[] {
  const codeNodes = graph.nodes.filter((node) => node.type === "code");
  if (codeNodes.length === 0) return [];

  const calls = [
    ...tree.sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression),
    ...tree.sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression),
    ...tree.sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression),
  ];

  const diagnostics: Diagnostic[] = [];
  for (const node of codeNodes) {
    const { start, end } = node.source;
    const inside = calls.filter((call) => call.getStart() >= start.offset && call.getEnd() <= end.offset);
    if (inside.length === 0) continue;
    const first = inside[0]!.getText().replace(/\s+/g, " ").slice(0, 80);
    diagnostics.push({
      severity: "warning",
      code: "inline-logic-in-code-node",
      message: `\`${first}\` runs inside a custom code node, so the step is invisible on the graph. Give the call its own \`const x = await …\` statement if it is a tool, or move the logic into a named function and call that (01 §3 rules 4–5).`,
      source: node.source,
    });
  }
  return diagnostics;
}

export function validateFlowSource(
  source: string,
  registry: RegistryLookup,
  options: ValidateFlowOptions = {},
): FlowValidationResult {
  const file = options.file ?? "flow.ts";
  const parser = options.parser ?? new TsMorphParser({ file });
  const tree = parser.parse(source, file);

  const syntax = parser.syntaxErrors(tree);
  if (syntax.length > 0) {
    return {
      level: "invalid",
      graph: null,
      diagnostics: syntax.slice(0, 10).map((error) => ({
        severity: "error",
        code: "parse-error",
        message: `${error.message} The file must be valid TypeScript before anything else can be checked (10 §5).`,
        ...(error.start === undefined
          ? {}
          : {
              source: {
                file,
                start: positionAt(tree.sourceFile, error.start),
                end: positionAt(tree.sourceFile, error.start + (error.length ?? 0)),
                semanticPath: "flow",
                fingerprint: "",
              },
            }),
      })),
    };
  }

  const graph = analyzeSource(source, registry, { file }, parser);
  const typeErrors = options.typeCheck?.(source, file) ?? [];
  const diagnostics: Diagnostic[] = [
    ...graph.diagnostics,
    ...importDiagnostics(
      tree,
      registry,
      file,
      options.allowedValueImports ?? DEFAULT_ALLOWED_VALUE_IMPORTS,
    ),
    ...typeErrors,
  ];

  const has = (code: string): boolean => diagnostics.some((d) => d.code === code);

  // Below L0: the contract is broken, an import cannot resolve by construction,
  // or the host's type checker rejected the file.
  if (
    has("invalid-flow-contract") ||
    has("invalid-import") ||
    typeErrors.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return { level: "invalid", graph, diagnostics };
  }

  const resolvesEverything =
    !has("unresolved-tool") &&
    !has("unresolved-library-function") &&
    !graph.nodes.some((node) => node.type === "unknown");
  if (!resolvesEverything) {
    return { level: "L0", graph, diagnostics };
  }

  diagnostics.push(...inlineLogicDiagnostics(tree, graph));

  const mapsCleanly =
    !has("hidden-call-in-expression") &&
    !has("unsupported-optional-chaining") &&
    !diagnostics.some((d) => d.code === "inline-logic-in-code-node");
  return { level: mapsCleanly ? "L2" : "L1", graph, diagnostics };
}
