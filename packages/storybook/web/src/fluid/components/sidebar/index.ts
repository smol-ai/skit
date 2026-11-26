import { shapeClass, shapeRadius } from '../shape';
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html';
import { cn } from '../../lib/utils';
import { Mount } from 'foldkit';
import * as Tooltip from '../tooltip';
import { icon } from '../icons';
import {
  Message,
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_KEYBOARD_SHORTCUT_RIGHT,
  SIDEBAR_WIDTH_MOBILE,
  groupOpen,
  tipInit,
  type Model,
  type Peek,
  type Side,
  type Variant,
} from './state';
import {
  CollapseMounted,
  ProviderMounted,
  RailMounted,
  SheetMounted,
  ShellMounted,
} from './runtime';
import { Option } from 'effect';
import * as Count from '../count';
import * as ScrollArea from '../scroll-area';
import './styles.css';
import './portable.css';

export * from './state';
export {
  menu,
  menuList,
  skeleton,
  rowGutter,
  type MenuRow,
  type MenuAction,
  type MenuProps,
  type Render,
} from './menu';
export * as Blocks from './blocks';

/** Upstream's Sidebar, part for part. The parts are view helpers composed in
 * the consumer's own markup (menus and triggers sit inside its content), so
 * each takes the consumer's builder and a lift of Sidebar messages into the
 * consumer's Message. Class strings are upstream's (sidebar-core +
 * base/sidebar), so the site stylesheet draws them as live does. */
export interface Kit<ParentMessage> {
  readonly h: HtmlBuilder<ParentMessage>;
  readonly toMessage: (message: Message) => ParentMessage;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly icons?: string;
}
const semibold = "'wght' 550, 'opsz' 18";
const mount = <P>(kit: Kit<P>, action: Parameters<typeof Mount.mapMessage>[0]) =>
  kit.h.OnMount(Mount.mapMessage(action as never, kit.toMessage) as never);

export interface ProviderProps {
  readonly peek?: Peek;
  /** The toggle key; null disables it. Defaults by side ("[" / "]"). */
  readonly shortcut?: string | null;
  readonly side?: Side;
  readonly mobileBreakpoint?: number;
  readonly widthMobile?: string;
  readonly className?: string;
  readonly attributes?: readonly Attribute<unknown>[];
}
/** SidebarProvider's wrapper: carries the live width as --sidebar-width,
 * watches the mobile breakpoint and answers the bare toggle key. */
export function provider<P>(
  model: Model,
  props: ProviderProps,
  children: readonly Html[],
  kit: Kit<P>,
): Html {
  const { h } = kit;
  const shortcut =
    props.shortcut === undefined
      ? props.side === 'right'
        ? SIDEBAR_KEYBOARD_SHORTCUT_RIGHT
        : SIDEBAR_KEYBOARD_SHORTCUT
      : props.shortcut;
  return h.div(
    [
      ...((props.attributes ?? []).filter(
        (attribute) => attribute._tag !== 'Style',
      ) as readonly Attribute<P>[]),
      h.DataAttribute('slot', 'sidebar-wrapper'),
      h.Class(cn('group/sidebar-wrapper relative flex w-full', props.className ?? 'min-h-svh')),
      h.Style({
        '--sidebar-width': model.width,
        '--sidebar-width-mobile': props.widthMobile ?? SIDEBAR_WIDTH_MOBILE,
        ...Object.assign(
          {},
          ...(props.attributes ?? [])
            .filter((attribute) => attribute._tag === 'Style')
            .map((attribute) => attribute.value),
        ),
      }),
      h.DataAttribute('sidebar-root', model.id),
      h.DataAttribute('shortcut', shortcut ?? ''),
      h.DataAttribute('breakpoint', String(props.mobileBreakpoint ?? 768)),
      mount(kit, ProviderMounted()),
    ],
    children,
  );
}

const shortcutKbd = <P>(h: HtmlBuilder<P>, key: string) =>
  h.kbd(
    [
      h.Class(
        '-my-1 flex h-4 min-w-4 items-center justify-center rounded border border-background/30 px-1 font-sans text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)] text-background',
      ),
    ],
    [key],
  );
