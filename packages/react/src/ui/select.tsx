/**
 * Select — Base UI, with a data-driven item list so callers describe options
 * rather than assemble parts.
 *
 * Every option carries an optional icon and description, because the two places
 * this is used — "which tool is this step?" and "which example flow?" — are
 * both choices a non-developer makes by recognising a thing, not by reading an
 * identifier.
 */

import type { ReactNode } from "react";
import { Select as BaseSelect } from "@base-ui-components/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./cn.js";

export interface SelectOption {
  value: string;
  label: string;
  /** Second line under the label — the machine name, a hint, a description. */
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Applied to the popup; use it to widen a list of long machine names. */
  popupClassName?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

export function Select(props: SelectProps): ReactNode {
  const selected = props.options.find((option) => option.value === props.value);

  return (
    <BaseSelect.Root
      value={props.value}
      onValueChange={(value: string | null) => { if (value !== null) props.onValueChange(value); }}
      disabled={props.disabled === true}
      {...(props.name === undefined ? {} : { name: props.name })}
      {...(props.id === undefined ? {} : { id: props.id })}
    >
      <BaseSelect.Trigger
        data-testid={props["data-testid"]}
        aria-label={props["aria-label"]}
        className={cn(
          "group inline-flex h-9 w-full min-w-0 max-w-full items-center gap-2 rounded-lg px-2.5",
          "border border-line bg-surface text-left font-sans text-[13px] text-ink",
          "cursor-pointer select-none transition-[border-color,background-color,box-shadow] duration-150",
          "hover:border-line-strong hover:bg-surface-2",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          props.className,
        )}
      >
        {selected?.icon === undefined ? null : (
          <span className="flex shrink-0 items-center text-ink-dim [&_svg]:size-4">{selected.icon}</span>
        )}
        <BaseSelect.Value className="min-w-0 flex-1 truncate">
          {(value: string) =>
            props.options.find((option) => option.value === value)?.label ?? props.placeholder ?? "Select…"
          }
        </BaseSelect.Value>
        <BaseSelect.Icon className="shrink-0 text-ink-faint transition-transform duration-150 group-data-[popup-open]:rotate-180">
          <ChevronDown className="size-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-[70]">
          <BaseSelect.Popup
            className={cn(
              "cf-scroll max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto",
              "rounded-xl border border-line bg-surface p-1 shadow-pop",
              "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              props.popupClassName,
            )}
          >
            {props.options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled === true}
                className={cn(
                  "grid cursor-pointer select-none grid-cols-[1.25rem_1fr_1rem] items-center gap-2 rounded-lg px-2 py-1.5",
                  "font-sans text-[13px] text-ink outline-none",
                  "data-[highlighted]:bg-surface-2 data-[selected]:text-accent",
                  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                )}
              >
                <span className="flex items-center justify-center text-ink-dim [&_svg]:size-4">{option.icon}</span>
                <span className="min-w-0">
                  <BaseSelect.ItemText className="block truncate">{option.label}</BaseSelect.ItemText>
                  {option.description === undefined ? null : (
                    <span className="block truncate font-mono text-[11px] text-ink-faint">{option.description}</span>
                  )}
                </span>
                <BaseSelect.ItemIndicator className="flex items-center justify-center text-accent">
                  <Check className="size-3.5" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
