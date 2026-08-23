/**
 * The raw Base UI dialog namespace, for a host that needs a shape `<Modal>` and
 * `<Sheet>` do not cover.
 *
 * Re-exported from its own module rather than from `dialog.tsx`: a namespace
 * object is not a component, and one non-component export is enough to stop a
 * module being a React Fast Refresh boundary.
 */

export { Dialog as DialogPrimitive } from "@base-ui-components/react/dialog";