const shortcutKey = (side: Side) =>
  side === 'right' ? SIDEBAR_KEYBOARD_SHORTCUT_RIGHT : SIDEBAR_KEYBOARD_SHORTCUT;
/** A Sidebar-owned tooltip around any trigger (group actions, row actions). */
export const tooltip = <P>(
  model: Model,
  kit: Kit<P>,
  key: string,
  content: string,
  side: 'top' | 'right' | 'bottom' | 'left',
  trigger: (attributes: readonly ChildAttribute[]) => Html,
  options: {
    readonly rich?: () => readonly Html[];
    readonly forceOpen?: boolean;
    readonly sideOffset?: number;
    readonly followCursor?: 'x' | 'y';
  } = {},
) =>
  kit.h.submodel({
    slotId: `sidebar-tip-${key}`,
    model: model.tooltips[key] ?? tipInit(model, key),
    view: Tooltip.view,
    toParentMessage: (message) => kit.toMessage(Message.Tip({ key, message })),
    viewInputs: {
      content,
      side,
      ...(kit.radius ? { radius: kit.radius } : {}),
      ...(options.rich ? { rich: options.rich } : {}),
      ...(options.forceOpen ? { forceOpen: true } : {}),
      ...(options.sideOffset !== undefined ? { sideOffset: options.sideOffset } : {}),
      ...(options.followCursor ? { followCursor: options.followCursor } : {}),
      renderTrigger: trigger,
    },
  });
/** The keystroke chip on the tooltips' inverted surface. */
export const shortcutChip = <P>(h: HtmlBuilder<P>, key: string) =>
  h.kbd(
    [
      h.Class(
        '-my-1 flex h-4 min-w-4 items-center justify-center rounded border border-background/30 px-1 font-sans text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)] text-background',
      ),
    ],
    [key],
  );
/** A tooltip line with a trailing keystroke chip (trigger, header actions). */
export const withShortcut =
  <P>(h: HtmlBuilder<P>, label: string, key: string) =>
  () => [
    h.span(
      [h.Class('flex items-center gap-1.5')],
      [h.span([h.Class('[text-box:trim-both_cap_alphabetic]')], [label]), shortcutChip(h, key)],
    ),
  ];

export interface SidebarProps {
  readonly side?: Side;
  readonly variant?: Variant;
  readonly collapsible?: 'offcanvas' | 'none';
  /** The sidebar variant's inner-edge border. Default true. */
  readonly bordered?: boolean;
  /** Pins the rail's tooltip open (a demo's subject); dragging hides it. */
  readonly railTooltipOpen?: boolean;
  /** The resize/collapse rail on the inner edge. Default true. */
  readonly rail?: boolean;
  readonly peek?: Peek;
  readonly mobileBreakpoint?: number;
  /** The shell's height: h-svh in an app, h-full inside a bounded frame. */
  readonly height?: 'h-svh' | 'h-full';
  /** Surface the floating card / peek / drawer sits on (default 1). */
  readonly surfaceLevel?: number;
  readonly className?: string;
}
const surface = (level: number) => `bg-surface-${level} shadow-surface-3`;
const hiddenBelow: Record<number, string> = {
  640: 'max-sm:hidden max-sm:opacity-0',
  768: 'max-md:hidden max-md:opacity-0',
  1024: 'max-lg:hidden max-lg:opacity-0',
  1280: 'max-xl:hidden max-xl:opacity-0',
};

/** Sidebar: the desktop rail (sliding column + optional rail handle), the
 * peek strip/overlay while collapsed, and the mobile drawer. */
export function sidebar<P>(
  model: Model,
  props: SidebarProps,
  children: readonly Html[],
  kit: Kit<P>,
): readonly Html[] {
  if (props.collapsible !== 'none' && model.isMobile) {
    return [sheet(model, props, children, kit)];
  }
  return [desktop(model, props, children, kit)];
}

/** The mobile drawer: a scrim and a panel two surfaces up, sliding in from
 * the sidebar's edge; the scrim or Escape closes it. */
