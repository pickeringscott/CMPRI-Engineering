/** CSS-hidden iframe documents remain document.visible. Inspect their host layers too. */
export function resourceViewVisible(view: Window): boolean {
  try {
    let current = view;
    for (;;) {
      if (current.document.hidden) return false;
      const frame = current.frameElement;
      if (!frame) return true;
      for (let element: Element | null = frame; element; element = element.parentElement) {
        if (element.hasAttribute('hidden') || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') return false;
        const style = current.parent.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      current = current.parent;
    }
  } catch { return !view.document.hidden; }
}

export function watchResourceVisibility(view: Window, reveal: () => void) {
  let visible = resourceViewVisible(view);
  const check = () => { const next = resourceViewVisible(view); if (next && !visible) reveal(); visible = next; };
  const cleanups: (() => void)[] = [];
  try {
    let current = view;
    for (;;) {
      const doc = current.document;
      doc.addEventListener('visibilitychange', check);
      cleanups.push(() => doc.removeEventListener('visibilitychange', check));
      const frame = current.frameElement;
      if (!frame) break;
      const observer = new MutationObserver(check);
      for (let element: Element | null = frame; element; element = element.parentElement) {
        observer.observe(element, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class'] });
      }
      cleanups.push(() => observer.disconnect());
      current = current.parent;
    }
  } catch { /* Cross-origin host cannot be inspected. */ }
  return () => cleanups.forEach(stop => stop());
}
