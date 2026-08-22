/**
 * Statement → node emission — the whole of 04-analyzer.md §2.
 *
 * The projection stays close to 1:1 (04 §1.1): each supported construct becomes
 * exactly one node, unsupported statements fall back to `code` nodes (the only
 * merging done at MVP), and control flow is threaded through *dangling exits*
 * so convergence points appear exactly where the spec says they do.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { Expression, Statement } from "ts-morph";
import type { NodePort, Schema, WorkflowNode } from "../model/index.js";
import { isNamedFieldsSchema } from "../model/schema.js";
import { inputSchemaFieldNames } from "../registry/validate.js";
import {
  PathScope,
  callSegment,
  fingerprintNode,
  mappingForNode,
  mappingForStatements,
  mappingForSynthetic,
  withRole,
} from "../mapper/index.js";
import { addControlEdge, addNode, connectAll, diagnose } from "./builder.js";
import type { AnalysisContext, Exit, FlowBinding, Frame } from "./context.js";
import { childFrame } from "./context.js";
import {
  assignedIdentifierNames,
  bindingNames,
  readIdentifierNames,
  recordReads,
  recordWrites,
} from "./dataflow.js";
import { findHiddenCalls, findOptionalToolChains, sanctionedTopLevel } from "./hidden-calls.js";
import { isPromiseAllCall, resolveCallee, toolsAliasPrefix } from "./resolve.js";
import type { CalleeResolution } from "./resolve.js";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function statementsOf(statement: Statement | undefined): Statement[] {
  if (statement === undefined) return [];
  if (Node.isBlock(statement)) return statement.getStatements();
  return [statement];
}

function unwrap(expression: Node | undefined): Node | undefined {
  let current = expression;
  while (current !== undefined && Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

/** The single declarator's initializer, when the statement declares exactly one. */
function soleInitializer(statement: Statement): Expression | undefined {
  if (!Node.isVariableStatement(statement)) return undefined;
  const declarations = statement.getDeclarationList().getDeclarations();
  if (declarations.length !== 1) return undefined;
  return declarations[0].getInitializer();
}

function soleNameNode(statement: Statement): Node | undefined {
  if (!Node.isVariableStatement(statement)) return undefined;
  const declarations = statement.getDeclarationList().getDeclarations();
  if (declarations.length !== 1) return undefined;
  return declarations[0].getNameNode();
}

function portsFromSchema(schema: Schema | undefined): NodePort[] {
  if (schema === undefined) return [];
  const names = inputSchemaFieldNames(schema);
  if (names === null) return [];
  const named = isNamedFieldsSchema(schema) ? (schema as Record<string, Schema>) : null;
  return names.map((name) => {
    const port: NodePort = { id: name, label: name };
    const fieldSchema = named?.[name];
    if (fieldSchema !== undefined) port.schema = fieldSchema;
    return port;
  });
}

/** Argument shape of a call, for the inspector (06 §1) — read-only at this phase. */
interface ArgumentInfo {
  text: string;
  editable: boolean;
  hasSpread: boolean;
  fields: Record<string, string> | null;
}

function describeArguments(call: Node): ArgumentInfo {
  if (!Node.isCallExpression(call)) {
    return { text: "", editable: false, hasSpread: false, fields: null };
  }
  const args = call.getArguments();
  const text = args.map((a) => a.getText()).join(", ");
  if (args.length !== 1) return { text, editable: false, hasSpread: false, fields: null };
  const only = unwrap(args[0]);
  if (only === undefined || !Node.isObjectLiteralExpression(only)) {
    return { text, editable: false, hasSpread: false, fields: null };
  }
  const fields: Record<string, string> = {};
  let hasSpread = false;
  for (const property of only.getProperties()) {
    if (Node.isSpreadAssignment(property)) {
      hasSpread = true;
      continue;
    }
    if (Node.isPropertyAssignment(property)) {
      fields[property.getName()] = property.getInitializerOrThrow().getText();
      continue;
    }
    if (Node.isShorthandPropertyAssignment(property)) {
      fields[property.getName()] = property.getName();
    }
  }
  return { text, editable: true, hasSpread, fields };
}

/* -------------------------------------------------------------------------- */
/* classification                                                              */
/* -------------------------------------------------------------------------- */

type Classification =
  | { type: "code"; hidden: Node[]; optionalTools: Node[] }
  | { type: "call"; call: Node; awaited: boolean; resolution: CalleeResolution }
  | { type: "parallel"; call: Node; elements: Node[]; awaited: boolean }
  | { type: "if"; statement: Statement }
  | { type: "loop"; statement: Statement; loop: Statement; label: string | null }
  | { type: "try"; statement: Statement }
  | { type: "return"; statement: Statement }
  | { type: "jump"; statement: Statement };

