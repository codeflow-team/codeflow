/**
 * Text controls — `<Input>`, `<Textarea>` — and the field scaffolding that goes
 * around them (`<Field>`, `<FieldLabel>`, `<FieldHint>`).
 *
 * `mono` is a presentation flag, not a semantic one: a field holding TypeScript
 * shows the source in the mono face so the user can tell code from prose
 * (06 §3), while a plain string field stays in the UI face.
 */

import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn.js";

const CONTROL_BASE = [
  "block w-full appearance-none m-0",
  "rounded-lg border border-line bg-surface-2 text-ink",
  "placeholder:text-ink-faint",
  "transition-[border-color,box-shadow,background-color] duration-150",
  "outline-none focus:border-accent/60 focus:bg-surface focus:ring-2 focus:ring-ring/35",
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-3",
].join(" ");

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid === true ? true : undefined}
      className={cn(
        CONTROL_BASE,
        "h-9 px-2.5 text-[13px] leading-none",
        mono === true ? "font-mono text-[12px]" : "font-sans",
        invalid === true && "border-danger/60 focus:border-danger focus:ring-danger/25",
        className,
      )}
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        CONTROL_BASE,
        "cf-scroll resize-y px-2.5 py-2 text-[13px] leading-[1.6]",
        mono === true ? "font-mono text-[12px] whitespace-pre" : "font-sans",
        className,
      )}
      {...props}
    />
  );
});

export function Field({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  return <div className={cn("flex flex-col gap-1.5", className)}>{children}</div>;
}

export function FieldLabel({
  className,
  children,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>): ReactNode {
  return (
    <label
      className={cn("flex flex-wrap items-center gap-1.5 m-0 text-[12px] font-semibold text-ink", className)}
      {...props}
    >
      {children}
    </label>
  );
}

export function FieldHint({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "warn" | "danger";
  className?: string;
}): ReactNode {
  return (
    <p
      className={cn(
        "m-0 text-[11.5px] leading-[1.5]",
        tone === "muted" && "text-ink-dim",
        tone === "warn" && "text-warn",
        tone === "danger" && "text-danger",
        className,
      )}
    >
      {children}
    </p>
  );
}
