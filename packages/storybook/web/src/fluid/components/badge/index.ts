import type { Attribute, Html, HtmlBuilder } from 'foldkit/html';
import './styles.css';

/** The reference's fixed hue palette; accent follows the application token. */
export const colors = {
  accent: 'var(--fluid-accent, #6B97FF)',
  gray: '#a3a3a3',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
} as const;
export type Color = keyof typeof colors;
export type Tone = 'success' | 'warning' | 'destructive' | 'info';
const tones: Readonly<Record<Tone, string>> = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  destructive: 'var(--destructive)',
  info: 'var(--info)',
};
export type Size = 'default' | 'compact' | 'sm' | 'md' | 'lg';
export interface Props<Message> {
  readonly children: readonly (Html | string)[];
  readonly color?: Color;
  /** Semantic tone takes precedence over the fixed hue palette. */
  readonly tone?: Tone;
  readonly variant?: 'solid' | 'dot';
  readonly size?: Size;
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly className?: string;
  readonly attributes?: readonly Attribute<Message>[];
}
export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  const color = props.tone ?? props.color ?? 'gray',
    variant = props.variant ?? 'solid';
  const size = props.size === 'sm' || props.size === 'compact' ? 'compact' : 'default';
  return h.span(
    [
      h.Class(`ff-badge ${props.className ?? ''}`),
      h.DataAttribute('size', size),
      h.DataAttribute('radius', props.radius ?? 'rounded'),
      h.DataAttribute('variant', variant),
      h.DataAttribute('color', color),
      h.Style({ '--badge-color': props.tone === undefined ? colors[props.color ?? 'gray'] : tones[props.tone] }),
      ...(props.attributes ?? []),
    ],
    [
      variant === 'dot' ? h.span([h.Class('ff-badge-dot'), h.AriaHidden(true)], []) : null,
      h.span([h.Class('ff-badge-label')], props.children),
    ],
  );
}
