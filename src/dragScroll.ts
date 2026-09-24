import { useEffect, type RefObject } from 'react';

/**
 * Horizontal drag-to-scroll. Capture only AFTER movement threshold so clicks still work.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>, axis: 'x' | 'y' = 'x') {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let ptr = -1;
    let start = 0;
    let origin = 0;
    let moved = false;
    let suppress = false;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      ptr = e.pointerId;
      start = axis === 'x' ? e.clientX : e.clientY;
      origin = axis === 'x' ? el.scrollLeft : el.scrollTop;
      moved = false;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== ptr) return;
      const cur = axis === 'x' ? e.clientX : e.clientY;
      const delta = cur - start;
      if (!moved && Math.abs(delta) > 10) {
        moved = true;
        el.classList.add('dragging');
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (!moved) return;
      e.preventDefault();
      if (axis === 'x') el.scrollLeft = origin - delta;
      else el.scrollTop = origin - delta;
    };

    const end = (e: PointerEvent) => {
      if (e.pointerId !== ptr) return;
      if (moved) {
        suppress = true;
        el.classList.remove('dragging');
        try {
          if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      ptr = -1;
      moved = false;
    };

    const onClick = (e: MouseEvent) => {
      if (!suppress) return;
      e.preventDefault();
      e.stopPropagation();
      suppress = false;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', onClick, true);

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('click', onClick, true);
      el.classList.remove('dragging');
    };
  }, [ref, axis]);
}
