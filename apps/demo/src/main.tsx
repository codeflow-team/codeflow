import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./monaco.js";
import "@xyflow/react/dist/style.css";
import "@codeflow-team/react/styles.css";
import "./app.css";

import { Root } from "./Root.js";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

// The entry imports one component and nothing else on purpose — see `Root.tsx`:
// anything the entry pulls in directly has a straight path to `full-reload`.
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
