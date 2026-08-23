/**
 * Theme state, without the switch.
 *
 * `applyTheme` is a plain function and `useTheme` is a hook — neither is a
 * component, so keeping them in `ThemeToggle.tsx` would stop that file being a
 * React Fast Refresh boundary and make every edit to it reload the page. The
 * stylesheet is driven by CSS variables and a `data-cf-theme` attribute on the
 * root, so a host that already has a theme can call `applyTheme` and never
 * render the toggle at all.
 */

import { useEffect, useState } from "react";

export type CodeFlowTheme = "light" | "dark";

export function applyTheme(theme: CodeFlowTheme, target?: HTMLElement): void {
  const element = target ?? (typeof document === "undefined" ? null : document.documentElement);
  element?.setAttribute("data-cf-theme", theme);
}

export function useTheme(initial: CodeFlowTheme = "light"): [CodeFlowTheme, (theme: CodeFlowTheme) => void] {
  const [theme, setTheme] = useState<CodeFlowTheme>(initial);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return [theme, setTheme];
}
