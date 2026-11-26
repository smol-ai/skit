# Fluid Foldkit

Vendored from Fluid Foldkit's source registry (`~/dev/fluid-foldkit/public/r`).
Lint and formatting skip this folder. It needs the `@foldkit/ui` render-slot patch
in `patches/`, plus the Foldkit submodel call-site caching patch.
Both patches are copied from the local Fluid Foldkit checkout and applied to SKIT’s
pinned 0.170.0 packages. Atlas compiles the utility classes through Tailwind and maps their
semantic colours in `../fluid-utilities.css`.

Local API correction: `Blocks.searchField` forwards native input attributes,
matching the upstream React block's prop forwarding. Keep this when refreshing
until the registry provides it. This lets Atlas open its command palette through
the existing search field without replacing the field's markup or styling.

Local Sidebar correction: its desktop viewport and mobile scrolling content use
`ff-scroll-fade`, matching the vendored ScrollArea stylesheet. Keep this when
refreshing until the registry updates its older `scroll-fade` class name.

Local count API: Sidebar rows and groups, and Tabs items accept a numeric `count`.
They share `components/count`, extracted from Sidebar's original menu badge.
Keep this component and these API changes when refreshing; do not restore inline
parenthetical counts or separate header count markup.

Local Accordion API correction: `Props.renderLabel(value)` optionally supplies rich
trigger content, such as a status badge beside the label. The default visible and
ghost label paths remain unchanged. Keep this when refreshing until the registry
provides the slot. Atlas passes its full-width utility through `className`; the
registry's default width and stylesheet remain unchanged. Accordion's existing
base/theme, hover, icons and shape dependencies are reused without refreshing
them or changing the pinned package versions.

Local Badge API correction: `Props.tone` accepts `success`, `warning`,
`destructive` and `info`, resolving to Fluid's matching semantic theme variable.
Tone takes precedence over `color`; omitting it keeps the registry's existing
hue palette and default path. Semantic tones also name `data-color` so the gray
variant override does not erase the semantic dot/background. Keep this when
refreshing until the registry provides semantic tones. No stylesheet changes.

Local Dialog width API correction: `Props.width` also accepts `2xl`, extending
the registry's `sm` / `lg` / `xl` width scale. Its maximum width is
`min(1100px, 96vw)`, preserving Atlas's full-size terminal viewing width without
a page selector or arbitrary view utility. The registry currently stops at
`xl` (880px). Default widths and compact-size behavior are unchanged. Keep this
when refreshing until the registry provides the larger width preset.

Local Tabs count layout correction: label and the existing Sidebar Count share
a baseline-aligned inline flex group with an 8px gap. Tabs passes Count
`h-auto min-w-0 px-0`, so the tab's symmetric outer padding owns both edges
instead of adding the count's standalone inset/minimum width. Count's shared
typography and status styling are unchanged. Keep this when refreshing.

Local ScrollArea scroll-chaining correction: horizontal viewports use
`overscroll-behavior-y: auto` while retaining horizontal containment. The upstream
all-axis containment trapped vertical wheel input over a horizontal-only diagram
even when its viewport had no vertical overflow. Keep this when refreshing so
vertical wheel input reaches the page without changing horizontal scrolling.