const EMPTY_CODE: Classification = { type: "code", hidden: [], optionalTools: [] };

function classify(ctx: AnalysisContext, frame: Frame, statement: Statement): Classification {
  // Labeled loops keep their label so `continue outer` can name its target (04 §2.9).
  if (Node.isLabeledStatement(statement)) {
    const inner = statement.getStatement();
    if (Node.isForOfStatement(inner) || Node.isWhileStatement(inner)) {
      return { type: "loop", statement, loop: inner, label: statement.getLabel().getText() };
    }
    return EMPTY_CODE;
  }

  const optionalTools = findOptionalToolChains(statement, frame);
  if (optionalTools.length > 0) return { type: "code", hidden: [], optionalTools };

  if (Node.isIfStatement(statement)) {
    const hidden = findHiddenCalls(statement.getExpression(), new Set(), frame);
    return hidden.length > 0 ? { type: "code", hidden, optionalTools: [] } : { type: "if", statement };
  }

  if (Node.isForOfStatement(statement)) {
    const hidden = findHiddenCalls(statement.getExpression(), new Set(), frame);
    return hidden.length > 0
      ? { type: "code", hidden, optionalTools: [] }
      : { type: "loop", statement, loop: statement, label: null };
  }

  if (Node.isWhileStatement(statement)) {
    const hidden = findHiddenCalls(statement.getExpression(), new Set(), frame);
    return hidden.length > 0
      ? { type: "code", hidden, optionalTools: [] }
      : { type: "loop", statement, loop: statement, label: null };
  }

  if (Node.isTryStatement(statement)) return { type: "try", statement };

  if (Node.isReturnStatement(statement)) {
    const expression = statement.getExpression();
    const hidden = expression === undefined ? [] : findHiddenCalls(expression, new Set(), frame);
    return hidden.length > 0
      ? { type: "code", hidden, optionalTools: [] }
      : { type: "return", statement };
  }

  if (Node.isBreakStatement(statement) || Node.isContinueStatement(statement)) {
    return { type: "jump", statement };
  }

  if (Node.isExpressionStatement(statement) || Node.isVariableStatement(statement)) {
    const sanctioned = sanctionedTopLevel(statement);
    let expression = unwrap(
      Node.isExpressionStatement(statement) ? statement.getExpression() : soleInitializer(statement),
    );
    let awaited = false;
    if (expression !== undefined && Node.isAwaitExpression(expression)) {
      awaited = true;
      expression = unwrap(expression.getExpression());
    }

    if (expression !== undefined && Node.isCallExpression(expression)) {
      // `Promise.all([...])` — array literal of single calls only (04 §2.6).
      if (awaited && isPromiseAllCall(expression)) {
        const parallel = classifyParallel(ctx, frame, statement, expression, sanctioned);
        if (parallel !== null) return parallel;
        const hidden = findHiddenCalls(statement, sanctioned, frame);
        return { type: "code", hidden, optionalTools: [] };
      }
      const resolution = resolveCallee(expression, frame, ctx.registry);
      if (resolution.kind !== "unresolved") {
        // Arguments are deliberately NOT sanctioned: an await or tool call in
        // an argument is exactly the hidden call §1.4 is about.
        const hidden = findHiddenCalls(statement, sanctioned, frame);
        if (hidden.length > 0) return { type: "code", hidden, optionalTools: [] };
        return { type: "call", call: expression, awaited, resolution };
      }
    }

    const hidden = findHiddenCalls(statement, sanctioned, frame);
    return { type: "code", hidden, optionalTools: [] };
  }

  const hidden = findHiddenCalls(statement, new Set(), frame);
  return { type: "code", hidden, optionalTools: [] };
}

function classifyParallel(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  call: Node,
  sanctioned: Set<Node>,
): Classification | null {
  if (!Node.isCallExpression(call)) return null;
  const args = call.getArguments();
  if (args.length !== 1) return null;
  const array = unwrap(args[0]);
  if (array === undefined || !Node.isArrayLiteralExpression(array)) return null;

  const elements: Node[] = [];
  for (const raw of array.getElements()) {
    const element = unwrap(raw);
    if (element === undefined || !Node.isCallExpression(element)) return null;
    const resolution = resolveCallee(element, frame, ctx.registry);
    if (resolution.kind === "unresolved") return null;
    sanctioned.add(element);
    elements.push(element);
  }
  if (elements.length === 0) return null;

  const hidden = findHiddenCalls(statement, sanctioned, frame);
  if (hidden.length > 0) return null;
  return { type: "parallel", call, elements, awaited: true };
}

