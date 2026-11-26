import { Effect, Schema } from 'effect';
import { Mount } from 'foldkit';
/** Let the native number implementation own step alignment and decimal
 * precision; dispatch the same input event as typing so controlled users update. */
export function stepInput(input: HTMLInputElement, direction: 1 | -1): void {
  if (input.disabled || input.readOnly) return;
  if (input.step === 'any') {
    const min = input.min === '' ? -Infinity : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    input.value = String(Math.min(max, Math.max(min, (Number(input.value) || 0) + direction)));
  } else if (direction === 1) input.stepUp();
  else input.stepDown();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
export const Mounted = Mount.define('Input.NativeEnhancements', {
  messages: [Schema.Never],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) return () => {};
        const input = element.querySelector('input');
        if (!input) return () => {};
        const button = (event: Event) =>
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-input-step]')
            : null;
        const onDown = (event: MouseEvent) => {
          if (button(event)) event.preventDefault();
        };
        const onClick = (event: MouseEvent) => {
          const target = button(event);
          if (target) stepInput(input, target.dataset.inputStep === '1' ? 1 : -1);
        };
        const onFile = () => {
          element.dataset.hasFile = String(!!input.files?.length);
        };
        element.addEventListener('mousedown', onDown);
        element.addEventListener('click', onClick);
        input.addEventListener('change', onFile);
        return () => {
          element.removeEventListener('mousedown', onDown);
          element.removeEventListener('click', onClick);
          input.removeEventListener('change', onFile);
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.andThen(Effect.never)),
});
