import { shapeClass } from '../shape';
import type { Attribute, ChildAttribute, Html } from 'foldkit/html';
import { cn } from '../../lib/utils';
import { icon } from '../icons';
import { trigger, input, menu, glyphSize, type Kit, type Render } from './index';
import { CalloutStackMounted } from './runtime';
import type { Model } from './state';

/* Upstream's sidebar blocks: the workspace header (tile + name + switcher
 * chevron, with the peek trigger tucked under the tile), the search field,
 * the user footer and the inset topbar. Class strings are the registry's. */
const semibold = "'wght' 550, 'opsz' 18";

export const workspaceTile = <P>(letter: string, kit: Kit<P>) =>
  kit.h.span(
    [
      kit.h.DataAttribute('sidebar', 'workspace-tile'),
      kit.h.DataAttribute('radius', kit.radius ?? 'rounded'),
      kit.h.Class(
        cn(
          'flex size-5 shrink-0 items-center justify-center bg-foreground text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)] text-background',
          shapeClass(kit.radius, 'rounded-md', 'rounded-full'),
        ),
      ),
      kit.h.Style({ fontVariationSettings: semibold }),
    ],
    [letter],
  );

export interface WorkspaceHeaderProps<P> {
  readonly name: string;
  readonly tile: Html;
  /** The switcher: the row becomes a menu button with a chevron. */
  readonly menu?: {
    readonly onClick?: P;
    readonly attributes?: readonly Attribute<P>[];
    /** The switcher's dropdown, given the row's button to render as its trigger. */
    readonly render?: Render<P>;
  };
}
/** The header's brand row. While the collapsed rail peeks, the tile fades
 * out and the sidebar trigger fades in under it. */
export function workspaceHeader<P>(
  model: Model,
  props: WorkspaceHeaderProps<P>,
  kit: Kit<P>,
): Html {
  const { h } = kit;
  const peeking = model.isPeeking;
  const tileSlot = h.span(
    [
      h.AriaHidden(true),
      h.Class(
        cn(
          'pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 transition-opacity duration-80',
          peeking ? 'opacity-0' : 'opacity-100',
        ),
      ),
    ],
    [props.tile],
  );
  const fade = cn(
    '[&>span:first-child]:hidden [&_svg]:size-4 transition-opacity duration-80',
    peeking ? 'opacity-100' : 'pointer-events-none opacity-0',
  );
  const name = h.span(
    [
      h.Class(
        'min-w-0 truncate text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] text-foreground',
      ),
      h.Style({ fontVariationSettings: semibold }),
    ],
    [props.name],
  );
  const peekTrigger = (className: string) =>
    trigger(
      model,
      {
        className: `${className} ${fade}`,
        iconCompact: true,
        inert: !peeking,
        tipKey: 'peek-trigger',
      },
      kit,
    );
  if (!props.menu)
    return h.div(
      [h.Class('relative flex h-8 items-center pl-8 pr-2')],
      [peekTrigger('absolute left-1 top-1/2 -translate-y-1/2'), tileSlot, name],
    );
  return menu(
    [
      {
        key: 'workspace',
        label: props.name,
        ariaLabel: 'Switch workspace',
        className: 'pl-8',
        before: [peekTrigger('absolute left-1 top-1/2 z-20 -translate-y-1/2')],
        content: [
          tileSlot,
          name,
          h.span(
            [h.Class('ml-auto inline-flex @max-[7rem]:hidden ff-sidebar-glyph'), glyphSize(kit)],
            [icon('chevron-down', kit.icons, h)],
          ),
        ],
        attributes: [
          h.AriaHasPopup('menu'),
          ...(props.menu.render ? [] : [h.AriaExpanded(false)]),
          ...(props.menu.attributes ?? []),
        ],
        ...(props.menu.onClick !== undefined ? { onClick: props.menu.onClick } : {}),
        ...(props.menu.render ? { renderButton: props.menu.render } : {}),
      },
    ],
    { label: 'Workspace', className: '@container' },
    kit,
  );
}

/** The header's search row: an inset-ladder field with a leading glyph and
 * a shortcut chip that shows on hover or focus. */
