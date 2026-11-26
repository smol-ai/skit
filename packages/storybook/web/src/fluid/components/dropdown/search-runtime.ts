import { Effect, Queue, Stream } from 'effect';
import { Mount } from 'foldkit';
import { Menu } from '@foldkit/ui';
import { Message } from './search-state';
type RuntimeMessage = Exclude<Message, { readonly _tag: 'CreatedRequested' }>;

/** DOM focus/editing bridge. Query and active-row state remain in Foldkit. */
export const SearchMounted = Mount.defineStream('Dropdown.Search', {
  messages: [Message.QueryChanged, Message.SearchFocused, Message.NavigatedToRow, Message.Behavior],
  execute: ({ element }) =>
    Stream.callback<RuntimeMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (!(element instanceof HTMLInputElement)) return () => {};
          const input = element,
            root = input.closest<HTMLElement>('.ff-popup');
          if (!root) return () => {};
          const emit = (message: RuntimeMessage) => Queue.offerUnsafe(queue, message);
          let outer = 0,
            inner = 0;
          const focus = () => {
            cancelAnimationFrame(outer);
            cancelAnimationFrame(inner);
            outer = requestAnimationFrame(() => {
              inner = requestAnimationFrame(() => {
                if (input.isConnected && !root.hasAttribute('data-leave')) input.focus();
              });
            });
          };
          const rows = () => [
            ...root.querySelectorAll<HTMLElement>('.ff-popup-row:not([aria-disabled="true"])'),
          ];
          const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') return;
            if (event.key === 'Tab') {
              event.preventDefault();
              event.stopImmediatePropagation();
              const trigger = document.getElementById(root.getAttribute('aria-labelledby') ?? '');
              const stops = [
                ...document.querySelectorAll<HTMLElement>(
                  'button,a[href],input,select,textarea,[tabindex]',
                ),
              ].filter(
                (node) =>
                  node.tabIndex >= 0 &&
                  !node.matches(':disabled,[aria-disabled="true"]') &&
                  !node.closest('[inert]') &&
                  !root.contains(node) &&
                  node.getClientRects().length > 0,
              );
              const index = trigger ? stops.indexOf(trigger) : -1;
              emit(Message.Behavior({ message: Menu.Message.BlurredItems() }));
              (event.shiftKey ? trigger : stops[index + 1])?.focus();
              return;
            }
            const items = rows();
            const fromInput = event.target === input;
            const active = items.findIndex((row) => row.hasAttribute('data-active'));
            if (fromInput) {
              event.stopImmediatePropagation();
              if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const row = event.key === 'ArrowDown' ? items[0] : items.at(-1);
                if (row) emit(Message.NavigatedToRow({ index: Number(row.dataset.dropdownIndex) }));
              } else if (event.key === 'Enter') event.preventDefault();
            } else if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
              return;
            } else if (
              (event.key === 'ArrowUp' && active === 0) ||
              (event.key === 'ArrowDown' && active === items.length - 1)
            ) {
              event.preventDefault();
              event.stopImmediatePropagation();
              root.querySelector('.ff-popup-viewport')?.scrollTo({ top: 0 });
              input.focus();
            } else if ((event.key.length === 1 && event.key !== ' ') || event.key === 'Backspace') {
              event.preventDefault();
              event.stopImmediatePropagation();
              const value =
                event.key === 'Backspace' ? input.value.slice(0, -1) : input.value + event.key;
              input.focus();
              emit(Message.QueryChanged({ value }));
            }
          };
          const focused = () => emit(Message.SearchFocused());
          const blur = (event: FocusEvent) => {
            if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget))
              event.stopImmediatePropagation();
            else if (event.target === input)
              emit(Message.Behavior({ message: Menu.Message.BlurredItems() }));
          };
          root.addEventListener('keydown', key, true);
          root.addEventListener('blur', blur, true);
          input.addEventListener('focus', focused);
          const observer = new MutationObserver(() => {
            if (root.hasAttribute('data-enter')) focus();
          });
          observer.observe(root, { attributes: true, attributeFilter: ['data-enter'] });
          focus();
          return () => {
            cancelAnimationFrame(outer);
            cancelAnimationFrame(inner);
            observer.disconnect();
            root.removeEventListener('keydown', key, true);
            root.removeEventListener('blur', blur, true);
            input.removeEventListener('focus', focused);
          };
        }),
        (dispose) => Effect.sync(dispose),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});