function sheet<P>(model: Model, props: SidebarProps, children: readonly Html[], kit: Kit<P>): Html {
  const { h } = kit;
  const side = props.side ?? 'left';
  const level = Math.min((props.surfaceLevel ?? 1) + 2, 8);
  if (!model.openMobile) return h.div([h.Key('sheet-closed'), h.Hidden(true)], []);
  const close = kit.toMessage(Message.MobileOpenSet({ open: false }));
  return h.div(
    [h.Key('sheet'), h.Class('contents')],
    [
      h.div(
        [
          h.Class('fixed inset-0 bg-black/40 dark:bg-black/80 z-[var(--z-overlay,40)]'),
          h.DataAttribute('sidebar', 'scrim'),
          h.OnClick(close),
        ],
        [],
      ),
      h.dialog(
        [
          h.Role('dialog'),
          h.AriaModal(true),
          h.AriaLabel('Sidebar'),
          h.Tabindex(-1),
          h.DataAttribute('sidebar', 'sidebar'),
          h.DataAttribute('mobile', 'true'),
          h.DataAttribute('side', side),
          h.Class(
            cn(
              'fixed inset-y-0 z-[var(--z-modal,50)] flex flex-col overflow-hidden outline-none',
              side === 'left' ? 'left-0' : 'right-0',
              surface(level),
            ),
          ),
          h.Style({
            width: 'var(--sidebar-width-mobile)',
            '--sidebar-surface': `var(--surface-${level})`,
          }),
          h.OnKeyDownPreventDefault((key) =>
            key === 'Escape' ? Option.some(close) : Option.none(),
          ),
          mount(kit, SheetMounted()),
        ],
        children,
      ),
    ],
  );
}

