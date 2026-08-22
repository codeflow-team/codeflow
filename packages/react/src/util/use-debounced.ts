/** A value that settles `ms` after the last change — used to keep expensive work (a preview patch, a re-analyze) off every keystroke. */

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setSettled(value); }, ms);
    return () => { clearTimeout(timer); };
  }, [value, ms]);
  return settled;
}
