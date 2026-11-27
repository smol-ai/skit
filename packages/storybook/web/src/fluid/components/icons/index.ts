import type { Attribute, Html, HtmlBuilder } from 'foldkit/html';
import { untitled, lucide, type IconName } from './data';
import { tabler, phosphor, phosphorRegular, hugeicons } from './additional-data';
import './styles.css';
export const iconLibraries = ['Lucide', 'Tabler', 'Phosphor', 'HugeIcons', 'Untitled UI'] as const;
export const iconDefinitions: Readonly<Record<string, import('./data').Definitions>> = {
  Lucide: lucide,
  Tabler: tabler,
  Phosphor: phosphor,
  HugeIcons: hugeicons,
  'Untitled UI': untitled,
};
export type { IconName } from './data';
/** Licensed source glyphs rendered directly by Foldkit. */
export function icon<Message>(
  name: IconName,
  set: string | undefined,
  h: HtmlBuilder<Message>,
  options: {
    readonly className?: string;
    readonly attributes?: readonly Attribute<Message>[];
  } = {},
): Html {
  const definitions = iconDefinitions[set ?? 'Untitled UI'] ?? untitled;
  const filled = set === 'Phosphor';
  const factories = {
    path: h.path,
    circle: h.circle,
    rect: h.rect,
    line: h.line,
    polyline: h.polyline,
    polygon: h.polygon,
    ellipse: h.ellipse,
  };
  return h.svg(
    [
      h.Attribute('viewBox', filled ? '0 0 256 256' : '0 0 24 24'),
      h.Class([filled ? 'ff-icon-phosphor' : '', options.className ?? ''].join(' ')),
      h.Attribute('fill', 'none'),
      h.Attribute('stroke', 'currentColor'),
      h.Attribute('stroke-width', '1.5'),
      h.Attribute('stroke-linecap', 'round'),
      h.Attribute('stroke-linejoin', 'round'),
      h.AriaHidden(true),
      ...(options.attributes ?? []),
    ],
    filled
      ? [
          h.g(
            [h.Class('ff-icon-light'), h.Fill('currentColor'), h.Stroke('none')],
            definitions[name].map(([tag, attrs]) =>
              factories[tag](
                Object.entries(attrs).map(([key, value]) => h.Attribute(key, value)),
                [],
              ),
            ),
          ),
          h.g(
            [h.Class('ff-icon-regular'), h.Fill('currentColor'), h.Stroke('none')],
            phosphorRegular[name].map(([tag, attrs]) =>
              factories[tag](
                Object.entries(attrs).map(([key, value]) => h.Attribute(key, value)),
                [],
              ),
            ),
          ),
        ]
      : definitions[name].map(([tag, attrs]) =>
          factories[tag](
            Object.entries(attrs).map(([key, value]) => h.Attribute(key, value)),
            [],
          ),
        ),
  );
}
