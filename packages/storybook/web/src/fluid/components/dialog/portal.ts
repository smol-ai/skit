import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';

/** Closed dialogs retain their native node. Keep those shells out of the
 * anchor host, which a later popup must create after it isolates siblings. */
export const DialogPortal = Mount.define('Dialog.Portal', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const dialog = element.closest('dialog');
        const root = element.getRootNode();
        const parent = dialog ?? (root instanceof ShadowRoot ? root : element.ownerDocument.body);
        let host = [...parent.children].find((child) =>
          child.hasAttribute('data-ff-dialog-portal-root'),
        );
        if (!host) {
          host = element.ownerDocument.createElement('div');
          host.setAttribute('data-ff-dialog-portal-root', '');
          if (dialog) parent.append(host);
          else parent.prepend(host);
        }
        const owner = host;
        owner.append(element);
        return () => {
          element.remove();
          if (!owner.hasChildNodes()) owner.remove();
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});