export function searchField<P>(
  kit: Kit<P>,
  props: { readonly placeholder?: string; readonly shortcut?: string | null; readonly attributes?: readonly Attribute<P>[] } = {},
): Html {
  const { h } = kit;
  const shortcut = props.shortcut === undefined ? '⌘K' : props.shortcut;
  return h.div(
    [h.Class('group/search relative')],
    [
      h.span(
        [
          h.Class(
            'pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground ff-sidebar-glyph',
          ),
          glyphSize(kit),
        ],
        [icon('search', kit.icons, h)],
      ),
      input(
        [h.Placeholder(props.placeholder ?? 'Search…'), h.AriaLabel('Search'), ...(props.attributes ?? [])],
        kit,
        'pl-8 pr-12',
      ),
      shortcut
        ? h.kbd(
            [
              h.Class(
                'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[length:var(--fs-micro,11px)] leading-[var(--lh-micro,14px)] text-muted-foreground opacity-0 transition-opacity duration-80 group-hover/search:opacity-100 group-focus-within/search:opacity-100',
              ),
            ],
            [shortcut],
          )
        : null,
    ],
  );
}

/** The footer's user row: avatar, name and an up-down chevron. */
export function userFooter<P>(
  kit: Kit<P>,
  props: {
    readonly name?: string;
    readonly avatar?: string;
    readonly onClick?: P;
    readonly attributes?: readonly Attribute<P>[];
    /** The user menu, given the row's button to render as its trigger. */
    readonly render?: Render<P>;
  } = {},
): Html {
  const { h } = kit;
  return menu(
    [
      {
        key: 'user',
        label: props.name ?? 'Micka Touillaud',
        ariaLabel: 'Open user menu',
        attributes: [
          h.AriaHasPopup('menu'),
          ...(props.render ? [] : [h.AriaExpanded(false)]),
          ...(props.attributes ?? []),
        ],
        ...(props.onClick !== undefined ? { onClick: props.onClick } : {}),
        ...(props.render ? { renderButton: props.render } : {}),
        content: [
          h.img([
            h.Src(props.avatar ?? '/micka.png'),
            h.Alt(''),
            h.Attribute('width', '20'),
            h.Attribute('height', '20'),
            h.DataAttribute('guide-img', 'true'),
            h.Class(
              '-ml-0.5 -mr-0.5 size-5 shrink-0 rounded-full outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10',
            ),
          ]),
          h.span(
            [h.Class('min-w-0 truncate text-[13px] text-foreground')],
            [props.name ?? 'Micka Touillaud'],
          ),
          h.span(
            [
              h.DataAttribute('guide', 'true'),
              h.Class(
                'ml-auto -mr-0.5 flex size-6 shrink-0 items-center justify-center ff-sidebar-glyph',
              ),
            ],
            [icon('chevrons-up-down', kit.icons, h)],
          ),
        ],
      },
    ],
    { label: 'User' },
    kit,
  );
}

/** The inset's topbar: the sidebar trigger (faded out while peeking) and a
 * caption. */
export function insetTopbar<P>(
  model: Model,
  children: readonly Html[],
  kit: Kit<P>,
  className = '',
) {
  const { h } = kit;
  return h.header(
    [h.Class(cn('flex h-12 shrink-0 items-center gap-2 px-1.5', className))],
    [
      trigger(
        model,
        {
          className: `transition-opacity delay-200 duration-160 ${model.isPeeking ? 'opacity-0' : 'opacity-100'}`,
        },
        kit,
      ),
      ...children,
    ],
  );
}

const GHOST =
  'group relative isolate inline-flex items-center justify-center outline-none cursor-pointer select-none whitespace-nowrap transition-colors duration-80 disabled:not-aria-busy:opacity-50 disabled:pointer-events-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] text-muted-foreground hover:text-foreground p-0';
const GHOST_FILL =
  'absolute inset-px rounded-[inherit] transition-[box-shadow,background-color] [transition-duration:180ms,80ms] [transition-timing-function:cubic-bezier(0.23,1,0.32,1),ease] group-active:[transition-duration:80ms,80ms] bg-transparent shadow-[0_0_0_1px_transparent] group-hover:bg-hover group-hover:shadow-[0_0_0_1px_var(--hover)] group-active:bg-active group-active:shadow-[0_0_0_0px_var(--active)]';
/** Upstream's ghost icon-compact Button at 24px (the header and footer
 * clusters' size-6 icon buttons). */
export function iconButton<P>(
  kit: Kit<P>,
  props: {
    readonly label: string;
    readonly icon: Parameters<typeof icon>[0];
    readonly attributes?: readonly (Attribute<P> | ChildAttribute)[];
  },
): Html {
  const { h } = kit;
  return h.button(
    [
      ...(props.attributes ?? []),
      h.Type('button'),
      h.AriaLabel(props.label),
      h.Class(
        cn(
          GHOST,
          '[&_svg]:h-3.5 [&_svg]:w-3.5',
          shapeClass(kit.radius, 'rounded-lg', 'rounded-full'),
          'size-6 shrink-0',
        ),
      ),
    ],
    [
      h.span([h.AriaHidden(true), h.Class(GHOST_FILL)], []),
      h.span(
        [h.Class('relative inline-flex items-center justify-center gap-[inherit]')],
        [
          h.span(
            [
              h.Class(
                '[&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 group-hover:[&_svg]:stroke-[2]',
              ),
            ],
            [icon(props.icon, kit.icons, h)],
          ),
        ],
      ),
    ],
  );
}

