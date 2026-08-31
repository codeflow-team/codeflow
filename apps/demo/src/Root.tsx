/**
 * The two providers that have to sit outside `<App>` — and the reason they are
 * a component rather than three lines of JSX in `main.tsx`.
 *
 * A toast has to survive the component that asked for it, and the tooltip
 * provider is what makes a second tooltip open instantly instead of waiting out
 * the delay again; `<App>` itself calls `useToast()`, so neither can live inside
 * it. They used to live in `main.tsx`, which imported them straight from
 * `@codeflow-team/react` — and that single import is what turned every edit in the
 * library into a full page reload.
 *
 * React Fast Refresh stops an HMR update at the first module in the importer
 * chain that is a refresh boundary. `main.tsx` is the entry: it declares no
 * component, so it is never a boundary, and it has no importers of its own, so
 * an update that reaches it has nowhere left to go but `full-reload`. With the
 * library's barrel (`index.js`, all re-exports, also never a boundary) imported
 * directly by the entry, *every* library module had an uninterrupted path to the
 * root. Moving the two providers into a component module puts a boundary in that
 * path: now `main.tsx` imports only components, and an update to any library
 * module is absorbed by whichever component consumes it.
 */

import type { ReactNode } from "react";
import { ToastHost, TooltipProvider } from "@codeflow-team/react";
import { App } from "./App.js";

export function Root(): ReactNode {
  return (
    <ToastHost>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ToastHost>
  );
}
