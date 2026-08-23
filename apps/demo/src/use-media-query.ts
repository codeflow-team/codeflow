/**
 * `useMediaQuery` — the layout decisions this app makes in JS rather than CSS.
 *
 * The inspector is either a docked column or an overlay sheet, and that is a
 * *different component tree*, not a different set of styles: rendering both and
 * hiding one would mount two Monaco-adjacent panels and two copies of every
 * form control (duplicate ids included).
 */

import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => { list.removeEventListener("change", onChange); };
    },
    () => (typeof window === "undefined" ? false : window.matchMedia(query).matches),
    () => false,
  );
}