/* -------------------------------------------------------------------------- */
/* sequence emission                                                           */
/* -------------------------------------------------------------------------- */

interface RunEntry {
  statement: Statement;
  index: number;
  classification: Extract<Classification, { type: "code" }>;
  /** Value bindings this statement introduces — writers are filled in on flush. */
  bindings: FlowBinding[];
}

export function emitSequence(
  ctx: AnalysisContext,
  frame: Frame,
  statements: readonly Statement[],
  incoming: readonly Exit[],
): Exit[] {
  let pending: Exit[] = [...incoming];
  const run: RunEntry[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const node = emitCodeNode(ctx, frame, run);
    connectAll(ctx, pending, node.id);
    pending = [{ nodeId: node.id }];
    run.length = 0;
  };

  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    const classification = classify(ctx, frame, statement);
    if (classification.type === "code") {
      // Bindings are declared as soon as the statement is classified, not when
      // the run is flushed: a `const tools = {…}` shadow must already be in
      // scope while the *next* statement of the same run is classified,
      // otherwise its calls would wrongly resolve against the outer `tools`.
      run.push({ statement, index, classification, bindings: declareStatementBindings(frame, statement) });
      continue;
    }
    flush();
    const hasFollowing = index < statements.length - 1;
    pending = emitStatement(ctx, frame, statement, classification, pending, hasFollowing);
  }
  flush();
  return pending;
}

function emitStatement(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  classification: Classification,
  incoming: readonly Exit[],
  hasFollowing: boolean,
): Exit[] {
  switch (classification.type) {
    case "call":
      return emitCall(ctx, frame, statement, classification.call, classification.awaited, classification.resolution, incoming);
    case "parallel":
      return emitParallel(ctx, frame, statement, classification.elements, incoming);
    case "if":
      return emitCondition(ctx, frame, statement, incoming, hasFollowing);
    case "loop":
      return emitLoop(ctx, frame, statement, classification.loop, classification.label, incoming);
    case "try":
      return emitTry(ctx, frame, statement, incoming);
    case "return":
      return emitOutput(ctx, frame, statement, incoming);
    case "jump":
      return emitJump(ctx, frame, statement, incoming);
    default:
      return [...incoming];
  }
}

/* -------------------------------------------------------------------------- */
/* code fallback — 04 §2.11                                                    */
/* -------------------------------------------------------------------------- */

function emitCodeNode(ctx: AnalysisContext, frame: Frame, run: readonly RunEntry[]): WorkflowNode {
  const statements = run.map((entry) => entry.statement);
  const semanticPath = frame.path.statements(run[0].index, run[run.length - 1].index);
  const mapping = mappingForStatements(ctx.file, ctx.sourceFile, statements, semanticPath);

  // Names this run declares — they are outputs, not inbound reads.
  const declared = new Set<string>();
  for (const statement of statements) {
    if (!Node.isVariableStatement(statement)) continue;
    for (const declaration of statement.getDeclarationList().getDeclarations()) {
      for (const bound of bindingNames(declaration.getNameNode())) declared.add(bound.name);
    }
  }

  const node = addNode(ctx, frame, {
    type: "code",
    label: "Custom Code",
    mapping,
    data: {
      text: statements.map((s) => s.getText()).join("\n"),
      statementCount: statements.length,
      // Per-statement fingerprints: Phase 3 matches a merged code node to its
      // predecessor when they share ≥1 statement fingerprint (04 §2.11).
      statementFingerprints: statements.map((s) => fingerprintNode(s)),
    },
    outputs: [...declared].map((name) => ({ id: name, label: name })),
  });

  recordReads(ctx, frame, node.id, statements, declared);
  recordWrites(ctx, frame, node.id, statements);

  diagnose(
    ctx,
    "info",
    "unsupported-construct",
    "Custom code is kept verbatim — no semantic projection.",
    mapping,
  );
  for (const entry of run) {
    for (const hidden of entry.classification.hidden) {
      diagnose(
        ctx,
        "warning",
        "hidden-call-in-expression",
        `\`${hidden.getText().replace(/\s+/g, " ").slice(0, 80)}\` is awaited/called inside an expression — hoist it into its own \`const\` so it becomes a node (04 §1.4).`,
        mapping,
      );
    }
    for (const optional of entry.classification.optionalTools) {
      diagnose(
        ctx,
        "warning",
        "unsupported-optional-chaining",
        `Optional chaining on \`tools\` (\`${optional.getText().replace(/\s+/g, " ").slice(0, 80)}\`) is not supported — the statement is kept as custom code (01 §2).`,
        mapping,
      );
    }
  }

  for (const entry of run) {
    for (const binding of entry.bindings) binding.writers.push({ nodeId: node.id, port: binding.name });
  }
  return node;
}