function desktop<P>(
  model: Model,
  props: SidebarProps,
  children: readonly Html[],
  kit: Kit<P>,
): Html {
  const { h } = kit;
  const side = props.side ?? 'left',
    variant = props.variant ?? 'sidebar',
    bordered = props.bordered ?? true,
    peek = props.peek ?? 'none';
  const level = Math.min((props.surfaceLevel ?? 1) + 1, 8);
  const container = shapeClass(kit.radius, 'rounded-xl', 'rounded-3xl');
  const height = props.height ?? 'h-svh';
  const inner = (extra: string) =>
    h.div(
      [
        h.DataAttribute('sidebar', 'sidebar'),
        h.DataAttribute('side', side),
        h.DataAttribute('bordered', String(bordered && variant === 'sidebar')),
        h.DataAttribute('radius', kit.radius ?? 'rounded'),
        ...(variant === 'floating'
          ? [h.Style({ '--sidebar-surface': `var(--surface-${level})` })]
          : []),
        h.Class(
          cn(
            'flex h-full w-full min-h-0 flex-col',
            extra,
            bordered &&
              variant === 'sidebar' &&
              (side === 'left' ? 'border-r border-border' : 'border-l border-border'),
          ),
        ),
      ],
      children,
    );
  if (props.collapsible === 'none')
    return h.div(
      [
        h.DataAttribute('slot', 'sidebar'),
        h.DataAttribute('variant', variant),
        h.DataAttribute('side', side),
        h.Class(
          cn(
            `peer sticky top-0 flex ${height} shrink-0 flex-col`,
            side === 'right' && 'order-last',
            props.className,
          ),
        ),
        h.Style({ width: model.width }),
      ],
      [inner('')],
    );
  const peekEnabled = peek !== 'none' && !model.open && !model.isResizing;
  const shown = model.open && !model.isMobile;
  const railHandle = () =>
    tooltip(
      model,
      kit,
      'rail',
      'Drag to resize. Click to collapse',
      side === 'left' ? 'right' : 'left',
      (attributes) =>
        h.button(
          [
            ...attributes,
            h.Type('button'),
            h.DataAttribute('sidebar', 'rail'),
            h.AriaLabel('Resize or collapse sidebar'),
            h.Tabindex(-1),
            h.Class(
              cn(
                'absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none',
                side === 'left' ? 'right-0' : 'left-0',
                'after:absolute after:inset-y-0 after:w-px after:bg-transparent hover:after:bg-foreground/25 after:transition-colors after:duration-80',
                // A pinned tooltip lights the edge too, standing in for hover.
                props.railTooltipOpen && 'after:bg-foreground/25',
                side === 'left' ? 'after:right-0' : 'after:left-0',
                variant === 'floating' &&
                  (side === 'left' ? 'right-1 after:right-[3.5px]' : 'left-1 after:left-[3.5px]'),
                variant !== 'sidebar' &&
                  'after:inset-y-2 after:[mask-image:linear-gradient(to_bottom,transparent_var(--rail-fade-start),black_var(--rail-fade-end),black_calc(100%-var(--rail-fade-end)),transparent_calc(100%-var(--rail-fade-start)))]',
              ),
            ),
            ...(variant !== 'sidebar'
              ? [
                  h.Style({
                    '--rail-fade-start': `${shapeRadius(kit.radius, 12, 24)}px`,
                    '--rail-fade-end': `${shapeRadius(kit.radius, 12, 24) + 24}px`,
                  }),
                ]
              : []),
            mount(kit, RailMounted()),
          ],
          [],
        ),
      {
        sideOffset: 8,
        // Along a full-height handle, the tip rides with the pointer.
        followCursor: 'y',
        ...(props.railTooltipOpen && !model.isResizing ? { forceOpen: true } : {}),
        // Both lines re-apply the surface's text-box trim; the gap carries
        // the rhythm. The verbs are semibold.
        rich: () => [
          h.span(
            [h.Class('flex flex-col items-start gap-2')],
            [
              h.span(
                [h.Class('[text-box:trim-both_cap_alphabetic]')],
                [h.span([h.Style({ fontVariationSettings: semibold })], ['Drag']), ' to resize'],
              ),
              h.span(
                [h.Class('flex items-center gap-1.5')],
                [
                  h.span(
                    [h.Class('[text-box:trim-both_cap_alphabetic]')],
                    [
                      h.span([h.Style({ fontVariationSettings: semibold })], ['Click']),
                      ' to collapse',
                    ],
                  ),
                  shortcutChip(h, shortcutKey(side)),
                ],
              ),
            ],
          ),
        ],
      },
    );
  return h.div(
    [
      h.DataAttribute('slot', 'sidebar'),
      h.DataAttribute('state', model.open ? 'expanded' : 'collapsed'),
      h.DataAttribute('collapsible', model.open ? '' : 'offcanvas'),
      h.DataAttribute('variant', variant),
      h.DataAttribute('side', side),
      h.DataAttribute('peek', peekEnabled ? peek : 'none'),
      h.DataAttribute('peeking', String(model.isPeeking)),
      h.DataAttribute('resizing', String(model.isResizing)),
      h.DataAttribute('shown', String(shown)),
      h.Class(
        cn(
          `peer shrink-0 sticky top-0 ${height}`,
          peekEnabled ? 'z-[var(--z-sticky,30)]' : 'overflow-hidden',
          side === 'right' && 'order-last',
          variant === 'inset' && '[--scroll-divider-inset:8px]',
          hiddenBelow[props.mobileBreakpoint ?? 768],
          props.className,
        ),
      ),
      // The runtime springs the width; this is where it settles.
      h.Style({ width: shown ? model.width : '0rem' }),
      h.DataAttribute('width', shown ? model.width : '0rem'),
      mount(kit, ShellMounted()),
    ],
    peekEnabled
      ? [
          h.button(
            [
              h.Type('button'),
              h.AriaLabel('Peek sidebar'),
              h.AriaExpanded(model.isPeeking),
              h.DataAttribute('sidebar', 'peek-strip'),
              h.Class(
                cn(
                  'group/peek-strip absolute inset-y-0 z-40 w-3 cursor-pointer outline-none',
                  side === 'left' ? 'left-0' : 'right-0',
                ),
              ),
              h.OnClick(kit.toMessage(Message.PeekChanged({ peeking: true }))),
            ],
            [
              h.span(
                [
                  h.AriaHidden(true),
                  h.Class(
                    cn(
                      'absolute inset-y-0 w-px bg-border opacity-0 transition-opacity duration-80 group-hover/peek-strip:opacity-100 group-focus-visible/peek-strip:opacity-100',
                      side === 'left' ? 'left-0' : 'right-0',
                    ),
                  ),
                ],
                [],
              ),
            ],
          ),
          model.isPeeking
            ? h.div(
                [
                  h.Key('peek'),
                  h.DataAttribute('sidebar', 'peek'),
                  h.Class(
                    cn(
                      'absolute inset-y-2 z-50 flex flex-col overflow-hidden',
                      side === 'left'
                        ? variant === 'floating'
                          ? 'left-2'
                          : 'left-0'
                        : variant === 'floating'
                          ? 'right-2'
                          : 'right-0',
                      container,
                      surface(level),
                    ),
                  ),
                  h.Style({
                    width: `calc(${model.width} - ${variant === 'floating' ? '1rem' : '0.5rem'})`,
                  }),
                ],
                children,
              )
            : null,
        ]
      : [
          h.div(
            [
              h.Key('panel'),
              h.DataAttribute('sidebar', 'panel'),
              h.Inert(!shown),
              h.AriaHidden(!shown),
              h.Class(
                cn(
                  'absolute inset-y-0 flex h-full flex-col',
                  side === 'left' ? 'left-0' : 'right-0',
                  variant === 'floating' && 'p-2',
                  variant === 'inset' && 'py-2',
                ),
              ),
              h.Style({
                width: model.width,
                transform: model.open
                  ? 'none'
                  : `translateX(${side === 'left' ? '-100%' : '100%'})`,
              }),
              h.DataAttribute(
                'offset',
                model.open ? 'none' : `translateX(${side === 'left' ? '-100%' : '100%'})`,
              ),
            ],
            [
              variant === 'floating' ? inner(cn(container, surface(level))) : inner(''),
              props.rail === false ? null : railHandle(),
            ],
          ),
        ],
  );
}

