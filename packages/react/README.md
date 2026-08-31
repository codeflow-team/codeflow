# `@codeflow-team/react`

The UI layer. A React Flow canvas with hierarchical ELK layout (loops and `try` blocks are real containers, not decorations), an inspector that edits through the patch engine, a Monaco panel with two-way selection sync, a diff preview, a diagnostics panel, three progressive-disclosure levels and a light/dark design system.

Everything the MVP cannot do renders as a disabled control with the reason next to it. The UI is not allowed to fail silently or approximate.

See the [root README](../../README.md) for screenshots and the wider picture.

## Install

Prepared for npm as v0.1.0; until the first release lands, use the workspace copy:

```jsonc
// package.json
"dependencies": { "@codeflow-team/react": "workspace:*" }
```

React 18 or 19 is a peer dependency. Two stylesheets must be imported by the host app:

```ts
import "@xyflow/react/dist/style.css";
import "@codeflow-team/react/styles.css";
```

## The shape of a host app

The host owns the source text and the graph; the provider owns everything else. This type-checks against the workspace as written:

```tsx
import { useEffect, useState } from "react";
import { createCodeFlow, createRegistry, type WorkflowGraph } from "@codeflow-team/core";
import { CodeFlowProvider, WorkflowCanvas, NodeInspector } from "@codeflow-team/react";

const session = createCodeFlow({ registry: createRegistry({ tools: [] }) });

export function Editor({ file }: { file: string }): React.ReactNode {
  const [source, setSource] = useState(file);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);

  useEffect(() => {
    void session.analyze(source, { file: "flow.ts" }).then(setGraph);
  }, [source]);

  return (
    <CodeFlowProvider
      session={session}
      graph={graph}
      source={source}
      onPatched={(result) => {
        setSource(result.source);   // the patched file — this is the source of truth
        setGraph(result.graph);
      }}
      onGraphSync={setGraph}
    >
      <WorkflowCanvas />
      <NodeInspector />
    </CodeFlowProvider>
  );
}
```

## The components that matter

| Export | What it is |
|---|---|
| `CodeFlowProvider` | Holds the session, the graph, the selection and the editing state. Also takes `source` (so patch conflicts can be detected when the editor is ahead of the graph), `mode` / `defaultMode` for the disclosure level, `run` for live execution state, and `editable={false}` to switch editing off entirely. |
| `WorkflowCanvas` | The diagram. ELK hierarchical layout, resizable containers, coloured branch labels, folding, minimap, and a select-to-reveal rule for data edges. |
| `NodeInspector` | The edit surface: fields, condition, iterable, tool swap, delete with its dependency check, code region, and a diff preview before Apply. Renders as a right-hand dock, or as a sheet on a narrow screen. |
| `CodePanel` / `CodeDialog` | Monaco, synced both ways — select a node and the code highlights; move the cursor and the node selects. `CodeDialog` is the "Edit Code" modal for an opaque region. |
| `DiagnosticsPanel` | Everything the analyzer could not fully understand, each entry linked to its node. |

Plus the controls a host needs to build its own chrome: `DisclosureToggle`, `DataLinksToggle`, `ThemeToggle`, `applyTheme` / `useTheme`, and a shadcn-shaped design system over Base UI primitives (`Button`, `Badge`, `Select`, `Modal`, `Sheet`, `Popover`, `Segmented`, `Notice`, `ToastHost`, `useToast`, `TooltipProvider`) — exported so an app builds its top bar out of the same parts the library uses instead of approximating them.

## Hooks and pure helpers

`useCodeFlow`, `useOptionalCodeFlow`, `useSelectedNode`, `useNodeDiagnostics` read the provider. Below them, the adapters are exported as plain functions and are the unit-test surface: `toReactFlow`, `toElkGraph` / `runLayout` / `useElkLayout`, `autoCollapse` / `buildCollapseView`, `buildDataLinks`, `resolveInspectorFields`, `encodeFieldValue`, `nodeSummaryRows`. None of them need React to run.

## Note for library development

`context/provider.tsx` exports exactly one component, and the context object is cached on `globalThis` by `context/context.ts`. Both are load-bearing: a module that creates a context at module scope *and* exports non-components is not a valid Fast Refresh boundary, so a rebuild produced a second context object, the provider and its consumers stopped meeting, and the app went white. Three regression tests hold that shut.

## Tests

```bash
pnpm --filter @codeflow-team/react test   # 155 tests
```

## License

[GNU AGPL v3 or later](LICENSE).