/**
 * Declare the bindings one unsupported statement introduces, including `tools`
 * aliases (04 §1.2). Value bindings come back with an empty writer list; the
 * code node fills it in once it exists.
 */
function declareStatementBindings(frame: Frame, statement: Statement): FlowBinding[] {
  if (!Node.isVariableStatement(statement)) return [];
  const declared: FlowBinding[] = [];

  for (const declaration of statement.getDeclarationList().getDeclarations()) {
    const nameNode = declaration.getNameNode();
    const initializer = unwrap(declaration.getInitializer());

    // `const t = tools` / `const gh = tools.github` — alias of the tools root.
    if (initializer !== undefined && Node.isIdentifier(nameNode)) {
      const prefix = toolsAliasPrefix(initializer, frame);
      if (prefix !== null) {
        frame.scope.declare({
          name: nameNode.getText(),
          kind: "tools",
          toolsPrefix: prefix,
          writers: [],
        });
        continue;
      }
    }
    // `const { github } = tools` — destructured alias.
    if (initializer !== undefined && Node.isObjectBindingPattern(nameNode)) {
      const prefix = toolsAliasPrefix(initializer, frame);
      if (prefix !== null) {
        for (const bound of bindingNames(nameNode)) {
          frame.scope.declare({
            name: bound.name,
            kind: "tools",
            toolsPrefix: [...prefix, bound.property ?? bound.name],
            writers: [],
          });
        }
        continue;
      }
    }

    for (const bound of bindingNames(nameNode)) {
      declared.push(
        frame.scope.declare({ name: bound.name, kind: "value", writers: [] }),
      );
    }
  }
  return declared;
}

/* -------------------------------------------------------------------------- */
/* tool / function calls — 04 §2.1, §2.2                                       */
/* -------------------------------------------------------------------------- */

function emitCall(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  call: Node,
  awaited: boolean,
  resolution: CalleeResolution,
  incoming: readonly Exit[],
): Exit[] {
  const node = createCallNode(ctx, frame, statement, statement, call, awaited, resolution);
  connectAll(ctx, incoming, node.id);
  return [{ nodeId: node.id }];
}

/**
 * Build the node for one resolved call. `owner` is the AST range the node maps
 * to — the whole statement for a statement call, the element expression for a
 * `Promise.all` branch.
 */
function createCallNode(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  owner: Node,
  call: Node,
  awaited: boolean,
  resolution: CalleeResolution,
): WorkflowNode {
  const args = describeArguments(call);
  const declaredNames = owner === statement ? declaredBindings(statement) : [];
  const declared = new Set(declaredNames.map((d) => d.name));

  let node: WorkflowNode;
  if (resolution.kind === "tool") {
    const tool = ctx.registry.getTool(resolution.toolPath);
    const semanticPath = frame.path.next(callSegment(resolution.toolPath));
    const mapping = mappingForNode(ctx.file, ctx.sourceFile, owner, semanticPath);
    const outputs = outputPortsFor(declaredNames, tool?.outputSchema);
    node = addNode(ctx, frame, {
      type: tool === undefined ? "unknown" : "tool",
      label: tool?.label ?? resolution.toolPath,
      mapping,
      inputs: portsFromSchema(tool?.inputSchema),
      outputs,
      data: {
        toolName: resolution.toolPath,
        resolved: tool !== undefined,
        awaited,
        arguments: args.fields,
        argumentText: args.text,
        argumentsEditable: args.editable,
        argumentsHaveSpread: args.hasSpread,
        ...(tool?.icon === undefined ? {} : { icon: tool.icon }),
      },
    });
    if (tool === undefined) {
      diagnose(
        ctx,
        "error",
        "unresolved-tool",
        `Tool \`${resolution.toolPath}\` is not in the registry — the call is shown as an unknown node (04 §1.2).`,
        mapping,
      );
    }
  } else if (resolution.kind === "library-function") {
    const definition = ctx.registry.getFunction(resolution.functionName);
    const semanticPath = frame.path.next(callSegment(resolution.functionName));
    const mapping = mappingForNode(ctx.file, ctx.sourceFile, owner, semanticPath);
    node = addNode(ctx, frame, {
      type: "function",
      label: definition?.label ?? resolution.functionName,
      mapping,
      inputs: portsFromSchema(definition?.inputSchema),
      outputs: outputPortsFor(declaredNames, definition?.outputSchema),
      data: {
        functionName: resolution.functionName,
        functionSource: "library",
        localName: resolution.localName,
        modulePath: definition?.modulePath ?? null,
        awaited,
        arguments: args.fields,
        argumentText: args.text,
        argumentsEditable: args.editable,
        argumentsHaveSpread: args.hasSpread,
        ...(definition?.icon === undefined ? {} : { icon: definition.icon }),
      },
    });
  } else {
    const name = resolution.kind === "local-function" ? resolution.functionName : "call";
    const semanticPath = frame.path.next(callSegment(name));
    const mapping = mappingForNode(ctx.file, ctx.sourceFile, owner, semanticPath);
    node = addNode(ctx, frame, {
      type: "function",
      label: name,
      mapping,
      outputs: outputPortsFor(declaredNames, undefined),
      data: {
        functionName: name,
        functionSource: "local",
        signature: localSignature(ctx, name),
        awaited,
        arguments: args.fields,
        argumentText: args.text,
        argumentsEditable: args.editable,
        argumentsHaveSpread: args.hasSpread,
      },
    });
  }

  recordReads(ctx, frame, node.id, [call], declared);
  if (owner === statement) {
    for (const bound of declaredNames) {
      frame.scope.declare({
        name: bound.name,
        kind: "value",
        writers: [{ nodeId: node.id, port: bound.port }],
      });
    }
  }
  return node;
}

