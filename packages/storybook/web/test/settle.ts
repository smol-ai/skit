import { Tooltip as TooltipPrimitive } from "@foldkit/ui";
import * as Scene from "foldkit/scene";
import * as Accordion from "../src/fluid/components/accordion";
import * as Breadcrumb from "../src/fluid/components/breadcrumb";
import * as CommandMenu from "../src/fluid/components/command-menu";
import * as Dialog from "../src/fluid/components/dialog";
import * as Tabs from "../src/fluid/components/tabs";
import * as Tooltip from "../src/fluid/components/tooltip";
import { Message } from "../src/model.ts";

/** A Message that changes nothing, of the type a Fluid component's Mount reports in. */
const unchanged = (mount: {
  readonly name: string;
  readonly messageMappers?: readonly unknown[];
}) => {
  // A Mount drawn with the Atlas's own builder reports an Atlas Message.
  if ((mount.messageMappers ?? []).length === 0) return Message.CompletedNavigation();
  switch (mount.name) {
    case "Breadcrumb.Layout":
      return Breadcrumb.Message.Measured({ widths: [], available: 0, ellipsis: 0 });
    case "AcquireResources":
    case "Dialog.Portal":
      return Dialog.Message.CompletedCloseDialog();
    case "AnchorTooltip":
      return TooltipPrimitive.Message.CompletedAnchorTooltip();
    case "FluidTooltip.FollowCursor":
      return Tooltip.Message.ExitFinished({ version: -1 });
    case "Accordion.Runtime":
      return Accordion.Message.Noop();
    case "Tabs.Visuals":
      return Tabs.Message.CompletedFocusTab();
    default:
      return CommandMenu.Message.Moved({ to: "first" });
  }
};

/**
 * Resolves every pending Mount. Fluid's Mounts measure and animate the live DOM, which a Scene
 * has none of, so each is resolved with a Message that changes nothing.
 */
export const settle = <Model, Msg, Out>(simulation: Scene.SceneSimulation<Model, Msg, Out>) =>
  simulation.mounts.reduce(
    (current, mount) =>
      Scene.Mount.resolve(
        { name: mount.name, ...(mount.args ? { args: mount.args } : {}) },
        unchanged(mount),
      )(current),
    simulation,
  );
