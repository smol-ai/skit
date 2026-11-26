import * as Count from '../count';
import { shapeClass, shapeRadius } from '../shape';
import { Effect, Schema } from 'effect';
import { cn } from '../../lib/utils';
import { Mount } from 'foldkit';
import type { Attribute, ChildAttribute, Html } from 'foldkit/html';
import { mountHover } from '../../fluid-hover/engine';
import { mountListFocus } from '../list-focus';
import { mountMenuKeyboard } from './menu-keyboard';
import { icon, type IconName } from '../icons';
import { tooltip, type Kit } from './index';
import type { Model } from './state';
import { CollapseMounted } from './runtime';
import '../../fluid-hover/styles.css';

/* Upstream's sidebar-menu, data-driven: a row is a button (or link) with an
 * icon or status dot, a label that animates between weights without
 * reflowing, and an optional badge, actions and nested sub-menu. One fluid
 * hover runs across a menu and its sub-menus; hover and active rows are
 * "lit" through data attributes (styles.css) rather than per-row state. */
export interface MenuAction<P> {
  readonly icon: IconName;
  readonly label: string;
  /** A tooltip naming the action (needs MenuProps.model). */
  readonly tooltip?: string;
  /** Static hover treatment (a pinned spotlight). */
  readonly lit?: boolean;
  /** Pins the action's tooltip open (the spotlight's subject). */
  readonly tooltipOpen?: boolean;
  readonly onClick?: P;
  readonly attributes?: readonly Attribute<P>[];
  /** Renders the action through the consumer (a dropdown trigger). */
  readonly render?: Render<P>;
  /** The action's menu is open: the row keeps its hover gutter and its
   * actions stay shown. Upstream reads this off the trigger with :has(),
   * which makes every data-state change on the page restyle the page. */
  readonly open?: boolean;
}
/** A render hook: the part's attributes and children, for a consumer that
 * renders the element itself (as a Dropdown's custom trigger). */
export type Render<P> = (
  attributes: readonly (Attribute<P> | ChildAttribute)[],
  children: readonly Html[],
) => Html;
export interface MenuRow<P> {
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  /** Status-dot navigation: active/unread fill the dot, idle rings it. */
  readonly status?: 'active' | 'unread' | 'idle';
  readonly dot?: 'filled' | 'ring';
  readonly active?: boolean;
  readonly size?: 'default' | 'sm' | 'lg';
  readonly href?: string;
  readonly onClick?: P;
  readonly attributes?: readonly Attribute<P>[];
  readonly count?: number;
  readonly actions?: readonly MenuAction<P>[];
  readonly actionsOnHover?: boolean;
  /** Content before the label (a workspace tile, an avatar) instead of an icon. */
  readonly leading?: readonly Html[];
  /** Content after the label (a chevron). */
  readonly trailing?: readonly Html[];
  readonly sub?: { readonly open: boolean; readonly rows: readonly MenuRow<P>[] };
  /** Element content instead of a text label (upstream's non-string
   * children): wrapped in the row's flex label span. */
  readonly content?: readonly Html[];
  /** Siblings of the button inside the row's <li>, before it. */
  readonly before?: readonly Html[];
  readonly className?: string;
  readonly style?: Readonly<Record<string, string>>;
  readonly ariaLabel?: string;
  /** Shows the hover-revealed actions without hover (a pinned spotlight). */
  readonly actionsShown?: boolean;
  /** Renders the row's button through the consumer (a dropdown trigger). */
  readonly renderButton?: Render<P>;
}

const ROW_BASE_PAD = 8,
  ROW_SLOT = 24,
  ROW_GAP = 4,
  ROW_BADGE_INSET = 8,
  ROW_ACTION_INSET = 6;
