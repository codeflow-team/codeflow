/**
 * `cn` — the one class-name helper every component in `src/ui` uses.
 *
 * `clsx` resolves the conditionals, `tailwind-merge` resolves the conflicts, so
 * a caller's `className` can always override a variant's default instead of
 * losing to it on source order.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
