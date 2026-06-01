'use strict';

// ============================================================
// Constants & State
// ============================================================

const LS_BOXES    = 'backtrack_boxes';
const LS_GRID     = 'backtrack_grid';
const LS_PAGES    = 'backtrack_pages';
const DB_NAME     = 'backtrack_db';
const DB_VERSION  = 1;
const STORE_NAME  = 'audio_blobs';
const LONG_PRESS_MS = 500;

const state = {
  db:           null,
  boxes:        [],        // BoxMeta[]
  grid:         { cols: 4, rows: 4 },
  pages:        1,
  currentPage:  0,
  pendingAssign:   null,   // { pageIndex, position, isReassign, oldIdbKey, file }
  pendingUnassign: null,   // { pageIndex, position }
  longPress:    { timer: null, fired: false },
  player: {
    idbKey:   null,
    blobUrl:  null,
    playing:  false,
  },
};

// ============================================================
// IndexedDB Module
// ============================================================

function initDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      showStorageWarning();
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
    };
    req.onsuccess = (e) => {
      state.db = e.target.result;
      resolve(state.db);
    };
    req.onerror = () => {
      showStorageWarning();
      resolve(null);
    };
  });
}

function saveAudioBlob(blob) {
  return new Promise((resolve, reject) => {
    if (!state.db) { reject(new Error('DB unavailable')); return; }
    const tx = state.db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).add(blob);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function getAudioBlob(idbKey) {
  return new Promise((resolve, reject) => {
    if (!state.db) { reject(new Error('DB unavailable')); return; }
    const tx = state.db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(idbKey);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function deleteAudioBlob(idbKey) {
  if (!state.db || idbKey == null) return;
  const tx = state.db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(idbKey);
}

// ============================================================
// LocalStorage Module
// ============================================================

function loadBoxes() {
  try {
    state.boxes = JSON.parse(localStorage.getItem(LS_BOXES) || '[]');
  } catch { state.boxes = []; }
}

function saveBoxes() {
  localStorage.setItem(LS_BOXES, JSON.stringify(state.boxes));
}

function loadGridSettings() {
  try {
    const g = JSON.parse(localStorage.getItem(LS_GRID));
    if (g && g.cols && g.rows) state.grid = g;
  } catch { /* use defaults */ }
}

function saveGridSettings() {
  localStorage.setItem(LS_GRID, JSON.stringify(state.grid));
}

function loadPageCount() {
  const v = parseInt(localStorage.getItem(LS_PAGES), 10);
  state.pages = isNaN(v) || v < 1 ? 1 : v;
}

function savePageCount() {
  localStorage.setItem(LS_PAGES, String(state.pages));
}

// ============================================================
// Utility
// ============================================================

function boxId(pageIndex, position) {
  return `box_p${pageIndex}_pos${position}`;
}

function findBox(pageIndex, position) {
  const id = boxId(pageIndex, position);
  return state.boxes.find(b => b.id === id) || null;
}

function upsertBox(meta) {
  const idx = state.boxes.findIndex(b => b.id === meta.id);
  if (idx >= 0) state.boxes[idx] = meta;
  else state.boxes.push(meta);
}

function formatTime(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showStorageWarning() {
  document.getElementById('storage-warning').classList.remove('hidden');
}

// ============================================================
// Render
// ============================================================

function renderAllPages() {
  const strip = document.getElementById('page-strip');
  strip.innerHTML = '';
  for (let i = 0; i < state.pages; i++) renderPage(i, strip);
  updatePageNav();
  updateRemovePageButton();
}

function renderPage(pageIndex, strip) {
  const container = strip || document.getElementById('page-strip');
  const page = document.createElement('div');
  page.className = 'grid-page';
  page.dataset.page = pageIndex;

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.setProperty('--grid-cols', state.grid.cols);
  grid.style.setProperty('--grid-rows', state.grid.rows);

  const total = state.grid.cols * state.grid.rows;
  for (let pos = 0; pos < total; pos++) {
    grid.appendChild(renderBox(pageIndex, pos));
  }
  page.appendChild(grid);
  container.appendChild(page);
}

function renderBox(pageIndex, position) {
  const meta = findBox(pageIndex, position);
  const box  = document.createElement('div');
  box.className = 'grid-box';
  box.dataset.page = pageIndex;
  box.dataset.pos  = position;

  if (!meta) {
    box.classList.add('free');
    box.innerHTML = `
      <span class="box-free-icon">+</span>
      <span class="box-free-label">Free space</span>
    `;
  } else {
    box.classList.add('filled');
    box.title = meta.title;
    if (state.player.idbKey === meta.idbKey) box.classList.add('playing');
    box.innerHTML = `
      <button class="box-remove-btn" title="Remove this track">&#10005;</button>
      <span class="box-title">${escapeHtml(meta.title)}</span>
      <span class="box-play-hint">&#9654; tap to play</span>
    `;
    const removeBtn = box.querySelector('.box-remove-btn');
    removeBtn.addEventListener('mousedown',  e => e.stopPropagation());
    removeBtn.addEventListener('mouseup',    e => e.stopPropagation());
    removeBtn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      onUnassignClick(pageIndex, position);
    });
    removeBtn.addEventListener('touchend', e => {
      e.stopPropagation();
      e.preventDefault();
      onUnassignClick(pageIndex, position);
    }, { passive: false });
  }

  attachBoxListeners(box, pageIndex, position);
  return box;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function replaceBoxInDOM(pageIndex, position) {
  const strip = document.getElementById('page-strip');
  const page  = strip.children[pageIndex];
  if (!page) return;
  const grid  = page.querySelector('.grid');
  if (!grid)  return;
  const total = state.grid.cols * state.grid.rows;
  const old   = grid.children[position];
  if (!old)   return;
  const fresh = renderBox(pageIndex, position);
  grid.replaceChild(fresh, old);
}

function updatePageNav() {
  const dots = document.getElementById('dot-indicators');
  dots.innerHTML = '';
  for (let i = 0; i < state.pages; i++) {
    const dot = document.createElement('button');
    dot.className = 'page-dot' + (i === state.currentPage ? ' active' : '');
    dot.title = `Page ${i + 1}`;
    dot.addEventListener('click', () => goToPage(i));
    dots.appendChild(dot);
  }
  document.getElementById('btn-prev').disabled = state.currentPage === 0;
  document.getElementById('btn-next').disabled = state.currentPage === state.pages - 1;
}

// ============================================================
// Page Navigation
// ============================================================

function goToPage(index) {
  if (index < 0 || index >= state.pages) return;
  state.currentPage = index;
  const strip = document.getElementById('page-strip');
  strip.style.transform = `translateX(-${index * 100}vw)`;
  updatePageNav();
  updateRemovePageButton();
}

function addPage() {
  state.pages++;
  savePageCount();
  const strip = document.getElementById('page-strip');
  renderPage(state.pages - 1, strip);
  updatePageNav();
  goToPage(state.pages - 1);
}

function updateRemovePageButton() {
  const btn = document.getElementById('btn-remove-page');
  if (state.currentPage > 0) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
}

function pageHasAssignedBoxes(pageIndex) {
  return state.boxes.some(b => b.pageIndex === pageIndex);
}

function onRemovePageClick() {
  if (pageHasAssignedBoxes(state.currentPage)) {
    showModal('modal-confirm-remove');
  } else {
    removePage(state.currentPage);
  }
}

function removePage(pageIndex) {
  // Delete IDB blobs for every assigned box on this page
  const pageBoxes = state.boxes.filter(b => b.pageIndex === pageIndex);
  pageBoxes.forEach(b => deleteAudioBlob(b.idbKey));

  // Stop player if it was playing a track from this page
  if (state.player.idbKey != null && pageBoxes.some(b => b.idbKey === state.player.idbKey)) {
    const audio = document.getElementById('audio-element');
    audio.pause();
    audio.src = '';
    if (state.player.blobUrl) { URL.revokeObjectURL(state.player.blobUrl); state.player.blobUrl = null; }
    state.player.idbKey  = null;
    state.player.playing = false;
    document.getElementById('player').classList.remove('visible');
    document.getElementById('player').classList.add('hidden');
  }

  // Remove boxes for this page; re-index boxes on later pages
  state.boxes = state.boxes.filter(b => b.pageIndex !== pageIndex);
  state.boxes.forEach(b => {
    if (b.pageIndex > pageIndex) {
      b.pageIndex--;
      b.id = boxId(b.pageIndex, b.position);
    }
  });

  state.pages--;
  savePageCount();
  saveBoxes();

  const newPage = Math.min(state.currentPage, state.pages - 1);
  const strip = document.getElementById('page-strip');
  strip.classList.add('no-transition');
  renderAllPages();
  goToPage(newPage);
  requestAnimationFrame(() => strip.classList.remove('no-transition'));
}

// Swipe detection
let swipeStartX = null;
let swipeStartY = null;

function onTouchStart(e) {
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
}

function onTouchEnd(e) {
  if (swipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  swipeStartX = null;
  swipeStartY = null;
  if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.8) return;
  if (state.longPress.fired) return;
  if (dx < 0) goToPage(state.currentPage + 1);
  else        goToPage(state.currentPage - 1);
}

// ============================================================
// Unassign Box
// ============================================================

function onUnassignClick(pageIndex, position) {
  const meta = findBox(pageIndex, position);
  if (!meta) return;
  state.pendingUnassign = { pageIndex, position };
  document.getElementById('confirm-unassign-message').textContent =
    `"${meta.title}" will be unassigned and the space will become free again.`;
  showModal('modal-confirm-unassign');
}

function unassignBox() {
  if (!state.pendingUnassign) return;
  const { pageIndex, position } = state.pendingUnassign;
  state.pendingUnassign = null;
  hideModal('modal-confirm-unassign');

  const meta = findBox(pageIndex, position);
  if (!meta) return;

  if (state.player.idbKey === meta.idbKey) {
    const audio = document.getElementById('audio-element');
    audio.pause();
    audio.src = '';
    if (state.player.blobUrl) { URL.revokeObjectURL(state.player.blobUrl); state.player.blobUrl = null; }
    state.player.idbKey  = null;
    state.player.playing = false;
    const player = document.getElementById('player');
    player.classList.remove('visible');
    player.classList.add('hidden');
  }

  deleteAudioBlob(meta.idbKey);
  state.boxes = state.boxes.filter(b => b.id !== meta.id);
  saveBoxes();
  replaceBoxInDOM(pageIndex, position);
}

// ============================================================
// Long-Press Detection
// ============================================================

function startLongPressTimer(box, pageIndex, position) {
  clearLongPressTimer();
  state.longPress.fired = false;
  state.longPress.timer = setTimeout(() => {
    state.longPress.fired = true;
    box.classList.add('pressing');
    assignFlow(pageIndex, position, true);
  }, LONG_PRESS_MS);
}

function clearLongPressTimer() {
  clearTimeout(state.longPress.timer);
  state.longPress.timer = null;
}

function attachBoxListeners(box, pageIndex, position) {
  // Mouse events
  box.addEventListener('mousedown', () => {
    startLongPressTimer(box, pageIndex, position);
  });
  box.addEventListener('mouseup', () => {
    const fired = state.longPress.fired;
    clearLongPressTimer();
    box.classList.remove('pressing');
    if (!fired) onBoxClick(pageIndex, position);
  });
  box.addEventListener('mouseleave', () => {
    clearLongPressTimer();
    box.classList.remove('pressing');
  });

  // Touch events
  box.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startLongPressTimer(box, pageIndex, position);
  }, { passive: false });
  box.addEventListener('touchend', (e) => {
    e.preventDefault();
    const fired = state.longPress.fired;
    clearLongPressTimer();
    box.classList.remove('pressing');
    if (!fired) onBoxClick(pageIndex, position);
  }, { passive: false });
  box.addEventListener('touchcancel', () => {
    clearLongPressTimer();
    box.classList.remove('pressing');
  });
}

// ============================================================
// Box Click Handler
// ============================================================

function onBoxClick(pageIndex, position) {
  const meta = findBox(pageIndex, position);
  if (!meta) {
    assignFlow(pageIndex, position, false);
  } else {
    loadAndPlayTrack(meta);
  }
}

// ============================================================
// Assign / File / ID3 Flow
// ============================================================

function assignFlow(pageIndex, position, isReassign) {
  const meta = findBox(pageIndex, position);
  state.pendingAssign = {
    pageIndex,
    position,
    isReassign,
    oldIdbKey: isReassign && meta ? meta.idbKey : null,
    file: null,
  };
  const input = document.getElementById('file-input');
  input.value = '';
  input.click();
}

function onFileSelected(file) {
  if (!file || !state.pendingAssign) return;
  state.pendingAssign.file = file;
  extractID3Title(file).then(suggestedTitle => {
    const input = document.getElementById('title-input');
    input.value = suggestedTitle;
    showModal('modal-title');
    setTimeout(() => { input.focus(); input.select(); }, 80);
  });
}

function extractID3Title(file) {
  return new Promise((resolve) => {
    if (typeof window.jsmediatags === 'undefined') {
      resolve(cleanFilename(file.name));
      return;
    }
    try {
      window.jsmediatags.read(file, {
        onSuccess: (tag) => {
          const title = tag?.tags?.title;
          resolve((title && title.trim()) ? title.trim() : cleanFilename(file.name));
        },
        onError: () => resolve(cleanFilename(file.name)),
      });
    } catch {
      resolve(cleanFilename(file.name));
    }
  });
}

function cleanFilename(name) {
  return name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ').trim();
}

// ============================================================
// Title Save
// ============================================================

async function onTitleSave() {
  const title = document.getElementById('title-input').value.trim();
  if (!title) {
    document.getElementById('title-input').focus();
    return;
  }
  hideModal('modal-title');

  const { pageIndex, position, isReassign, oldIdbKey, file } = state.pendingAssign;
  state.pendingAssign = null;

  let idbKey = null;

  if (state.db && file) {
    try {
      if (isReassign && oldIdbKey != null) deleteAudioBlob(oldIdbKey);
      idbKey = await saveAudioBlob(file);
    } catch (err) {
      console.error('IDB save failed', err);
    }
  }

  const meta = {
    id:         boxId(pageIndex, position),
    pageIndex,
    position,
    title,
    idbKey,
    assignedAt: Date.now(),
  };

  upsertBox(meta);
  saveBoxes();
  replaceBoxInDOM(pageIndex, position);
}

// ============================================================
// Audio Player
// ============================================================

async function loadAndPlayTrack(meta) {
  const audio = document.getElementById('audio-element');

  if (state.player.idbKey === meta.idbKey) {
    togglePlayPause();
    return;
  }

  if (meta.idbKey == null || !state.db) {
    markBoxMissing(meta);
    return;
  }

  let blob;
  try {
    blob = await getAudioBlob(meta.idbKey);
  } catch {
    markBoxMissing(meta);
    return;
  }

  if (!blob) {
    markBoxMissing(meta);
    return;
  }

  if (state.player.blobUrl) URL.revokeObjectURL(state.player.blobUrl);
  const url = URL.createObjectURL(blob);

  state.player.idbKey  = meta.idbKey;
  state.player.blobUrl = url;
  state.player.playing = false;

  clearPlayingHighlight();

  audio.src = url;
  audio.load();

  document.getElementById('player-track-title').textContent = meta.title;
  document.getElementById('seek-bar').value = 0;
  document.getElementById('time-current').textContent = '0:00';
  document.getElementById('time-total').textContent   = '0:00';
  setPlayIcon(false);

  showPlayer();
  highlightPlayingBox(meta);

  audio.play().then(() => {
    state.player.playing = true;
    setPlayIcon(true);
  }).catch(() => {
    /* autoplay blocked — user can tap play */
  });
}

function togglePlayPause() {
  const audio = document.getElementById('audio-element');
  if (audio.paused) {
    audio.play().then(() => {
      state.player.playing = true;
      setPlayIcon(true);
    }).catch(() => {});
  } else {
    audio.pause();
    state.player.playing = false;
    setPlayIcon(false);
  }
}

function setPlayIcon(isPlaying) {
  document.getElementById('btn-play-pause').innerHTML = isPlaying ? '&#9646;&#9646;' : '&#9654;';
}

function onStop() {
  const audio = document.getElementById('audio-element');
  audio.pause();
  audio.currentTime = 0;
  state.player.playing = false;
  setPlayIcon(false);
  document.getElementById('seek-bar').value = 0;
  document.getElementById('time-current').textContent = '0:00';
}

function onRewind() {
  const audio = document.getElementById('audio-element');
  audio.currentTime = Math.max(0, audio.currentTime - 10);
}

function onFastForward() {
  const audio = document.getElementById('audio-element');
  if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
}

function onSeekBarInput() {
  const audio   = document.getElementById('audio-element');
  const seekBar = document.getElementById('seek-bar');
  if (isFinite(audio.duration)) audio.currentTime = (seekBar.value / 100) * audio.duration;
}

function onAudioTimeUpdate() {
  const audio   = document.getElementById('audio-element');
  const seekBar = document.getElementById('seek-bar');
  if (!isFinite(audio.duration)) return;
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  document.getElementById('time-current').textContent = formatTime(audio.currentTime);
  document.getElementById('time-total').textContent   = formatTime(audio.duration);
}

function onAudioEnded() {
  state.player.playing = false;
  setPlayIcon(false);
  document.getElementById('seek-bar').value = 0;
  document.getElementById('time-current').textContent = '0:00';
  clearPlayingHighlight();
}

function showPlayer() {
  const player = document.getElementById('player');
  player.classList.remove('hidden');
  requestAnimationFrame(() => player.classList.add('visible'));
}

function closePlayer() {
  const audio  = document.getElementById('audio-element');
  const player = document.getElementById('player');
  audio.pause();
  audio.src = '';
  if (state.player.blobUrl) { URL.revokeObjectURL(state.player.blobUrl); state.player.blobUrl = null; }
  state.player.idbKey  = null;
  state.player.playing = false;
  clearPlayingHighlight();
  player.classList.remove('visible');
  player.addEventListener('transitionend', () => player.classList.add('hidden'), { once: true });
}

function highlightPlayingBox(meta) {
  clearPlayingHighlight();
  const strip = document.getElementById('page-strip');
  const page  = strip.children[meta.pageIndex];
  if (!page) return;
  const grid  = page.querySelector('.grid');
  if (!grid)  return;
  const box   = grid.children[meta.position];
  if (box)    box.classList.add('playing');
}

function clearPlayingHighlight() {
  document.querySelectorAll('.grid-box.playing').forEach(b => b.classList.remove('playing'));
}

function markBoxMissing(meta) {
  const strip = document.getElementById('page-strip');
  const page  = strip.children[meta.pageIndex];
  if (!page) return;
  const grid  = page.querySelector('.grid');
  if (!grid)  return;
  const box   = grid.children[meta.position];
  if (!box)   return;
  box.classList.add('missing');
  const hint = box.querySelector('.box-play-hint');
  if (hint) hint.textContent = 'File missing — long press to reassign';
}

// ============================================================
// Modals
// ============================================================

function showModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  const overlay = document.getElementById('modal-overlay');
  const anyOpen = overlay.querySelectorAll('.modal:not(.hidden)').length > 0;
  if (!anyOpen) overlay.classList.add('hidden');
}

function onTitleCancel() {
  state.pendingAssign = null;
  hideModal('modal-title');
}

function onSettingsSave() {
  const cols = parseInt(document.getElementById('settings-cols').value, 10);
  const rows = parseInt(document.getElementById('settings-rows').value, 10);
  if (!isFinite(cols) || cols < 2 || cols > 8 || !isFinite(rows) || rows < 2 || rows > 8) return;
  state.grid = { cols, rows };
  saveGridSettings();
  hideModal('modal-settings');
  const strip = document.getElementById('page-strip');
  strip.classList.add('no-transition');
  renderAllPages();
  goToPage(0);
  requestAnimationFrame(() => strip.classList.remove('no-transition'));
}

function openSettings() {
  document.getElementById('settings-cols').value = state.grid.cols;
  document.getElementById('settings-rows').value = state.grid.rows;
  showModal('modal-settings');
}

// ============================================================
// Global Event Listeners
// ============================================================

function attachGlobalListeners() {
  // Header buttons
  document.getElementById('btn-add-page').addEventListener('click', addPage);
  document.getElementById('btn-remove-page').addEventListener('click', onRemovePageClick);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-about').addEventListener('click', () => showModal('modal-about'));

  // Page nav
  document.getElementById('btn-prev').addEventListener('click', () => goToPage(state.currentPage - 1));
  document.getElementById('btn-next').addEventListener('click', () => goToPage(state.currentPage + 1));

  // Swipe on stage
  const stage = document.getElementById('stage');
  stage.addEventListener('touchstart', onTouchStart, { passive: true });
  stage.addEventListener('touchend',   onTouchEnd,   { passive: true });

  // File input
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) onFileSelected(file);
    else state.pendingAssign = null;
  });

  // Title modal
  document.getElementById('btn-title-save').addEventListener('click', onTitleSave);
  document.getElementById('btn-title-cancel').addEventListener('click', onTitleCancel);
  document.getElementById('title-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onTitleSave();
    if (e.key === 'Escape') onTitleCancel();
  });

  // Settings modal
  document.getElementById('btn-settings-save').addEventListener('click', onSettingsSave);
  document.getElementById('btn-settings-cancel').addEventListener('click', () => hideModal('modal-settings'));

  // About modal
  document.getElementById('btn-about-close').addEventListener('click', () => hideModal('modal-about'));

  // Confirm unassign box modal
  document.getElementById('btn-confirm-unassign-ok').addEventListener('click', unassignBox);
  document.getElementById('btn-confirm-unassign-cancel').addEventListener('click', () => {
    state.pendingUnassign = null;
    hideModal('modal-confirm-unassign');
  });

  // Confirm remove page modal
  document.getElementById('btn-confirm-remove-ok').addEventListener('click', () => {
    hideModal('modal-confirm-remove');
    removePage(state.currentPage);
  });
  document.getElementById('btn-confirm-remove-cancel').addEventListener('click', () => hideModal('modal-confirm-remove'));

  // Overlay click outside modal
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => {
        if (m.id === 'modal-title') onTitleCancel();
        else hideModal(m.id);
      });
    }
  });

  // Audio player controls
  document.getElementById('btn-player-close').addEventListener('click', closePlayer);
  document.getElementById('btn-play-pause').addEventListener('click',  togglePlayPause);
  document.getElementById('btn-stop').addEventListener('click',         onStop);
  document.getElementById('btn-rewind').addEventListener('click',       onRewind);
  document.getElementById('btn-fast-forward').addEventListener('click', onFastForward);
  document.getElementById('seek-bar').addEventListener('input',         onSeekBarInput);

  const audio = document.getElementById('audio-element');
  audio.addEventListener('timeupdate', onAudioTimeUpdate);
  audio.addEventListener('ended',      onAudioEnded);
  audio.addEventListener('durationchange', onAudioTimeUpdate);
}

// ============================================================
// Init
// ============================================================

async function init() {
  loadGridSettings();
  loadPageCount();
  loadBoxes();

  await initDB();

  const strip = document.getElementById('page-strip');
  strip.classList.add('no-transition');
  renderAllPages();
  goToPage(0);
  requestAnimationFrame(() => strip.classList.remove('no-transition'));

  attachGlobalListeners();
}

document.addEventListener('DOMContentLoaded', init);
