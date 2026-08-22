import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./monaco.js";
import "@xyflow/react/dist/style.css";
import "@codeflow/react/styles.css";
import "./app.css";

import { App } from "./App.js";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
