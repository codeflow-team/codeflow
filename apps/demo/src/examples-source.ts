/**
 * Where the gallery gets its examples.
 *
 * The whole app is written against the `@codeflow/examples` contract:
 *
 *   FlowExample · ExampleRegistry · EXAMPLES · REGISTRIES · registryFor
 *
 * Nothing else in the app imports that package directly, so this file is the one
 * place a different example set would be swapped in — a scratch flow, a
 * customer's own library, or a stand-in while the package is being rebuilt.
 */

export type { ExampleCategory, ExampleRegistry, FlowExample } from "@codeflow/examples";
export { EXAMPLES, REGISTRIES, registryFor } from "@codeflow/examples";
