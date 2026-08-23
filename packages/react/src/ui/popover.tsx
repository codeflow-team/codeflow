/**
 * Popover — Base UI, for panels that hang off a control instead of taking over
 * the screen (the issues list, secondary actions).
 */

import type { ReactElement, ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui-components/react/popover";
import { cn } from "./cn.js";

export interface PopoverProps {
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}

export function Popover(props: PopoverProps): ReactNode {
  return (
    <BasePopover.Root
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}
    >
      <BasePopover.Trigger render={props.trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side={props.side ?? "top"}
          align={props.align ?? "start"}
          sideOffset={8}
          className="z-[65]"
        >
          <BasePopover.Popup
            className={cn(
              "w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface font-sans text-ink shadow-pop outline-none",
              "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              props.className,
            )}
          >
            {props.children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
