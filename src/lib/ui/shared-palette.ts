import { sitePaletteTokens } from './site-palette-defaults';
/** Same-origin modal documents follow the host's shared palette, including future theme changes. */
export function followSitePalette(view: Window) {
  let host = view;
  try { while (host.parent !== host && host.parent.location.origin === view.location.origin) host = host.parent; } catch {}
  if (host === view) return () => {};
  const names = Object.keys(sitePaletteTokens).map(name => '--cmpri-palette-' + name);
  const root = view.document.documentElement;
  const sync = () => {
    const source = host.getComputedStyle(host.document.documentElement);
    for (const name of names) {
      const value = source.getPropertyValue(name).trim();
      if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(host.document.documentElement, { attributes: true, attributeFilter: ['style','class','data-theme','data-cmpri-site-theme'] });
  host.addEventListener('cmpri-palette-change', sync);
  return () => { observer.disconnect(); host.removeEventListener('cmpri-palette-change', sync); for (const name of names) root.style.removeProperty(name); };
}
