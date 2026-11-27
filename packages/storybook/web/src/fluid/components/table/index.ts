import type { Attribute, Html, HtmlBuilder } from 'foldkit/html';
import { Mounted } from './runtime';
import '../../fluid-hover/styles.css';
import './styles.css';
export interface Children<Message> {
  readonly children: readonly (Html | string)[];
  readonly className?: string;
  readonly attributes?: readonly Attribute<Message>[];
}
export interface Props<Message> extends Children<Message> {
  /** Upstream follows the surrounding SizeProvider; Foldkit has no context, so
   * pass the docs or app size preference here (default 36px, compact 28px). */
  readonly size?: 'default' | 'compact';
  /** `false` suspends the row highlight (an inspector overlay, say) and
   * releases any lit row. Defaults to true. */
  readonly hover?: boolean;
  readonly wrapperAttributes?: readonly Attribute<Message>[];
}
/** The positioned wrapper owns the shared hover layer; the HTML table keeps
 * its native semantics and all consumer attributes. Size cascades to cells. */
export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>): Html {
  return h.div(
    [
      h.Class('ff-table'),
      h.DataAttribute('size', props.size ?? 'default'),
      h.DataAttribute('hover', props.hover === false ? 'off' : 'on'),
      h.OnMount(Mounted()),
      ...(props.wrapperAttributes ?? []),
    ],
    [
      h.table(
        [h.Class(`ff-table-element ${props.className ?? ''}`), ...(props.attributes ?? [])],
        props.children,
      ),
    ],
  );
}
export function header<Message>(props: Children<Message>, h: HtmlBuilder<Message>): Html {
  return h.thead([h.Class(props.className ?? ''), ...(props.attributes ?? [])], props.children);
}
export function body<Message>(props: Children<Message>, h: HtmlBuilder<Message>): Html {
  return h.tbody([h.Class(props.className ?? ''), ...(props.attributes ?? [])], props.children);
}
export interface RowProps<Message> extends Children<Message> {
  /** Omit on header rows. Indexed rows participate in pointer hover. */
  readonly index?: number;
}
export function row<Message>(props: RowProps<Message>, h: HtmlBuilder<Message>): Html {
  return h.tr(
    [
      h.Class(`ff-table-row ${props.className ?? ''}`),
      ...(props.index === undefined
        ? []
        : [h.DataAttribute('fluid-hover-index', String(props.index))]),
      ...(props.attributes ?? []),
    ],
    props.children,
  );
}
export function head<Message>(props: Children<Message>, h: HtmlBuilder<Message>): Html {
  return h.th(
    [h.Class(`ff-table-head ${props.className ?? ''}`), ...(props.attributes ?? [])],
    props.children,
  );
}
export function cell<Message>(props: Children<Message>, h: HtmlBuilder<Message>): Html {
  return h.td(
    [h.Class(`ff-table-cell ${props.className ?? ''}`), ...(props.attributes ?? [])],
    props.children,
  );
}
export interface EmptyProps<Message> {
  /** How many columns the message spans: the table's column count. */
  readonly columns: number;
  /** One short line saying what belongs here. */
  readonly title?: Html | string;
  /** One line on how rows get here. */
  readonly description?: Html | string;
  /** The control that creates the first row, e.g. a Button. */
  readonly action?: Html;
  /** The height to hold, in body rows, so filling the table doesn't shift
   * what sits under it. Defaults to 3. */
  readonly rows?: number;
  readonly children?: readonly (Html | string)[];
  readonly className?: string;
  readonly attributes?: readonly Attribute<Message>[];
}
/** Rendered in place of the body rows when there are none. It has no `index`,
 * so it never joins the hover; its height follows the cell padding. */
export function empty<Message>(props: EmptyProps<Message>, h: HtmlBuilder<Message>): Html {
  return h.tr(
    [
      h.DataAttribute('slot', 'table-empty'),
      ...(props.className ? [h.Class(props.className)] : []),
      ...(props.attributes ?? []),
    ],
    [
      h.td(
        [h.Class('ff-table-empty-cell'), h.Attribute('colspan', String(props.columns))],
        [
          h.div(
            [h.Class('ff-table-empty'), h.Style({ '--table-empty-rows': String(props.rows ?? 3) })],
            [
              props.title === undefined
                ? null
                : h.span([h.Class('ff-table-empty-title')], [props.title]),
              props.description === undefined
                ? null
                : h.span([h.Class('ff-table-empty-description')], [props.description]),
              ...(props.children ?? []),
              props.action === undefined
                ? null
                : h.div([h.Class('ff-table-empty-action')], [props.action]),
            ],
          ),
        ],
      ),
    ],
  );
}
