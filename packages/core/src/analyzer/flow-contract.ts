/**
 * Flow contract checks — 01-flow-contract.md §1, §4.
 *
 * "1 flow = 1 file, export default a single async function taking
 * (input, tools)." Violations produce diagnostics; the body is still analyzed
 * best-effort so the user sees a graph rather than a blank canvas.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { FunctionDeclaration, FunctionExpression, ArrowFunction, SourceFile } from "ts-morph";
import type { Diagnostic } from "../model/index.js";

export type FlowFunction = FunctionDeclaration | FunctionExpression | ArrowFunction;

export interface FlowContractResult {
  flow: FlowFunction | null;
  diagnostics: Diagnostic[];
}

function isFunctionLike(node: Node): node is FlowFunction {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
  );
}

/** Locate the default export, following `export default <identifier>` one hop. */
function findDefaultExport(sourceFile: SourceFile): FlowFunction | null {
  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isDefaultExport()) {
      return statement;
    }
    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      let expression: Node = statement.getExpression();
      while (Node.isParenthesizedExpression(expression)) expression = expression.getExpression();
      if (isFunctionLike(expression)) return expression;
      if (Node.isIdentifier(expression)) {
        const name = expression.getText();
        for (const candidate of sourceFile.getFunctions()) {
          if (candidate.getName() === name) return candidate;
        }
      }
    }
  }
  return null;
}

/** Every named export besides the default one — 01 §4 wants a warning for these. */
function otherExportNames(sourceFile: SourceFile, flow: FlowFunction | null): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      if (statement === flow) continue;
      if (statement.hasModifier(SyntaxKind.ExportKeyword) && !statement.isDefaultExport()) {
        names.push(statement.getName() ?? "<anonymous>");
      }
      continue;
    }
    if (Node.isVariableStatement(statement) && statement.hasModifier(SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.getDeclarationList().getDeclarations()) {
        names.push(declaration.getNameNode().getText());
      }
      continue;
    }
    if (Node.isClassDeclaration(statement) && statement.hasModifier(SyntaxKind.ExportKeyword)) {
      names.push(statement.getName() ?? "<anonymous>");
      continue;
    }
    if (Node.isExportDeclaration(statement)) {
      // `export { a, b }` — type-only re-exports are not value exports.
      if (statement.isTypeOnly()) continue;
      for (const specifier of statement.getNamedExports()) {
        if (specifier.isTypeOnly()) continue;
        names.push(specifier.getName());
      }
    }
  }
  return names;
}

export function checkFlowContract(sourceFile: SourceFile, file: string): FlowContractResult {
  const diagnostics: Diagnostic[] = [];
  const flow = findDefaultExport(sourceFile);

  if (flow === null) {
    diagnostics.push({
      severity: "error",
      code: "invalid-flow-contract",
      message:
        "No default export found. A flow file must `export default` a single async function taking (input, tools) — 01 §1.",
    });
    return { flow, diagnostics };
  }

  if (!flow.isAsync()) {
    diagnostics.push({
      severity: "error",
      code: "invalid-flow-contract",
      message: "The default-exported flow function must be `async` — 01 §1.",
    });
  }

  const parameters = flow.getParameters();
  if (parameters.length !== 2) {
    diagnostics.push({
      severity: "error",
      code: "invalid-flow-contract",
      message: `The flow function must take exactly two parameters (input, tools) — found ${String(parameters.length)}. Tool calls cannot be resolved without the \`tools\` parameter (01 §1).`,
    });
  }

  const others = otherExportNames(sourceFile, flow);
  if (others.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "multiple-exports",
      message: `Only the default export is analyzed; ${others.map((n) => `\`${n}\``).join(", ")} ${others.length === 1 ? "is" : "are"} ignored — 01 §4.`,
    });
  }

  void file;
  return { flow, diagnostics };
}