interface DeclaredBinding {
  name: string;
  port: string;
}

/** Names bound by `const x = …` / `const { data, error } = …` (03 §6). */
function declaredBindings(statement: Statement): DeclaredBinding[] {
  const nameNode = soleNameNode(statement);
  if (nameNode === undefined) return [];
  return bindingNames(nameNode).map((bound) => ({
    name: bound.name,
    port: bound.property ?? bound.name,
  }));
}

function outputPortsFor(declared: readonly DeclaredBinding[], schema: Schema | undefined): NodePort[] {
  if (declared.length === 0) return [];
  if (declared.length === 1 && declared[0].name === declared[0].port) {
    const port: NodePort = { id: declared[0].port, label: declared[0].name };
    if (schema !== undefined) port.schema = schema;
    return [port];
  }
  // Destructured output: one port per name (03 §6).
  return declared.map((bound) => ({ id: bound.port, label: bound.name }));
}

function localSignature(ctx: AnalysisContext, name: string): string | null {
  const declaration = ctx.localFunctions.get(name);
  if (declaration === undefined || !Node.isFunctionDeclaration(declaration)) return null;
  const parameters = declaration
    .getParameters()
    .map((p) => `${p.getName()}${p.getTypeNode() === undefined ? "" : `: ${p.getTypeNodeOrThrow().getText()}`}`)
    .join(", ");
  const returnType = declaration.getReturnTypeNode()?.getText();
  return `(${parameters})${returnType === undefined ? "" : `: ${returnType}`}`;
}

/* -------------------------------------------------------------------------- */
/* parallel — 04 §2.6                                                          */
/* -------------------------------------------------------------------------- */

function emitParallel(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  elements: readonly Node[],
  incoming: readonly Exit[],
): Exit[] {
  const semanticPath = frame.path.next("parallel");
  const mapping = mappingForNode(ctx.file, ctx.sourceFile, statement, semanticPath);
  const parallel = addNode(ctx, frame, {
    type: "parallel",
    label: "Parallel",
    mapping,
    data: { branchCount: elements.length },
  });
  connectAll(ctx, incoming, parallel.id);

  const branchScope = PathScope.under(semanticPath);
  const branchFrame = childFrame(frame, { path: branchScope, scope: frame.scope });
  const branchNodes: WorkflowNode[] = [];
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    const resolution = resolveCallee(element, frame, ctx.registry);
    const node = createCallNode(ctx, branchFrame, statement, element, element, false, resolution);
    node.data["branch"] = index;
    addControlEdge(ctx, { nodeId: parallel.id, port: `branch[${String(index)}]` }, node.id, `branch ${String(index)}`);
    branchNodes.push(node);
  }

  const mergePath = withRole(semanticPath, "merge");
  const declared = declaredBindings(statement);
  const ports = declared.map((bound, index) => ({
    id: bound.port,
    label: bound.name,
    branch: index,
  }));
  const merge = addNode(ctx, frame, {
    type: "merge",
    label: "Merge",
    mapping: mappingForSynthetic(ctx.file, ctx.sourceFile, statement, mergePath, "merge"),
    synthetic: true,
    outputs: ports.map((port) => ({ id: port.id, label: port.label })),
    data: {
      of: "parallel",
      // Which branch each destructured port came from, so downstream data edges
      // trace back to the right source (04 §2.6).
      ports: ports.map((port) => ({ port: port.id, branch: port.branch })),
    },
  });
  for (const node of branchNodes) addControlEdge(ctx, { nodeId: node.id }, merge.id);

  for (const bound of declared) {
    frame.scope.declare({
      name: bound.name,
      kind: "value",
      writers: [{ nodeId: merge.id, port: bound.port }],
    });
  }
  return [{ nodeId: merge.id }];
}

