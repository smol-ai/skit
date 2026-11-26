import { shapeRadius } from '../shape';
import { animate, type AnimationPlaybackControls } from 'motion';
import './styles.css';

export function mountListFocus(
  root: HTMLElement,
  rows: () => readonly HTMLElement[],
  radius: () => number = () => shapeRadius(root.dataset.radius, 10, 22, 3),
): () => void {
  const ring = document.createElement('div');
  ring.className = 'ff-list-focus';
  ring.setAttribute('aria-hidden', 'true');
  ring.hidden = true;
  root.append(ring);
  let motion: AnimationPlaybackControls | undefined;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const focus = () => {
    const row = rows().find(
      (row) => row === document.activeElement && row.matches(':focus-visible'),
    );
    motion?.stop();
    if (!row) {
      motion = animate(ring, { opacity: 0 }, { duration: reduced.matches ? 0 : 0.06 });
      return;
    }
    let top = row.offsetTop,
      left = row.offsetLeft,
      ancestor = row.offsetParent;
    while (ancestor instanceof HTMLElement && ancestor !== root && root.contains(ancestor)) {
      top += ancestor.offsetTop + ancestor.clientTop;
      left += ancestor.offsetLeft + ancestor.clientLeft;
      ancestor = ancestor.offsetParent;
    }
    const geometry = {
      top: top - 2,
      left: left - 2,
      width: row.offsetWidth + 4,
      height: row.offsetHeight + 4,
    };
    ring.style.borderRadius = `${radius()}px`;
    if (ring.hidden || reduced.matches) {
      Object.assign(ring.style, {
        top: `${geometry.top}px`,
        left: `${geometry.left}px`,
        width: `${geometry.width}px`,
        height: `${geometry.height}px`,
        opacity: '1',
      });
      ring.hidden = false;
    } else
      motion = animate(
        ring,
        { ...geometry, opacity: 1 },
        { type: 'spring', duration: 0.08, bounce: 0 },
      );
  };
  const change = new MutationObserver(focus);
  change.observe(root, { attributes: true, attributeFilter: ['data-size', 'data-radius'] });
  if (root !== document.documentElement)
    change.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-radius'],
    });
  const resize = new ResizeObserver(focus);
  resize.observe(root);
  for (const row of rows()) resize.observe(row);
  root.addEventListener('focusin', focus);
  root.addEventListener('focusout', focus);
  return () => {
    motion?.stop();
    ring.remove();
    change.disconnect();
    resize.disconnect();
    root.removeEventListener('focusin', focus);
    root.removeEventListener('focusout', focus);
  };
}
