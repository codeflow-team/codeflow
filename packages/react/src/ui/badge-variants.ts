/**
 * Badge variants, kept out of `badge.tsx`.
 *
 * `cva()` returns a plain (lower-cased) function, and a module that exports one
 * next to a component is not a React Fast Refresh boundary — every edit to it
 * escalates into a full page reload. Style tables therefore live in their own
 * `*-variants.ts`, components in the `.tsx`.
 */

import { cva, type VariantProps } from "class-variance-authority";

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

export type BadgeVariantProps = VariantProps<typeof badgeVariants>;
