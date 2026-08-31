import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // `test/stress` analyzes the flows `@codeflow-team/examples` publishes. Core
      // cannot depend on that package (examples depends on core, and a
      // devDependency back would make the build graph cyclic), so the suite
      // resolves it from source — the same mapping `tsconfig.json` declares,
      // and no `dist/` has to exist first.
      "@codeflow-team/examples": fileURLToPath(new URL("../examples/src/index.ts", import.meta.url)),
      "@codeflow-team/core": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
});