/** SidebarInset: the main column beside the rail (an inset card for the
 * inset variant, through peer-data selectors on the shell). */
export function inset<P>(children: readonly Html[], kit: Kit<P>, className = ''): Html {
  const { h } = kit;
  return h.main(
    [
      h.DataAttribute('slot', 'sidebar-inset'),
      h.Class(
        cn(
          'relative flex w-full min-w-0 flex-1 flex-col bg-background',
          'peer-data-[variant=inset]:m-2 peer-data-[variant=inset]:peer-data-[side=left]:ml-0 peer-data-[variant=inset]:peer-data-[side=right]:mr-0',
          'peer-data-[variant=inset]:peer-data-[state=collapsed]:peer-data-[side=left]:ml-2 peer-data-[variant=inset]:peer-data-[state=collapsed]:peer-data-[side=right]:mr-2',
          'transition-[margin] duration-80',
          'peer-data-[variant=inset]:' + shapeClass(kit.radius, 'rounded-xl', 'rounded-3xl'),
          'peer-data-[variant=inset]:bg-surface-2 peer-data-[variant=inset]:shadow-surface-2',
          className,
        ),
      ),
    ],
    children,
  );
}

export const header = <P>(children: readonly Html[], kit: Kit<P>, className = '') =>
  kit.h.div(
    [
      kit.h.DataAttribute('sidebar', 'header'),
      kit.h.Class(cn('flex shrink-0 flex-col gap-2 p-2', className)),
    ],
    children,
  );
export const footer = <P>(children: readonly Html[], kit: Kit<P>, className = '') =>
  kit.h.div(
    [
      kit.h.DataAttribute('sidebar', 'footer'),
      kit.h.Class(cn('mt-auto flex shrink-0 flex-col gap-2 p-2', className)),
    ],
    children,
  );
export const separator = <P>(kit: Kit<P>, className = '') =>
  kit.h.div(
    [
      kit.h.DataAttribute('sidebar', 'separator'),
      kit.h.Role('separator'),
      kit.h.AriaOrientation('horizontal'),
      kit.h.Class(cn('mx-2 h-px shrink-0 bg-border', className)),
    ],
    [],
  );

/** SidebarTrigger: a ghost icon button toggling the sidebar; its tooltip
 * names the action and shows the key. */