/** The exact trailing reservation: badge slot, action run and one gap. */
export function rowGutter(actionCount: number, hasBadge: boolean) {
  if (!actionCount && !hasBadge) return ROW_BASE_PAD;
  const actions = actionCount ? actionCount * ROW_SLOT + (actionCount - 1) * ROW_GAP : 0;
  const run = (hasBadge ? ROW_SLOT : 0) + actions + (hasBadge && actionCount ? ROW_GAP : 0);
  return (hasBadge ? ROW_BADGE_INSET : ROW_ACTION_INSET) + run + ROW_GAP;
}
const BADGE_TOP = 'top-[calc((var(--row-h,32px)_-_20px)/2)]';
const ACTION_TOP = 'top-[calc((var(--row-h,32px)_-_24px)/2)]';
const BUTTON_BASE =
  'peer/menu-button relative z-10 flex w-full cursor-pointer select-none items-center gap-2 pl-2 text-left outline-none disabled:opacity-50 disabled:pointer-events-none transition-[padding] duration-80 pr-[var(--row-gutter)] group-hover/menu-item:pr-[var(--row-gutter-hover)] group-focus-within/menu-item:pr-[var(--row-gutter-hover)] group-hover/menu-sub-item:pr-[var(--row-gutter-hover)] group-focus-within/menu-sub-item:pr-[var(--row-gutter-hover)] group-data-[action-open]/menu-item:pr-[var(--row-gutter-hover)] group-data-[action-open]/menu-sub-item:pr-[var(--row-gutter-hover)]';
const SUB_BUTTON_BASE =
  'relative z-10 flex w-full cursor-pointer select-none items-center gap-2 pl-2 text-left outline-none transition-[padding] duration-80 pr-[var(--row-gutter)] group-hover/menu-sub-item:pr-[var(--row-gutter-hover)] group-focus-within/menu-sub-item:pr-[var(--row-gutter-hover)] group-data-[action-open]/menu-sub-item:pr-[var(--row-gutter-hover)]';
const body = (compact: boolean) =>
  compact
    ? 'text-[length:var(--fs-body-compact,12px)] leading-[var(--lh-body-compact,18px)]'
    : 'text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)]';
const semibold = "'wght' 550, 'opsz' 18",
  normal = "'wght' 400, 'opsz' 14";

/** One fluid hover over a menu and its sub-menus, plus the traveling focus
 * ring; rows mark themselves lit through data-fluid-hover-active. */
