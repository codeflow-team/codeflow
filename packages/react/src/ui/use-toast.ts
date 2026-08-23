/**
 * `useToast` — the manager hook, kept out of `toast.tsx`.
 *
 * A hook is not a component, and React Fast Refresh only takes a module over
 * when every export of it is one; leaving `useToast` beside `<ToastHost>` makes
 * that file a non-boundary and turns each of its rebuilds into a full page
 * reload. Hosts import it from the package root either way.
 */

import { Toast } from "@base-ui-components/react/toast";

export const useToast = Toast.useToastManager;