export function trigger<P>(
  model: Model,
  props: {
    readonly side?: Side;
    readonly className?: string;
    /** Button's icon-compact step (28px) regardless of the size ladder. */
    readonly iconCompact?: boolean;
    /** Out of the tab order and the accessibility tree (a hidden peek trigger). */
    readonly inert?: boolean;
    /** Tooltip identity when a shell carries more than one trigger. */
    readonly tipKey?: string;
  },
  kit: Kit<P>,
): Html {
  const { h } = kit;
  const side = props.side ?? 'left';
  const collapsed = model.isMobile ? !model.openMobile : !model.open;
  const compact = props.iconCompact === true || kit.size === 'compact';
  return tooltip(
    model,
    kit,
    props.tipKey ?? 'trigger',
    `${collapsed ? 'Expand sidebar' : 'Collapse sidebar'} (${shortcutKey(side)})`,
    'bottom',
    (attributes) =>
      h.button(
        [
          ...attributes,
          h.Type('button'),
          h.DataAttribute('sidebar', 'trigger'),
          h.AriaLabel('Toggle Sidebar'),
          ...(props.inert ? [h.AriaHidden(true), h.Tabindex(-1)] : []),
          h.Class(
            cn(
              'group relative isolate inline-flex items-center justify-center outline-none cursor-pointer select-none whitespace-nowrap disabled:not-aria-busy:opacity-50 disabled:pointer-events-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] text-muted-foreground hover:text-foreground p-0',
              compact ? 'h-7 w-7' : 'h-9 w-9',
              shapeClass(kit.radius, 'rounded-lg', 'rounded-full'),
              props.className,
            ),
          ),
          // The button's icon step sizes its glyph: 16px, 14px at icon-compact.
          h.Style({ '--glyph-size': compact ? '14px' : '16px' }),
          h.OnClick(kit.toMessage(Message.Toggled())),
        ],
        [
          h.span(
            [
              h.AriaHidden(true),
              h.Class(
                'absolute inset-px rounded-[inherit] transition-[box-shadow,background-color] [transition-duration:180ms,80ms] [transition-timing-function:cubic-bezier(0.23,1,0.32,1),ease] group-active:[transition-duration:80ms,80ms] bg-transparent shadow-[0_0_0_1px_transparent] group-hover:bg-hover group-hover:shadow-[0_0_0_1px_var(--hover)] group-active:bg-active group-active:shadow-[0_0_0_0px_var(--active)]',
              ),
            ],
            [],
          ),
          h.span(
            [h.Class('relative inline-flex items-center justify-center gap-[inherit]')],
            [
              h.span(
                [
                  h.Class(
                    '[&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 group-hover:[&_svg]:stroke-[2]',
                  ),
                ],
                [icon(side === 'right' ? 'panel-right' : 'panel-left', kit.icons, h)],
              ),
            ],
          ),
        ],
      ),
    { rich: withShortcut(h, collapsed ? 'Expand sidebar' : 'Collapse sidebar', shortcutKey(side)) },
  );
}

/** SidebarInput: the rail's search field, on InputGroup's fill ladder. */
export function input<P>(attributes: readonly Attribute<P>[], kit: Kit<P>, className = ''): Html {
  const { h } = kit;
  return h.input([
    ...attributes,
    h.DataAttribute('sidebar', 'input'),
    h.Class(
      cn(
        'w-full bg-transparent px-3 text-foreground placeholder:text-muted-foreground outline-none',
        'ring-1 ring-transparent transition-[background-color,box-shadow] duration-80',
        'hover:bg-muted/50 hover:ring-border',
        'focus:bg-card focus:ring-border',
        'focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
        kit.size === 'compact'
          ? 'h-7 text-[length:var(--fs-body-compact,12px)] leading-[var(--lh-body-compact,18px)] pointer-coarse:text-[16px]'
          : 'h-8 text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] pointer-coarse:text-[16px]',
        shapeClass(kit.radius, 'rounded-lg', 'rounded-[20px]'),
        className,
      ),
    ),
  ]);
}

