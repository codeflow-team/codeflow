/**
 * Button — shadcn-shaped variants over a plain `<button>`.
 *
 * The stylesheet ships without preflight (see `styles.css`), so the base class
 * list resets the parts of the UA button the design depends on rather than
 * assuming a reset ran.
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn.js";
import { buttonVariants, type ButtonVariantProps } from "./button-variants.js";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonVariantProps {}

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
