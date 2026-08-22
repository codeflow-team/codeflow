/**
 * `generated/lib.d.ts` — module declarations for the function library
 * (05-registry.md §2, §4). Tells the AI what it may import and with which
 * signature. It never participates in compilation: type resolution of a flow
 * points at the real `lib/` source through tsconfig paths.
 */

import {
  isJsonSchema,
  isNamedFieldsSchema,
  type JsonSchema,
  type NamedFieldsSchema,
  type Schema,
} from "../model/schema.js";
import type { RegisteredFunction } from "../registry/definitions.js";
import type { RegistryLookup } from "../registry/lookup.js";
import { generatedHeader } from "./header.js";
import { schemaToTs } from "./schema-to-ts.js";
import { jsDoc } from "./tools-dts.js";

export interface GenerateLibDtsOptions {
  /** Only emit these module paths. Defaults to every module in the registry. */
  modulePaths?: string[];
}

interface Parameter {
  name: string;
  type: string;
  optional: boolean;
}

/**
 * The named-fields input schema is the bridge to positional arguments: key order
 * is parameter order, key name is parameter name (05 §4).
 */
export function functionParameters(def: RegisteredFunction): Parameter[] {
  const schema = def.inputSchema;
  if (isNamedFieldsSchema(schema)) {
    return Object.entries(schema as NamedFieldsSchema).map(([name, value]) => ({
      name,
      type: schemaToTs(value),
      optional: false,
    }));
  }
  if (isJsonSchema(schema)) {
    const json = schema as JsonSchema;
    const properties = json["properties"];
    if (typeof properties !== "object" || properties === null) return [];
    const required = new Set(
      Array.isArray(json["required"]) ? (json["required"] as unknown[]).map(String) : [],
    );
    return Object.entries(properties as Record<string, Schema>).map(([name, value]) => ({
      name,
      type: schemaToTs(value),
      optional: !required.has(name),
    }));
  }
  return [];
}

function renderParameters(parameters: Parameter[]): string {
  return parameters
    .map((parameter, index) => {
      // An optional parameter followed by a required one would be invalid TS;
      // widen it instead of reordering, since order is positional.
      const trailingRequired = parameters.slice(index + 1).some((p) => !p.optional);
      if (parameter.optional && !trailingRequired) return `${parameter.name}?: ${parameter.type}`;
      if (parameter.optional) return `${parameter.name}: ${parameter.type} | undefined`;
      return `${parameter.name}: ${parameter.type}`;
    })
    .join(", ");
}

function declaration(def: RegisteredFunction, indent: string): string[] {
  return [
    ...jsDoc(def.description ?? def.label, indent),
    `${indent}export function ${def.name}(${renderParameters(functionParameters(def))}): ${schemaToTs(def.outputSchema)};`,
  ];
}

export function generateLibDts(
  registry: RegistryLookup,
  options: GenerateLibDtsOptions = {},
): string {
  const modulePaths = options.modulePaths ?? registry.listFunctionModulePaths();
  const blocks: string[] = [];

  for (const modulePath of [...modulePaths].sort()) {
    const functions = registry.listFunctionsByModule(modulePath);
    if (functions.length === 0) continue;
    const body: string[] = [];
    functions.forEach((fn, index) => {
      if (index > 0) body.push("");
      body.push(...declaration(fn, "  "));
    });
    blocks.push([`declare module ${JSON.stringify(modulePath)} {`, ...body, "}"].join("\n"));
  }

  return [
    generatedHeader(registry.registryHash()),
    "",
    ...(blocks.length === 0 ? ["// No library functions are registered."] : [blocks.join("\n\n")]),
    "",
  ].join("\n");
}