export interface GroupProps {
  /** Collapsible groups keep their open state in the model by key. */
  readonly key?: string;
  readonly collapsible?: boolean;
  readonly defaultOpen?: boolean;
  readonly label?: string;
  readonly count?: number;
  /** Header actions (groupAction / groupActions) overlaid on the label row. */
  readonly actions?: readonly Html[];
  /** How many 24px actions the header carries (the label pads past them). */
  readonly actionsCount?: number;
  /** A header action's menu is open: the chevron slot stays shown. */
  readonly actionsOpen?: boolean;
  readonly className?: string;
  readonly attributes?: readonly Attribute<unknown>[];
}
/** SidebarGroup with its label: collapsible groups turn the label into the
 * toggle and spring everything after it closed (the runtime measures). */
export function group<P>(
  model: Model,
  props: GroupProps,
  children: readonly Html[],
  kit: Kit<P>,
): Html {
  const { h } = kit;
  const caption =
    kit.size === 'compact'
      ? 'text-[length:var(--fs-caption-compact,11px)] leading-[var(--lh-caption-compact,14px)]'
      : 'text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)]';
  const item = shapeClass(kit.radius, 'rounded-lg', 'rounded-[20px]');
  const key = props.key ?? props.label ?? 'group';
  const collapsible = props.collapsible === true;
  const open = groupOpen(model, key, props.defaultOpen ?? true);
  const contentId = `${model.id}-group-${key.replace(/\W+/g, '-')}`;
  const labelText = h.span([h.Class('min-w-0 truncate')], [props.label ?? '']);
  const count = props.count === undefined ? null : Count.view({ value: props.count, size: kit.size, className: 'ml-auto' }, h);
  const actionsCount = props.actionsCount ?? props.actions?.length ?? 0;
  if (!collapsible)
    return h.div(
      [
        h.DataAttribute('sidebar', 'group'),
        h.Class(cn('relative flex w-full min-w-0 flex-col p-2', props.className)),
      ],
      [
        props.label !== undefined
          ? h.div(
              [
                h.DataAttribute('sidebar', 'group-label'),
                h.Class(
                  cn(
                    'flex h-8 shrink-0 items-center gap-2 px-2 text-muted-foreground outline-none',
                    caption,
                  ),
                ),
              ],
              [labelText, count],
            )
          : null,
        ...(props.actions ?? []),
        ...children,
      ],
    );
  return h.div(
    [
      ...((props.attributes ?? []) as readonly Attribute<P>[]),
      h.DataAttribute('sidebar', 'group'),
      h.DataAttribute('state', open ? 'open' : 'closed'),
      h.Class(cn('relative flex w-full min-w-0 flex-col p-2', props.className)),
    ],
    [
      h.div(
        [
          ...(props.actionsOpen ? [h.DataAttribute('action-open', '')] : []),
          h.Class('group/group-header w-full'),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.DataAttribute('sidebar', 'group-label'),
              h.AriaExpanded(open),
              h.AriaControls(contentId),
              h.OnClick(
                kit.toMessage(
                  Message.GroupToggled({ key, defaultOpen: props.defaultOpen ?? true }),
                ),
              ),
              ...(actionsCount > 0
                ? [h.Style({ '--group-actions-pad': `${actionsCount * 28 + 6}px` })]
                : []),
              h.Class(
                cn(
                  'flex h-8 w-full shrink-0 cursor-pointer select-none items-center gap-2 px-2 text-left text-muted-foreground outline-none',
                  'transition-colors duration-80 hover:text-muted-foreground',
                  actionsCount > 0 && 'pr-[var(--group-actions-pad)]',
                  'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
                  item,
                  caption,
                ),
              ),
            ],
            [
              labelText,
              count,
              h.span(
                [
                  h.Class(
                    cn(
                      'ml-auto flex h-6 shrink-0 items-center justify-center overflow-hidden',
                      open
                        ? 'w-0 opacity-0 group-hover/group-header:w-6 group-hover/group-header:opacity-100 group-focus-within/group-header:w-6 group-focus-within/group-header:opacity-100 group-data-[action-open]/group-header:w-6 group-data-[action-open]/group-header:opacity-100 pointer-coarse:w-6 pointer-coarse:opacity-100'
                        : 'w-6 opacity-100',
                    ),
                  ),
                ],
                [
                  h.span(
                    [
                      h.Class('inline-flex ff-sidebar-chevron'),
                      h.DataAttribute('open', String(open)),
                      glyphSize(kit),
                    ],
                    [icon('chevron-right', kit.icons, h)],
                  ),
                ],
              ),
            ],
          ),
          ...(props.actions ?? []),
        ],
      ),
      h.div(
        [
          h.Id(contentId),
          h.DataAttribute('sidebar', 'group-collapse'),
          h.DataAttribute('open', String(open)),
          ...(open ? [] : [h.AriaHidden(true)]),
          h.Class(open ? 'overflow-visible' : 'overflow-hidden'),
          h.Style(open ? { opacity: '1' } : { height: '0px', opacity: '0' }),
          kit.h.OnMount(CollapseMounted()),
        ],
        [h.div([h.Class('flex w-full min-w-0 flex-col')], children)],
      ),
    ],
  );
}