/* -------------------------------------------------------------------------- */
/* condition — 04 §2.4                                                         */
/* -------------------------------------------------------------------------- */

interface SugarLabel {
  label: string;
  functionName: string;
}

/**
 * Label sugar — 04 §2.2b. Applies only when the *whole* condition is
 * `fn(args)`, `xs.some(fn)` or `xs.every(fn)` with `fn` resolving by symbol to
 * a registered function. Negation, combination or anything else shows the raw
 * expression: a wrong label is failure mode I6.
 */
function conditionSugar(ctx: AnalysisContext, frame: Frame, condition: Node): SugarLabel | null {
  const expression = unwrap(condition);
  if (expression === undefined || !Node.isCallExpression(expression)) return null;

  const callee = expression.getExpression();
  if (Node.isIdentifier(callee)) {
    const binding = frame.scope.lookup(callee.getText());
    if (binding?.kind !== "library-function") return null;
    const name = binding.functionName ?? binding.name;
    const definition = ctx.registry.getFunction(name);
    return definition === undefined ? null : { label: definition.label, functionName: name };
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const method = callee.getName();
    if (method !== "some" && method !== "every") return null;
    const args = expression.getArguments();
    if (args.length !== 1) return null;
    const argument = unwrap(args[0]);
    if (argument === undefined || !Node.isIdentifier(argument)) return null;
    const binding = frame.scope.lookup(argument.getText());
    if (binding?.kind !== "library-function") return null;
    const name = binding.functionName ?? binding.name;
    const definition = ctx.registry.getFunction(name);
    return definition === undefined ? null : { label: definition.label, functionName: name };
  }

  return null;
}

function emitCondition(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  incoming: readonly Exit[],
  hasFollowing: boolean,
): Exit[] {
  if (!Node.isIfStatement(statement)) return [...incoming];
  const condition = statement.getExpression();
  const semanticPath = frame.path.next("if");
  const mapping = mappingForNode(ctx.file, ctx.sourceFile, statement, semanticPath);
  const sugar = conditionSugar(ctx, frame, condition);

  const node = addNode(ctx, frame, {
    type: "condition",
    label: sugar?.label ?? condition.getText(),
    mapping,
    data: {
      expression: condition.getText(),
      labelSource: sugar === null ? "expression" : "registry",
      ...(sugar === null ? {} : { functionName: sugar.functionName }),
      hasElse: statement.getElseStatement() !== undefined,
    },
  });
  connectAll(ctx, incoming, node.id);
  recordReads(ctx, frame, node.id, [condition]);

  const thenFrame = childFrame(frame, { path: PathScope.under(semanticPath) });
  const thenExits = emitSequence(ctx, thenFrame, statementsOf(statement.getThenStatement()), [
    { nodeId: node.id, port: "true", label: "true" },
  ]);

  const elseStatement = statement.getElseStatement();
  let elseExits: Exit[];
  if (elseStatement === undefined) {
    // No else: the false branch runs straight to the convergence point (04 §2.4).
    elseExits = [{ nodeId: node.id, port: "false", label: "false" }];
  } else {
    const elseFrame = childFrame(frame, { path: PathScope.under(`${semanticPath}/else`) });
    elseExits = emitSequence(ctx, elseFrame, statementsOf(elseStatement), [
      { nodeId: node.id, port: "false", label: "false" },
    ]);
  }

  const pending = [...thenExits, ...elseExits];
  // A merge node exists if and only if a statement follows the branch in the
  // same block. At the end of a block the two branches simply reach the block
  // boundary — no merge node (04 §2.4).
  if (!hasFollowing) return pending;

  const merge = addNode(ctx, frame, {
    type: "merge",
    label: "Merge",
    mapping: mappingForSynthetic(
      ctx.file,
      ctx.sourceFile,
      statement,
      withRole(semanticPath, "merge"),
      "merge",
    ),
    synthetic: true,
    data: { of: "condition" },
  });
  connectAll(ctx, pending, merge.id);
  return [{ nodeId: merge.id }];
}

/* -------------------------------------------------------------------------- */
/* loop — 04 §2.5, §2.8                                                        */
/* -------------------------------------------------------------------------- */

