import { Submodel } from 'foldkit';
import { childAttributes } from 'foldkit/html';
import * as Dropdown from './index';
import * as Searchable from './searchable';
import { Model, Message, itemsAt, menuId, pathKey, type Item } from './tree-state';
import { icon } from '../icons';
import { TreeMounted } from './tree-runtime';
export {
  Model,
  Message,
  OutMessage,
  init,
  update,
  type Item,
  type UpdateOptions,
} from './tree-state';
export interface Props extends Omit<
  Dropdown.Props,
  'items' | 'itemToAttributes' | 'popupAttributes'
> {
  readonly items: readonly Item[];
  readonly direction?: 'ltr' | 'rtl';
  readonly selectionForPath?: (path: readonly number[]) => Dropdown.Panel.Selection;
  readonly search?: boolean;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  readonly searchIcon?: Searchable.Props['searchIcon'];
  readonly creatable?: boolean;
  readonly createIcon?: Searchable.Props['createIcon'];
  readonly createLabel?: Searchable.Props['createLabel'];
}
export const view = Submodel.defineView<Model, Message, Props>((model, props, h) => {
  const visibleItems = props.search ? Searchable.matches(props.items, model.query) : props.items;
  const renderedIndex = (path: readonly number[], index: number) =>
    path.length
      ? index
      : visibleItems.findIndex((item) => item.value === props.items[index]?.value);
  const paths = Object.keys(model.menus)
    .map((key) => (key ? key.split('.').map(Number) : []))
    .sort((a, b) => a.length - b.length);
  return h.div(
    [
      h.Class('ff-dropdown-tree'),
      h.DataAttribute('tree-id', model.id),
      h.OnMount(TreeMounted({ id: model.id })),
    ],
    paths.map((path) => {
      const parentPath = path.slice(0, -1),
        parentIndex = path.at(-1),
        children = path.length ? itemsAt(props.items, path) : visibleItems;
      const parent =
        parentIndex === undefined ? undefined : itemsAt(props.items, parentPath)[parentIndex];
      const isAncestor = path.every((value, index) => value === model.openPath[index]);
      const viewInputs: Dropdown.Props = {
        ...props,
        selection: props.selectionForPath?.(path) ?? props.selection,
        items: children.map((item) => ({
          ...item,
          action: item.children?.length ? true : item.action,
          trailing: item.children?.length
            ? icon('chevron-right', props.icons, h, {
                attributes: [
                  h.Style({ transform: props.direction === 'rtl' ? 'scaleX(-1)' : 'none' }),
                ],
              })
            : item.trailing,
        })),
        label: parent?.label ?? props.label,
        anchorTriggerId:
          parentIndex === undefined
            ? undefined
            : `${menuId(model.id, parentPath)}-item-${renderedIndex(parentPath, parentIndex)}`,
        hideTrigger: path.length > 0,
        submenu: path.length > 0,
        surfaceLevel: Math.min((props.surfaceLevel ?? 3) + path.length * 2, 8),
        anchorOffset: path.length ? -4 : 0,
        placement: path.length
          ? props.direction === 'rtl'
            ? 'left-start'
            : 'right-start'
          : props.placement,
        heldIndex:
          isAncestor && model.openPath[path.length] !== undefined
            ? renderedIndex(path, model.openPath[path.length]!)
            : undefined,
        popupAttributes: childAttributes([
          h.DataAttribute('menu-tree', model.id),
          h.DataAttribute('menu-path', pathKey(path)),
          h.DataAttribute('direction', props.direction ?? 'ltr'),
          h.DataAttribute('menu-parent', pathKey(parentPath)),
          h.DataAttribute(
            'menu-parent-index',
            parentIndex === undefined ? '' : String(renderedIndex(parentPath, parentIndex)),
          ),
        ]),
        itemToAttributes: (value, index) =>
          children[index]?.children?.length
            ? childAttributes([
                h.DataAttribute('submenu-trigger', ''),
                h.Attribute('aria-haspopup', 'menu'),
                h.Attribute(
                  'aria-expanded',
                  String(
                    isAncestor &&
                      model.openPath[path.length] !== undefined &&
                      renderedIndex(path, model.openPath[path.length]!) === index,
                  ),
                ),
                h.AriaControls(
                  `${menuId(model.id, [...path, path.length ? index : props.items.findIndex((item) => item.value === children[index]?.value)])}-items`,
                ),
              ])
            : [],
      };
      if (!path.length && props.search)
        return h.submodel({
          slotId: 'search-root',
          model: { menu: model.menus['']!, query: model.query },
          view: Searchable.view,
          toParentMessage: (message) => Message.Search({ message }),
          viewInputs: {
            ...viewInputs,
            // Searchable owns root filtering; child levels use the visible path indices.
            items: props.items.map((item) => ({
              ...item,
              action: item.children?.length ? true : item.action,
              trailing: item.children?.length
                ? viewInputs.items.find((child) => child.value === item.value)?.trailing
                : item.trailing,
            })),
            placeholder: props.placeholder,
            emptyLabel: props.emptyLabel,
            searchIcon: props.searchIcon,
            creatable: props.creatable,
            createIcon: props.createIcon,
            createLabel: props.createLabel,
          },
        });
      return h.submodel({
        slotId: `level-${pathKey(path)}`,
        model: model.menus[pathKey(path)]!,
        view: Dropdown.view,
        toParentMessage: (message) => Message.Behavior({ path, message }),
        viewInputs,
      });
    }),
  );
});
