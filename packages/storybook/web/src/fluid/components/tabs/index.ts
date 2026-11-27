import { Tabs as Primitive } from '@foldkit/ui';
import { Submodel } from 'foldkit';
import type { Html } from 'foldkit/html';
import * as Count from '../count';
import { Mounted } from './runtime';
import './styles.css';

const behavior = Primitive.create();
export const Model = Primitive.Model;
export type Model = Primitive.Model;
export const Message = Primitive.Message;
export type Message = Primitive.Message;
export type OutMessage = Primitive.OutMessage;
export const init = (config: { readonly id: string }): Model =>
  Primitive.init({ ...config, activationMode: 'Manual' });
export const update = behavior.update;
export interface Item {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
  readonly icon?: Html;
  readonly content?: Html | string;
  readonly disabled?: boolean;
}
export interface Props {
  readonly items: readonly Item[];
  readonly value: string;
  readonly label: string;
  readonly activeLabel?: boolean;
  readonly size?: 'default' | 'compact';
  readonly radius?: 'rounded' | 'pill' | 'sharp';
  readonly className?: string;
  /** Renders the active panel. Use it when panel content carries Mounts or
   * parent messages: Foldkit allows functions only at the top level of
   * viewInputs, where they are scoped to the parent boundary. It takes
   * precedence over an item's static `content`. */
  readonly panel?: (value: string, index: number) => Html;
}
export const view = Submodel.defineView<Model, Message, Props>((model, props, h) =>
  h.submodel({
    slotId: 'behavior',
    model,
    view: behavior.view,
    toParentMessage: (message) => message,
    viewInputs: {
      tabs: props.items.map((item) => item.value),
      selectedValue: props.value,
      ariaLabel: props.label,
      panelMount: 'All',
      isTabDisabled: (_, index) => !!props.items[index]?.disabled,
      toView: ({ tablist, tabs }) =>
        h.div(
          [h.Class(`ff-tabs ${props.className ?? ''}`)],
          [
            h.div(
              [
                ...tablist,
                h.Class('ff-tabs-list'),
                h.DataAttribute('size', props.size ?? 'default'),
                h.DataAttribute('radius', props.radius ?? 'rounded'),
                h.OnMount(Mounted()),
              ],
              tabs.map((tab) => {
                const item = props.items[tab.index];
                if (!item) return null;
                const collapse = !!props.activeLabel && !!item.icon;
                return h.button(
                  [
                    ...tab.tab,
                    h.Class('ff-tab'),
                    h.DataAttribute('collapse-label', String(collapse)),
                    ...(collapse ? [h.AriaLabel(item.count === undefined ? item.label : `${item.label} ${item.count}`)] : []),
                  ],
                  [
                    item.icon
                      ? h.span([h.Class('ff-tab-icon'), h.AriaHidden(true)], [item.icon])
                      : null,
                    h.span(
                      [h.Class('ff-tab-label-count')],
                      [
                        h.span(
                          [
                            h.Class('ff-tab-label-clip'),
                            ...(collapse && !tab.isActive ? [h.AriaHidden(true)] : []),
                          ],
                          [
                            h.span(
                              [h.Class('ff-tab-label')],
                              [
                                h.span(
                                  [h.Class('ff-tab-label-sizer'), h.AriaHidden(true)],
                                  [item.label],
                                ),
                                h.span([h.Class('ff-tab-label-text')], [item.label]),
                              ],
                            ),
                          ],
                        ),
                        item.count === undefined ? null : Count.view({ value: item.count, size: props.size, active: tab.isActive, className: 'h-auto min-w-0 px-0' }, h),
                      ],
                    ),
                  ],
                );
              }),
            ),
            ...tabs.map((tab) =>
              h.div(
                [
                  ...tab.panel,
                  h.Class('ff-tabs-panel'),
                  h.Tabindex(-1),
                  h.Hidden(
                    !tab.isActive ||
                      (props.panel === undefined && props.items[tab.index]?.content === undefined),
                  ),
                ],
                tab.isActive
                  ? [
                      props.panel
                        ? props.panel(tab.value, tab.index)
                        : (props.items[tab.index]?.content ?? null),
                    ]
                  : [],
              ),
            ),
          ],
        ),
    },
  }),
);
