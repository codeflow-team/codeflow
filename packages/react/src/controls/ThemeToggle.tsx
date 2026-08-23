/**
 * Minimal light/dark switch. The stylesheet is driven by CSS variables and a
 * `data-cf-theme` attribute on the root, so hosts that already have a theme can
 * set the attribute themselves and skip this component.
 */

import { useCallback, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "../ui/button.js";
import { Hint } from "../ui/tooltip.js";
import type { CodeFlowTheme } from "./theme.js";

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
    <Hint label={theme === "light" ? "Switch to dark" : "Switch to light"}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle theme"
        onClick={toggle}
        {...(className === undefined ? {} : { className })}
      >
        {theme === "light" ? <Moon /> : <Sun />}
      </Button>
    </Hint>
  );
}
