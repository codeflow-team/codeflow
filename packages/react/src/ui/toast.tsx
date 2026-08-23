/**
 * Toast — Base UI, for the *confirmation* half of feedback only.
 *
 * 07 §5 is explicit that a refusal has to stay on screen: every `patch-*` error
 * therefore lives in the inspector as state, and never here. A toast is only
 * ever "that worked", which is exactly the message that may safely disappear.
 */

import type { ReactNode } from "react";
import { Toast } from "@base-ui-components/react/toast";
import { CircleCheck, Info, X } from "lucide-react";
import { cn } from "./cn.js";

export const useToast = Toast.useToastManager;

export function ToastHost({ children }: { children: ReactNode }): ReactNode {
  return (
    <Toast.Provider timeout={3800} limit={3}>
      {children}
      <ToastViewport />
    </Toast.Provider>
  );
}

function ToastViewport(): ReactNode {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      {/* Bottom-left: the right edge belongs to the inspector and the zoom
          controls, and a confirmation that covers the panel you just used is
          not a confirmation. */}
      <Toast.Viewport className="pointer-events-none fixed bottom-4 left-4 z-[80] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            swipeDirection={["left", "down"]}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-surface p-3",
              "font-sans shadow-pop outline-none",
              "transition-[opacity,transform] duration-250 ease-out",
              "data-[starting-style]:-translate-x-2 data-[starting-style]:opacity-0",
              "data-[ending-style]:-translate-x-2 data-[ending-style]:opacity-0",
            )}
          >
            <span
              className={cn(
                "mt-px flex size-5 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
                toast.type === "info" ? "bg-info-soft text-info" : "bg-ok-soft text-ok",
              )}
            >
              {toast.type === "info" ? <Info /> : <CircleCheck />}
            </span>
            <div className="min-w-0 flex-1">
              <Toast.Title className="m-0 text-[13px] font-semibold leading-snug text-ink" />
              <Toast.Description className="m-0 mt-0.5 text-[12px] leading-snug text-ink-dim" />
            </div>
            <Toast.Close
              aria-label="Dismiss"
              className="m-0 shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-1 text-ink-faint outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              <X className="size-3.5" />
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
