(function () {
  'use strict';

  let nextInstance = 0;
  const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const paperclip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8L15.2 5.6"/></svg>';
  const combinedMedia = '<svg class="attachment-media-symbol" viewBox="0 0 72 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="22" width="25" height="23" rx="2"/><path d="M7 22v23m15-23v23M2 28h5m-5 8h5m-5 6h5m15-14h5m-5 8h5m-5 6h5"/><path d="m11 28 7 5-7 5z" fill="currentColor" stroke="none"/><rect x="16" y="2" width="30" height="20" rx="2"/><circle cx="24" cy="8" r="2"/><path d="m18 19 9-7 6 5 5-8 6 10"/><path d="M56 21v17m0-14 12-3v13"/><ellipse cx="52" cy="39" rx="4" ry="3"/><ellipse cx="64" cy="35" rx="4" ry="3"/><path d="m45 26-10 10a4 4 0 0 0 5.7 5.7l9-9a5.8 5.8 0 0 0-8.2-8.2l-9.7 9.7a2.1 2.1 0 0 0 3 3l8.5-8.5"/></svg>';
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
  function validGif(value) {
    if (!value || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.id || '')) return false;
    return [value.preview, value.original].every(image => {
      const url = safeMediaURL(image?.url);
      return url && new URL(url).hostname.endsWith('.giphy.com');
    });
  }

  function html() {
    return '<button type="button" class="notepad-attachments-trigger" data-notepad-attachments-trigger aria-label="Add attachment" title="Attachments" aria-haspopup="menu" aria-expanded="false">' + paperclip + '</button>';
  }

  function attach(options) {
    const { container, getNote, getNoteById, onChange, badge, request, onError, isNoteAvailable } = options || {};
    const trigger = container && (container.matches?.('[data-notepad-attachments-trigger]') ? container : container.querySelector?.('[data-notepad-attachments-trigger]'));
    if (!trigger || typeof getNote !== 'function') return { destroy() {}, close() { return Promise.resolve(); }, openAttachment() { return Promise.resolve(); }, uploading() { return false; }, isInteracting() { return false; } };

    const instance = ++nextInstance;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const animations = new Map();
    let destroyed = false;
    let menu = null;
    let gif = null;
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

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.setAttribute('aria-label', 'Choose attachments');
    fileInput.dataset.notepadAttachmentInput = String(instance);
    document.body.append(fileInput);

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
      // A save callback may replace the whole editor and its trigger.
      queueMicrotask(() => {
        if (!sameNote(payload.note)) return;
        const active = document.activeElement;
        const next = trigger.isConnected ? trigger : document.querySelector('[data-notepad-attachments-trigger]');
        if (next && (!active || active === document.body || active === trigger)) next.focus({ preventScroll: true });
      });
    }
    function originFor(node, rect) {
      const panel = node.getBoundingClientRect();
      node.style.transformOrigin = (rect.left + rect.width / 2 - panel.left) + 'px ' + (rect.top + rect.height / 2 - panel.top) + 'px';
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
    function positionMenu() {
      if (!menu || !trigger.isConnected) return;
      const anchor = trigger.getBoundingClientRect();
      const width = 126;
      const height = 30;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.max(3, Math.min(viewportWidth - width - 3, anchor.left + anchor.width / 2 - width / 2));
      const above = anchor.top - height - 3;
      const top = above >= 3 ? above : Math.min(viewportHeight - height - 3, anchor.bottom + 3);
      menu.node.style.left = left + 'px';
      menu.node.style.top = Math.max(3, top) + 'px';
      menu.node.style.transformOrigin = (anchor.left + anchor.width / 2 - left) + 'px ' + (anchor.top + anchor.height / 2 - Math.max(3, top)) + 'px';
    }
    function openMenu() {
      if (destroyed || menu) return;
      const note = currentNote();
      if (!note) return;
      const node = document.createElement('div');
      node.className = 'attachment-choices';
      node.id = 'notepad-attachment-choices-' + instance;
      node.setAttribute('role', 'menu');
      node.setAttribute('aria-label', 'Add attachment');
      node.innerHTML = '<button type="button" class="attachment-choice" data-attachment-choice="gif" role="menuitem" aria-haspopup="dialog" aria-label="Choose a GIF">GIF</button><button type="button" class="attachment-choice" data-attachment-choice="files" role="menuitem" aria-label="Choose photo, video, music or any file" title="Photo, video, music or files">' + combinedMedia + '</button>';
      node.style.transform = 'scale(.035)';
      node.style.opacity = '0';
      menu = { node, note, closing: false, closePromise: null };
      const session = menu;
      document.body.append(node);
      positionMenu();
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-controls', node.id);
      trigger.dispatchEvent(new CustomEvent('notepad:attachments-open', { bubbles: true }));
      node.addEventListener('click', event => {
        const choice = event.target.closest('[data-attachment-choice]');
        if (!choice || session.closing || destroyed) return;
        event.stopPropagation();
        if (!sameNote(session.note)) { close({ restoreFocus: false, immediate: true }); return; }
        if (choice.dataset.attachmentChoice === 'gif') openGif(choice, session);
        else chooseFiles(session);
      });
      animate(node, true).then(() => {
        if (!destroyed && menu === session && !session.closing && !gif) focus(node.querySelector('button'));
      });
    }
    function collapseMenu({ restoreFocus = true, immediate = false } = {}) {
      const session = menu;
      if (!session) return Promise.resolve();
      if (session.closing) return session.closePromise || Promise.resolve();
      session.closing = true;
      session.node.style.pointerEvents = 'none';
      trigger.setAttribute('aria-expanded', 'false');
      const finish = () => {
        stopAnimation(session.node);
        session.node.remove();
        if (menu === session) menu = null;
        trigger.removeAttribute('aria-controls');
        if (restoreFocus && sameNote(session.note)) focus(trigger);
      };
      if (immediate) { finish(); return Promise.resolve(); }
      session.closePromise = animate(session.node, false).then(finish);
      return session.closePromise;
    }
    function renderGifResults(session) {
      session.node.querySelector('.staff-gif-results').innerHTML = session.gifs.length
        ? session.gifs.map(item => '<button type="button" data-attachment-gif="' + escapeHTML(item.id) + '" aria-label="Select ' + escapeHTML(item.title) + '"><img src="' + escapeHTML(item.preview.url) + '" alt="' + escapeHTML(item.title) + '" width="' + (Number(item.preview.width) || 200) + '" height="' + (Number(item.preview.height) || 150) + '" loading="lazy" style="display:block;width:100%;height:auto"></button>').join('')
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
    function openGif(anchor, menuSession) {
      if (gif || destroyed || menu !== menuSession || !sameNote(menuSession.note)) return;
      stopAnimation(menuSession.node);
      menuSession.node.style.transform = 'scale(1)';
      menuSession.node.style.opacity = '1';
      const origin = anchor.getBoundingClientRect();
      const node = document.createElement('dialog');
      node.className = 'staff-giphy-picker attachment-giphy-dialog';
      node.setAttribute('aria-label', 'GIPHY picker');
      const badgeURL = typeof badge === 'string' && (/^data:image\//i.test(badge) || badge === '/Poweredby_100px_Badge.gif') ? badge : '';
      node.innerHTML = '<div class="staff-gif-search"><input aria-label="Search GIPHY" type="search" placeholder="Search GIPHY" maxlength="50" autocomplete="off"><button type="button" data-attachment-close-gif aria-label="Close GIF picker">×</button></div><p class="giphy-status" role="status"></p><div class="staff-gif-grid"><div class="staff-gif-results"></div></div><a class="staff-giphy-credit" href="https://giphy.com/" target="_blank" rel="noopener noreferrer" aria-label="Powered by GIPHY">' + (badgeURL ? '<img src="' + escapeHTML(badgeURL) + '" alt="Powered by GIPHY" width="40" height="57">' : '<span>GIPHY</span>') + '</a>';
      gif = { node, anchor, origin, note: menuSession.note, closing: false, closePromise: null, selecting: false, query: '', gifs: [], offset: 0, total: 0, loading: false, version: 0, timer: null };
      const session = gif;
      document.body.append(node);
      node.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); closeGif(); });
      node.addEventListener('click', event => {
        const closeButton = event.target.closest('[data-attachment-close-gif]');
        const result = event.target.closest('[data-attachment-gif]');
        if (closeButton) { event.stopPropagation(); closeGif(); }
        else if (result) { event.stopPropagation(); selectGif(session, result.dataset.attachmentGif); }
      });
      node.querySelector('input').addEventListener('input', event => searchGifs(session, event.target.value));
      node.querySelector('.staff-gif-grid').addEventListener('scroll', event => {
        const grid = event.currentTarget;
        if (!session.loading && session.offset < session.total && grid.scrollHeight - grid.scrollTop - grid.clientHeight < 100) void loadGifs(session, true);
      });
      try { node.showModal(); } catch (_) { gif = null; node.remove(); return; }
      originFor(node, origin);
      node.style.transform = 'scale(.035)';
      node.style.opacity = '0';
      focus(node.querySelector('input'));
      animate(node, true);
      void loadGifs(session);
    }
    function closeGif({ restoreFocus = true, immediate = false } = {}) {
      const session = gif;
      if (!session) return Promise.resolve();
      if (session.closing) return session.closePromise || Promise.resolve();
      session.closing = true;
      session.version++;
      clearTimeout(session.timer);
      session.node.style.pointerEvents = 'none';
      const finish = () => {
        stopAnimation(session.node);
        if (session.node.open) session.node.close();
        session.node.remove();
        if (gif === session) gif = null;
        if (restoreFocus && menu && !menu.closing && sameNote(session.note)) focus(session.anchor);
      };
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
      const target = session.note;
      await closeGif({ restoreFocus: false });
      await collapseMenu({ restoreFocus: false });
      if (destroyed || !sameNote(target)) return;
      const additions = [{ id: uid(), kind: 'gif', gifId: item.id, name: item.title || 'GIPHY GIF', type: 'image/gif', size: 0 }];
      if (!Array.isArray(target.attachments)) target.attachments = [];
      target.attachments.push(...additions);
      changed({ noteId: target.id, note: target, kind: 'gif', additions });
      if (!destroyed && sameNote(target)) focus(trigger);
    }
    function chooseFiles(session) {
      if (destroyed || pendingFiles) return;
      // Capture the note before the asynchronous native chooser opens.
      pendingFiles = { note: session.note, noteId: session.note.id };
      fileInput.value = '';
      collapseMenu({ restoreFocus: false });
      fileInput.click();
    }
    async function filesChanged() {
      const pending = pendingFiles;
      pendingFiles = null;
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (!pending || destroyed || !files.length) { if (!destroyed) focus(trigger); return; }
      const target = resolveOrigin(pending.note);
      if (!target) { status('The original note is no longer available. The file was not attached.', true); return; }
      if (attachmentCount(target) + files.length > MAX_ATTACHMENTS) { status('Attach up to 20 files or GIFs per note.', true); return; }
      if (files.some(file => file.size < 1 || file.size > MAX_FILE_BYTES)) { status('Files must be between 1 byte and 100 MB each.', true); return; }
      pendingCounts.set(target.id, (pendingCounts.get(target.id) || 0) + files.length);
      uploads += files.length;
      trigger.disabled = true;
      trigger.setAttribute('aria-busy', 'true');
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
          changed({ noteId: pending.noteId, note: destination, kind: 'files', additions: [addition] });
        } catch (error) {
          lastError = error?.message || 'The file could not be uploaded. Choose it again to retry.';
          status(lastError, true);
        } finally {
          uploads--;
          const left = (pendingCounts.get(target.id) || 1) - 1;
          if (left > 0) pendingCounts.set(target.id, left); else pendingCounts.delete(target.id);
        }
      }
      if (!destroyed) { trigger.disabled = false; trigger.removeAttribute('aria-busy'); status(lastError); }
      if (!destroyed && sameNote(target)) focus(trigger);
    }
    function filesCanceled() { const pending = pendingFiles; pendingFiles = null; if (!destroyed && (!pending || sameNote(pending.note))) focus(trigger); }
    function closeViewer() {
      viewerVersion++;
      if (!viewer) return;
      const dialog = viewer;
      viewer = null;
      dialog.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
      if (dialog.open) dialog.close();
      dialog.remove();
    }
    async function openAttachment(attachment) {
      if (destroyed || !attachment) return;
      const target = currentNote();
      if (!target) return;
      closeViewer();
      const version = ++viewerVersion;
      const dialog = document.createElement('dialog');
      dialog.className = 'staff-giphy-picker attachment-giphy-dialog';
      dialog.setAttribute('aria-label', attachment.name || 'Attachment');
      const header = document.createElement('div');
      header.className = 'staff-gif-search';
      const name = document.createElement('span');
      name.textContent = attachment.name || 'Attachment';
      name.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px';
      const dismiss = document.createElement('button');
      dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Close attachment'); dismiss.textContent = '×';
      header.append(name, dismiss);
      const body = document.createElement('div');
      body.style.cssText = 'display:flex;flex:1;min-height:0;align-items:center;justify-content:center;overflow:auto;padding:3px';
      body.textContent = 'Loading attachment…';
      dialog.append(header, body);
      viewer = dialog;
      document.body.append(dialog);
      dismiss.addEventListener('click', closeViewer);
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
      try { dialog.showModal(); } catch (_) { closeViewer(); return; }
      focus(dismiss);
      try {
        let url = '', type = attachment.type || 'application/octet-stream';
        if (attachment.kind === 'gif') {
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
        if (destroyed || viewer !== dialog || version !== viewerVersion || !sameNote(target)) return;
        if (!url) throw Error('Attachment unavailable. Reopen the note to refresh it.');
        body.replaceChildren();
        const imageType = /^image\/(jpeg|png|gif|webp|avif)$/.test(type);
        const videoType = /^video\/(mp4|webm|quicktime)$/.test(type);
        const audioType = /^audio\/[-\w.+]+$/.test(type);
        if (imageType || videoType || audioType) {
          const media = document.createElement(imageType ? 'img' : videoType ? 'video' : 'audio');
          media.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain';
          if (imageType) media.alt = attachment.name || 'Attachment';
          else { media.controls = true; media.preload = 'none'; if (videoType) media.playsInline = true; }
          // No audio/video element or src exists before this explicit open action.
          media.src = url;
          media.addEventListener('error', () => { if (viewer === dialog) body.textContent = 'This attachment could not be loaded. Close and open it to retry.'; });
          body.append(media);
        } else {
          const link = document.createElement('a');
          link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open ' + (attachment.name || 'file');
          link.style.cssText = 'color:var(--cmpri-modal-text);overflow-wrap:anywhere';
          body.append(link);
        }
      } catch (error) {
        if (!destroyed && viewer === dialog && version === viewerVersion) body.textContent = error?.message || 'The attachment could not be opened.';
      }
    }
    async function close({ restoreFocus = true, immediate = false } = {}) {
      closeViewer();
      await closeGif({ restoreFocus: false, immediate });
      await collapseMenu({ restoreFocus, immediate });
    }
    function onTriggerClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (menu || gif) close();
      else openMenu();
    }
    function onPointerDown(event) {
      if (destroyed || (!menu && !gif)) return;
      const session = gif || menu;
      if (!sameNote(session.note)) { close({ restoreFocus: false, immediate: true }); return; }
      if (gif) {
        const rect = gif.node.getBoundingClientRect();
        if (event.target === gif.node && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeGif();
        return;
      }
      if (!menu.node.contains(event.target) && !trigger.contains(event.target)) close({ restoreFocus: false });
    }
    function onKeyDown(event) {
      if (destroyed || (!menu && !gif)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (gif) closeGif(); else close();
        return;
      }
      if (gif || !menu || menu.closing || !menu.node.contains(document.activeElement)) return;
      const buttons = Array.from(menu.node.querySelectorAll('button'));
      const index = buttons.indexOf(document.activeElement);
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        focus(buttons[next]);
      } else if (event.key === 'Tab') close({ restoreFocus: false });
    }
    function onReposition(event) {
      if (destroyed || !menu) return;
      positionMenu();
      if (gif && !gif.closing && event?.type === 'resize') {
        const transform = gif.node.style.transform;
        gif.node.style.transform = 'none';
        originFor(gif.node, gif.anchor.isConnected ? gif.anchor.getBoundingClientRect() : gif.origin);
        gif.node.style.transform = transform;
      }
    }
    const observedRoot = trigger.closest('.layout-body') || container.parentElement || container;
    const observer = new MutationObserver(() => {
      if (destroyed) return;
      if (!trigger.isConnected) { destroy(); return; }
      const session = gif || menu;
      if (session && !sameNote(session.note)) close({ restoreFocus: false, immediate: true });
    });
    observer.observe(observedRoot, { childList: true, subtree: true });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pendingFiles = null;
      observer.disconnect();
      trigger.removeEventListener('click', onTriggerClick);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('scroll', onReposition, true);
      fileInput.removeEventListener('change', filesChanged);
      fileInput.removeEventListener('cancel', filesCanceled);
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
      if (gif) { gif.version++; clearTimeout(gif.timer); if (gif.node.open) gif.node.close(); gif.node.remove(); gif = null; }
      if (menu) { menu.node.remove(); menu = null; }
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      fileInput.remove();
      closeViewer();
      statusNode.remove();
    }

    trigger.addEventListener('click', onTriggerClick);
    fileInput.addEventListener('change', filesChanged);
    fileInput.addEventListener('cancel', filesCanceled);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    document.addEventListener('scroll', onReposition, true);
    return { destroy, close, openAttachment, uploading: () => uploads > 0, isInteracting: () => !destroyed && !!(menu || gif || pendingFiles || viewer) };
  }

  window.NotepadAttachments = { html, attach };
})();