const MenuMounted = Mount.define('Sidebar.Menu', {
  args: { focusRing: Schema.Boolean },
  messages: [Schema.Never],
  execute: ({ element, focusRing }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const selector = '[data-sidebar=menu-button],[data-sidebar=menu-sub-button]';
        const owns = (item: HTMLElement) =>
          item.closest('[data-sidebar=menu]:not([data-sidebar=menu-sub])') === element &&
          !item.closest('[data-sidebar=menu-sub][data-state=closed]');
        const hover = mountHover(element, {
          itemSelector: selector,
          ownsItem: owns,
          nearest: true,
          axis: 'y',
          selectedAttribute: 'aria-current',
          keyboardNavigation: false,
          radius: () => `${shapeRadius(element.dataset.radius, 8, 20, 1)}px`,
        });
        const rows = () => [...element.querySelectorAll<HTMLElement>(selector)].filter(owns);
        const keyboard = mountMenuKeyboard(element, () =>
          [...element.querySelectorAll<HTMLElement>(selector)].filter(
            (item) => item.closest('[data-sidebar=menu]:not([data-sidebar=menu-sub])') === element,
          ),
        );
        const focus = focusRing ? mountListFocus(element, rows) : () => {};
        return () => {
          hover.dispose();
          keyboard();
          focus();
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});

export interface MenuProps {
  /** The sidebar model, for action tooltips. */
  readonly model?: Model;
  readonly label?: string;
  readonly className?: string;
  readonly focusRing?: boolean;
}
/** SidebarMenu: the list, its hover scope and rows. */
export function menu<P>(rows: readonly MenuRow<P>[], props: MenuProps, kit: Kit<P>): Html {
  const { h } = kit;
  const firstActive = rows.some((row) => row.active || row.status === 'active');
  return menuList(
    rows.map((row, index) => item(row, kit, false, index === 0 && !firstActive, props.model)),
    props,
    kit,
  );
}
/** The bare SidebarMenu list (for skeleton rows or hand-built items). */
export function menuList<P>(children: readonly Html[], props: MenuProps, kit: Kit<P>): Html {
  const { h } = kit;
  return h.ul(
    [
      h.DataAttribute('sidebar', 'menu'),
      h.DataAttribute('ff-sidebar-menu', ''),
      h.DataAttribute('radius', kit.radius ?? 'rounded'),
      ...(props.label ? [h.AriaLabel(props.label)] : []),
      h.Class(cn('relative flex w-full min-w-0 flex-col select-none', props.className)),
      h.OnMount(MenuMounted({ focusRing: props.focusRing ?? true })),
    ],
    children,
  );
}

function label<P>(row: MenuRow<P>, kit: Kit<P>, active: boolean, compact: boolean): Html[] {
  const { h } = kit;
  const text = row.size === 'sm' ? body(true) : body(compact);
  if (row.content)
    return [
      h.span(
        [
          h.DataAttribute('sidebar', 'menu-label-text'),
          h.Class(
            cn(
              'flex min-w-0 flex-1 items-center gap-2 transition-colors duration-80',
              active ? 'text-foreground' : 'text-muted-foreground',
              text,
            ),
          ),
        ],
        row.content,
      ),
    ];
  return [
    h.span(
      [
        h.Class(cn('inline-grid min-w-0 text-left', text)),
        h.DataAttribute('sidebar', 'menu-label'),
      ],
      [
        h.span(
          [
            h.Class(
              'col-start-1 row-start-1 invisible truncate pt-[0.25em] -mt-[0.25em] pb-[0.25em] -mb-[0.25em] [text-box:trim-both_cap_alphabetic]',
            ),
            h.Style({ fontVariationSettings: semibold }),
            h.AriaHidden(true),
          ],
          [row.label],
        ),
        h.span(
          [
            h.Class(
              cn(
                'col-start-1 row-start-1 truncate pt-[0.25em] -mt-[0.25em] pb-[0.25em] -mb-[0.25em] transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
                active ? 'text-foreground' : 'text-muted-foreground',
              ),
            ),
            h.DataAttribute('sidebar', 'menu-label-text'),
            h.Style({ fontVariationSettings: active ? semibold : normal }),
          ],
          [row.label],
        ),
      ],
    ),
    ...(row.trailing ?? []),
  ];
}

function item<P>(
  row: MenuRow<P>,
  kit: Kit<P>,
  sub: boolean,
  firstStop: boolean,
  model?: Model,
): Html {
  const { h } = kit;
  const compact = kit.size === 'compact';
  const active = row.active === true || row.status === 'active';
  const actionCount = row.actions?.length ?? 0;
  const hasBadge = row.count !== undefined;
  const gutterHover = rowGutter(actionCount, hasBadge);
  const gutterRest = row.actionsOnHover ? rowGutter(0, hasBadge) : gutterHover;
  const radius = shapeClass(kit.radius, 'rounded-lg', 'rounded-[20px]');
  const iconSize = compact ? 14 : 16;
  const dot = row.dot ?? (row.status ? (row.status === 'idle' ? 'ring' : 'filled') : undefined);
  const height = sub
    ? row.size === 'sm' || compact
      ? 'h-6'
      : 'h-7'
    : row.size === 'sm'
      ? 'h-7'
      : row.size === 'lg'
        ? 'h-12'
        : compact
          ? 'h-7'
          : 'h-8';
  const leading = row.leading
    ? row.leading
    : row.icon
      ? [
          h.span(
            [
              h.Class(
                'ff-sidebar-row-icon shrink-0 inline-flex transition-[color,stroke-width] duration-80',
              ),
              h.DataAttribute('lit', String(active)),
              h.Style({ '--icon-size': `${iconSize}px` }),
            ],
            [icon(row.icon, kit.icons, h)],
          ),
        ]
      : dot
        ? [
            h.span(
              [
                h.Class('flex shrink-0 items-center justify-center'),
                h.Style({ width: `${iconSize}px`, height: `${iconSize}px` }),
              ],
              [
                h.span(
                  [
                    h.DataAttribute('sidebar', 'menu-dot'),
                    h.DataAttribute('dot', dot),
                    h.Class(
                      cn(
                        'size-2 rounded-full transition-colors duration-80',
                        dot === 'filled'
                          ? active
                            ? 'bg-foreground/60'
                            : 'bg-muted-foreground/50'
                          : active
                            ? 'border border-foreground/60'
                            : 'border border-muted-foreground/50',
                      ),
                    ),
                  ],
                  [],
                ),
              ],
            ),
          ]
        : [];
  const buttonAttributes = [
    ...(row.attributes ?? []),
    h.DataAttribute('sidebar', sub ? 'menu-sub-button' : 'menu-button'),
    h.DataAttribute('size', row.size ?? (sub ? 'md' : 'default')),
    ...(active ? [h.DataAttribute('active', 'true'), h.AriaCurrent('page')] : []),
    ...(row.status ? [h.DataAttribute('status', row.status)] : []),
    h.Tabindex(active || firstStop ? 0 : -1),
    h.Class(cn(sub ? SUB_BUTTON_BASE : BUTTON_BASE, height, radius, row.className)),
    h.Style({
      '--row-gutter': `${gutterRest}px`,
      '--row-gutter-hover': `${gutterHover}px`,
      ...row.style,
    }),
    ...(row.ariaLabel ? [h.AriaLabel(row.ariaLabel)] : []),
    ...(row.onClick !== undefined ? [h.OnClick(row.onClick)] : []),
  ];
  const content = [
    ...leading,
    ...label(row, kit, active, compact),
    row.status === 'unread' ? h.span([h.Class('sr-only')], [', unread']) : null,
  ];
  const button = row.renderButton
    ? row.renderButton(
        buttonAttributes,
        content.filter((child): child is Html => child !== null),
      )
    : row.href !== undefined
      ? h.a([h.Href(row.href), ...buttonAttributes], content)
      : sub
        ? h.a(buttonAttributes, content)
        : h.button([h.Type('button'), ...buttonAttributes], content);
  const group = sub ? 'menu-sub-item' : 'menu-item';
  const rowHeight = sub
    ? cn(compact ? '[--row-h:24px]' : '[--row-h:28px]', 'has-[>[data-size=sm]]:[--row-h:24px]')
    : cn(
        compact ? '[--row-h:28px]' : '[--row-h:32px]',
        'has-[>[data-size=sm]]:[--row-h:28px] has-[>[data-size=lg]]:[--row-h:48px]',
      );
  const action = (entry: MenuAction<P>, inCluster: boolean) =>
    entry.tooltip && model
      ? tooltip(
          model,
          kit,
          `${row.key}-${entry.label}`,
          entry.tooltip,
          'top',
          (attributes) => actionButton(entry, inCluster, attributes),
          entry.tooltipOpen ? { forceOpen: true } : {},
        )
      : actionButton(entry, inCluster, []);
  const actionButton = (
    entry: MenuAction<P>,
    inCluster: boolean,
    extra: readonly ChildAttribute[],
  ) => {
    const attributes = [
      ...extra,
      ...(entry.attributes ?? []),
      h.DataAttribute('sidebar', 'menu-action'),
      h.AriaLabel(entry.label),
      ...(row.actionsOnHover && !inCluster ? [h.DataAttribute('show-on-hover', '')] : []),
      h.Class(
        cn(
          inCluster
            ? 'relative flex size-6 shrink-0 items-center justify-center text-muted-foreground outline-none'
            : 'absolute right-1.5 z-10 flex size-6 items-center justify-center text-muted-foreground outline-none',
          !inCluster && `group-has-[>[data-sidebar=menu-badge]]/${group}:right-8.5`,
          !inCluster && ACTION_TOP,
          'hover:bg-hover hover:text-foreground transition-[color,background-color,opacity] duration-80',
          'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
          '[&_svg]:size-[var(--icon-size)] [&_svg]:shrink-0 [&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 hover:[&_svg]:stroke-[2]',
          radius,
          entry.lit && 'bg-hover text-foreground',
          !inCluster &&
            row.actionsOnHover &&
            (sub
              ? 'opacity-0 group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100 data-[state=open]:opacity-100 aria-expanded:opacity-100'
              : 'opacity-0 peer-hover/menu-button:opacity-100 peer-focus-visible/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 aria-expanded:opacity-100'),
        ),
      ),
      h.Style({ '--icon-size': `${iconSize}px` }),
      ...(entry.onClick !== undefined ? [h.OnClick(entry.onClick)] : []),
    ];
    const children = [icon(entry.icon, kit.icons, h)];
    return entry.render
      ? entry.render(attributes, children)
      : h.button([...attributes, h.Type('button')], children);
  };
  return h.li(
    [
      h.Key(row.key),
      h.DataAttribute('sidebar', group),
      ...(row.actions?.some((entry) => entry.open) ? [h.DataAttribute('action-open', '')] : []),
      h.Class(cn(`group/${group} relative`, rowHeight)),
    ],
    [
      ...(row.before ?? []),
      button,
      hasBadge
        ? Count.view({
            value: row.count!,
            size: kit.size,
            active,
            className: cn('absolute right-2 z-10', BADGE_TOP),
            attributes: [h.DataAttribute('sidebar', 'menu-badge'), h.DataAttribute('lit', String(active))],
          }, h)
        : null,
      actionCount === 1 ? action(row.actions![0]!, false) : null,
      actionCount > 1
        ? h.div(
            [
              h.DataAttribute('sidebar', 'menu-actions'),
              h.Class(
                cn(
                  'absolute right-1.5 z-10 flex items-center gap-1',
                  `group-has-[>[data-sidebar=menu-badge]]/${group}:right-8.5`,
                  ACTION_TOP,
                  row.actionsShown
                    ? 'opacity-100'
                    : row.actionsOnHover &&
                        (sub
                          ? 'opacity-0 transition-opacity duration-80 group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100 group-data-[action-open]/menu-sub-item:opacity-100'
                          : 'opacity-0 transition-opacity duration-80 peer-hover/menu-button:opacity-100 peer-focus-visible/menu-button:opacity-100 hover:opacity-100 focus-within:opacity-100 group-data-[action-open]/menu-item:opacity-100'),
                ),
              ),
            ],
            row.actions!.map((entry) => action(entry, true)),
          )
        : null,
      row.sub
        ? h.div(
            [
              h.DataAttribute('slot', 'sidebar-menu-sub-wrapper'),
              h.DataAttribute('sidebar', 'group-collapse'),
              h.DataAttribute('open', String(row.sub.open)),
              h.Class('overflow-hidden'),
              h.Style(row.sub.open ? { opacity: '1' } : { height: '0px', opacity: '0' }),
              h.OnMount(CollapseMounted()),
            ],
            [
              h.ul(
                [
                  h.DataAttribute('sidebar', 'menu-sub'),
                  h.DataAttribute('state', row.sub.open ? 'open' : 'closed'),
                  ...(row.sub.open ? [] : [h.AriaHidden(true)]),
                  h.Class(
                    'relative ml-[15px] flex min-w-0 flex-col border-l border-border pl-2 select-none',
                  ),
                ],
                row.sub.rows.map((child) => item(child, kit, true, false, model)),
              ),
            ],
          )
        : null,
    ],
  );
}

const SKELETON_WIDTHS = ['62%', '74%', '55%', '82%', '68%'];
/** SidebarMenuSkeleton: a placeholder row (loading state). The width cycles
 * by index so every render agrees. */
export function skeleton<P>(kit: Kit<P>, index: number, showIcon = false): Html {
  const { h } = kit;
  return h.div(
    [
      h.Key(`skeleton-${index}`),
      h.DataAttribute('sidebar', 'menu-skeleton'),
      h.Class(cn('flex items-center gap-2 px-2', kit.size === 'compact' ? 'h-7' : 'h-8')),
    ],
    [
      showIcon
        ? h.div(
            [
              h.DataAttribute('sidebar', 'menu-skeleton-icon'),
              h.Class('size-4 shrink-0 animate-pulse rounded-md bg-hover'),
            ],
            [],
          )
        : null,
      h.div(
        [
          h.DataAttribute('sidebar', 'menu-skeleton-text'),
          h.Class('h-4 flex-1 animate-pulse rounded-md bg-hover'),
          h.Style({ maxWidth: SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]! }),
        ],
        [],
      ),
    ],
  );
}
