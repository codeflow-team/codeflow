/**
 * "Show data links" — the switch for the layer the canvas hides by default.
 *
 * The diagram's default answer to "what does this flow do" is control flow: a
 * single readable spine of steps in the order they happen. Where each *value*
 * travels is a second, much denser graph laid over the same nodes — on the
 * large examples it outnumbers the control layer three to two, and two thirds
 * of it crosses `for`/`try` frames, so it is routed across the whole diagram.
 * That is the picture the owner of this product described as "rất rối".
 *
 * So *all of it at once* is off — but the selected step's own values are drawn
 * at every level, without this button and without asking. That is the half of
 * the data layer a beginner needs most ("where does this step get its input?")
 * and it is never more than a handful of lines.
 *
 * This button is how someone who wants all of it says so. The
 * label says what is on screen rather than what the click does, and the pressed
 * state is real (`aria-pressed`), because this is a view setting a user will
 * come back to and needs to be able to read the current value of at a glance.
 */

import type { ReactNode } from "react";
import { Waypoints } from "lucide-react";
import { useCodeFlow } from "../context/hooks.js";
import { Button } from "../ui/button.js";
import { Hint } from "../ui/tooltip.js";

export interface DataLinksToggleProps {
  /** Drop the label and keep the icon — for narrow chrome. */
  iconOnly?: boolean;
  className?: string;
}

export function DataLinksToggle(props: DataLinksToggleProps): ReactNode {
  const { showDataLinks, setShowDataLinks } = useCodeFlow();

  const hint = showDataLinks
    ? "Hide the value links — the diagram goes back to the order steps run in"
    : "Draw a line for every value passed between steps, not just the selected one's";

  return (
    <Hint label={hint}>
      <Button
        variant={showDataLinks ? "soft" : "ghost"}
        size={props.iconOnly === true ? "icon" : "md"}
        data-testid="toggle-data-links"
        aria-label="Show data links"
        aria-pressed={showDataLinks}
        {...(props.className === undefined ? {} : { className: props.className })}
        onClick={() => { setShowDataLinks(!showDataLinks); }}
      >
        <Waypoints />
        {props.iconOnly === true ? null : "Data links"}
      </Button>
    </Hint>
  );
}
