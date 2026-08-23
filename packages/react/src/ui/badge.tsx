/**
 * Small status pieces: `<Badge>` for a state word, `<Chip>` for a count, and
 * `<Kbd>` for a shortcut hint.
 */

import type { ReactNode } from "react";
import { cn } from "./cn.js";
import { badgeVariants, type BadgeVariantProps } from "./badge-variants.js";

export interface BadgeProps extends BadgeVariantProps {
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
