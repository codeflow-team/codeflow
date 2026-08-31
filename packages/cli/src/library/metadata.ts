/**
 * On-disk encoding of a library function — 05-registry.md §4, 10-ai-codegen.md §2.
 *
 * The file in `lib/` is the ONLY storage: `FunctionDefinition.code` is literally
 * the file content. Everything a `FunctionDefinition` carries beyond the source
 * (label, schemas, modulePath) therefore has to live in the file too, or there
 * would be a second copy to keep in sync. It lives in a leading block comment
 * opened with the `@codeflow-function` marker and holding the JSON metadata:
 *
 *   {@literal /}* @codeflow-function
 *   { "name": "isAuthChange", "label": "Is Auth Change",
 *     "inputSchema": { "file": "File" }, "outputSchema": "boolean" }
 *   *{@literal /}
 *   export function isAuthChange(file: File): boolean { ... }
 *
 * A `.ts` file in `lib/` without that marker is a plain helper module, not a
 * library function: it is left alone and never registered.
 */

import type { FunctionDefinition } from "@codeflow-team/core";
import { CliError } from "../errors.js";

export const MARKER = "@codeflow-function";
export const DEFAULT_MODULE_PATH = "@flows/lib";

const HEADER = /^\s*\/\*\s*@codeflow-function\s*([\s\S]*?)\*\//;

/** Fields of a `FunctionDefinition` that are not the source itself. */
interface FunctionMetadata {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  inputSchema: unknown;
  outputSchema: unknown;
  modulePath: string;
  editableFields?: unknown[];
}

export function hasFunctionHeader(content: string): boolean {
  return HEADER.test(content);
}

/** Strips the metadata header, leaving the TypeScript source the user owns. */
export function stripFunctionHeader(content: string): string {
  const match = HEADER.exec(content);
  if (match === null) return content;
  return content.slice(match[0].length).replace(/^\r?\n/, "");
}

function fail(file: string, detail: string): never {
  throw new CliError(
    "invalid-library-file",
    `${file}: ${detail} (a library function file starts with a /* ${MARKER} … */ block containing its JSON metadata).`,
  );
}

/**
 * Parses one library file into a `FunctionDefinition`.
 * Returns `null` when the file carries no marker — a plain helper module.
 */
export function parseFunctionFile(
  file: string,
  content: string,
  defaults: { modulePath?: string } = {},
): FunctionDefinition | null {
  const match = HEADER.exec(content);
  if (match === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch (error) {
    fail(file, `metadata block is not valid JSON — ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(file, "metadata block must be a JSON object");
  }

  const meta = parsed as Record<string, unknown>;
  const name = meta["name"];
  if (typeof name !== "string" || name.length === 0) {
    fail(file, "metadata is missing a `name`");
  }
  if (meta["inputSchema"] === undefined) fail(file, `metadata for "${name}" is missing \`inputSchema\``);
  if (meta["outputSchema"] === undefined) fail(file, `metadata for "${name}" is missing \`outputSchema\``);

  const label = typeof meta["label"] === "string" && meta["label"].length > 0 ? meta["label"] : name;
  const modulePath =
    typeof meta["modulePath"] === "string" && meta["modulePath"].length > 0
      ? meta["modulePath"]
      : (defaults.modulePath ?? DEFAULT_MODULE_PATH);

  const def: FunctionDefinition = {
    name,
    label,
    inputSchema: meta["inputSchema"] as FunctionDefinition["inputSchema"],
    outputSchema: meta["outputSchema"] as FunctionDefinition["outputSchema"],
    // The file IS the storage — `code` is the whole file, header included, so
    // that save(get(x)) is a byte-for-byte round trip.
    code: content,
    modulePath,
  };
  if (typeof meta["description"] === "string") def.description = meta["description"];
  if (typeof meta["icon"] === "string") def.icon = meta["icon"];
  if (Array.isArray(meta["editableFields"])) {
    def.editableFields = meta["editableFields"] as FunctionDefinition["editableFields"];
  }
  return def;
}

function metadataOf(def: FunctionDefinition): FunctionMetadata {
  const meta: FunctionMetadata = {
    name: def.name,
    label: def.label,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    modulePath: def.modulePath,
  };
  if (def.description !== undefined) meta.description = def.description;
  if (def.icon !== undefined) meta.icon = def.icon;
  if (def.editableFields !== undefined && def.editableFields.length > 0) {
    meta.editableFields = def.editableFields;
  }
  // Key order is fixed here (not by object spread) so the file is stable across
  // saves regardless of how the caller built the definition.
  return meta;
}

/** Renders the file content for a definition: metadata header + the user's source. */
export function serializeFunctionFile(def: FunctionDefinition): string {
  const meta = JSON.stringify(metadataOf(def), null, 2);
  const body = stripFunctionHeader(def.code).replace(/^\s*\n/, "");
  const trailing = body.endsWith("\n") || body.length === 0 ? "" : "\n";
  return `/* ${MARKER}\n${meta}\n*/\n${body}${trailing}`;
}

/**
 * Renames the function's own binding inside its file.
 *
 * Whole-identifier replacement across the body: this is the function's own file,
 * so every standalone occurrence of the old name refers to it (declaration,
 * recursion, a local re-export). Flows importing the old name are deliberately
 * NOT touched — 03-data-model.md §11.
 */
export function renameInSource(body: string, oldName: string, newName: string): string {
  const identifier = new RegExp(`\\b${oldName.replace(/[$]/g, "\\$$")}\\b`, "g");
  return body.replace(identifier, newName);
}

/** `isAuthChange` → `is-auth-change`. Deterministic; the file name is derived, never stored. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
