import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastHost, TooltipProvider } from "@codeflow/react";

import "./monaco.js";
import "@xyflow/react/dist/style.css";
import "@codeflow/react/styles.css";
import "./app.css";

import { App } from "./App.js";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    {/* Both providers sit outside the app: a toast has to survive the component
        that asked for it, and the tooltip provider is what makes a second
        tooltip open instantly instead of waiting out the delay again. */}
    <ToastHost>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ToastHost>
  </StrictMode>,
);
