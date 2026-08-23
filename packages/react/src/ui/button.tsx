/**
 * Button — shadcn-shaped variants over a plain `<button>`.
 *
 * The stylesheet ships without preflight (see `styles.css`), so the base class
 * list resets the parts of the UA button the design depends on rather than
 * assuming a reset ran.
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 shrink-0 appearance-none",
    "m-0 whitespace-nowrap font-sans font-medium leading-none",
    "cursor-pointer select-none border border-transparent",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-150",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg shadow-xs hover:bg-accent-hover active:translate-y-px",
        secondary: "bg-surface text-ink border-line shadow-xs hover:bg-surface-2 hover:border-line-strong",
        ghost: "bg-transparent text-ink-dim hover:bg-surface-2 hover:text-ink",
        soft: "bg-accent-soft text-accent hover:bg-accent-soft/70",
        danger: "bg-transparent text-danger border-danger/35 hover:bg-danger-soft hover:border-danger/60",
        "danger-solid": "bg-danger text-white shadow-xs hover:brightness-110",
      },
      size: {
        xs: "h-6 rounded-md px-2 text-[11px] [&_svg]:size-3",
        sm: "h-8 rounded-lg px-2.5 text-[12px] [&_svg]:size-3.5",
        md: "h-9 rounded-lg px-3.5 text-[13px] [&_svg]:size-4",
        lg: "h-10 rounded-[10px] px-4 text-[13px] [&_svg]:size-4",
        icon: "size-8 rounded-lg [&_svg]:size-4",
        "icon-sm": "size-7 rounded-md [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
