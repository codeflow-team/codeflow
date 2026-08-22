/**
 * Bundle Monaco locally instead of letting `@monaco-editor/react` pull it from a
 * CDN — the demo has to work offline (and in CI/e2e).
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// `monaco-editor` already declares `MonacoEnvironment` on the global — only assign.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  // The demo has no tsconfig/lib for the flow file; markers would be noise.
  noSemanticValidation: true,
  noSyntaxValidation: false,
});

loader.config({ monaco });