/** The anchored footer callout: a compact link card one surface above the
 * rail, rising another on hover, with a hover-revealed dismiss. "inline"
 * leads with an icon tile on one row; "banner" leads with an image. */
export interface CalloutProps<P> {
  readonly variant?: 'inline' | 'banner';
  readonly title: string;
  readonly description: string;
  readonly media: Parameters<typeof icon>[0];
  /** The inline tile's tint classes (the stacked pile's brand ladder). */
  readonly mediaClass?: string;
  readonly image?: string;
  readonly label: string;
  readonly href: string;
  readonly surfaceLevel?: number;
  /** Extra card classes (the pile drops the card's 60px floor). */
  readonly className?: string;
  readonly onDismiss?: P;
}
export function callout<P>(kit: Kit<P>, props: CalloutProps<P>): Html {
  const { h } = kit;
  const banner = props.variant === 'banner';
  const level = Math.min((props.surfaceLevel ?? 1) + 1, 8);
  const surface = `${shapeClass(kit.radius, 'rounded-xl', 'rounded-3xl')} overflow-hidden transition-[background-color,box-shadow] duration-80 bg-surface-${level} hover:bg-surface-${Math.min(level + 1, 8)} shadow-[var(--shadow-2-inset)] hover:shadow-[var(--shadow-3-inset)]`;
  const trim = banner ? '' : ' [text-box:trim-both_cap_alphabetic]';
  const card = h.div(
    [
      h.DataAttribute('slot', 'card'),
      h.DataAttribute('orientation', banner ? 'card' : 'inline'),
      h.Class(
        cn(
          banner
            ? 'group/card relative z-10 min-w-0 flex flex-col pb-3'
            : 'group/card relative z-10 min-w-0 flex flex-row items-center gap-2.5 [&:hover_[data-slot=card-header]]:pr-10 [&:focus-within_[data-slot=card-header]]:pr-10',
          surface,
          banner ? props.className : cn('min-h-0 pl-2.5', props.className),
        ),
      ),
    ],
    [
      h.a(
        [
          h.AriaLabel(props.label),
          h.Href(props.href),
          h.Class(
            'absolute inset-0 z-20 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] rounded-[inherit]',
          ),
        ],
        [],
      ),
      banner
        ? h.img([
            h.Src(props.image ?? ''),
            h.Alt(''),
            h.DataAttribute('slot', 'card-image'),
            h.Class(
              'object-cover rounded-[2px] outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 w-full aspect-[2/1] max-h-28',
            ),
          ])
        : h.span(
            [
              h.DataAttribute('slot', 'card-media'),
              h.Class(
                cn(
                  'inline-flex items-center justify-center shrink-0 size-8 ff-sidebar-callout-media',
                  shapeClass(kit.radius, 'rounded-lg', 'rounded-full'),
                  props.mediaClass ?? 'bg-hover',
                ),
              ),
            ],
            [icon(props.media, kit.icons, h)],
          ),
      h.div(
        [
          h.DataAttribute('slot', 'card-header'),
          h.Class(
            cn(
              'grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto]',
              banner ? 'px-3 gap-0 pt-3' : 'min-w-0 flex-1 gap-[2px] py-3',
            ),
          ),
        ],
        [
          h.span(
            [
              h.DataAttribute('slot', 'card-title'),
              h.Class(
                'inline-grid grid-cols-[minmax(0,1fr)] text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)] truncate',
              ),
            ],
            [
              h.span(
                [
                  h.AriaHidden(true),
                  h.Class(
                    `col-start-1 row-start-1 invisible min-w-0 overflow-x-clip text-ellipsis${trim}`,
                  ),
                  h.Style({ fontVariationSettings: semibold }),
                ],
                [props.title],
              ),
              h.span(
                [
                  h.Class(
                    `col-start-1 row-start-1 min-w-0 overflow-x-clip text-ellipsis text-foreground transition-[font-variation-settings] duration-80${trim}`,
                  ),
                  h.Style({ fontVariationSettings: "'wght' 400, 'opsz' 14" }),
                ],
                [props.title],
              ),
            ],
          ),
          h.p(
            [
              h.DataAttribute('slot', 'card-description'),
              h.Class(
                'text-muted-foreground truncate text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)]',
              ),
            ],
            [props.description],
          ),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.AriaLabel('Dismiss'),
          ...(props.onDismiss !== undefined ? [h.OnClick(props.onDismiss)] : []),
          h.Class(
            cn(
              'absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
              banner ? 'bg-card/70 backdrop-blur-sm hover:bg-card' : 'hover:bg-hover',
              'pointer-events-none opacity-0 transition-opacity duration-80 group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
              shapeClass(kit.radius, 'rounded-lg', 'rounded-full'),
              'ff-sidebar-glyph',
            ),
          ),
        ],
        [icon('x', kit.icons, h)],
      ),
    ],
  );
  return banner
    ? card
    : h.div(
        [
          h.Class('relative grid gap-0'),
          h.Style({ gridTemplateColumns: 'repeat(1, minmax(0, 1fr))' }),
          h.DataAttribute('slot', 'card-group'),
          h.DataAttribute('orientation', 'inline'),
        ],
        [card],
      );
}

