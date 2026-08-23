/**
 * Segmented control — Base UI `ToggleGroup` in single-select mode, with a
 * sliding indicator behind the active item.
 *
 * Used for the one setting a first-time user is most likely to touch: how much
 * detail the canvas shows (07 §4).
 */

import type { ReactNode } from "react";
import { ToggleGroup } from "@base-ui-components/react/toggle-group";
import { Toggle } from "@base-ui-components/react/toggle";
import { cn } from "./cn.js";
import { Hint } from "./tooltip.js";

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  hint?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  items: SegmentedItem<T>[];
  /** Hide the labels and keep the icons — used below the compact breakpoint. */
  iconOnly?: boolean;
  className?: string;
  "aria-label": string;
}

export function Segmented<T extends string>(props: SegmentedProps<T>): ReactNode {
  return (
    <ToggleGroup
      value={[props.value]}
      onValueChange={(groupValue: unknown[]) => {
        const next = groupValue[0];
        // Single-select: clicking the active item yields an empty group, which
        // would leave the canvas with no detail level at all.
        if (typeof next === "string") props.onValueChange(next as T);
      }}
      aria-label={props["aria-label"]}
      className={cn("inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-surface-2 p-0.5", props.className)}
    >
      {props.items.map((item) => (
        <Hint key={item.value} label={item.hint ?? item.label} disabled={item.hint === undefined && props.iconOnly !== true}>
          <Toggle
            value={item.value}
            aria-label={item.label}
            className={cn(
              "inline-flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5",
              "font-sans text-[12px] font-medium text-ink-dim outline-none",
              "transition-[background-color,color,box-shadow] duration-150",
              "hover:text-ink",
              "focus-visible:ring-2 focus-visible:ring-ring/70",
              "data-[pressed]:bg-surface data-[pressed]:text-ink data-[pressed]:shadow-xs",
              "[&_svg]:size-3.5 [&_svg]:shrink-0",
              props.iconOnly === true && "px-2",
            )}
          >
            {item.icon}
            {props.iconOnly === true ? null : item.label}
          </Toggle>
        </Hint>
      ))}
    </ToggleGroup>
  );
}
