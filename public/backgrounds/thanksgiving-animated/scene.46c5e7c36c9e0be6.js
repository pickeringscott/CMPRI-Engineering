/* All coordinates originate in the approved full-viewport desktop/mobile canvases. */
(() => {
  const layouts = JSON.parse(document.getElementById('theme-layouts').textContent);
  const scene = document.getElementById('scene');
  const mobile = matchMedia('(max-width: 767px)');
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
    for (const [id, layer] of Object.entries(layout.leaves.layers)) {
      document.getElementById(id).style.zIndex = String(10 + layer.layer);
    }
    window.cmpriLeaves.configure(layout.leaves);
    scene.dataset.layout = mode;
    scene.dataset.scale = String(scale);
  }
  mobile.addEventListener('change', renderLayout);
  addEventListener('resize', renderLayout);
  renderLayout();
})();