function emitLoop(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  loop: Statement,
  label: string | null,
  incoming: readonly Exit[],
): Exit[] {
  const isWhile = Node.isWhileStatement(loop);
  const semanticPath = frame.path.next(isWhile ? "while" : "for");
  const mapping = mappingForNode(ctx.file, ctx.sourceFile, statement, semanticPath);

  let node: WorkflowNode;
  let readRegions: Node[];
  let bodyStatements: Statement[];
  const loopBindings: DeclaredBinding[] = [];

  if (Node.isForOfStatement(loop)) {
    const isAwait = loop.getAwaitKeyword() !== undefined;
    const initializer = loop.getInitializer();
    const iterable = loop.getExpression();
    let variableText = initializer.getText();
    if (Node.isVariableDeclarationList(initializer)) {
      const declaration = initializer.getDeclarations()[0];
      variableText = declaration.getNameNode().getText();
      for (const bound of bindingNames(declaration.getNameNode())) {
        loopBindings.push({ name: bound.name, port: bound.property ?? bound.name });
      }
    }
    node = addNode(ctx, frame, {
      type: "loop",
      label: `For Each ${variableText} in ${iterable.getText()}`,
      mapping,
      outputs: loopBindings.map((bound) => ({ id: bound.port, label: bound.name })),
      data: {
        kind: isAwait ? "forAwaitOf" : "forOf",
        variable: variableText,
        iterable: iterable.getText(),
        ...(label === null ? {} : { label }),
      },
    });
    readRegions = [iterable];
    bodyStatements = statementsOf(loop.getStatement());
  } else if (Node.isWhileStatement(loop)) {
    const condition = loop.getExpression();
    bodyStatements = statementsOf(loop.getStatement());
    const bounded = isBoundedWhile(condition, loop.getStatement());
    node = addNode(ctx, frame, {
      type: "loop",
      label: `While ${condition.getText()}`,
      mapping,
      data: {
        kind: "while",
        condition: condition.getText(),
        bounded,
        ...(label === null ? {} : { label }),
      },
    });
    if (!bounded) {
      diagnose(
        ctx,
        "warning",
        "unbounded-loop-risk",
        `No stopping condition recognised for \`while (${condition.getText()})\` — update a counter or flag from the loop body so the bound is visible (04 §2.8).`,
        mapping,
      );
    }
    readRegions = [condition];
  } else {
    return [...incoming];
  }

  connectAll(ctx, incoming, node.id);
  recordReads(ctx, frame, node.id, readRegions);

  const bodyScope = frame.scope.child();
  for (const bound of loopBindings) {
    bodyScope.declare({
      name: bound.name,
      kind: "value",
      writers: [{ nodeId: node.id, port: bound.port }],
    });
  }
  const bodyFrame = childFrame(frame, {
    scope: bodyScope,
    path: PathScope.under(semanticPath),
    parentId: node.id,
    parentSlot: "body",
    sinkLoopDepth: frame.sinkLoopDepth + 1,
    sinkLabels: label === null ? frame.sinkLabels : new Set([...frame.sinkLabels, label]),
  });
  // Body exits are the end of an iteration — no back edge is drawn (04 §2.5).
  emitSequence(ctx, bodyFrame, bodyStatements, [{ nodeId: node.id, port: "body", label: "body" }]);

  return [{ nodeId: node.id }];
}

/**
 * Bound check — 04 §2.8, best-effort and explicitly not a termination proof:
 * a `while` is considered bounded when some identifier read by the condition is
 * assigned or updated inside the body.
 */
