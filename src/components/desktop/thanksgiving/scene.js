/* All coordinates originate in the approved full-viewport desktop/mobile canvases. */
(() => {
  const layouts = JSON.parse(document.getElementById('theme-layouts').textContent);
  const scene = document.getElementById('scene');
  const mobile = matchMedia('(max-width: 767px)');
  let header;
  let headerResize;
  function updateHeader() {
    let next;
    try { next = window.parent.document.querySelector('.cmpri-desktop-topbar'); } catch {}
    if (next === header) return;
    headerResize?.disconnect();
    header = next;
    if (header && typeof ResizeObserver !== 'undefined') {
      headerResize = new ResizeObserver(renderLayout);
      headerResize.observe(header);
    }
    renderLayout();
  }
  function renderLayout() {
    const mode = mobile.matches ? 'mobile' : 'desktop';
    const layout = layouts[mode];
    // Scale the entire composition uniformly; header reflow never changes its origin.
    const scale = Math.min(innerWidth / layout.canvas.width, innerHeight / layout.canvas.height);
    const left = (innerWidth - layout.canvas.width * scale) / 2;
    const top = innerHeight - layout.canvas.height * scale;
    for (const [id, object] of Object.entries(layout.objects)) {
      Object.assign(document.getElementById(id).style, {
        left: left + object.x * scale + 'px', top: top + object.y * scale + 'px',
        width: object.width * scale + 'px', height: object.height * scale + 'px',
        zIndex: String(10 + object.layer),
      });
    }
    if (mode === 'desktop') {
      const object = layout.objects.greeting;
      const clearance = 20 * scale;
      const safeTop = Math.max(object.y * scale, (header?.getBoundingClientRect().bottom || 0) + clearance);
      const available = Math.max(0, innerHeight - safeTop - 12 * scale);
      const greetingScale = Math.min(scale, available / object.height);
      Object.assign(document.getElementById('greeting').style, {
        left: innerWidth - 24 * scale - object.width * greetingScale + 'px',
        top: safeTop + 'px', width: object.width * greetingScale + 'px',
        height: object.height * greetingScale + 'px', visibility: available ? 'visible' : 'hidden',
      });
    } else document.getElementById('greeting').style.removeProperty('visibility');
    for (const [id, layer] of Object.entries(layout.leaves.layers)) {
      document.getElementById(id).style.zIndex = String(10 + layer.layer);
    }
    window.cmpriLeaves.configure(layout.leaves);
    scene.dataset.layout = mode;
    scene.dataset.scale = String(scale);
  }
  mobile.addEventListener('change', renderLayout);
  addEventListener('resize', renderLayout);
  // Only the desktop greeting follows the header's clearance. The turkey,
  // pumpkins, leaf layers and full-viewport origin retain their fixed layout.
  let headerObserver;
  try {
    if (window.parent !== window) {
      headerObserver = new MutationObserver(updateHeader);
      headerObserver.observe(window.parent.document.body, { childList: true, subtree: true });
    }
  } catch {}
  updateHeader();
  addEventListener('pagehide', () => { headerResize?.disconnect(); headerObserver?.disconnect(); }, { once: true });
  renderLayout();
})();
