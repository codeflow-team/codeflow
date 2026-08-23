/**
 * Progressive-disclosure switch — 07 §4. One graph, three levels of detail;
 * never three representations.
 */

import type { ReactNode } from "react";
import { useCodeFlow } from "../context/hooks.js";
import type { DisclosureMode } from "../flow/summary.js";

const LEVELS: { mode: DisclosureMode; label: string; hint: string }[] = [
  { mode: "compact", label: "Beginner", hint: "Icon + label only" },
  { mode: "expanded", label: "Power user", hint: "Fields, expressions, config" },
  { mode: "developer", label: "Developer", hint: "Source text on the node" },
];

export function DisclosureToggle({ className }: { className?: string }): ReactNode {
  const { mode, setMode } = useCodeFlow();
  return (
    <div className={`cf-toggle ${className ?? ""}`} role="group" aria-label="Detail level">
      {LEVELS.map((level) => (
        <button
          key={level.mode}
          type="button"
          title={level.hint}
          className={`cf-toggle__button${mode === level.mode ? " is-active" : ""}`}
          aria-pressed={mode === level.mode}
          onClick={() => { setMode(level.mode); }}
        >
          {level.label}
        </button>
      ))}
    </div>
  );
}