/** SidebarGroupAction: a 24px icon button on the rows' action axis. Inside
 * groupActions it sits in the cluster's row instead. */
export function groupAction<P>(
  attributes: readonly (Attribute<P> | ChildAttribute)[],
  children: readonly Html[],
  kit: Kit<P>,
  inCluster = false,
): Html {
  const { h } = kit;
  return h.button(
    [
      ...attributes,
      h.Type('button'),
      h.DataAttribute('sidebar', 'group-action'),
      h.Class(
        cn(
          inCluster
            ? 'relative flex size-6 items-center justify-center text-muted-foreground outline-none'
            : 'absolute right-3.5 top-3 flex size-6 items-center justify-center text-muted-foreground outline-none',
          'hover:bg-hover hover:text-foreground transition-colors duration-80',
          'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
          '[&_svg]:size-[var(--icon-size)] [&_svg]:shrink-0 [&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 hover:[&_svg]:stroke-[2]',
          shapeClass(kit.radius, 'rounded-lg', 'rounded-[20px]'),
        ),
      ),
      h.Style({ '--icon-size': `${kit.size === 'compact' ? 14 : 16}px` }),
    ],
    children,
  );
}
/** Header glyphs follow the size ladder's icon step: 16px, 14px compact. */
export const glyphSize = <P>(kit: Kit<P>) =>
  kit.h.Style({ '--glyph-size': kit.size === 'compact' ? '14px' : '16px' });

export const groupActions = <P>(children: readonly Html[], kit: Kit<P>) =>
  kit.h.div(
    [
      kit.h.DataAttribute('sidebar', 'group-actions'),
      kit.h.Class('absolute right-3.5 top-2 z-10 flex h-8 items-center gap-1'),
    ],
    children,
  );
export const groupContent = <P>(children: readonly Html[], kit: Kit<P>, className = '') =>
  kit.h.div(
    [kit.h.DataAttribute('sidebar', 'group-content'), kit.h.Class(cn('w-full', className))],
    children,
  );

/** SidebarContent: the scrolling middle, a ScrollArea with the scroll
 * divider and fade (a plain overflow column inside the mobile drawer). */
export function content<P>(
  model: Model,
  children: readonly Html[],
  kit: Kit<P>,
  className = '',
): Html {
  const { h } = kit;
  const body = h.div(
    [h.DataAttribute('sidebar', 'content'), h.Class('flex w-full min-w-0 flex-col')],
    children,
  );
  if (model.isMobile)
    return h.div(
      [h.Class('scroll-divider [--scroll-divider-inset:8px] flex min-h-0 w-full flex-1 flex-col')],
      [
        h.div(
          [
            h.DataAttribute('sidebar', 'content'),
            h.Class(
              cn('ff-scroll-fade flex min-h-0 w-full flex-1 flex-col overflow-y-auto', className),
            ),
          ],
          children,
        ),
      ],
    );
  return ScrollArea.view(
    {
      children: [body],
      className: cn('scroll-divider min-h-0 w-full flex-1', className),
      viewportClassName: 'ff-scroll-fade [&>div]:!block [&>div]:!min-w-0',
      ...(kit.radius ? { radius: kit.radius } : {}),
    },
    h,
  );
}
