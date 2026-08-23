/**
 * Progressive-disclosure switch — 07 §4. One graph, three levels of detail;
 * never three representations.
 *
 * The labels are what the user gets, not what the level is called internally:
 * "Simple" shows names, "Details" shows the settings, "Code" shows the source
 * on the node itself.
 */

import type { ReactNode } from "react";
import { Braces, Rows3, Type } from "lucide-react";
import { useCodeFlow } from "../context/hooks.js";
import { Segmented } from "../ui/segmented.js";
import type { DisclosureMode } from "../flow/summary.js";

const LEVELS = [
  { value: "compact" as DisclosureMode, label: "Simple", icon: <Type />, hint: "Just the name of each step" },
  { value: "expanded" as DisclosureMode, label: "Details", icon: <Rows3 />, hint: "Settings and values on each step" },
  { value: "developer" as DisclosureMode, label: "Code", icon: <Braces />, hint: "The source behind each step" },
];

export function DisclosureToggle({
  className,
  iconOnly,
}: {
  className?: string;
  iconOnly?: boolean;
}): ReactNode {
  const { mode, setMode } = useCodeFlow();
  return (
    <Segmented
      aria-label="Detail level"
      value={mode}
      onValueChange={setMode}
      items={LEVELS}
      {...(iconOnly === undefined ? {} : { iconOnly })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
