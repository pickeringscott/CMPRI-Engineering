(function () {
  'use strict';

  let nextInstance = 0;
  const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const paperclip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8L15.2 5.6"/></svg>';
  const cameraIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const MAX_ATTACHMENTS = 20;
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  const pendingCounts = new Map();
  function safeMediaURL(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      return !url.username && !url.password && ['https:', 'blob:'].includes(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }
  function isImage(type) { return /^image\/(jpeg|png|gif|webp|avif)$/.test(type); }
  function photoPreview(attachment) {
    return attachment?.kind === 'file' && isImage(attachment.type) ? safeMediaURL(attachment.url) : '';
  }
  function inlineMedia(attachment) {
    const video = attachment?.kind === 'file' && /^video\/(mp4|webm|quicktime)$/.test(attachment.type);
    return { video, url: video ? safeMediaURL(attachment.url) : photoPreview(attachment) };
  }
  function validGif(value) {
    if (!value || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.id || '')) return false;
    return [value.preview, value.original].every(image => {
      const url = safeMediaURL(image?.url);
      return url && new URL(url).hostname.endsWith('.giphy.com');
    });
  }

  function html() {
    return '<button type="button" class="notepad-media-trigger" data-notepad-gif-trigger aria-label="Choose a GIF" title="GIF" aria-haspopup="dialog">GIF</button>' +
      '<button type="button" class="notepad-media-trigger" data-notepad-camera-trigger aria-label="Take a photo" title="Camera" aria-haspopup="dialog">' + cameraIcon + '</button>' +
      '<button type="button" class="notepad-media-trigger" data-notepad-attachments-trigger aria-label="Add attachment" title="Attach files">' + paperclip + '</button>';
  }

  function attach(options) {
    const { container, pickerRoot, getNote, getNoteById, onChange, badge, request, onError, isNoteAvailable, getInlinePlacement } = options || {};
    const filesTrigger = container?.querySelector('[data-notepad-attachments-trigger]');
    const gifTrigger = container?.querySelector('[data-notepad-gif-trigger]');
    const cameraTrigger = container?.querySelector('[data-notepad-camera-trigger]');
    if (!filesTrigger || !gifTrigger || !cameraTrigger || typeof getNote !== 'function') return { destroy() {}, close() { return Promise.resolve(); }, openAttachment() { return Promise.resolve(); }, uploading() { return false; }, isInteracting() { return false; } };

    const instance = ++nextInstance;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mobilePicker = window.matchMedia('(max-width: 650px)');
    const animations = new Map();
    let destroyed = false;
    let gif = null;
    let camera = null;
    let pendingFiles = null;
    let viewer = null;
    let viewerVersion = 0;
    let uploads = 0;
    const gifCache = new Map();
    const statusNode = document.createElement('p');
    statusNode.className = 'attachment-status';
    statusNode.setAttribute('role', 'status');
    statusNode.style.cssText = 'margin:1px 2px;font:11px/1.3 Arial,sans-serif;color:var(--cmpri-modal-muted);overflow-wrap:anywhere';
    statusNode.hidden = true;
    container.after(statusNode);
    function status(message, error = false) {
      if (!destroyed) { statusNode.textContent = message; statusNode.hidden = !message; }
      if (error) onError?.(message);
    }
    async function send(action, payload) {
      if (typeof request !== 'function') throw Error('Attachments are unavailable. Reopen Notepad to reconnect.');
      return request(action, payload);
    }
    function available(note) {
      if (typeof isNoteAvailable === 'function') return isNoteAvailable(note.id);
      return !destroyed && sameNote(note);
    }
    function resolveOrigin(note) {
      if (!available(note)) return null;
      // A save acknowledgement can replace the note object while a real upload
      // is in flight. Resolve its current record without changing its owner.
      if (typeof getNoteById === 'function') {
        const current = getNoteById(note.id);
        return current?.id === note.id ? current : null;
      }
      return note;
    }
    function attachmentCount(note) { return (note.attachments?.length || 0) + (pendingCounts.get(note.id) || 0); }
    function rememberGifs(rows) {
      for (const row of rows) {
        gifCache.set(row.id, row);
        if (gifCache.size > 200) gifCache.delete(gifCache.keys().next().value);
      }
    }

    async function gifPreviews(ids) {
      const values = [...new Set(ids)].filter(id => /^[a-zA-Z0-9_-]{1,200}$/.test(id || ''));
      const missing = values.filter(id => !gifCache.has(id));
      if (missing.length && !destroyed) {
        try {
          const result = await send('giphy', { ids: missing });
          if (!destroyed) rememberGifs(Array.isArray(result?.gifs) ? result.gifs.filter(validGif) : []);
        } catch { /* Keep the fallback thumbnail if the preview is unavailable. */ }
      }
      return new Map(values.flatMap(id => gifCache.has(id) ? [[id, gifCache.get(id).preview.url]] : []));
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.setAttribute('aria-label', 'Choose attachments');
    fileInput.dataset.notepadAttachmentInput = String(instance);
    const cameraInput = document.createElement('input');
    cameraInput.type = 'file';
    cameraInput.accept = 'image/*';
    cameraInput.setAttribute('capture', 'environment');
    cameraInput.setAttribute('aria-label', 'Capture a photo with the device camera');
    cameraInput.hidden = true;
    cameraInput.dataset.notepadCameraInput = String(instance);
    document.body.append(fileInput, cameraInput);

    function currentNote() {
      try { return getNote() || null; } catch (_) { return null; }
    }
    function sameNote(note) {
      const current = currentNote();
      return !!current && !!note && (note.id == null ? current === note : current.id === note.id);
    }
    function focus(element) {
      if (!destroyed && element?.isConnected) element.focus({ preventScroll: true });
    }
    function uid() {
      if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
      const bytes = window.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    function changed(payload) {
      onChange?.(payload);
    }
    function stopAnimation(node) {
      const animation = animations.get(node);
      if (animation) { animations.delete(node); animation.cancel(); }
    }
    function animate(node, opening) {
      const computed = getComputedStyle(node);
      const from = { transform: computed.transform === 'none' ? 'scale(1)' : computed.transform, opacity: computed.opacity };
      stopAnimation(node);
      const to = { transform: opening ? 'scale(1)' : 'scale(.035)', opacity: opening ? '1' : '0' };
      if (reducedMotion.matches || typeof node.animate !== 'function') {
        node.style.transform = 'none';
        node.style.opacity = to.opacity;
        return Promise.resolve();
      }
      node.style.transform = from.transform;
      node.style.opacity = from.opacity;
      const animation = node.animate([from, to], {
        duration: opening ? 210 : 170,
        easing: opening ? 'cubic-bezier(.18,.8,.22,1)' : 'cubic-bezier(.5,0,.8,.45)',
        fill: 'both'
      });
      animations.set(node, animation);
      return animation.finished.catch(() => {}).then(() => {
        if (animations.get(node) === animation) {
          node.style.transform = to.transform;
          node.style.opacity = to.opacity;
          animations.delete(node);
          animation.cancel();
        }
      });
    }
    function renderGifResults(session) {
      session.node.querySelector('.staff-gif-results').innerHTML = session.gifs.length
        ? session.gifs.map(item => '<button type="button" data-attachment-gif="' + escapeHTML(item.id) + '" aria-label="Select ' + escapeHTML(item.title) + '"><img src="' + escapeHTML(item.preview.url) + '" alt="' + escapeHTML(item.title) + '" width="' + (Number(item.preview.width) || 200) + '" height="' + (Number(item.preview.height) || 150) + '" loading="lazy"></button>').join('')
        : '';
    }
    async function loadGifs(session, append = false) {
      if (destroyed || gif !== session || session.closing || session.loading) return;
      const version = ++session.version;
      session.loading = true;
      const label = session.node.querySelector('.giphy-status');
      label.textContent = session.query ? 'Searching…' : 'Loading Trending…';
      try {
        const result = await send('giphy', { query: session.query, offset: append ? session.offset : 0 });
        if (destroyed || gif !== session || session.closing || version !== session.version) return;
        const rows = Array.isArray(result?.gifs) ? result.gifs.filter(validGif) : [];
        rememberGifs(rows);
        session.gifs = append ? [...new Map([...session.gifs, ...rows].map(item => [item.id, item])).values()] : rows;
        session.offset = (append ? session.offset : 0) + rows.length;
        session.total = rows.length ? Math.max(session.offset, Number(result?.total) || session.offset) : session.offset;
        renderGifResults(session);
        label.textContent = session.gifs.length ? (session.query ? 'Search results' : 'Trending') : 'No GIFs found';
      } catch (error) {
        if (!destroyed && gif === session && !session.closing && version === session.version) label.textContent = error?.message || 'GIFs could not be loaded. Try again.';
      } finally {
        if (version === session.version) session.loading = false;
      }
    }
    function searchGifs(session, query) {
      clearTimeout(session.timer);
      session.query = query.slice(0, 50);
      session.version++;
      session.loading = false;
      session.gifs = [];
      session.offset = 0;
      session.total = 0;
      renderGifResults(session);
      session.node.querySelector('.giphy-status').textContent = session.query ? 'Searching…' : 'Loading Trending…';
      // Debounce only a user edit. No polling or background provider requests.
      session.timer = setTimeout(() => { session.timer = null; void loadGifs(session); }, session.query ? 300 : 0);
    }
    function positionGifOrigin(session) {
      const { node, anchor, origin } = session;
      const dockWidth = container.getBoundingClientRect().width;
      if (dockWidth > 0) node.style.setProperty('--notepad-gif-dock-width', dockWidth + 'px');
      const rect = anchor.isConnected ? anchor.getBoundingClientRect() : origin;
      const parent = node.offsetParent;
      if (!parent) return;
      const panel = parent.getBoundingClientRect();
      const left = panel.left + parent.clientLeft + node.offsetLeft;
      const top = panel.top + parent.clientTop + node.offsetTop;
      node.style.transformOrigin = (rect.left + rect.width / 2 - left) + 'px ' + (rect.top + rect.height / 2 - top) + 'px';
    }
    function openGif(anchor, note) {
      if (gif || destroyed || !pickerRoot?.isConnected || !anchor.isConnected || !sameNote(note)) return;
      const node = document.createElement('dialog');
      node.className = 'staff-giphy-picker attachment-giphy-dialog note-giphy-picker';
      node.setAttribute('aria-label', 'GIPHY picker');
      const badgeURL = typeof badge === 'string' && (/^data:image\//i.test(badge) || badge === '/Poweredby_100px_Badge.gif') ? badge : '';
      const credit = '<a class="staff-giphy-credit" href="https://giphy.com/" target="_blank" rel="noopener noreferrer" aria-label="Powered by GIPHY">' + (badgeURL ? '<img src="' + escapeHTML(badgeURL) + '" alt="Powered by GIPHY" width="40" height="57">' : '<span>GIPHY</span>') + '</a>';
      node.innerHTML = '<div class="staff-gif-search"><input aria-label="Search GIPHY" type="search" placeholder="Search GIPHY" maxlength="50" autocomplete="off"><button type="button" data-attachment-close-gif aria-label="Close GIF picker">×</button></div><p class="giphy-status" role="status"></p><div class="staff-gif-grid"><div class="staff-gif-results"></div></div>' + credit;
      const grid = node.querySelector('.staff-gif-grid');
      gif = { node, anchor, origin: anchor.getBoundingClientRect(), note, placement: getInlinePlacement?.(note), closing: false, closePromise: null, selecting: false, query: '', gifs: [], offset: 0, total: 0, loading: false, version: 0, timer: null, resize: null };
      const session = gif;
      pickerRoot.append(node);
      node.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); closeGif(); });
      node.addEventListener('click', event => {
        const closeButton = event.target.closest('[data-attachment-close-gif]');
        const result = event.target.closest('[data-attachment-gif]');
        if (closeButton) { event.stopPropagation(); closeGif(); }
        else if (result) { event.stopPropagation(); selectGif(session, result.dataset.attachmentGif); }
      });
      node.querySelector('input').addEventListener('input', event => searchGifs(session, event.target.value));
      grid.addEventListener('scroll', () => {
        if (!session.loading && session.offset < session.total && grid.scrollHeight - grid.scrollTop - grid.clientHeight < 100) void loadGifs(session, true);
      });
      node.open = true;
      positionGifOrigin(session);
      if (typeof ResizeObserver === 'function') {
        session.resize = new ResizeObserver(() => {
          if (gif === session && !session.closing) positionGifOrigin(session);
        });
        session.resize.observe(container);
        session.resize.observe(pickerRoot);
      }
      node.style.transform = 'scale(.035)';
      node.style.opacity = '0';
      focus(node.querySelector('input'));
      animate(node, true);
      void loadGifs(session);
    }
    function closeGif({ restoreFocus = true, immediate = false } = {}) {
      const session = gif;
      if (!session) return Promise.resolve();
      const finish = () => {
        if (gif !== session) return;
        stopAnimation(session.node);
        if (session.node.open) session.node.close();
        session.node.remove();
        gif = null;
        if (restoreFocus && sameNote(session.note)) focus(session.anchor);
      };
      if (session.closing) {
        if (immediate) { finish(); return Promise.resolve(); }
        return session.closePromise || Promise.resolve();
      }
      session.closing = true;
      session.version++;
      clearTimeout(session.timer);
      session.resize?.disconnect();
      session.node.style.pointerEvents = 'none';
      if (immediate) { finish(); return Promise.resolve(); }
      session.closePromise = animate(session.node, false).then(finish);
      return session.closePromise;
    }
    async function selectGif(session, id) {
      if (session.selecting || session.closing || destroyed) return;
      const item = session.gifs.find(row => row.id === id);
      if (!item || !sameNote(session.note)) return;
      if (attachmentCount(session.note) >= MAX_ATTACHMENTS) { session.node.querySelector('.giphy-status').textContent = 'Attach up to 20 files or GIFs per note.'; return; }
      session.selecting = true;
      await closeGif({ restoreFocus: false });
      if (destroyed || !sameNote(session.note)) return;
      const target = resolveOrigin(session.note);
      if (!target) return;
      const additions = [{ id: uid(), kind: 'gif', gifId: item.id, name: item.title || 'GIPHY GIF', type: 'image/gif', size: 0 }];
      if (!Array.isArray(target.attachments)) target.attachments = [];
      target.attachments.push(...additions);
      changed({ noteId: target.id, note: target, kind: 'gif', additions, placement: session.placement });
      if (!destroyed && sameNote(target)) focus(session.anchor);
    }
    function chooseFiles(note, input, opener, placement = getInlinePlacement?.(note)) {
      if (destroyed || pendingFiles || uploads || !sameNote(note)) return;
      // Capture the note before the asynchronous native chooser opens.
      pendingFiles = { note, input, opener, placement };
      input.value = '';
      input.click();
    }
    function finishChoosing(input) {
      const pending = pendingFiles;
      if (pending?.input !== input) return null;
      pendingFiles = null;
      return pending;
    }
    function focusAfterUpload(note, opener) {
      if (sameNote(note) && (!document.activeElement || document.activeElement === document.body || document.activeElement === opener)) focus(opener);
    }
    function filesChanged(event) {
      const input = event.currentTarget;
      const pending = finishChoosing(input);
      const files = Array.from(input.files || []);
      input.value = '';
      if (!pending || destroyed) return;
      if (!files.length) { focusAfterUpload(pending.note, pending.opener); return; }
      if (input === cameraInput && files.some(file => !file.type.startsWith('image/'))) {
        status('Choose a photo from the device camera.', true);
        focusAfterUpload(pending.note, pending.opener);
        return;
      }
      void attachFiles(files, pending.note, pending.opener, pending.placement);
    }
    function filesCanceled(event) {
      const pending = finishChoosing(event.currentTarget);
      if (pending) focusAfterUpload(pending.note, pending.opener);
    }
    async function attachFiles(files, note, opener, placement) {
      const target = resolveOrigin(note);
      if (!target) { status('The original note is no longer available. The file was not attached.', true); return; }
      if (attachmentCount(target) + files.length > MAX_ATTACHMENTS) { status('Attach up to 20 files or GIFs per note.', true); return; }
      if (files.some(file => file.size < 1 || file.size > MAX_FILE_BYTES)) { status('Files must be between 1 byte and 100 MB each.', true); return; }
      pendingCounts.set(target.id, (pendingCounts.get(target.id) || 0) + files.length);
      uploads += files.length;
      opener.setAttribute('aria-busy', 'true');
      filesTrigger.disabled = true;
      cameraTrigger.disabled = true;
      let lastError = '';
      for (const file of files) {
        try {
          if (!available(target)) throw Error('The original note is no longer available. The file was not attached.');
          status('Uploading ' + file.name + '…');
          const uploaded = await send('upload', { file, id: uid(), noteId: target.id });
          const destination = resolveOrigin(target);
          if (!destination) throw Error('The upload finished, but the original note is no longer available. The file was not attached.');
          if (!uploaded || !uploaded.id || uploaded.kind !== 'file') throw Error('The uploaded file could not be verified.');
          const addition = { id: uploaded.id, kind: 'file', name: uploaded.name || file.name, type: uploaded.type || file.type || 'application/octet-stream', size: uploaded.size || file.size, ...(safeMediaURL(uploaded.url) ? { url: uploaded.url } : {}) };
          if (!Array.isArray(destination.attachments)) destination.attachments = [];
          if (destination.attachments.length >= MAX_ATTACHMENTS) throw Error('This note now has 20 attachments. Remove one, then choose the file again.');
          destination.attachments.push(addition);
          changed({ noteId: target.id, note: destination, kind: 'files', additions: [addition], placement });
        } catch (error) {
          lastError = error?.message || 'The file could not be uploaded. Choose it again to retry.';
          status(lastError, true);
        } finally {
          uploads--;
          const left = (pendingCounts.get(target.id) || 1) - 1;
          if (left > 0) pendingCounts.set(target.id, left); else pendingCounts.delete(target.id);
        }
      }
      if (!destroyed) {
        filesTrigger.disabled = false;
        cameraTrigger.disabled = false;
        opener.removeAttribute('aria-busy');
        status(lastError);
        focusAfterUpload(target, opener);
      }
    }
    function stopStream(stream) { stream?.getTracks().forEach(track => track.stop()); }
    function closeCamera(restoreFocus = true) {
      const session = camera;
      if (!session) return;
      camera = null;
      stopStream(session.stream);
      session.video.srcObject = null;
      if (session.node.open) session.node.close();
      session.node.remove();
      if (restoreFocus && sameNote(session.note)) focus(cameraTrigger);
    }
    async function takePhoto(session) {
      if (camera !== session || !sameNote(session.note) || session.capture.disabled) return;
      const { video, capture, label } = session;
      if (!video.videoWidth || !video.videoHeight) return;
      capture.disabled = true;
      label.textContent = 'Capturing photo…';
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (!context) throw Error();
        context.drawImage(video, 0, 0);
        const photo = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        if (camera !== session || !sameNote(session.note)) return;
        if (!photo) throw Error();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        closeCamera(false);
        await attachFiles([new File([photo], 'Camera photo ' + stamp + '.jpg', { type: 'image/jpeg' })], session.note, cameraTrigger, session.placement);
      } catch {
        if (camera !== session) return;
        capture.disabled = false;
        label.textContent = 'The photo could not be captured. Try again.';
      }
    }
    async function openCamera(note) {
      if (destroyed || camera || !sameNote(note) || pendingFiles || uploads) return;
      const placement = getInlinePlacement?.(note);
      if (window.matchMedia('(pointer: coarse)').matches) { chooseFiles(note, cameraInput, cameraTrigger, placement); return; }
      const node = document.createElement('dialog');
      node.className = 'notepad-media-dialog notepad-camera';
      node.setAttribute('aria-label', 'Camera');
      node.innerHTML = '<header><span>Camera</span><button type="button" data-camera-close aria-label="Close camera">×</button></header><video autoplay muted playsinline aria-label="Camera preview"></video><p role="status">Starting camera…</p><footer><button type="button" data-device-camera>Use device camera</button><button type="button" data-camera-capture disabled>Take photo</button></footer>';
      const video = node.querySelector('video');
      video.muted = true;
      const session = { note, placement, node, video, capture: node.querySelector('[data-camera-capture]'), label: node.querySelector('[role="status"]'), stream: null };
      camera = session;
      const dismiss = node.querySelector('[data-camera-close]');
      const useDevice = node.querySelector('[data-device-camera]');
      dismiss.addEventListener('click', () => closeCamera());
      node.addEventListener('cancel', event => { event.preventDefault(); closeCamera(); });
      useDevice.addEventListener('click', () => {
        closeCamera();
        chooseFiles(note, cameraInput, cameraTrigger, placement);
      });
      session.capture.addEventListener('click', () => void takePhoto(session));
      document.body.append(node);
      try { node.showModal(); } catch { closeCamera(false); chooseFiles(note, cameraInput, cameraTrigger, placement); return; }
      focus(dismiss);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (camera !== session || !sameNote(note)) { stopStream(stream); return; }
        session.stream = stream;
        video.srcObject = stream;
        await video.play();
        if (camera !== session || !sameNote(note)) return;
        session.capture.disabled = false;
        session.label.textContent = 'Camera ready.';
        focus(session.capture);
      } catch {
        if (camera !== session) return;
        stopStream(session.stream);
        session.stream = null;
        video.srcObject = null;
        session.label.textContent = 'Camera unavailable. Allow camera access in your browser or use the device camera picker.';
      }
    }
    function closeViewer(restoreFocus = true) {
      viewerVersion++;
      if (!viewer) return;
      const { dialog, opener, tab, note } = viewer;
      viewer = null;
      tab?.close();
      dialog.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
      if (dialog.open) dialog.close();
      dialog.remove();
      if (restoreFocus && sameNote(note)) focus(opener);
    }
    async function openAttachment(attachment, opener) {
      if (destroyed || !attachment) return;
      const target = currentNote();
      if (!target) return;
      closeViewer(false);
      const inline = opener?.hasAttribute('data-open-inline-attachment');
      let tab = null;
      if (attachment.kind === 'file' && attachment.type === 'application/pdf') {
        // Reserve the PDF tab while the browser still has the user's click.
        try {
          tab = window.open('', '_blank');
          if (tab) tab.opener = null;
        } catch { tab = null; }
      }
      const version = ++viewerVersion;
      const dialog = document.createElement('dialog');
      dialog.className = 'notepad-media-dialog notepad-attachment-viewer';
      dialog.setAttribute('aria-label', attachment.name || 'Attachment');
      const header = document.createElement('header');
      const name = document.createElement('span');
      name.textContent = attachment.name || 'Attachment';
      const dismiss = document.createElement('button');
      dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Close attachment'); dismiss.textContent = '×';
      header.append(name, dismiss);
      const body = document.createElement('div');
      body.className = 'notepad-attachment-body';
      body.textContent = 'Loading attachment…';
      dialog.append(header, body);
      const session = { dialog, opener, tab, note: target };
      viewer = session;
      document.body.append(dialog);
      dismiss.addEventListener('click', () => closeViewer());
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
      try { dialog.showModal(); } catch { closeViewer(); return; }
      focus(dismiss);
      try {
        let url = '', type = attachment.type || 'application/octet-stream';
        if (attachment.kind === 'gif') {
          if (inline) {
            const verified = await send('attachment', { noteId: target.id, id: attachment.id });
            if (verified?.kind !== 'gif' || verified.gifId !== attachment.gifId) throw Error('This attachment is no longer available to your account.');
          }
          let item = gifCache.get(attachment.gifId);
          if (!item) {
            const result = await send('giphy', { ids: [attachment.gifId] });
            const rows = Array.isArray(result?.gifs) ? result.gifs.filter(validGif) : [];
            rememberGifs(rows); item = rows.find(row => row.id === attachment.gifId);
          }
          url = safeMediaURL(item?.original.url); type = 'image/gif';
        } else {
          // The host rechecks access and renews signed URLs on an explicit open.
          const refreshed = await send('attachment', { noteId: target.id, id: attachment.id });
          url = safeMediaURL(refreshed?.url); type = refreshed?.type || type;
        }
        if (destroyed || viewer !== session || version !== viewerVersion || !sameNote(target)) return;
        if (!url) throw Error('Attachment unavailable. Reopen the note to refresh it.');
        if (type === 'application/pdf' && tab && !tab.closed) {
          try {
            tab.location.replace(url);
            session.tab = null;
            closeViewer(false);
            return;
          } catch { tab.close(); session.tab = null; }
        }
        session.tab?.close();
        session.tab = null;
        body.replaceChildren();
        const imageType = isImage(type);
        const videoType = /^video\/(mp4|webm|quicktime)$/.test(type);
        const audioType = /^audio\/[-\w.+]+$/.test(type);
        if (imageType || videoType || audioType) {
          const media = document.createElement(imageType ? 'img' : videoType ? 'video' : 'audio');
          if (imageType) media.alt = attachment.name || 'Attachment';
          else { media.controls = true; media.preload = 'none'; if (videoType) media.playsInline = true; }
          // No audio/video element or src exists before this explicit open action.
          media.src = url;
          media.addEventListener('error', () => {
            if (viewer === session) body.replaceChildren(originalLink(attachment, url, 'Open original'));
          });
          body.append(media);
        } else {
          const link = originalLink(attachment, url, 'Open original');
          body.append(link);
          // The signed link delivers non-previewable files through the browser's downloader.
          if (inline && new URL(url).searchParams.has('download')) {
            link.removeAttribute('target');
            link.click();
            link.target = '_blank';
          } else if (!inline && type !== 'application/pdf') link.click();
        }
      } catch (error) {
        if (!destroyed && viewer === session && version === viewerVersion) {
          session.tab?.close();
          session.tab = null;
          body.textContent = error?.message || 'The attachment could not be opened.';
        }
      }
    }
    function originalLink(attachment, url, label) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = label + ': ' + (attachment.name || 'file');
      return link;
    }
    function close({ restoreFocus = true, immediate = false } = {}) {
      closeViewer(restoreFocus);
      closeCamera(restoreFocus);
      return closeGif({ restoreFocus, immediate });
    }
    function onFilesClick() {
      void closeGif({ restoreFocus: false, immediate: true });
      chooseFiles(currentNote(), fileInput, filesTrigger);
    }
    function onCameraClick() {
      void closeGif({ restoreFocus: false, immediate: true });
      void openCamera(currentNote());
    }
    function onGifClick() {
      if (gif) void closeGif();
      else openGif(gifTrigger, currentNote());
    }
    function onPointerDown(event) {
      if (!gif) return;
      if (!sameNote(gif.note)) { void closeGif({ restoreFocus: false, immediate: true }); return; }
      if (mobilePicker.matches) return;
      if (!gif.node.contains(event.target) && !gifTrigger.contains(event.target)) void closeGif({ restoreFocus: false });
    }
    function onResize() { if (gif && !gif.closing) positionGifOrigin(gif); }
    function onKeyDown(event) {
      if (!(gif || camera || viewer) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      void close();
    }
    function onPageHide() { void close({ restoreFocus: false, immediate: true }); }
    const observedRoot = filesTrigger.closest('.layout-body') || container.parentElement || container;
    const observer = new MutationObserver(() => {
      if (destroyed) return;
      if (!filesTrigger.isConnected) { destroy(); return; }
      const session = gif || camera || viewer;
      if (session && !sameNote(session.note)) close({ restoreFocus: false, immediate: true });
    });
    observer.observe(observedRoot, { childList: true, subtree: true });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pendingFiles = null;
      observer.disconnect();
      filesTrigger.removeEventListener('click', onFilesClick);
      gifTrigger.removeEventListener('click', onGifClick);
      cameraTrigger.removeEventListener('click', onCameraClick);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('resize', onResize);
      for (const input of [fileInput, cameraInput]) {
        input.removeEventListener('change', filesChanged);
        input.removeEventListener('cancel', filesCanceled);
        input.remove();
      }
      onPageHide();
      statusNode.remove();
    }

    filesTrigger.addEventListener('click', onFilesClick);
    gifTrigger.addEventListener('click', onGifClick);
    cameraTrigger.addEventListener('click', onCameraClick);
    for (const input of [fileInput, cameraInput]) {
      input.addEventListener('change', filesChanged);
      input.addEventListener('cancel', filesCanceled);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('resize', onResize);
    return { destroy, close, openAttachment, gifPreviews, uploading: () => uploads > 0, isInteracting: () => !destroyed && !!(gif || camera || pendingFiles || viewer) };
  }

  window.NotepadAttachments = { html, attach, photoPreview, inlineMedia };
})();