/** A sonner-style pile of callouts (the queued-message stack's geometry):
 * cards peek 12px apiece behind the front one, a 5% scale step each, two
 * peeks at most; the inline pile fans out under the pointer. The runtime
 * measures the front card and lays the pile out. */
export function calloutStack<P>(
  kit: Kit<P>,
  props: {
    readonly variant: 'inline' | 'banner';
    readonly cards: readonly (CalloutProps<P> & { readonly key: string })[];
  },
): Html {
  const { h } = kit;
  return h.div(
    [
      h.Class('relative'),
      h.DataAttribute('sidebar', 'callout-stack'),
      h.DataAttribute('variant', props.variant),
      h.DataAttribute('count', String(props.cards.length)),
      h.OnMount(CalloutStackMounted()),
    ],
    props.cards.map((card, index) =>
      h.div(
        [
          h.Key(card.key),
          h.DataAttribute('callout', card.key),
          h.Class('absolute inset-x-0 bottom-0'),
          h.Style({ transformOrigin: 'bottom center', zIndex: String(100 - index) }),
        ],
        [
          callout(kit, {
            ...card,
            variant: props.variant,
            className: cn('min-h-0', card.className),
          }),
        ],
      ),
    ),
  );
}

/** An icon from the kit's set (for hand-built actions). */
export const glyph = <P>(kit: Kit<P>, name: Parameters<typeof icon>[0]) =>
  icon(name, kit.icons, kit.h);

/** The footer pile's cards (upstream's CALLOUT_STACK), each keeping its own
 * step of the brand-blue ladder when promoted. */
export const CALLOUT_STACK = [
  {
    id: 'sidebar',
    icon: 'panel-left',
    title: 'Sidebar is here',
    desc: 'New in Fluid Functionalism',
  },
  { id: 'stars', icon: 'star', title: '500 stars', desc: 'Find the hidden mosaic' },
  { id: 'motion', icon: 'play', title: 'Motion guidelines', desc: 'Three spring tiers, one page' },
] as const;
const MESH_STEPS = [1, 0.4, 0.66] as const;
const TILE_TINTS = [
  'bg-[#6B97FF]/25 [&_svg]:text-[#6B97FF]',
  'bg-[#6B97FF]/[0.08] [&_svg]:text-[#6B97FF]',
  'bg-[#6B97FF]/15 [&_svg]:text-[#6B97FF]',
] as const;
/** Scales every opacity stop in the brand mesh, so one asset yields the ladder. */
export const meshAt = (src: string, k: number) =>
  src.replace(
    /(stop-opacity='|fill-opacity=')([0-9.]+)/g,
    (_, prefix: string, value: string) => `${prefix}${Math.round(Number(value) * k * 1000) / 1000}`,
  );
/** The pile's cards, minus the dismissed ones, ready for calloutStack. */
export function stackCards<P>(
  banner: string,
  dismissed: readonly string[],
  onDismiss: (id: string) => P,
) {
  return CALLOUT_STACK.filter((card) => !dismissed.includes(card.id)).map((card) => {
    const step = CALLOUT_STACK.findIndex((entry) => entry.id === card.id);
    return {
      key: card.id,
      title: card.title,
      description: card.desc,
      media: card.icon,
      mediaClass: TILE_TINTS[step] ?? TILE_TINTS[2],
      image: meshAt(banner, MESH_STEPS[step] ?? 0.4),
      label: `${card.title} — ${card.desc}`,
      href: '/docs/sidebar',
      onDismiss: onDismiss(card.id),
    };
  });
}
