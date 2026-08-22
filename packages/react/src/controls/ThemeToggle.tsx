/**
 * Minimal light/dark switch. The stylesheet is driven by CSS variables and a
 * `data-cf-theme` attribute on the root, so hosts that already have a theme can
 * set the attribute themselves and skip this component.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

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

export function ThemeToggle({
  theme,
  onChange,
  className,
}: {
  theme: CodeFlowTheme;
  onChange: (theme: CodeFlowTheme) => void;
  className?: string;
}): ReactNode {
  const toggle = useCallback(() => { onChange(theme === "light" ? "dark" : "light"); }, [theme, onChange]);
  return (
    <button type="button" className={`cf-theme-toggle ${className ?? ""}`} onClick={toggle} aria-label="Toggle theme">
      {theme === "light" ? "🌙" : "☀️"}
    </button>
  );
}