function isBoundedWhile(condition: Node, body: Node): boolean {
  const read = readIdentifierNames(condition);
  if (read.size === 0) return false;
  const assigned = assignedIdentifierNames(body);
  for (const name of read) {
    if (assigned.has(name)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* try / catch / finally — 04 §2.7                                             */
/* -------------------------------------------------------------------------- */

function emitTry(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  incoming: readonly Exit[],
): Exit[] {
  if (!Node.isTryStatement(statement)) return [...incoming];
  const semanticPath = frame.path.next("try");
  const mapping = mappingForNode(ctx.file, ctx.sourceFile, statement, semanticPath);

  const catchClause = statement.getCatchClause();
  const finallyBlock = statement.getFinallyBlock();
  const catchVariable = catchClause?.getVariableDeclaration();
  const catchParam = catchVariable === undefined ? null : catchVariable.getNameNode().getText();

  const node = addNode(ctx, frame, {
    type: "try",
    label: "Try",
    mapping,
    outputs: catchParam === null ? [] : [{ id: catchParam, label: catchParam }],
    data: {
      hasCatch: catchClause !== undefined,
      hasFinally: finallyBlock !== undefined,
      catchParam,
    },
  });
  connectAll(ctx, incoming, node.id);

  const sink = finallyBlock === undefined ? frame.sink : { nodeIds: [] as string[] };
  const bodyFrame = childFrame(frame, {
    path: PathScope.under(semanticPath),
    parentId: node.id,
    parentSlot: "body",
    sink,
    sinkLoopDepth: finallyBlock === undefined ? frame.sinkLoopDepth : 0,
    sinkLabels: finallyBlock === undefined ? frame.sinkLabels : new Set<string>(),
  });
  const bodyExits = emitSequence(ctx, bodyFrame, statement.getTryBlock().getStatements(), [
    { nodeId: node.id, port: "body", label: "body" },
  ]);

  let catchExits: Exit[] = [];
  if (catchClause !== undefined) {
    const catchScope = frame.scope.child();
    if (catchParam !== null) {
      // `catch {}` without a binding is valid — it simply has no data edge.
      catchScope.declare({
        name: catchParam,
        kind: "value",
        writers: [{ nodeId: node.id, port: catchParam }],
      });
    }
    const catchFrame = childFrame(frame, {
      scope: catchScope,
      path: PathScope.under(`${semanticPath}/catch`),
      parentId: node.id,
      parentSlot: "catch",
      sink,
      sinkLoopDepth: finallyBlock === undefined ? frame.sinkLoopDepth : 0,
      sinkLabels: finallyBlock === undefined ? frame.sinkLabels : new Set<string>(),
    });
    catchExits = emitSequence(ctx, catchFrame, catchClause.getBlock().getStatements(), [
      { nodeId: node.id, port: "error", label: "error" },
    ]);
  }

  if (finallyBlock === undefined) return [...bodyExits, ...catchExits];

  const finallyIncoming: Exit[] = [...bodyExits, ...catchExits];
  // break/return inside body or catch still runs finally before leaving — the
  // graph would lie about the finally's side effects without these edges.
  for (const terminalId of sink?.nodeIds ?? []) finallyIncoming.push({ nodeId: terminalId });

  const finallyFrame = childFrame(frame, {
    path: PathScope.under(`${semanticPath}/finally`),
    parentId: node.id,
    parentSlot: "finally",
    sink: frame.sink,
    sinkLoopDepth: frame.sinkLoopDepth,
    sinkLabels: frame.sinkLabels,
  });
  return emitSequence(ctx, finallyFrame, finallyBlock.getStatements(), finallyIncoming);
}

/* -------------------------------------------------------------------------- */
/* return / break / continue — 04 §2.9                                         */
/* -------------------------------------------------------------------------- */

function emitOutput(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  incoming: readonly Exit[],
): Exit[] {
  if (!Node.isReturnStatement(statement)) return [...incoming];
  const semanticPath = frame.path.next("return");
  const expression = statement.getExpression();
  const node = addNode(ctx, frame, {
    type: "output",
    label: "End Flow",
    mapping: mappingForNode(ctx.file, ctx.sourceFile, statement, semanticPath),
    data: {
      explicit: true,
      expression: expression?.getText() ?? null,
    },
  });
  connectAll(ctx, incoming, node.id);
  if (expression !== undefined) recordReads(ctx, frame, node.id, [expression]);
  // A `return` always leaves the function, so it always runs an enclosing finally.
  frame.sink?.nodeIds.push(node.id);
  return [];
}

function emitJump(
  ctx: AnalysisContext,
  frame: Frame,
  statement: Statement,
  incoming: readonly Exit[],
): Exit[] {
  const isBreak = statement.getKind() === SyntaxKind.BreakStatement;
  const kind = isBreak ? "break" : "continue";
  const labelNode = Node.isBreakStatement(statement)
    ? statement.getLabel()
    : Node.isContinueStatement(statement)
      ? statement.getLabel()
      : undefined;
  const label = labelNode?.getText() ?? null;

  const semanticPath = frame.path.next(kind);
  const node = addNode(ctx, frame, {
    type: "jump",
    label: label === null ? kind : `${kind} → ${label}`,
    mapping: mappingForNode(ctx.file, ctx.sourceFile, statement, semanticPath),
    data: { kind, ...(label === null ? {} : { label }) },
  });
  connectAll(ctx, incoming, node.id);

  // Only jumps that actually leave the `try` run its finally: an unlabeled jump
  // inside a loop nested in the try targets that loop, not the try.
  const leavesTry =
    label === null ? frame.sinkLoopDepth === 0 : !frame.sinkLabels.has(label);
  if (leavesTry) frame.sink?.nodeIds.push(node.id);
  return [];
}
