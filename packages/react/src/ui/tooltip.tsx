/**
 * Tooltip — Base UI, wrapped so the rest of the app writes one line:
 *
 *   <Hint label="Fit to view"><Button …/></Hint>
 *
 * A tooltip is only ever a *repetition* of something already visible or an
 * expansion of an icon-only control. Anything the user must read to avoid a
 * mistake is a hint under the field, never a tooltip.
 */

import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui-components/react/tooltip";
import { cn } from "./cn.js";

export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <Tooltip.Provider delay={350} closeDelay={80}>
      {children}
    </Tooltip.Provider>
  );
}

export interface HintProps {
  label: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom" | "left" | "right";
  /** Turn the tooltip off without changing the markup around it. */
  disabled?: boolean;
}

export function Hint({ label, children, side = "bottom", disabled }: HintProps): ReactNode {
  if (disabled === true) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={7} className="z-[70]">
          <Tooltip.Popup
            className={cn(
              "max-w-64 rounded-lg bg-ink px-2 py-1 font-sans text-[11.5px] leading-snug font-medium",
              "text-[color:var(--cf-surface)] shadow-pop",
              "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            )}
          >
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
