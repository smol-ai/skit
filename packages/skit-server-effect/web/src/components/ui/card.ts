import type { Html, HtmlBuilder } from "foldkit/html";
import { cn } from "../../lib/utils.js";

type Child = Html | string;
type StyleConfig = Readonly<{ className?: string }>;
type CardConfig = Readonly<{ className?: string; size?: "default" | "sm" }>;

const cardContainer = <M>(
  config: CardConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [
      h.Class(
        cn(
          "ring-foreground/10 bg-card text-card-foreground gap-(--card-spacing) overflow-hidden rounded-xl py-(--card-spacing) text-sm ring-1 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 data-[size=sm]:[--card-spacing:--spacing(3)] group/card flex flex-col",
          config.className,
        ),
      ),
      h.DataAttribute("slot", "card"),
      h.DataAttribute("size", config.size ?? "default"),
    ],
    children,
  );

const section =
  (slot: string, classes: string) =>
  <M>(config: StyleConfig, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html =>
    h.div([h.Class(cn(classes, config.className)), h.DataAttribute("slot", slot)], children);

export const Card = Object.assign(cardContainer, {
  header: section(
    "card-header",
    "gap-1 rounded-t-xl px-(--card-spacing) group/card-header grid auto-rows-min items-start",
  ),
  title: section("card-title", "text-base leading-snug font-medium font-heading"),
  description: section("card-description", "text-muted-foreground text-sm"),
  content: section("card-content", "px-(--card-spacing)"),
  footer: section(
    "card-footer",
    "bg-muted/50 rounded-b-xl border-t p-(--card-spacing) flex items-center",
  ),
});
