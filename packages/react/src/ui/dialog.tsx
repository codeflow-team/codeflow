/**
 * Dialog — Base UI, in the two shapes this app needs:
 *
 * - `<Modal>`: a centred panel (the code editor, the command palette);
 * - `<Sheet>`: an edge-anchored panel used below the two-pane breakpoint, where
 *   the inspector cannot be docked without eating the canvas.
 */

import type { ReactNode } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { cn } from "./cn.js";
import { Button } from "./button.js";

const BACKDROP = cn(
  // A dedicated scrim token: deriving the wash from the ink colour would tint
  // it *light* in dark mode, which lifts the page instead of dimming it.
  "fixed inset-0 z-[60] bg-scrim backdrop-blur-[2px]",
  "transition-opacity duration-200",
  "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
);

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Header accessory rendered left of the close button. */
  action?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function Modal(props: ModalProps): ReactNode {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-[61] flex w-[min(46rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100dvh-3rem))]",
            "-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
            "rounded-2xl border border-line bg-surface font-sans text-ink shadow-pop outline-none",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
            props.className,
          )}
        >
          <header className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="m-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">
                {props.title}
              </Dialog.Title>
              {props.description === undefined ? null : (
                <Dialog.Description className="m-0 mt-0.5 text-[12px] leading-snug text-ink-dim">
                  {props.description}
                </Dialog.Description>
              )}
            </div>
            {props.action}
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X />
                </Button>
              }
            />
          </header>
          {props.children}
          {props.footer === undefined ? null : (
            <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">
              {props.footer}
            </footer>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "right" | "bottom";
  children: ReactNode;
  className?: string;
  "aria-label": string;
}

export function Sheet(props: SheetProps): ReactNode {
  const side = props.side ?? "right";
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup
          aria-label={props["aria-label"]}
          className={cn(
            "fixed z-[61] flex flex-col overflow-hidden bg-surface font-sans text-ink shadow-pop outline-none",
            "transition-[opacity,transform] duration-250 ease-out",
            side === "right"
              ? [
                  "inset-y-0 right-0 w-[min(26rem,100vw)] border-l border-line",
                  "data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full",
                ]
              : [
                  "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-line",
                  "data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full",
                ],
            props.className,
          )}
        >
          {props.children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { Dialog as DialogPrimitive };
