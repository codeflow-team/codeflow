/**
 * Small status pieces: `<Badge>` for a state word, `<Chip>` for a count, and
 * `<Kbd>` for a shortcut hint.
 */

import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 m-0 rounded-full font-sans font-medium leading-none whitespace-nowrap [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-ink-dim ring-1 ring-inset ring-line",
        accent: "bg-accent-soft text-accent",
        ok: "bg-ok-soft text-ok",
        warn: "bg-warn-soft text-warn",
        danger: "bg-danger-soft text-danger",
        info: "bg-info-soft text-info",
      },
      size: {
        xs: "h-[18px] px-1.5 text-[10px] [&_svg]:size-2.5",
        sm: "h-[22px] px-2 text-[11px] [&_svg]:size-3",
      },
    },
    defaultVariants: { tone: "neutral", size: "xs" },
  },
);

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({ children, className, tone, size, title }: BadgeProps): ReactNode {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} title={title}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-surface-2 px-1.5 font-sans text-[10px] font-medium text-ink-dim">
      {children}
    </kbd>
  );
}
