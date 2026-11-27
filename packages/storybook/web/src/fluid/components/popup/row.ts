import type { Html, HtmlBuilder } from 'foldkit/html';

/** Common row projection; the enclosing primitive supplies role and state. */
export function rowContent<Message>(
  props: {
    readonly label: string;
    readonly icon?: Html;
    readonly check?: boolean;
    readonly trailing?: Html;
  },
  h: HtmlBuilder<Message>,
): Html {
  return h.span(
    [h.Class('ff-popup-row-content')],
    [
      props.icon ? h.span([h.Class('ff-popup-row-icon'), h.AriaHidden(true)], [props.icon]) : null,
      h.span([h.Class('ff-popup-row-label')], [props.label]),
      props.trailing
        ? h.span([h.Class('ff-popup-row-icon'), h.AriaHidden(true)], [props.trailing])
        : null,
      props.check
        ? h.span(
            [h.Class('ff-popup-row-check'), h.AriaHidden(true)],
            [
              h.svg(
                [
                  h.Attribute('viewBox', '0 0 24 24'),
                  h.Attribute('fill', 'none'),
                  h.Attribute('stroke', 'currentColor'),
                  h.Attribute('stroke-width', '2'),
                  h.Attribute('stroke-linecap', 'round'),
                  h.Attribute('stroke-linejoin', 'round'),
                ],
                [h.path([h.Attribute('d', 'M4 12L9 17L20 6'), h.Attribute('pathLength', '1')], [])],
              ),
            ],
          )
        : null,
    ],
  );
}
