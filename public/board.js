// The evidence board: a collection's documents on a canvas, with notes, groups,
// connections and a timeline slider. Opened over the search page, whose helpers
// it uses (apiFetch, collectionsApi, loadFullText and so on).
//
// Everything from the index is shown with textContent, never innerHTML: titles
// and metadata come from indexed files, which anyone could have written.
(() => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CARD_W = 220;
  const CARD_H = 90;       // only until a card's been measured
  const GROUP_PAD = 24;
  const GROUP_HEAD = 40;
  const GROUP_GAP = 20;
  const GROUP_MARGIN = 50;
  const SECTION_H = 36;
  const SECTION_PAD = 12;
  const SECTION_GAP = 16;
  const MAX_SECTIONS = 100;  // lib/board.js allows more, but past this they don't help
  const ARRANGEMENTS = [['', 'No sections'], ['date', 'Date'], ['subject', 'Subject'], ['sender', 'Sender'], ['type', 'File type']];
  const MAX_BOARD_CONNECTIONS = 3000;
  const MAX_BOARD_GROUPS = 1000;  // lib/board.js refuses to save more
  const MAX_DISMISSED = 5000;
  const COLLAPSED_W = 220;
  const COLLAPSED_H = 40;
  const MIN_GROUP_W = 160;
  const MIN_GROUP_H = 100;
  const MIN_ZOOM = 0.05;
  // Below this, cards are drawn as plain boxes: their text is too small to read,
  // and drawing thousands of them made moving around slow.
  const FAR_ZOOM = 0.4;
  const MAX_ZOOM = 2.5;
  const HISTORY = 50;
  const SAVE_DELAY = 800;
  const SAVE_RETRY = 5000;
  const KEEPALIVE_MAX = 60000;  // browsers refuse much more than this in a request outliving the page
  const HIST_BINS = 80;
  const PLAY_TICK = 80;
  const PLAY_STEPS = 200;
  const SHOW_TEXT_KEY = 'frogmouth.boardShowText';
  const HIDE_KEY = 'frogmouth.boardHideOut';
  // The sidebars' widths, and whether the right one is hidden, as last left in this browser.
  const SIDES = {
    tray: { key: 'frogmouth.boardTrayWidth', css: '--tray-size', width: 250, min: 180 },
    inspector: { key: 'frogmouth.boardInspectorWidth', css: '--inspector-size', width: 300, min: 220 },
  };
  const NO_INSPECTOR_KEY = 'frogmouth.boardNoInspector';
  const KINDS = { doc: 'Document', note: 'Note', person: 'Person', place: 'Place', org: 'Organisation', event: 'Event' };
  const COLORS = ['default', 'teal', 'amber', 'red', 'violet', 'blue'];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let s = null;  // the open board

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  function button(text, onClick, opts = {}) {
    const b = el('button', opts.className, text);
    b.type = 'button';
    if (opts.title) b.title = opts.title;
    b.addEventListener('click', onClick);
    return b;
  }

  // Not crypto.randomUUID: that's only there over HTTPS or on localhost.
  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  const objectById = id => s.data.objects.find(o => o.id === id);
  const groupById = id => s.data.groups.find(g => g.id === id);
  const membersOf = id => s.data.objects.filter(o => o.group === id);
  const placedDocs = () => new Set(s.data.objects.filter(o => o.kind === 'doc').map(o => o.doc_id));
  const isGroupId = id => Boolean(groupById(id));
  const toDay = ms => Math.floor(ms / DAY_MS);
  const isoOfDay = day => new Date(day * DAY_MS).toISOString().slice(0, 10);
  const fmtDay = day => new Date(day * DAY_MS).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });

  // ----- What a document's card says -----
  function sourceOf(doc) { return SOURCES_BY_HOST[firstOf(doc.source)] || {}; }
  function docIsMail(doc) { return sourceOf(doc).layout === 'email'; }
  function docTitle(doc) {
    return firstOf(doc.email_subject) || firstOf(doc.title)
      || firstOf(doc.filename) || String(doc.id).split('/').pop() || 'Untitled';
  }

  function timeOf(o) {
    if (o.date) return Date.parse(`${o.date}T00:00:00Z`);
    if (o.kind !== 'doc') return null;
    const doc = s.docs[o.doc_id];
    return doc && Number.isFinite(doc.time) ? doc.time : null;
  }

  function dateText(o) {
    const t = timeOf(o);
    if (t === null) return o.kind === 'doc' && s.docs[o.doc_id] ? 'Undated' : '';
    const day = fmtDay(toDay(t));
    if (o.date) return o.kind === 'doc' ? `Event: ${day}` : day;
    return `${dateSource(s.docs[o.doc_id], docIsMail(s.docs[o.doc_id]))}: ${day}`;
  }

  // ----- Open and close -----
  window.openBoard = async function openBoard(collection, onClose) {
    if (s) return;
    const root = el('div', 'board');
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', `Board for ${collection.name}`);
    root.classList.toggle('hide-out', loadPref(HIDE_KEY) === '1');
    root.classList.toggle('no-tray', window.matchMedia('(max-width: 1000px)').matches);
    root.classList.toggle('no-inspector', loadPref(NO_INSPECTOR_KEY) === '1');
    Object.entries(SIDES).forEach(([side, { key }]) => {
      const saved = Number(loadPref(key));
      if (saved) setSideWidth(root, side, saved);
    });
    s = {
      collection, onClose, root, data: { objects: [], groups: [], connections: [] }, docs: {}, items: [], hiddenItems: 0,
      revision: 0, view: { x: 0, y: 0, k: 1 }, selected: new Set(), selectedLink: null, connecting: null,
      undo: [], redo: [], snapshot: '', savedJson: '', saveTimer: null, retryTimer: null, saving: false, conflict: false,
      saveFailed: false, closeArmed: false, range: null, bounds: null, nodes: new Map(), sizes: new Map(), trayFilter: '',
      playTimer: null, loaded: false, cleanups: [], find: emptyFind(),
    };
    buildShell();
    document.body.appendChild(root);
    document.body.classList.add('board-open');
    root.focus();
    listen(document, 'keydown', onKeyDown);
    listen(document, 'keyup', e => { if (e.code === 'Space') setSpaceHeld(false); });
    listen(window, 'blur', () => setSpaceHeld(false));
    listen(window, 'beforeunload', onBeforeUnload);
    listen(window, 'pagehide', onPageHide);
    await load();
  };

  function listen(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    s.cleanups.push(() => target.removeEventListener(type, handler, opts));
  }

  async function load() {
    const board = s;
    setStatus('Loading…');
    try {
      const data = await collectionsApi('GET', `/api/collections/${board.collection.id}/board`);
      if (s !== board) return;
      const { revision, objects, groups, connections, dismissed, view } = data.board;
      Object.assign(s, {
        suggest: null, panel: null, revision, data: { objects, groups, connections, dismissed: dismissed || [] }, docs: data.docs, items: data.items, hiddenItems: data.hidden,
        undo: [], redo: [], conflict: false, saveFailed: false, loaded: true, range: null, selectedLink: null,
      });
      s.selected.clear();
      s.snapshot = s.savedJson = JSON.stringify(s.data);
      s.els.name.textContent = data.collection.name;
      setStatus('Saved');
      s.highlight = null;
      renderAll();
      renderInspector();
      if (view) {
        s.view = view;
        applyView();
      } else {
        fitView();
      }
      s.savedView = JSON.stringify(s.view);
      layOutPending();
    } catch (err) {
      if (s !== board) return;
      setStatus(`Couldn't load the board: ${err.message}`, true);
      s.els.empty.textContent = 'This board could not be loaded. Close it and try again.';
      s.els.empty.hidden = false;
    }
  }

  // Groups made on the timeline, laid out now that card sizes are known: in a row
  // to the right of everything else, with room made around them, and shown. This
  // isn't an undo step (undoing it would pile the cards up), but it's saved.
  function layOutPending() {
    const pending = s.data.groups.filter(g => g.pending);
    if (!pending.length) return;
    const pendingIds = new Set(pending.map(g => g.id));
    const settled = [...s.data.groups.filter(g => !g.pending), ...s.data.objects.filter(o => !pendingIds.has(o.group))]
      .map(item => rectOf(item.id)).filter(Boolean);
    let x = settled.length ? Math.max(...settled.map(r => r.x + r.w)) + 80 : 0;
    const y = settled.length ? Math.min(...settled.map(r => r.y)) : 0;
    for (const g of pending) {
      delete g.pending;
      Object.assign(g, { x, y });
      layOutGroup(g);
      makeRoomFor(g);
      x = g.x + g.w + GROUP_MARGIN;
    }
    s.snapshot = JSON.stringify(s.data);
    renderAll();
    select([...pendingIds]);
    fitView([...pendingIds]);
    scheduleSave();
    setStatus(pending.length === 1 ? `Laid out "${pending[0].title}", grouped on the timeline.` : `Laid out ${pending.length} groups made on the timeline.`);
  }

  async function closeBoard() {
    if (!s) return;
    if (s.loaded && (isDirty() || viewMoved()) && !s.conflict) {
      await saveNow(true);
      if (!s) return;
      if (isDirty() && !s.closeArmed) {
        s.closeArmed = true;
        s.els.close.textContent = 'Close without saving';
        setStatus('Your latest changes could not be saved. Close again to lose them.', true);
        return;
      }
    }
    const { onClose } = s;
    stopPlay();
    clearTimeout(s.saveTimer);
    clearTimeout(s.retryTimer);
    s.cleanups.forEach(fn => fn());
    s.root.remove();
    document.body.classList.remove('board-open');
    s = null;
    if (onClose) onClose();
  }

  function onBeforeUnload(e) {
    if (s.loaded && isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  // A last try as the page goes, if it's small enough to be allowed.
  function onPageHide() {
    if (!s.loaded || !isDirty() || s.conflict) return;
    const body = JSON.stringify({ revision: s.revision, board: { ...s.data, view: s.view } });
    if (body.length > KEEPALIVE_MAX) return;
    fetch(boardUrl(), { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
  }

  const boardUrl = () => `/api/collections/${s.collection.id}/board`;

  // ----- Saving and undo -----
  const isDirty = () => JSON.stringify(s.data) !== s.savedJson;
  // Moving around isn't a change to the board, so it's only saved along with
  // one, by Save, or on closing, and never asks about leaving the page.
  const viewMoved = () => JSON.stringify(s.view) !== s.savedView;

  function setStatus(text, error) {
    s.els.status.classList.toggle('error', Boolean(error));
    s.els.statusText.textContent = text;
    s.els.reload.hidden = !s.conflict;
  }

  // After a finished change: one undo step, and a save soon.
  function commit() {
    const now = JSON.stringify(s.data);
    if (now === s.snapshot) return;
    s.undo.push(s.snapshot);
    if (s.undo.length > HISTORY) s.undo.shift();
    s.redo = [];
    s.snapshot = now;
    renderAll();
    scheduleSave();
  }

  function restore(from, to) {
    if (!from.length) return;
    to.push(s.snapshot);
    s.snapshot = from.pop();
    s.data = JSON.parse(s.snapshot);
    s.selected = new Set([...s.selected].filter(id => objectById(id) || groupById(id)));
    if (s.selectedLink && !s.data.connections.some(c => c.id === s.selectedLink)) s.selectedLink = null;
    renderAll();
    renderInspector();
    scheduleSave();
  }

  function scheduleSave() {
    if (s.conflict) return;
    s.closeArmed = false;
    s.els.close.textContent = 'Close';
    setStatus('Saving…');
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }

  // Sends the board as it is now, if it's changed or force is set. A change made
  // during a save gets a save of its own afterwards. Resolves when nothing's in flight.
  async function saveNow(force = false) {
    const board = s;
    clearTimeout(board.saveTimer);
    clearTimeout(board.retryTimer);
    if (board.saving) {
      await board.saving;
      return s === board && (force || isDirty()) ? saveNow(force) : undefined;
    }
    if (board.conflict) return;
    // Undoing back to what's saved leaves nothing to send.
    if (!isDirty() && !(force && viewMoved())) {
      board.saveFailed = false;
      setStatus('Saved');
      return;
    }
    const json = JSON.stringify(board.data);
    const viewJson = JSON.stringify(board.view);
    board.saving = (async () => {
      try {
        const res = await apiFetch(boardUrl(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: board.revision, board: { ...board.data, view: board.view } }),
        });
        const data = await res.json().catch(() => ({}));
        if (s !== board) return;
        if (res.status === 409) {
          s.conflict = true;
          setStatus('Changed in another window. Reload to get the latest; changes made here since the last save are lost.', true);
          return;
        }
        if (!res.ok) {
          // A rejected board won't do better next time, but a later edit might fix it.
          s.saveFailed = true;
          setStatus(`Couldn't save: ${data.error || res.statusText}. Undo your last change, then it can save again.`, true);
          return;
        }
        s.revision = data.revision;
        s.savedJson = json;
        s.savedView = viewJson;
        s.saveFailed = false;
        if (!isDirty()) setStatus('Saved');
      } catch (err) {
        if (s !== board) return;
        s.saveFailed = true;
        setStatus('Couldn\'t save. Trying again…', true);
        s.retryTimer = setTimeout(saveNow, SAVE_RETRY);
      }
    })();
    await board.saving;
    board.saving = false;
    if (s === board && isDirty() && !s.conflict && !s.saveFailed) await saveNow();
  }

  // ----- The page's structure -----
  function buildShell() {
    const { root } = s;
    s.els = {};
    const bar = el('div', 'board-bar');
    const name = el('div', 'board-name', s.collection.name);
    const tools = el('div', 'board-tools');
    const addTool = kind => button(`+ ${kind === 'org' ? 'Org' : KINDS[kind]}`, () => addObject(kind), { title: `Add ${KINDS[kind].toLowerCase()}` });
    tools.append(...['note', 'person', 'place', 'org', 'event'].map(addTool));
    const edit = el('div', 'board-tools');
    const group = button('Group', groupSelection, { title: 'Put a frame around what\'s selected, or add an empty one' });
    const connect = button('Connect', () => setConnecting(s.connecting ? null : { from: null }), { title: 'Click one item, then another, to connect them (Esc to stop)' });
    const undo = button('Undo', () => restore(s.undo, s.redo), { title: 'Undo (Ctrl+Z)' });
    const redo = button('Redo', () => restore(s.redo, s.undo), { title: 'Redo (Ctrl+Shift+Z)' });
    const suggest = button('Suggest', openSuggestions, { title: 'Suggest connections and groupings from the documents on the board' });
    const resetBoard = button('Reset board', () => openPanel({ reset: true }), { title: 'Clear the board and start again' });
    edit.append(suggest, group, connect, undo, redo, resetBoard);
    const viewTools = el('div', 'board-tools');
    // Small, as the toolbar is full: a square with that side filled in.
    const tray = button('\u25E7', () => root.classList.toggle('no-tray'), { className: 'board-side-toggle', title: 'Show or hide the left sidebar: Find, and the documents not on the board' });
    tray.setAttribute('aria-label', 'Left panel');
    const side = button('\u25E8', () => showInspector(root.classList.contains('no-inspector')), { className: 'board-side-toggle', title: 'Show or hide the right sidebar, with the details of what\'s selected' });
    side.setAttribute('aria-label', 'Right panel');
    const find = button('Find', () => showSide('find', true), { title: 'Search and filter what\'s on the board (Ctrl+F)' });
    viewTools.append(find, tray, side, button('Fit', fitView, { title: 'Bring everything into view' }),
      button('−', () => zoomBy(1 / 1.25), { title: 'Zoom out' }), button('+', () => zoomBy(1.25), { title: 'Zoom in' }));
    const status = el('div', 'board-status');
    status.setAttribute('aria-live', 'polite');
    const statusText = el('span');
    const reload = button('Reload', () => { s.conflict = false; load(); });
    reload.hidden = true;
    status.append(statusText, reload);
    const versions = button('Versions', openVersions, { title: 'Save a named version of this board, or go back to one' });
    const save = button('Save', saveByHand, { title: 'Save now, including where you\'ve zoomed and panned to, so it reopens there (Ctrl+S)' });
    const close = button('Close', closeBoard);
    bar.append(name, tools, edit, viewTools, status, versions, save, close);
    // A clicked button keeps focus, and holding Space to pan would press it again.
    root.addEventListener('click', e => {
      if (e.detail > 0 && e.target.closest('button')) e.target.closest('button').blur();
    });

    const trayEl = el('aside', 'board-tray');
    const trayHead = el('div', 'board-tray-head');
    const trayTitle = el('span', 'board-panel-title', 'Not on the board');
    const placeAll = button('Place all', placeAllDocs, { title: 'Lay out every document listed here, in date order' });
    trayHead.append(trayTitle, placeAll);
    const trayFilter = el('input');
    trayFilter.type = 'text';
    trayFilter.placeholder = 'Filter…';
    trayFilter.setAttribute('aria-label', 'Filter the documents not on the board');
    trayFilter.addEventListener('input', () => { s.trayFilter = trayFilter.value.trim().toLowerCase(); renderTray(); });
    const trayList = el('div', 'board-tray-list');
    const trayNote = el('div', 'board-note');
    // The sidebar: Find, or the documents not on the board yet.
    const tabs = el('div', 'board-side-tabs');
    const findTab = button('Find', () => showSide('find'), { className: 'board-side-tab' });
    const trayTab = button('Not on board', () => showSide('tray'), { className: 'board-side-tab', title: 'The collection\'s documents not on the board yet' });
    tabs.append(findTab, trayTab);
    const trayPane = el('div', 'board-side-pane');
    trayPane.append(trayHead, trayFilter, trayList, trayNote);
    trayEl.append(tabs, trayPane, buildFind());

    const canvas = el('div', 'board-canvas');
    const world = el('div', 'board-world');
    const groupsLayer = el('div');
    const links = svg('svg', { class: 'board-links' });
    const cardsLayer = el('div');
    world.append(groupsLayer, links, cardsLayer);
    const empty = el('div', 'board-empty');
    empty.hidden = true;
    canvas.append(world, empty);

    const inspector = el('aside', 'board-inspector');
    const time = el('div', 'board-time');

    root.append(bar, trayEl, canvas, inspector, time, sideHandle('tray'), sideHandle('inspector'));
    Object.assign(s.els, { save, name, undo, redo, connect, group, status, statusText, reload, close, trayList, trayNote, trayTitle, placeAll,
              canvas, world, groupsLayer, links, cardsLayer, empty, inspector, time, findTab, trayTab, trayPane });
    showSide('tray', false, false);

    canvas.addEventListener('pointerdown', onCanvasDown);
    // Otherwise the middle button starts the browser's own autoscroll.
    canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onCanvasDblClick);
    // Tabbing to a card can scroll this even though it hides overflow.
    canvas.addEventListener('scroll', () => { canvas.scrollTop = 0; canvas.scrollLeft = 0; });
    links.addEventListener('pointerdown', onLinkDown);
    buildTime();
  }

  // ----- Drawing -----
  function renderAll() {
    renderNodes();
    renderLinks();
    renderTray();
    renderTime();
    applyRange();
    refreshFindChoices();
    applyFind();
    updateToolbar();
    s.els.empty.hidden = s.data.objects.length + s.data.groups.length > 0;
    if (!s.els.empty.hidden) return;
    s.els.empty.textContent = s.items.length
      ? 'Drag documents here from the tray, or add a note from the toolbar.\nScroll to zoom, and hold Space and drag to pan.'
      : 'This collection has no documents yet. You can still add notes from the toolbar.';
    s.els.empty.style.whiteSpace = 'pre-line';
  }

  function updateToolbar() {
    s.els.undo.disabled = !s.undo.length;
    s.els.redo.disabled = !s.redo.length;
    s.els.group.textContent = s.selected.size && [...s.selected].some(objectById) ? 'Group selected' : 'Group';
  }

  function renderNodes() {
    s.nodes.clear();
    s.els.groupsLayer.replaceChildren(...s.data.groups.map(buildGroup));
    const shown = s.data.objects.filter(o => !isCollapsedMember(o));
    s.els.cardsLayer.replaceChildren(...shown.map(buildCard));
    measure();
  }

  const isCollapsedMember = o => {
    const g = o.group && groupById(o.group);
    return Boolean(g && g.collapsed);
  };

  function measure() {
    s.sizes.clear();
    s.nodes.forEach((node, id) => s.sizes.set(id, { w: node.offsetWidth, h: node.offsetHeight }));
  }

  function place(node, item) { node.style.transform = `translate(${item.x}px, ${item.y}px)`; }

  function addHandle(node, id) {
    const handle = el('div', 'board-handle');
    handle.title = 'Drag to another item to connect them';
    handle.addEventListener('pointerdown', e => startLinkDrag(e, id));
    node.appendChild(handle);
  }

  function buildCard(o) {
    const doc = o.kind === 'doc' ? s.docs[o.doc_id] : null;
    const unavailable = o.kind === 'doc' && !doc;
    const card = el('div', `board-node board-card kind-${o.kind} color-${o.color}${unavailable ? ' unavailable' : ''}`);
    card.dataset.node = o.id;
    card.tabIndex = 0;
    place(card, o);
    const title = doc ? docTitle(doc) : unavailable ? 'A document you can no longer see' : o.title || `Untitled ${KINDS[o.kind].toLowerCase()}`;
    card.setAttribute('aria-label', `${KINDS[o.kind]}: ${title}`);
    const kindLabel = doc ? firstOf(doc.type) || KINDS.doc : KINDS[o.kind];
    card.append(el('div', 'board-card-kind', kindLabel), el('div', 'board-card-title', title));
    if (o.text) card.append(el('div', 'board-card-text', o.text));
    const date = dateText(o);
    if (date) card.append(el('div', 'board-card-meta', date));
    if (doc && !s.items.includes(o.doc_id)) card.append(el('div', 'board-card-flag', 'Removed from the collection'));
    card.classList.toggle('selected', s.selected.has(o.id));
    card.classList.toggle('weak-highlight', Boolean(s.highlight && s.highlight.ids.has(o.id)));
    addHandle(card, o.id);
    card.addEventListener('pointerdown', e => onNodeDown(e, o.id));
    card.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (s.connecting) connectClick(o.id);
      else select([o.id]);
    });
    s.nodes.set(o.id, card);
    return card;
  }

  function buildGroup(g) {
    const node = el('div', `board-node board-group color-${g.color}`);
    node.dataset.node = g.id;
    place(node, g);
    node.style.width = `${g.collapsed ? COLLAPSED_W : g.w}px`;
    node.style.height = `${g.collapsed ? COLLAPSED_H : g.h}px`;
    const head = el('div', 'board-group-head');
    const count = membersOf(g.id).length;
    const toggle = button(g.collapsed ? '+' : '−', () => {
      g.collapsed = !g.collapsed;
      commit();
      renderInspector();
    }, { className: 'board-group-toggle', title: g.collapsed ? 'Expand' : 'Collapse' });
    toggle.addEventListener('pointerdown', e => e.stopPropagation());
    head.append(toggle, el('span', 'board-group-title', g.title || 'Untitled group'), el('span', 'board-group-count', String(count)));
    node.appendChild(head);
    if (!g.collapsed) {
      const size = el('div', 'board-group-size');
      size.title = 'Drag to resize';
      size.addEventListener('pointerdown', e => startResize(e, g));
      node.appendChild(size);
      sectionsNow(g).forEach(({ section, cards, whole }) => {
        const label = el('div', 'board-section');
        label.append(el('span', 'board-section-title', section.title), el('span', 'board-group-count', String(cards.length)));
        const make = button('Make group', () => sectionToGroup(g, section), { title: 'Make this section a group of its own' });
        make.disabled = whole;
        make.addEventListener('pointerdown', e => e.stopPropagation());
        label.append(make);
        if (section.h) {
          const box = el('div', 'board-section-box');
          Object.assign(box.style, { left: `${section.x}px`, top: `${section.y}px`, width: `${section.w}px`, height: `${section.h}px` });
          box.appendChild(label);
          node.appendChild(box);
        } else {
          // Laid out before sections had boxes, until it's next re-shuffled.
          label.style.top = `${section.y}px`;
          node.appendChild(label);
        }
      });
    }
    node.classList.toggle('selected', s.selected.has(g.id));
    addHandle(node, g.id);
    // Only the title bar picks a group up, so the canvas inside it still pans.
    head.addEventListener('pointerdown', e => onNodeDown(e, g.id));
    s.nodes.set(g.id, node);
    return node;
  }

  // Where an id is drawn: its collapsed group if it's tucked away in one.
  function drawnId(id) {
    const o = objectById(id);
    return o && isCollapsedMember(o) ? o.group : id;
  }

  function rectOf(id) {
    const item = objectById(id) || groupById(id);
    if (!item) return null;
    const size = s.sizes.get(id) || { w: CARD_W, h: CARD_H };
    return { x: item.x, y: item.y, w: size.w, h: size.h };
  }

  // Where the line from a rectangle's centre towards a point leaves it.
  function edgePoint(rect, tx, ty) {
    const [cx, cy] = [rect.x + rect.w / 2, rect.y + rect.h / 2];
    const [dx, dy] = [tx - cx, ty - cy];
    if (!dx && !dy) return { x: cx, y: cy };
    const scale = Math.min(dx ? (rect.w / 2) / Math.abs(dx) : Infinity, dy ? (rect.h / 2) / Math.abs(dy) : Infinity);
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  function renderLinks() {
    const shapes = [];
    for (const c of s.data.connections) {
      const [from, to] = [drawnId(c.from), drawnId(c.to)];
      if (from === to) continue;  // both inside one collapsed group
      const [a, b] = [rectOf(from), rectOf(to)];
      if (!a || !b) continue;
      const start = edgePoint(a, b.x + b.w / 2, b.y + b.h / 2);
      const end = edgePoint(b, a.x + a.w / 2, a.y + a.h / 2);
      const color = `var(--color-${c.color})`;
      const line = { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
      const shape = svg('g', { class: `board-link${c.id === s.selectedLink ? ' selected' : ''}`, 'data-link': c.id });
      shape.append(svg('line', { ...line, class: 'board-link-line', stroke: color }));
      if (c.directed) {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const point = (len, off) => `${end.x - len * Math.cos(angle + off)},${end.y - len * Math.sin(angle + off)}`;
        shape.append(svg('polygon', { points: `${end.x},${end.y} ${point(11, 0.45)} ${point(11, -0.45)}`, fill: color }));
      }
      shape.append(svg('line', { ...line, class: 'board-link-hit', 'data-link': c.id }));
      if (c.label) {
        const label = svg('text', { class: 'board-link-label', x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        label.textContent = c.label;
        shape.append(label);
      }
      shapes.push(shape);
    }
    const temp = s.els.links.querySelector('.board-link-temp');
    s.els.links.replaceChildren(...shapes, ...(temp ? [temp] : []));
    applyLinkRange();
  }

  function queueLinks() {
    if (s.linksQueued) return;
    s.linksQueued = true;
    requestAnimationFrame(() => {
      if (!s) return;
      s.linksQueued = false;
      renderLinks();
    });
  }

  function applyView() {
    const { x, y, k } = s.view;
    s.els.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    s.root.classList.toggle('far', k < FAR_ZOOM);
    const step = 24 * k;
    s.els.canvas.style.backgroundSize = `${step}px ${step}px`;
    s.els.canvas.style.backgroundPosition = `${x}px ${y}px`;
  }

  function worldAt(clientX, clientY) {
    const r = s.els.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - s.view.x) / s.view.k, y: (clientY - r.top - s.view.y) / s.view.k };
  }

  function zoomAround(px, py, factor) {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.view.k * factor));
    const ratio = k / s.view.k;
    s.view = { k, x: px - (px - s.view.x) * ratio, y: py - (py - s.view.y) * ratio };
    applyView();
  }

  async function saveByHand() {
    if (!s.loaded) return;
    const board = s;
    if (board.conflict) return;
    await saveNow(true);
    if (s !== board || isDirty() || viewMoved()) return;
    const { save } = s.els;
    save.textContent = 'Saved ✓';
    clearTimeout(s.savedFlash);
    s.savedFlash = setTimeout(() => { if (s === board) save.textContent = 'Save'; }, 1500);
  }

  function zoomBy(factor) {
    const r = s.els.canvas.getBoundingClientRect();
    zoomAround(r.width / 2, r.height / 2, factor);
  }

  function onWheel(e) {
    e.preventDefault();
    const r = s.els.canvas.getBoundingClientRect();
    zoomAround(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }

  // Everything in view, or just these.
  function fitView(ids) {
    // Also a button's handler, given its click event.
    const rects = (Array.isArray(ids) ? ids : [...s.nodes.keys()]).map(rectOf).filter(Boolean);
    const r = s.els.canvas.getBoundingClientRect();
    if (!rects.length) {
      s.view = { x: r.width / 2, y: r.height / 2, k: 1 };
      return applyView();
    }
    const left = Math.min(...rects.map(b => b.x));
    const top = Math.min(...rects.map(b => b.y));
    const right = Math.max(...rects.map(b => b.x + b.w));
    const bottom = Math.max(...rects.map(b => b.y + b.h));
    const margin = 40;
    const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((r.width - margin * 2) / (right - left), (r.height - margin * 2) / (bottom - top))));
    s.view = { k, x: (r.width - (right - left) * k) / 2 - left * k, y: (r.height - (bottom - top) * k) / 2 - top * k };
    applyView();
  }

  // ----- Selecting -----
  function setHighlight(highlight) {
    s.highlight = highlight;
    s.root.classList.toggle('highlighting', Boolean(highlight));
    s.nodes.forEach((node, id) => node.classList.toggle('weak-highlight', Boolean(highlight && highlight.ids.has(id))));
  }

  function select(ids, link = null) {
    // A highlight belongs to the group it's for.
    if (s.highlight && !(ids.length === 1 && ids[0] === s.highlight.group)) setHighlight(null);
    s.rerated = null;
    s.selected = new Set(ids);
    s.selectedLink = link;
    s.nodes.forEach((node, id) => node.classList.toggle('selected', s.selected.has(id)));
    s.els.links.querySelectorAll('.board-link').forEach(g => g.classList.toggle('selected', g.dataset.link === link));
    markFindRows(true);
    updateToolbar();
    renderInspector();
  }

  // A field being edited finishes first, so that its change isn't lost.
  function finishEditing() {
    const active = document.activeElement;
    if (active && s.root.contains(active) && active.matches('input, textarea')) active.blur();
  }

  // ----- Dragging on the canvas -----
  function onCanvasDown(e) {
    const onItem = e.target.closest('[data-node]:not(.board-group), .board-group-head, .board-handle, .board-group-size, .board-link-hit');
    // A finger has no Space or middle button, so on empty canvas it pans.
    const pan = s.spaceHeld || e.button === 1 || (e.pointerType === 'touch' && !onItem);
    if (!pan && (e.button !== 0 || onItem)) return;
    finishEditing();
    if (!pan && s.connecting) return setConnecting(null);
    const { canvas } = s.els;
    canvas.setPointerCapture(e.pointerId);
    const [startX, startY] = [e.clientX, e.clientY];
    const moved = ev => Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3;
    let marquee = null;
    let dragged = false;
    const original = { ...s.view };
    const base = worldAt(startX, startY);
    const additive = e.shiftKey;
    const onMove = ev => {
      if (!dragged && !moved(ev)) return;
      dragged = true;
      if (!pan) {
        const r = canvas.getBoundingClientRect();
        if (!marquee) {
          marquee = el('div', 'board-marquee');
          canvas.appendChild(marquee);
        }
        marquee.style.left = `${Math.min(startX, ev.clientX) - r.left}px`;
        marquee.style.top = `${Math.min(startY, ev.clientY) - r.top}px`;
        marquee.style.width = `${Math.abs(ev.clientX - startX)}px`;
        marquee.style.height = `${Math.abs(ev.clientY - startY)}px`;
      } else {
        canvas.classList.add('panning');
        // Zoomed far out, drawn once and moved while it's only moving: not for good,
        // as text drawn like that stays blurred after zooming in, and not close up,
        // where the board is far bigger than the window and that's slower.
        if (s.view.k < FAR_ZOOM) s.els.world.style.willChange = 'transform';
        s.view = { ...original, x: original.x + ev.clientX - startX, y: original.y + ev.clientY - startY };
        applyView();
      }
    };
    const onUp = ev => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.classList.remove('panning');
      s.els.world.style.willChange = '';
      if (marquee) {
        marquee.remove();
        const end = worldAt(ev.clientX, ev.clientY);
        const [x0, x1] = [Math.min(base.x, end.x), Math.max(base.x, end.x)];
        const [y0, y1] = [Math.min(base.y, end.y), Math.max(base.y, end.y)];
        const showing = id => s.nodes.has(id) && !s.nodes.get(id).classList.contains('out-of-range');
        const cards = s.data.objects.filter(o => {
          const r = rectOf(o.id);
          return showing(o.id) && r.x + r.w >= x0 && r.x <= x1 && r.y + r.h >= y0 && r.y <= y1;
        });
        // A frame only when it's wholly inside, as dragging within one is common.
        const frames = s.data.groups.filter(g => {
          const r = rectOf(g.id);
          return showing(g.id) && r.x >= x0 && r.x + r.w <= x1 && r.y >= y0 && r.y + r.h <= y1;
        });
        const hits = [...cards, ...frames].map(item => item.id);
        select(additive ? [...s.selected, ...hits] : hits);
      } else if (!dragged && !additive && !pan) {
        select([]);
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  function onCanvasDblClick(e) {
    if (e.target.closest('[data-node]:not(.board-group), .board-group-head, .board-link-hit')) return;
    const p = worldAt(e.clientX, e.clientY);
    addObject('note', { x: p.x - CARD_W / 2, y: p.y - 30 });
  }

  function onNodeDown(e, id) {
    if (e.button !== 0 || s.spaceHeld || e.target.closest('.board-handle, .board-group-size, .board-group-toggle')) return;
    e.stopPropagation();
    finishEditing();
    if (s.connecting) return connectClick(id);
    if (e.shiftKey) {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return select([...next]);
    }
    const wasSelected = s.selected.has(id);
    if (!wasSelected) select([id]);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    // What moves: the selection, and the members of any group in it.
    const moving = new Map();
    const take = item => moving.set(item.id, { item, x: item.x, y: item.y });
    s.selected.forEach(sel => {
      const o = objectById(sel);
      if (o) take(o);
      const g = groupById(sel);
      if (g) {
        take(g);
        membersOf(g.id).forEach(take);
      }
    });
    const [startX, startY] = [e.clientX, e.clientY];
    let dragged = false;
    const onMove = ev => {
      const dx = (ev.clientX - startX) / s.view.k;
      const dy = (ev.clientY - startY) / s.view.k;
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      dragged = true;
      moving.forEach(({ item, x, y }, movedId) => {
        item.x = Math.round(x + dx);
        item.y = Math.round(y + dy);
        const node = s.nodes.get(movedId);
        if (node) place(node, item);
      });
      queueLinks();
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      if (dragged) {
        const groupsMoving = new Set([...s.selected].filter(isGroupId));
        moving.forEach(({ item }) => {
          // A card carried along by its group stays in it.
          if (item.kind && !groupsMoving.has(item.group)) item.group = groupAt(item);
        });
        commit();
      } else if (wasSelected && s.selected.size > 1) {
        select([id]);
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  // The open group a card's centre is in; the smallest, if frames overlap.
  function groupAt(o) {
    const r = rectOf(o.id);
    const [cx, cy] = [r.x + r.w / 2, r.y + r.h / 2];
    const inside = s.data.groups.filter(g => !g.collapsed && cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h);
    inside.sort((a, b) => a.w * a.h - b.w * b.h);
    return inside.length ? inside[0].id : null;
  }

  function startResize(e, g) {
    if (e.button !== 0) return;
    e.stopPropagation();
    finishEditing();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const [startX, startY, w, h] = [e.clientX, e.clientY, g.w, g.h];
    const node = s.nodes.get(g.id);
    const onMove = ev => {
      g.w = Math.round(Math.max(MIN_GROUP_W, w + (ev.clientX - startX) / s.view.k));
      g.h = Math.round(Math.max(MIN_GROUP_H, h + (ev.clientY - startY) / s.view.k));
      node.style.width = `${g.w}px`;
      node.style.height = `${g.h}px`;
      s.sizes.set(g.id, { w: g.w, h: g.h });
      queueLinks();
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      commit();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  // ----- Connections -----
  function addConnection(from, to) {
    if (from === to) return;
    if (s.data.connections.some(c => (c.from === from && c.to === to) || (c.from === to && c.to === from))) return;
    const c = { id: newId(), from, to, label: '', color: 'default', directed: false };
    s.data.connections.push(c);
    commit();
    return c;
  }

  function setConnecting(state) {
    s.connecting = state;
    s.root.classList.toggle('connecting', Boolean(state));
    s.els.connect.classList.toggle('active', Boolean(state));
    if (state) setStatus('Click the first item to connect');
    else if (s.loaded && !s.conflict && !s.saveFailed) setStatus(isDirty() ? 'Saving…' : 'Saved');
  }

  function connectClick(id) {
    if (!s.connecting.from) {
      s.connecting.from = id;
      select([id]);
      setStatus('Now click the item to connect it to');
      return;
    }
    const { from } = s.connecting;
    setConnecting({ from: null });
    const c = addConnection(from, id);
    if (c) select([], c.id);
    else select([]);
  }

  function startLinkDrag(e, from) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    finishEditing();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const temp = svg('line', { class: 'board-link-temp' });
    s.els.links.appendChild(temp);
    const rect = rectOf(from);
    const onMove = ev => {
      const p = worldAt(ev.clientX, ev.clientY);
      const edge = edgePoint(rect, p.x, p.y);
      Object.entries({ x1: edge.x, y1: edge.y, x2: p.x, y2: p.y }).forEach(([k, v]) => temp.setAttribute(k, v));
    };
    const finish = ev => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', cancel);
      temp.remove();
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node]');
      const to = over && s.root.contains(over) ? over.dataset.node : null;
      if (to && to !== from) {
        const c = addConnection(from, to);
        if (c) select([], c.id);
      }
    };
    const cancel = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', cancel);
      temp.remove();
    };
    onMove(e);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', cancel);
  }

  function onLinkDown(e) {
    const hit = e.target.closest('.board-link-hit');
    if (!hit || e.button !== 0 || s.spaceHeld) return;
    e.stopPropagation();
    finishEditing();
    select([], hit.dataset.link);
  }

  // ----- Adding and removing -----
  function viewCentre() {
    const r = s.els.canvas.getBoundingClientRect();
    return worldAt(r.left + r.width / 2, r.top + r.height / 2);
  }

  function addObject(kind, at) {
    const centre = at || (() => {
      const c = viewCentre();
      const nudge = (s.data.objects.length % 8) * 16;
      return { x: c.x - CARD_W / 2 + nudge, y: c.y - 40 + nudge };
    })();
    const o = { id: newId(), kind, x: Math.round(centre.x), y: Math.round(centre.y), color: kind === 'note' ? 'amber' : 'default', group: null, date: '', text: '', title: '' };
    s.data.objects.push(o);
    o.group = groupAt(o);
    commit();
    select([o.id]);
    s.els.inspector.querySelector('input[type="text"]')?.focus();
  }

  function addDoc(docId, x, y) {
    const o = { id: newId(), kind: 'doc', doc_id: docId, x: Math.round(x), y: Math.round(y), color: 'default', group: null, date: '', text: '' };
    s.data.objects.push(o);
    o.group = groupAt(o);
    commit();
    select([o.id]);
  }

  function placeAllDocs() {
    const docs = trayDocs().sort((a, b) => {
      const [ta, tb] = [s.docs[a].time, s.docs[b].time];
      if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : Number.isFinite(tb) ? 1 : 0;
      return ta - tb;
    });
    if (!docs.length) return;
    // To the right of what's already there, reading across in date order.
    const rects = [...s.nodes.keys()].map(rectOf).filter(Boolean);
    const left = rects.length ? Math.max(...rects.map(r => r.x + r.w)) + 60 : 0;
    const top = rects.length ? Math.min(...rects.map(r => r.y)) : 0;
    // As many columns as suit the canvas's shape, so that the cards fit at a readable size.
    const [stepX, stepY] = [CARD_W + 30, 140];
    const area = s.els.canvas.getBoundingClientRect();
    const cols = Math.max(1, Math.round(Math.sqrt(docs.length * (stepY / stepX) * (area.width / area.height))));
    docs.forEach((docId, i) => {
      s.data.objects.push({
        id: newId(), kind: 'doc', doc_id: docId, color: 'default', group: null, date: '', text: '',
        x: left + (i % cols) * stepX, y: top + Math.floor(i / cols) * stepY,
      });
    });
    commit();
    fitView();
  }

  function removeSelection() {
    const link = s.selectedLink;
    if (link) s.data.connections = s.data.connections.filter(c => c.id !== link);
    const gone = new Set(s.selected);
    // A group goes, and its cards stay where they are.
    s.data.objects.forEach(o => { if (gone.has(o.group)) o.group = null; });
    s.data.objects = s.data.objects.filter(o => !gone.has(o.id));
    s.data.groups = s.data.groups.filter(g => !gone.has(g.id));
    s.data.connections = s.data.connections.filter(c => !gone.has(c.from) && !gone.has(c.to));
    s.selected = new Set();
    s.selectedLink = null;
    commit();
    renderInspector();
  }

  function groupSelection() {
    if (s.data.groups.length >= MAX_BOARD_GROUPS) {
      setStatus(`A board can hold up to ${MAX_BOARD_GROUPS} groups. Delete one to add another.`, true);
      return;
    }
    const members = [...s.selected].map(objectById).filter(Boolean);
    const g = { id: newId(), title: '', color: 'default', collapsed: false };
    if (members.length) {
      const rects = members.map(o => rectOf(o.id));
      const left = Math.min(...rects.map(r => r.x));
      const top = Math.min(...rects.map(r => r.y));
      Object.assign(g, {
        x: left - GROUP_PAD,
        y: top - GROUP_HEAD,
        w: Math.max(MIN_GROUP_W, Math.max(...rects.map(r => r.x + r.w)) - left + GROUP_PAD * 2),
        h: Math.max(MIN_GROUP_H, Math.max(...rects.map(r => r.y + r.h)) - top + GROUP_HEAD + GROUP_PAD),
      });
      members.forEach(o => { o.group = g.id; });
    } else {
      const c = viewCentre();
      Object.assign(g, { x: Math.round(c.x - 200), y: Math.round(c.y - 130), w: 400, h: 260 });
    }
    s.data.groups.push(g);
    commit();
    select([g.id]);
    s.els.inspector.querySelector('input[type="text"]')?.focus();
  }

  // ----- Sidebars -----
  function setSideWidth(root, side, width) {
    const { css, min } = SIDES[side];
    const max = Math.max(min, Math.round(window.innerWidth * 0.45));
    const clamped = Math.round(Math.min(max, Math.max(min, width)));
    root.style.setProperty(css, `${clamped}px`);
    return clamped;
  }

  // Its width when shown: --tray-size and --inspector-size, as hiding sets the column to 0.
  const sideWidth = side => parseInt(s.root.style.getPropertyValue(SIDES[side].css), 10) || SIDES[side].width;

  function showInspector(on) {
    s.root.classList.toggle('no-inspector', !on);
    savePref(NO_INSPECTOR_KEY, on ? '0' : '1');
  }

  // A handle on a sidebar's inner edge: drag it, or use the arrow keys, to change
  // its width; double-click it for the usual width.
  function sideHandle(side) {
    const handle = el('div', `board-side-handle board-side-handle-${side}`);
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', side === 'tray' ? 'Resize the left sidebar' : 'Resize the right sidebar');
    handle.title = 'Drag to resize; double-click for the usual width';
    const sign = side === 'tray' ? 1 : -1;  // which way widens it
    const keep = width => savePref(SIDES[side].key, String(setSideWidth(s.root, side, width)));
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const [startX, startW] = [e.clientX, sideWidth(side)];
      s.root.classList.add('resizing');
      const move = ev => setSideWidth(s.root, side, startW + sign * (ev.clientX - startX));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        s.root.classList.remove('resizing');
        keep(sideWidth(side));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => keep(SIDES[side].width));
    handle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      keep(sideWidth(side) + (e.key === 'ArrowRight' ? sign : -sign) * 20);
    });
    return handle;
  }

  // ----- Find -----
  // Searching the documents' text (on the server) and the board's own titles and
  // notes, narrowed by filters. Matches stand out on the board and are listed in
  // the sidebar; everything else fades. Nothing here changes the board.
  const FIND_ROWS = 500;
  const emptyFind = () => ({ q: '', mode: 'keyword', kind: '', type: '', group: '', from: '', notes: false, after: null, before: null,
    docIds: null, highlighting: {}, busy: false, error: '', run: 0, matched: null });

  // opening: also shows the sidebar if it's hidden.
  function showSide(which, focus, opening = true) {
    if (opening) s.root.classList.remove('no-tray');
    s.els.findPane.hidden = which !== 'find';
    s.els.trayPane.hidden = which !== 'tray';
    s.els.findTab.classList.toggle('active', which === 'find');
    s.els.trayTab.classList.toggle('active', which === 'tray');
    if (focus) s.els.findInput.focus();
  }

  function buildFind() {
    const pane = el('div', 'board-side-pane board-find');
    const form = el('form', 'board-find-form');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Search the board…';
    input.setAttribute('aria-label', 'Search the board');
    const go = el('button', null, 'Find');
    go.type = 'submit';
    form.append(input, go);
    form.addEventListener('submit', e => {
      e.preventDefault();
      runFind();
    });
    const select = (label, options, onChange) => {
      const control = el('select');
      options.forEach(([value, text]) => control.append(new Option(text, value)));
      control.addEventListener('change', () => onChange(control.value));
      return { control, wrap: field(label, control) };
    };
    const labels = { keyword: 'Keyword', semantic: 'Semantic', advanced: 'Advanced' };
    const modes = ((typeof CONFIG !== 'undefined' && CONFIG.search_modes) || ['keyword']).filter(m => labels[m]);
    const mode = select('Search by', modes.map(m => [m, labels[m]]), value => {
      s.find.mode = value;
      if (s.find.q) runFind();
    });
    const kind = select('Kind', [['', 'Everything'], ...Object.entries(KINDS).map(([k, label]) => [k, k === 'doc' ? 'Documents' : `${label === 'Person' ? 'People' : `${label}s`}`])],
      value => setFind({ kind: value }));
    const type = select('File type', [['', 'Any']], value => setFind({ type: value }));
    const group = select('Group', [['', 'Any']], value => setFind({ group: value }));
    const from = el('input');
    from.type = 'text';
    from.placeholder = 'e.g. smith';
    from.addEventListener('input', () => setFind({ from: from.value.trim().toLowerCase() }));
    // Days, inclusive, by the date each item has on the board's timeline.
    const dateInput = (key, label) => {
      const input = el('input');
      input.type = 'date';
      input.addEventListener('change', () => setFind({ [key]: input.value ? toDay(Date.parse(`${input.value}T00:00:00Z`)) : null }));
      return { input, wrap: field(label, input) };
    };
    const after = dateInput('after', 'Date from');
    const before = dateInput('before', 'Date to');
    const notesBox = el('input');
    notesBox.type = 'checkbox';
    notesBox.addEventListener('change', () => setFind({ notes: notesBox.checked }));
    const notes = el('label', 'board-check');
    notes.append(notesBox, document.createTextNode(' Only cards with notes'));
    const filters = el('div', 'board-find-filters');
    filters.append(mode.wrap, kind.wrap, type.wrap, group.wrap, after.wrap, before.wrap, field('Sender', from), notes);
    const head = el('div', 'board-find-head');
    const summary = el('div', 'board-note');
    summary.setAttribute('aria-live', 'polite');
    const clear = button('Clear', clearFind, { title: 'Show everything again' });
    head.append(summary, clear);
    const list = el('div', 'board-find-list');
    pane.append(form, filters, head, list);
    Object.assign(s.els, { findPane: pane, findInput: input, findMode: mode.control, findKind: kind.control, findType: type.control,
      findGroup: group.control, findFrom: from, findAfter: after.input, findBefore: before.input, findNotes: notesBox, findSummary: summary, findClear: clear, findList: list });
    return pane;
  }

  function setFind(change) {
    Object.assign(s.find, change);
    applyFind();
  }

  function clearFind() {
    s.find = { ...emptyFind(), mode: s.find.mode, run: s.find.run + 1 };
    const { findInput, findKind, findType, findGroup, findFrom, findAfter, findBefore, findNotes } = s.els;
    findInput.value = findFrom.value = findAfter.value = findBefore.value = '';
    findKind.value = findType.value = findGroup.value = '';
    findNotes.checked = false;
    applyFind();
  }

  // The documents' text is searched on the server; titles and notes here.
  async function runFind() {
    const board = s;
    const f = s.find;
    const q = s.els.findInput.value.trim();
    const run = ++f.run;
    Object.assign(f, { q, mode: s.els.findMode.value, docIds: null, highlighting: {}, error: '', busy: Boolean(q) });
    applyFind();
    if (!q) return;
    try {
      const params = new URLSearchParams({ q });
      if (f.mode !== 'keyword') params.set('mode', f.mode);
      const data = await collectionsApi('GET', `${boardUrl()}/search?${params}`);
      if (s !== board || f !== s.find || f.run !== run) return;
      Object.assign(f, { docIds: data.ids, highlighting: data.highlighting || {} });
    } catch (err) {
      if (s !== board || f !== s.find || f.run !== run) return;
      Object.assign(f, { docIds: [], error: err.message });
    }
    f.busy = false;
    applyFind();
  }

  const findActive = () => { const f = s.find; return Boolean(f.q || f.kind || f.type || f.group || f.from || f.notes || f.after !== null || f.before !== null); };
  const docType = doc => String(firstOf(doc.type) || '').toLowerCase();

  function findMatch(o, docSet) {
    const f = s.find;
    const doc = o.kind === 'doc' ? s.docs[o.doc_id] : null;
    if (f.kind && o.kind !== f.kind) return false;
    if (f.type && !(doc && docType(doc) === f.type)) return false;
    if (f.group && (f.group === 'none' ? groupById(o.group) : o.group !== f.group)) return false;
    if (f.from && !(doc && allOf(doc.email_from).join(' ').toLowerCase().includes(f.from))) return false;
    if (f.notes && !(o.text || '').trim()) return false;
    if (f.after !== null || f.before !== null) {
      // Something with no date can't be said to fall in a period.
      const t = timeOf(o);
      if (t === null || (f.after !== null && toDay(t) < f.after) || (f.before !== null && toDay(t) > f.before)) return false;
    }
    if (!f.q) return true;
    // Keyword searches also look at what you wrote: a card's notes, an object's title.
    if (f.mode === 'keyword' && `${o.title || ''}\n${o.text || ''}`.toLowerCase().includes(f.q.toLowerCase())) return true;
    return Boolean(doc) && docSet.has(o.doc_id);
  }

  // The choices that depend on what's on the board, keeping what's chosen if it's still there.
  function refreshFindChoices() {
    const { findType, findGroup } = s.els;
    if (!findType) return;
    const types = [...new Set(s.data.objects.filter(o => o.kind === 'doc' && s.docs[o.doc_id]).map(o => docType(s.docs[o.doc_id])).filter(Boolean))].sort();
    const fill = (control, options, key) => {
      const keep = s.find[key];
      control.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
      if (options.some(([value]) => value === keep)) control.value = keep;
      else s.find[key] = control.value = '';
    };
    fill(findType, [['', 'Any'], ...types.map(t => [t, t])], 'type');
    fill(findGroup, [['', 'Any'], ['none', 'Not in a group'], ...s.data.groups.map(g => [g.id, g.title || 'Untitled group'])], 'group');
  }

  function applyFind() {
    if (!s.els.findList) return;
    const active = findActive();
    const docSet = new Set(s.find.docIds || []);
    const matched = active ? new Set(s.data.objects.filter(o => findMatch(o, docSet)).map(o => o.id)) : null;
    s.find.matched = matched;
    // A group stays clear while anything in it matches, and stands out if it's collapsed.
    const hitGroups = new Set();
    if (matched) s.data.objects.forEach(o => { if (o.group && matched.has(o.id)) hitGroups.add(o.group); });
    const shown = id => matched.has(id) || hitGroups.has(id);
    s.data.objects.forEach(o => {
      const node = s.nodes.get(o.id);
      if (!node) return;
      node.classList.toggle('find-match', Boolean(matched) && matched.has(o.id));
      node.classList.toggle('find-out', Boolean(matched) && !matched.has(o.id));
    });
    s.data.groups.forEach(g => {
      const node = s.nodes.get(g.id);
      if (!node) return;
      node.classList.toggle('find-match', Boolean(matched) && g.collapsed && hitGroups.has(g.id));
      node.classList.toggle('find-out', Boolean(matched) && !hitGroups.has(g.id));
    });
    const links = new Map(s.data.connections.map(c => [c.id, c]));
    s.els.links.querySelectorAll('.board-link').forEach(shape => {
      const c = links.get(shape.dataset.link);
      shape.classList.toggle('find-out', Boolean(matched && c) && !(shown(c.from) && shown(c.to)));
    });
    renderFindList();
  }

  function renderFindList() {
    const f = s.find;
    const { findSummary, findList, findClear } = s.els;
    findClear.hidden = !findActive() && !s.els.findInput.value;
    if (!findActive()) {
      findSummary.textContent = 'Search the text of the documents on the board, and the titles and notes of everything on it. Or choose a filter.';
      findList.replaceChildren();
      return;
    }
    if (f.busy) {
      findSummary.textContent = 'Searching…';
      findList.replaceChildren();
      return;
    }
    const rank = new Map((f.docIds || []).map((id, i) => [id, i]));
    const rankOf = o => (o.kind === 'doc' && rank.has(o.doc_id) ? rank.get(o.doc_id) : Infinity);
    const time = o => timeOf(o) ?? Infinity;
    const found = s.data.objects.filter(o => f.matched.has(o.id))
      .sort((a, b) => rankOf(a) - rankOf(b) || time(a) - time(b) || (a.id < b.id ? -1 : 1));
    const total = s.data.objects.length;
    findSummary.textContent = f.error ? f.error
      : `${found.length.toLocaleString()} of ${total.toLocaleString()} item${total === 1 ? '' : 's'} on the board match`
        + (found.length > FIND_ROWS ? `; the first ${FIND_ROWS} are listed.` : '.');
    findSummary.classList.toggle('error', Boolean(f.error));
    findList.replaceChildren(...found.slice(0, FIND_ROWS).map(buildFindRow));
    markFindRows(false);
  }

  // The rows for what's selected on the board, scrolled to if asked. A card in a
  // collapsed group is selected as its group, so that counts only for the row chosen.
  function markFindRows(scroll) {
    if (!s.els.findList) return;
    let first = null;
    s.els.findList.querySelectorAll('.board-find-row').forEach(row => {
      const id = row.dataset.id;
      const on = s.selected.has(id) || (s.find.current === id && s.selected.has(drawnId(id)));
      row.classList.toggle('current', on);
      row.setAttribute('aria-current', String(on));
      if (on && !first) first = row;
    });
    if (scroll && first) first.scrollIntoView({ block: 'nearest' });
  }

  function buildFindRow(o) {
    const f = s.find;
    const doc = o.kind === 'doc' ? s.docs[o.doc_id] : null;
    const row = el('button', 'board-find-row');
    row.type = 'button';
    row.dataset.id = o.id;
    const t = timeOf(o);
    const meta = [doc ? firstOf(doc.type) : KINDS[o.kind], t !== null ? fmtDay(toDay(t)) : 'Undated', groupById(o.group)?.title].filter(Boolean).join(' · ');
    const title = doc ? docTitle(doc) : o.kind === 'doc' ? 'A document you can no longer see' : o.title || (o.text || '').split('\n')[0] || KINDS[o.kind];
    row.append(el('div', 'board-tray-meta', meta), el('div', 'board-tray-title', title));
    const passages = doc && f.highlighting[o.doc_id];
    if (passages) {
      const snippet = el('div', 'board-find-snippet');
      // Escaped by the server, with <mark> around what matched, as in search results.
      snippet.innerHTML = passages.content.join(' … ');
      row.append(snippet);
    } else if (f.q && (doc || o.title) && (o.text || '').toLowerCase().includes(f.q.toLowerCase())) {
      row.append(el('div', 'board-find-snippet', `Your note: ${excerpt(o.text, f.q)}`));
    }
    row.addEventListener('click', () => goToFound(o));
    row.addEventListener('pointerenter', () => s.nodes.get(drawnId(o.id))?.classList.add('find-hover'));
    row.addEventListener('pointerleave', () => s.nodes.get(drawnId(o.id))?.classList.remove('find-hover'));
    return row;
  }

  // A few words either side of the first match.
  function excerpt(text, q) {
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, at - 40);
    return `${start ? '…' : ''}${text.slice(start, at + q.length + 60).replace(/\s+/g, ' ').trim()}${at + q.length + 60 < text.length ? '…' : ''}`;
  }

  // Selects it and brings it to the middle, zooming in only if it's too small to read.
  function goToFound(o) {
    s.find.current = o.id;
    const id = drawnId(o.id);
    const r = rectOf(id);
    if (!r) return;
    const box = s.els.canvas.getBoundingClientRect();
    const k = Math.max(s.view.k, 0.6);
    s.view = { k, x: box.width / 2 - (r.x + r.w / 2) * k, y: box.height / 2 - (r.y + r.h / 2) * k };
    applyView();
    select([id]);
    renderInspector();
    const node = s.nodes.get(id);
    if (node) {
      node.classList.remove('find-pulse');
      void node.offsetWidth;  // to start it again if it's already been pulsed
      node.classList.add('find-pulse');
      node.addEventListener('animationend', () => node.classList.remove('find-pulse'), { once: true });
    }
  }

  // ----- Tray -----
  function trayDocs() {
    const placed = placedDocs();
    return s.items.filter(id => !placed.has(id)).filter(id => {
      if (!s.trayFilter) return true;
      const doc = s.docs[id];
      return `${docTitle(doc)} ${firstOf(doc.type) || ''}`.toLowerCase().includes(s.trayFilter);
    });
  }

  function renderTray() {
    const docs = trayDocs();
    const remaining = s.items.filter(id => !placedDocs().has(id)).length;
    s.els.trayTitle.textContent = `Not on the board (${remaining.toLocaleString()})`;
    s.els.placeAll.disabled = !docs.length;
    s.els.trayNote.textContent = s.hiddenItems ? `${s.hiddenItems.toLocaleString()} more you can no longer see.` : '';
    if (!docs.length) {
      s.els.trayList.replaceChildren(el('div', 'board-tray-empty', s.trayFilter ? 'Nothing matches.' : s.items.length ? 'Every document is on the board.' : 'No documents in this collection yet.'));
      return;
    }
    s.els.trayList.replaceChildren(...docs.map(buildTrayItem));
  }

  function buildTrayItem(docId) {
    const doc = s.docs[docId];
    const item = el('div', 'board-tray-item');
    const title = docTitle(doc);
    item.tabIndex = 0;
    item.title = 'Drag onto the board, or press Enter to place it in the middle';
    item.append(el('div', 'board-tray-title', title));
    const date = Number.isFinite(doc.time) ? fmtDay(toDay(doc.time)) : 'Undated';
    item.append(el('div', 'board-tray-meta', [firstOf(doc.type), date].filter(Boolean).join(' · ')));
    item.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const c = viewCentre();
      addDoc(docId, c.x - CARD_W / 2, c.y - CARD_H / 2);
    });
    item.addEventListener('pointerdown', e => startTrayDrag(e, item, docId, title));
    return item;
  }

  function startTrayDrag(e, item, docId, title) {
    if (e.button !== 0) return;
    e.preventDefault();
    finishEditing();
    item.setPointerCapture(e.pointerId);
    let ghost = null;
    const position = ev => {
      ghost.style.left = `${ev.clientX + 8}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
    };
    const onMove = ev => {
      if (!ghost) {
        ghost = el('div', 'board-ghost', title);
        s.root.appendChild(ghost);
      }
      position(ev);
    };
    const onUp = ev => {
      item.removeEventListener('pointermove', onMove);
      item.removeEventListener('pointerup', onUp);
      item.removeEventListener('pointercancel', onCancel);
      if (ghost) ghost.remove();
      const r = s.els.canvas.getBoundingClientRect();
      if (ghost && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        const p = worldAt(ev.clientX, ev.clientY);
        addDoc(docId, p.x - CARD_W / 2, p.y - 20);
      }
    };
    const onCancel = () => {
      item.removeEventListener('pointermove', onMove);
      item.removeEventListener('pointerup', onUp);
      item.removeEventListener('pointercancel', onCancel);
      if (ghost) ghost.remove();
    };
    item.addEventListener('pointermove', onMove);
    item.addEventListener('pointerup', onUp);
    item.addEventListener('pointercancel', onCancel);
  }

  // ----- Inspector -----
  function field(label, control) {
    const wrap = el('div', 'board-field');
    const name = el('label', null, label);
    const id = `board-field-${newId()}`;
    control.id = id;
    name.htmlFor = id;
    wrap.append(name, control);
    return wrap;
  }

  // A live edit shows as it's typed, and becomes one undo step when finished.
  function textInput(label, item, key, max, multiline, onInput) {
    const input = el(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = 'text';
    input.maxLength = max;
    input.value = item[key] || '';
    input.addEventListener('input', () => {
      item[key] = input.value;
      onInput();
    });
    input.addEventListener('change', commit);
    return field(label, input);
  }

  function refreshNode(id) {
    const node = s.nodes.get(id);
    if (!node) return;
    const o = objectById(id);
    node.replaceWith(o ? buildCard(o) : buildGroup(groupById(id)));
    measure();
    queueLinks();
    scheduleSave();
  }

  function swatches(item, label = 'Colour') {
    const wrap = el('div', 'board-field');
    wrap.append(el('div', 'board-field-label', label));
    const row = el('div', 'board-swatches');
    COLORS.forEach(color => {
      const b = button('', () => {
        const items = Array.isArray(item) ? item : [item];
        items.forEach(i => { i.color = color; });
        commit();
        renderInspector();
      }, { className: `board-swatch color-${color}${!Array.isArray(item) && item.color === color ? ' active' : ''}`, title: color === 'default' ? 'Grey' : color[0].toUpperCase() + color.slice(1) });
      b.setAttribute('aria-label', b.title);
      row.appendChild(b);
    });
    wrap.appendChild(row);
    return wrap;
  }

  function dateField(o) {
    const input = el('date-select');
    input.value = o.date || '';
    input.addEventListener('change', () => {
      o.date = input.value;
      commit();
      renderInspector();
    });
    const wrap = field(o.kind === 'doc' ? 'Event date' : 'Date', input);
    if (o.date) {
      const row = el('div', 'board-date-row');
      wrap.replaceChild(row, input);
      row.append(input, button('Clear', () => {
        o.date = '';
        commit();
        renderInspector();
      }));
    }
    return wrap;
  }

  function renderInspector() {
    const { inspector } = s.els;
    inspector.replaceChildren();
    // On a narrow window it floats over the canvas, so only when there's something to edit.
    inspector.classList.toggle('idle', !s.panel && !s.suggest && !s.selected.size && !s.selectedLink);
    if (s.panel) return s.panel.reset ? renderResetConfirm(inspector) : renderVersions(inspector);
    if (s.suggest) return renderSuggestions(inspector);
    const ids = [...s.selected];
    if (s.selectedLink) return inspectLink(inspector, s.data.connections.find(c => c.id === s.selectedLink));
    if (ids.length > 1) return inspectMany(inspector, ids);
    if (ids.length === 1) {
      const o = objectById(ids[0]);
      if (o) return o.kind === 'doc' ? inspectDoc(inspector, o) : inspectObject(inspector, o);
      return inspectGroup(inspector, groupById(ids[0]));
    }
    inspector.append(el('div', 'board-panel-title', 'Board'),
      el('p', 'board-note', 'Click a card, group or connection to edit it. Drag across the canvas to select an area, and hold Shift to add to a selection. Scroll to zoom. To pan, hold Space and drag, or drag with the middle mouse button. Double-click the canvas to add a note.'));
  }

  function inspectObject(root, o) {
    root.append(el('div', 'board-panel-title', KINDS[o.kind]),
      textInput('Title', o, 'title', 200, false, () => refreshNode(o.id)),
      textInput('Notes', o, 'text', 2000, true, () => refreshNode(o.id)),
      dateField(o), swatches(o));
    const actions = el('div', 'board-actions');
    actions.append(button('Delete', removeSelection, { className: 'board-danger' }));
    root.append(actions);
  }

  function inspectDoc(root, o) {
    const doc = s.docs[o.doc_id];
    root.append(el('div', 'board-panel-title', KINDS.doc));
    if (!doc) {
      root.append(el('p', 'board-note', 'You can no longer see this document, so nothing about it is shown. Your notes and connections are still here.'));
    } else {
      root.append(el('div', 'board-doc-title', docTitle(doc)));
      const facts = el('dl', 'board-facts');
      const fact = (label, value) => {
        if (value) facts.append(el('dt', null, label), el('dd', null, String(value)));
      };
      const src = sourceOf(doc);
      fact(src.share_label || 'Source', firstOf(doc.share));
      fact('From', firstOf(doc.email_from));
      fact('To', allOf(doc.email_to).join(', '));
      fact('Type', firstOf(doc.type));
      fact(dateSource(doc, docIsMail(doc)), fmtDateTime(doc.created));
      fact('Path', docIsMail(doc) ? null : doc.id);
      root.append(facts);
    }
    root.append(textInput('Your notes', o, 'text', 2000, true, () => refreshNode(o.id)), dateField(o), swatches(o));
    if (doc && !Number.isFinite(doc.time) && !o.date) root.append(el('p', 'board-note', 'This document has no usable date, so it stays visible whatever the timeline shows.'));
    const actions = el('div', 'board-actions');
    if (doc) {
      const src = sourceOf(doc);
      if (src.open === 'link') {
        if (/^https:\/\//i.test(doc.id)) {
          const link = el('a', null, `↗ ${src.link_label || 'Open'}`);
          link.href = doc.id;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          actions.append(link);
        }
      } else {
        const link = el('a', null, '↓ Download');
        link.href = `/api/download?id=${encodeURIComponent(doc.id)}`;
        actions.append(link);
      }
      const textBox = el('div', 'board-text');
      textBox.hidden = true;
      const show = button('Show text', async () => {
        if (!textBox.hidden) {
          textBox.hidden = true;
          show.textContent = 'Show text';
          return;
        }
        textBox.hidden = false;
        show.textContent = 'Hide text';
        if (!textBox.dataset.loaded) {
          textBox.textContent = 'Loading…';
          if (await loadFullText(doc.id, textBox)) textBox.dataset.loaded = '1';
        }
      });
      actions.append(show);
      const always = el('label', 'board-check');
      const alwaysBox = el('input');
      alwaysBox.type = 'checkbox';
      alwaysBox.checked = loadPref(SHOW_TEXT_KEY) === '1';
      alwaysBox.addEventListener('change', () => {
        savePref(SHOW_TEXT_KEY, alwaysBox.checked ? '1' : '0');
        if (alwaysBox.checked && textBox.hidden) show.click();
      });
      always.append(alwaysBox, document.createTextNode('Show by default'));
      always.title = 'Open the text whenever you select a document, on this browser';
      actions.append(always);
      if (alwaysBox.checked) show.click();
      if (!s.items.includes(o.doc_id)) {
        actions.append(button('Add back to collection', async e => {
          e.currentTarget.disabled = true;
          try {
            await collectionsApi('POST', `/api/collections/${s.collection.id}/items`, { id: o.doc_id });
            s.items.unshift(o.doc_id);
            refreshNode(o.id);
            renderInspector();
          } catch (err) {
            setStatus(err.message, true);
          }
        }));
      }
      actions.append(button('Take off board', removeSelection, { className: 'board-danger' }));
      root.append(actions, textBox);
      return;
    }
    actions.append(button('Take off board', removeSelection, { className: 'board-danger' }));
    root.append(actions);
  }

  // The bars in lib/board-suggest.js. Boards saved under the old single bar can
  // hold large groups rated too highly, so a rating is checked again on display.
  const veryAlikeBar = members => (members.length >= 20 ? 0.8 : 0.6);
  function currentRating({ rating, alike, shared, members }) {
    if (rating !== 'near_identical' || alike >= veryAlikeBar(members)) return rating;
    if (members.length < 8) return 'too_few';
    return shared >= 0.5 ? 'clear' : shared < 0.2 ? 'unclear' : 'some';
  }

  // Why a group has its label, in terms someone can check.
  function ratingReason({ basis, alike, shared, members }, rating) {
    const percent = Math.round(shared * 100);
    const similarity = `${alike.toFixed(2)} average similarity by ${basis}`;
    switch (rating) {
      case 'near_identical':
        return `Its documents are very alike: ${similarity}, and ${veryAlikeBar(members).toFixed(2)} or more counts as very alike for a group this size. That's often a repeated template, forwarded copies or one thread. It shows they're alike, not that the topic matters.`;
      case 'clear':
        return `Key words picked from half of this group appeared in ${percent}% of the other half, and 50% or more counts as clear. Its documents share wording, which doesn't prove the group is meaningful.`;
      case 'some':
        return `Key words picked from half of this group appeared in ${percent}% of the other half, between the 20% for unclear and the 50% for clear. Part of it hangs together, and some of it may not belong.`;
      case 'unclear':
        return `Key words picked from half of this group appeared in only ${percent}% of the other half, under the 20% that counts as unclear. It may be a jumble, but some real topics also show this, so check before dismissing it.`;
      default:
        return `It has ${members.length} item${members.length === 1 ? '' : 's'}, and it takes 8 documents to test words from one half against the other. Its ${similarity} wasn't high enough to count as very alike.`;
    }
  }

  function groupRating(root, g) {
    const wrap = el('div', 'board-field');
    wrap.append(el('div', 'board-field-label', 'Topic rating'));
    root.append(wrap);
    const q = g.quality;
    const rate = button(q ? 'Re-rate' : 'Rate this group', e => rerateGroup(g, e.currentTarget), {
      title: 'Rate the cards in this group now. It reads the whole board, so it can take a little while on a big one',
    });
    const rateRow = el('div', 'board-actions');
    rateRow.append(rate);
    if (!q) {
      wrap.append(el('p', 'board-note', 'Not rated yet.'), rateRow);
      return;
    }
    const rating = currentRating(q);
    wrap.append(el('span', `board-quality ${rating}`, QUALITY_LABELS[rating]), el('p', 'board-note', ratingReason(q, rating)));
    if (s.rerated && s.rerated.group === g.id) wrap.append(el('p', 'board-note', s.rerated.text));
    if (q.left_out) wrap.append(el('p', 'board-note', `Rated with ${q.left_out} weak fit${q.left_out === 1 ? '' : 's'} that you chose to leave out of the frame.`));
    const now = new Set(membersOf(g.id).map(o => o.id));
    const then = new Set(q.members);
    const added = [...now].filter(id => !then.has(id)).length;
    const removed = [...then].filter(id => !now.has(id)).length;
    if (added || removed) {
      const changes = [added && `${added} added`, removed && `${removed} removed`].filter(Boolean).join(' and ');
      wrap.append(el('p', 'board-note board-rating-stale', `Rated when the group was made. Since then, ${changes}, so this may no longer describe it. Re-rate to update it.`));
    }
    wrap.append(rateRow);
    const weak = q.weak_fits.filter(id => now.has(id));
    if (weak.length) {
      const list = el('details', 'board-weak-fits');
      list.append(el('summary', null, `${weak.length} weak fit${weak.length === 1 ? '' : 's'}: least like the rest of the group`));
      const names = el('ul');
      weak.forEach(id => names.append(el('li', null, itemName(id))));
      list.append(names);
      const lit = Boolean(s.highlight && s.highlight.group === g.id);
      const highlight = button(lit ? 'Clear highlight' : 'Highlight weak fits', () => {
        setHighlight(lit ? null : { group: g.id, ids: new Set(weak) });
        renderInspector();
      }, { title: g.collapsed ? 'Expand the group to see its cards' : 'Mark these cards on the board, and dim the rest' });
      highlight.disabled = g.collapsed;
      const remove = button('Remove weak fits', () => removeWeakFits(g, weak), {
        className: 'board-danger', title: 'Take these cards out of the group. They stay on the board, below everything else, and Undo puts them back',
      });
      const actions = el('div', 'board-actions');
      actions.append(highlight, remove);
      wrap.append(list, actions);
    }
  }

  // Closes the gaps left by cards that have gone, oldest first, with the frame fitted
  // around them. If it grows, whatever it would land on moves out of the way.
  function reshuffleGroup(g) {
    if (!membersOf(g.id).length) return;
    layOutGroup(g);
    const moved = makeRoomFor(g);
    commit();
    renderInspector();
    if (moved) setStatus(`Moved ${moved} other item${moved === 1 ? '' : 's'} out of the way.`);
  }

  function arrangeChoice(text, value, onChange) {
    const field = el('label', 'board-field');
    field.append(el('span', 'board-field-label', text));
    const arrange = el('select', 'board-arrange');
    ARRANGEMENTS.forEach(([option, label]) => {
      const item = el('option', null, label);
      item.value = option;
      arrange.appendChild(item);
    });
    arrange.value = value;
    arrange.addEventListener('change', () => onChange(arrange.value));
    field.append(arrange);
    return field;
  }

  const oldestFirst = (a, b) => (timeOf(a) ?? Infinity) - (timeOf(b) ?? Infinity) || (a.id < b.id ? -1 : 1);

  // A group's cards, in sections if it's arranged, with the frame fitted around them.
  function layOutGroup(g) {
    const cards = membersOf(g.id).sort(oldestFirst);
    const grid = gridFor(cards);
    g.w = grid.w;
    g.h = grid.h;
    if (!g.arrange) {
      delete g.sections;
      placeInFrame(cards, g, grid);
      return;
    }
    // Boxes side by side, in order, starting a new row when one won't fit.
    const step = CARD_W + GROUP_GAP;
    const inner = grid.cols * step - GROUP_GAP + SECTION_PAD * 2;
    let [x, y, rowHeight] = [0, GROUP_HEAD, 0];
    g.sections = sectionsFor(cards, g.arrange).map(({ title, cards: inSection }) => {
      const cols = inSection.length >= grid.cols ? grid.cols : Math.ceil(Math.sqrt(inSection.length));
      const rows = Math.ceil(inSection.length / cols);
      const width = cols * step - GROUP_GAP + SECTION_PAD * 2;
      const height = SECTION_H + rows * grid.rowH - GROUP_GAP + SECTION_PAD;
      if (x && x + width > inner) {
        x = 0;
        y += rowHeight + SECTION_GAP;
        rowHeight = 0;
      }
      const section = { id: newId(), title, x: GROUP_PAD + x, y, w: width, h: height, members: inSection.map(o => o.id) };
      inSection.forEach((o, i) => {
        o.x = g.x + GROUP_PAD + x + SECTION_PAD + (i % cols) * step;
        o.y = g.y + y + SECTION_H + Math.floor(i / cols) * grid.rowH;
      });
      rowHeight = Math.max(rowHeight, height);
      x += width + SECTION_GAP;
      return section;
    });
    g.w = inner + GROUP_PAD * 2;
    g.h = Math.max(MIN_GROUP_H, y + rowHeight + GROUP_PAD);
  }

  // What can be moved as one: a group and its cards, or a card in no group.
  function topLevelItems(except) {
    const groups = s.data.groups.filter(g => g.id !== except.id).map(g => ({
      group: g, x: g.x, y: g.y, w: g.collapsed ? COLLAPSED_W : g.w, h: g.collapsed ? COLLAPSED_H : g.h,
    }));
    const cards = s.data.objects.filter(o => !o.group).map(o => {
      const size = s.sizes.get(o.id) || { w: CARD_W, h: CARD_H };
      return { card: o, x: o.x, y: o.y, w: size.w, h: size.h };
    });
    return [...groups, ...cards];
  }

  // Moves whatever a frame now lands on, right or down, whichever is the shorter
  // way, then whatever that lands on in turn. Says how many moved.
  function makeRoomFor(g) {
    const items = topLevelItems(g);
    const moved = new Set();
    const queue = [{ x: g.x, y: g.y, w: g.w, h: g.h }];
    const limit = items.length * 20 + 1;
    for (let turns = 0; queue.length && turns < limit; turns++) {
      const mover = queue.shift();
      for (const item of items) {
        if (item === mover || item.x >= mover.x + mover.w || item.x + item.w <= mover.x
            || item.y >= mover.y + mover.h || item.y + item.h <= mover.y) continue;
        const right = mover.x + mover.w + GROUP_MARGIN - item.x;
        const down = mover.y + mover.h + GROUP_MARGIN - item.y;
        if (right < down) item.x += right;
        else item.y += down;
        moved.add(item);
        queue.push(item);
      }
    }
    for (const item of moved) {
      if (item.card) {
        item.card.x = item.x;
        item.card.y = item.y;
      } else {
        const [dx, dy] = [item.x - item.group.x, item.y - item.group.y];
        membersOf(item.group.id).forEach(o => {
          o.x += dx;
          o.y += dy;
        });
        item.group.x = item.x;
        item.group.y = item.y;
      }
    }
    return moved.size;
  }

  // How to divide some cards, oldest first within each section.
  function sectionsFor(cards, by) {
    return by === 'date' ? dateSections(cards) : valueSections(cards, by);
  }

  function dateSections(cards) {
    const dated = cards.filter(o => timeOf(o) !== null);
    const undated = cards.filter(o => timeOf(o) === null);
    const months = t => new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth();
    const span = dated.length ? months(timeOf(dated[dated.length - 1])) - months(timeOf(dated[0])) : 0;
    // Years for a long stretch, months for a shorter one, days within a month.
    const format = span >= 24 ? { timeZone: 'UTC', year: 'numeric' }
      : span >= 1 ? { timeZone: 'UTC', year: 'numeric', month: 'short' }
      : { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' };
    const keyOf = t => new Date(t).toISOString().slice(0, span >= 24 ? 4 : span >= 1 ? 7 : 10);
    const sections = new Map();
    for (const o of dated) {
      const t = timeOf(o);
      const key = keyOf(t);
      if (!sections.has(key)) sections.set(key, { title: new Date(t).toLocaleDateString(undefined, format), cards: [] });
      sections.get(key).cards.push(o);
    }
    const list = [...sections.values()];
    return mergeExtraSections(list, 'Later', undated.length ? [{ title: 'Undated', cards: undated }] : []);
  }

  const SECTION_VALUES = {
    subject: { of: doc => String(firstOf(doc.email_subject) || '').replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '').trim(), none: 'No subject', other: 'Other subjects' },
    sender: { of: doc => String(firstOf(doc.email_from) || '').trim(), none: 'No sender', other: 'Other senders' },
    type: { of: doc => String(firstOf(doc.type) || '').trim(), none: 'No file type', other: 'Other file types' },
  };

  // The largest first, then those with one card together, as a section each would
  // only list them, then whatever the value doesn't apply to.
  function valueSections(cards, by) {
    const { of, none, other } = SECTION_VALUES[by];
    const sections = new Map();
    const missing = [];
    const items = [];
    for (const o of cards) {
      if (o.kind !== 'doc') { items.push(o); continue; }
      const doc = s.docs[o.doc_id];
      const value = doc ? of(doc) : '';
      if (!value) { missing.push(o); continue; }
      const key = value.toLowerCase();
      if (!sections.has(key)) sections.set(key, { title: value, cards: [] });
      sections.get(key).cards.push(o);
    }
    const ordered = [...sections.values()].sort((a, b) => b.cards.length - a.cards.length || (a.title < b.title ? -1 : 1));
    const several = ordered.filter(section => section.cards.length > 1);
    const singles = ordered.filter(section => section.cards.length === 1);
    const main = several.length || singles.length < 2 ? [...several, ...(singles.length === 1 ? singles : [])] : [];
    const rest = singles.length >= 2 ? [{ title: other, cards: singles.flatMap(section => section.cards).sort(oldestFirst) }] : [];
    return mergeExtraSections(main, other, [
      ...rest,
      ...(missing.length ? [{ title: none, cards: missing }] : []),
      ...(items.length ? [{ title: 'Notes and other items', cards: items }] : []),
    ]);
  }

  // Keeps to the limit by folding the smallest of the main sections into one.
  function mergeExtraSections(main, title, last) {
    const room = MAX_SECTIONS - last.length - 1;
    if (main.length <= room + 1) return [...main, ...last];
    const folded = main.slice(room).flatMap(section => section.cards).sort(oldestFirst);
    const same = last.find(section => section.title === title);
    if (same) {
      same.cards = [...folded, ...same.cards].sort(oldestFirst);
      return [...main.slice(0, room), ...last];
    }
    return [...main.slice(0, room), { title, cards: folded }, ...last];
  }

  // The sections with cards still in them, which dragging can change.
  function sectionsNow(g) {
    const members = membersOf(g.id);
    const here = new Map(members.map(o => [o.id, o]));
    return (g.sections || []).map(section => {
      const cards = section.members.map(id => here.get(id)).filter(Boolean);
      return { section, cards, whole: cards.length === members.length };
    }).filter(({ cards }) => cards.length);
  }

  function arrangeGroup(g, by) {
    if (by) g.arrange = by;
    else delete g.arrange;
    reshuffleGroup(g);
  }

  // Takes a section out as its own group, beside the one it came from, and closes the gap.
  function sectionToGroup(g, section) {
    if (s.data.groups.length >= MAX_BOARD_GROUPS) {
      setStatus(`A board can hold up to ${MAX_BOARD_GROUPS} groups. Delete one to add another.`, true);
      return;
    }
    const found = sectionsNow(g).find(entry => entry.section.id === section.id);
    if (!found || found.whole) return;
    const cards = found.cards.sort(oldestFirst);
    const moving = new Set(cards.map(o => o.id));
    const grid = gridFor(cards);
    const frame = { id: newId(), title: clipTitle(`${g.title ? `${g.title}: ` : ''}${section.title}`), color: g.color, collapsed: false, x: 0, y: 0, w: grid.w, h: grid.h };
    cards.forEach(o => { o.group = frame.id; });
    layOutGroup(g);
    const others = [...s.nodes.keys()].filter(id => !moving.has(id) && id !== g.id && !membersOf(g.id).some(o => o.id === id)).map(rectOf).filter(Boolean);
    frame.x = g.x + g.w + GROUP_MARGIN;
    frame.y = g.y;
    const hit = () => others.find(r => r.x < frame.x + frame.w && r.x + r.w > frame.x && r.y < frame.y + frame.h && r.y + r.h > frame.y);
    for (let blocked = hit(); blocked; blocked = hit()) frame.y = blocked.y + blocked.h + GROUP_MARGIN;
    s.data.groups.push(frame);
    placeInFrame(cards, frame, grid);
    commit();
    select([frame.id]);
  }

  const clipTitle = text => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

  async function rerateGroup(g, control) {
    const board = s;
    const id = g.id;
    control.disabled = true;
    control.textContent = 'Rating…';
    try {
      if (!await saveFirst()) return;
      const had = g.quality ? currentRating(g.quality) : null;
      const data = await collectionsApi('POST', `${boardUrl()}/groups/${encodeURIComponent(id)}/rate`);
      if (s !== board) return;
      const group = groupById(id);
      if (!group) return;
      group.quality = data.quality;
      const now = QUALITY_LABELS[currentRating(data.quality)];
      // Kept here rather than in the status, which the save soon replaces.
      s.rerated = { group: id, text: `${had ? `Was ${QUALITY_LABELS[had]}, now` : 'Rated'} ${now}, from ${data.rated} document${data.rated === 1 ? '' : 's'}.${data.vectors_failed ? ' Vector search wasn\'t available, so this used words alone.' : ''}` };
      commit();
      renderInspector();
    } catch (err) {
      if (s !== board) return;
      setStatus(err.message, true);
      renderInspector();
    }
  }

  // Out of the group and out of its frame, or they'd still look like part of it:
  // in rows below everything on the board, where they can't land on anything.
  function removeWeakFits(g, ids) {
    const rects = [...s.nodes.keys()].map(rectOf).filter(Boolean);
    const top = rects.length ? Math.max(...rects.map(r => r.y + r.h)) + 60 : 0;
    const left = g.x;
    const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    ids.map(objectById).filter(Boolean).forEach((o, i) => {
      o.group = null;
      o.x = left + (i % cols) * (CARD_W + GROUP_GAP);
      o.y = top + Math.floor(i / cols) * 160;
    });
    setHighlight(null);
    commit();
    renderInspector();
    setStatus(`Moved ${ids.length} card${ids.length === 1 ? '' : 's'} out of the group, to below the board. Saving…`);
  }

  function inspectGroup(root, g) {
    root.append(el('div', 'board-panel-title', 'Group'),
      textInput('Title', g, 'title', 200, false, () => refreshNode(g.id)), swatches(g));
    groupRating(root, g);
    const check = el('label', 'board-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = g.collapsed;
    box.addEventListener('change', () => {
      g.collapsed = box.checked;
      commit();
      renderInspector();
    });
    check.append(box, document.createTextNode('Collapsed'));
    root.append(check, el('p', 'board-note', `${membersOf(g.id).length} item(s). Drag a card into the frame to add it, or out to take it out.`));
    const arranging = arrangeChoice('Arrange by', g.arrange || '', value => arrangeGroup(g, value));
    arranging.querySelector('select').disabled = g.collapsed || !membersOf(g.id).length;
    root.append(arranging);
    const sections = sectionsNow(g);
    if (sections.length) {
      const list = el('div', 'board-section-list');
      sections.forEach(({ section, cards, whole }) => {
        const row = el('div', 'board-section-row');
        row.append(el('span', 'board-section-title', section.title), el('span', 'board-group-count', String(cards.length)));
        const make = button('Make group', () => sectionToGroup(g, section), { title: 'Make this section a group of its own' });
        make.disabled = whole;
        row.append(make);
        list.append(row);
      });
      root.append(list);
    }
    const actions = el('div', 'board-actions');
    const shuffle = button('Re-shuffle cards', () => reshuffleGroup(g), { title: g.arrange ? 'Sort the cards into their sections again, and fit the frame around them' : 'Close the gaps, oldest first, and fit the frame around the cards' });
    shuffle.disabled = g.collapsed || !membersOf(g.id).length;
    actions.append(shuffle, button('Delete group, keep cards', removeSelection, { className: 'board-danger' }));
    root.append(actions);
  }

  function itemName(id) {
    const o = objectById(id);
    if (!o) return groupById(id)?.title || 'Untitled group';
    if (o.kind !== 'doc') return o.title || `Untitled ${KINDS[o.kind].toLowerCase()}`;
    return s.docs[o.doc_id] ? docTitle(s.docs[o.doc_id]) : 'A document you can no longer see';
  }

  function inspectLink(root, c) {
    const nameOf = itemName;
    root.append(el('div', 'board-panel-title', 'Connection'));
    const facts = el('dl', 'board-facts');
    facts.append(el('dt', null, 'From'), el('dd', null, nameOf(c.from)), el('dt', null, 'To'), el('dd', null, nameOf(c.to)));
    root.append(facts, textInput('Label', c, 'label', 100, false, () => { queueLinks(); scheduleSave(); }), swatches(c));
    const check = el('label', 'board-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = c.directed;
    box.addEventListener('change', () => {
      c.directed = box.checked;
      commit();
    });
    check.append(box, document.createTextNode('Arrow from first to second'));
    const actions = el('div', 'board-actions');
    actions.append(button('Swap direction', () => {
      [c.from, c.to] = [c.to, c.from];
      commit();
      renderInspector();
    }), button('Delete', removeSelection, { className: 'board-danger' }));
    root.append(check, actions);
  }

  function inspectMany(root, ids) {
    const items = ids.map(id => objectById(id) || groupById(id)).filter(Boolean);
    root.append(el('div', 'board-panel-title', `${items.length} selected`), swatches(items, 'Colour for all'));
    const actions = el('div', 'board-actions');
    actions.append(button('Group', groupSelection), button('Remove', removeSelection, { className: 'board-danger' }));
    root.append(actions, el('p', 'board-note', 'Documents go back to the tray. Notes and other objects are deleted, and Undo brings them back.'));
  }

  // ----- Versions and starting again -----
  function openPanel(panel) {
    showInspector(true);
    previewLink(null);
    s.suggest = null;
    s.panel = panel;
    renderInspector();
  }

  function closePanel() {
    s.panel = null;
    renderInspector();
  }

  function panelHead(root, title) {
    const head = el('div', 'board-tray-head');
    head.append(el('span', 'board-panel-title', title), button('Close', closePanel));
    root.append(head);
  }

  // Versions copy the board as saved, so anything unsaved has to go first.
  async function saveFirst() {
    const board = s;
    await saveNow(true);
    if (s !== board) return false;
    if (s.conflict || isDirty()) throw new Error('The board has to be saved first, and that isn\'t working right now.');
    return true;
  }

  async function openVersions() {
    const board = s;
    openPanel({ loading: true });
    try {
      const { versions } = await collectionsApi('GET', `${boardUrl()}/versions`);
      if (s !== board || !s.panel || s.panel.reset) return;
      s.panel = { versions };
    } catch (err) {
      if (s !== board || !s.panel) return;
      s.panel = { error: err.message };
    }
    renderInspector();
  }

  function renderVersions(root) {
    const { panel } = s;
    panelHead(root, 'Versions');
    if (panel.loading) return root.append(el('p', 'board-note', 'Loading…'));
    if (panel.error) root.append(el('p', 'board-note board-rating-stale', panel.error));
    if (!panel.versions) return;
    const form = el('form', 'board-version-new');
    const name = el('input');
    name.type = 'text';
    name.maxLength = 100;
    name.placeholder = 'Name this version';
    name.setAttribute('aria-label', 'Name this version');
    const add = el('button', null, 'Save version');
    add.type = 'submit';
    form.append(name, add);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!name.value.trim()) return;
      add.disabled = true;
      try {
        if (!await saveFirst()) return;
        await collectionsApi('POST', `${boardUrl()}/versions`, { name: name.value });
        await openVersions();
      } catch (err) {
        s.panel.error = err.message;
        renderInspector();
      }
    });
    root.append(el('p', 'board-note', 'A version keeps the board as it is now, to come back to whenever you like. Restoring one keeps what it replaces as another version.'), form);
    if (!panel.versions.length) return root.append(el('p', 'board-note', 'No versions yet.'));
    const list = el('div', 'board-suggest-list');
    panel.versions.forEach(v => {
      const row = el('div', 'board-version');
      row.append(el('div', 'board-suggest-names', v.name));
      const when = new Date(v.created).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      row.append(el('div', 'board-suggest-reason', `${v.auto ? 'Automatic · ' : ''}${when} · ${v.cards} card${v.cards === 1 ? '' : 's'}, ${v.groups} group${v.groups === 1 ? '' : 's'}, ${v.connections} connection${v.connections === 1 ? '' : 's'}`));
      const actions = el('div', 'board-actions');
      if (panel.confirmDelete === v.id) {
        actions.append(button('Cancel', () => { panel.confirmDelete = null; renderInspector(); }),
          button('Delete version', () => deleteVersion(v), { className: 'board-danger' }));
      } else {
        actions.append(button('Restore', () => restoreVersion(v)),
          button('Delete', () => { panel.confirmDelete = v.id; renderInspector(); }, { className: 'board-danger' }));
      }
      row.append(actions);
      list.append(row);
    });
    root.append(list);
  }

  async function deleteVersion(v) {
    try {
      await collectionsApi('DELETE', `${boardUrl()}/versions/${v.id}`);
      await openVersions();
    } catch (err) {
      s.panel.error = err.message;
      renderInspector();
    }
  }

  async function restoreVersion(v) {
    const board = s;
    try {
      if (!await saveFirst()) return;
      await collectionsApi('POST', `${boardUrl()}/versions/${v.id}/restore`, { revision: s.revision });
      if (s !== board) return;
      await load();
      setStatus(`Restored ${v.name}`);
    } catch (err) {
      if (s !== board) return;
      s.panel = { ...s.panel, error: err.message };
      renderInspector();
    }
  }

  function renderResetConfirm(root) {
    panelHead(root, 'Reset board');
    const { objects, groups, connections } = s.data;
    const docs = objects.filter(o => o.kind === 'doc').length;
    if (!objects.length && !groups.length) return root.append(el('p', 'board-note', 'The board is already empty.'));
    root.append(el('p', 'board-note', `This clears everything: ${objects.length} card${objects.length === 1 ? '' : 's'}, ${groups.length} group${groups.length === 1 ? '' : 's'} and ${connections.length} connection${connections.length === 1 ? '' : 's'}, along with your notes, event dates and dismissed suggestions.`),
      el('p', 'board-note', `The ${docs} document${docs === 1 ? '' : 's'} stay in the collection and go back to the tray. The board is first saved as a version called "Before reset", so you can restore it.`));
    if (s.panel.error) root.append(el('p', 'board-note board-rating-stale', s.panel.error));
    const actions = el('div', 'board-actions');
    actions.append(button('Cancel', closePanel), button('Reset board', e => resetTheBoard(e.currentTarget), { className: 'board-danger' }));
    root.append(actions);
  }

  async function resetTheBoard(confirm) {
    const board = s;
    confirm.disabled = true;
    try {
      if (!await saveFirst()) return;
      await collectionsApi('POST', `${boardUrl()}/versions`, { name: 'Before reset', auto: true });
      if (s !== board) return;
    } catch (err) {
      if (s !== board) return;
      s.panel = { reset: true, error: `The board wasn't reset, as it couldn't be saved first: ${err.message}` };
      return renderInspector();
    }
    stopPlay();
    s.panel = null;
    s.range = null;
    s.selected = new Set();
    s.selectedLink = null;
    setHighlight(null);
    setConnecting(null);
    s.data = { objects: [], groups: [], connections: [], dismissed: [] };
    commit();
    renderInspector();
    fitView();
  }

  // ----- Suggestions -----
  const QUALITY_LABELS = { near_identical: 'very alike', clear: 'clear', some: 'some shared wording', unclear: 'unclear', too_few: 'too few to rate' };

  // Worked out on the server from the saved board, so anything unsaved goes
  // first. Nothing changes until it's accepted, and accepting is one undo step.
  // Called with true only for Find similar documents: a toolbar button passes its click event.
  async function openSuggestions(option) {
    const similar = option === true;
    const board = s;
    showInspector(true);
    s.panel = null;
    s.suggest = { loading: true, similar };
    renderInspector();
    await saveNow();
    if (s !== board) return;
    if (isDirty()) {
      s.suggest = { error: 'The board has to be saved first, and that isn\'t working right now.' };
      return renderInspector();
    }
    // Says how far it's got. A failure here doesn't matter: the answer still comes.
    const watching = setInterval(async () => {
      const status = await collectionsApi('GET', `${boardUrl()}/suggestions/status`).catch(() => null);
      if (s !== board || !s.suggest || !s.suggest.loading || !status || !status.stage) return;
      s.suggest.stage = status.stage;
      const line = s.els.inspector?.querySelector('.board-suggest-stage');
      if (line) line.textContent = status.stage;
    }, 700);
    try {
      const data = await collectionsApi('GET', `${boardUrl()}/suggestions${similar ? '?similar=1' : ''}`);
      if (s !== board || !s.suggest) return;
      s.suggest = {
        ...data,
        chosen: new Set(data.connections.filter(c => c.sure).map(suggestionKey)),
        grouping: data.groupings.length ? data.groupings[0].key : null,
      };
    } catch (err) {
      if (s !== board || !s.suggest) return;
      s.suggest = { error: err.message };
    } finally {
      clearInterval(watching);
    }
    renderInspector();
  }

  const suggestionKey = c => (c.from < c.to ? `${c.from}|${c.to}` : `${c.to}|${c.from}`);
  const isConnected = (a, b) => s.data.connections.some(c => (c.from === a && c.to === b) || (c.from === b && c.to === a));

  function closeSuggestions() {
    previewLink(null);
    s.suggest = null;
    renderInspector();
  }

  function previewLink(c) {
    s.els.links.querySelector('.board-link-suggested')?.remove();
    if (!c) return;
    const [from, to] = [drawnId(c.from), drawnId(c.to)];
    const [a, b] = [rectOf(from), rectOf(to)];
    if (!a || !b || from === to) return;
    const start = edgePoint(a, b.x + b.w / 2, b.y + b.h / 2);
    const end = edgePoint(b, a.x + a.w / 2, a.y + a.h / 2);
    s.els.links.appendChild(svg('line', { class: 'board-link-suggested', x1: start.x, y1: start.y, x2: end.x, y2: end.y }));
  }

  function renderSuggestions(root) {
    const data = s.suggest;
    const head = el('div', 'board-tray-head');
    head.append(el('span', 'board-panel-title', 'Suggestions'), button('Close', closeSuggestions));
    root.append(head);
    if (data.loading) {
      root.append(el('p', 'board-note board-suggest-stage', data.stage || 'Reading the documents on the board…'));
      if (data.similar) root.append(el('p', 'board-note', 'Comparing every document with the others can take a while on a large board.'));
      return;
    }
    if (data.error) return root.append(el('p', 'board-note', data.error));
    if (!data.analysed) return root.append(el('p', 'board-note', 'Put some documents on the board first. Suggestions only look at what\'s on it.'));
    const note = `Looked at ${data.analysed.toLocaleString()} document${data.analysed === 1 ? '' : 's'} on the board`
      + `${data.unavailable ? `, not the ${data.unavailable.toLocaleString()} you can no longer see` : ''}. These are leads to check, not findings. Nothing changes until you accept it.`;
    root.append(el('p', 'board-note', note));
    if (data.vectors_failed) root.append(el('p', 'board-note', 'Vector search wasn\'t available just now, so these use words alone.'));
    renderGroupingChoice(root, data);
    renderConnectionChoice(root, data);
  }

  function renderConnectionChoice(root, data) {
    // Lists of ids, not lookups for each row: there can be thousands of rows.
    const onBoard = new Set(s.data.objects.map(o => o.id));
    const connected = new Set(s.data.connections.map(suggestionKey));
    const rows = data.connections.filter(c => onBoard.has(c.from) && onBoard.has(c.to) && !connected.has(suggestionKey(c)));
    root.append(el('div', 'board-suggest-title', `Connections (${rows.length.toLocaleString()})`));
    if (!data.similar_included) {
      root.append(button('Find similar documents', () => openSuggestions(true), {
        className: 'board-suggest-similar',
        title: 'Also compare every document with the others, by words and by meaning. It takes longer on a large board.',
      }));
    }
    if (!rows.length) return root.append(el('p', 'board-note', 'Nothing more to suggest. Adding a person, place, organisation or event with a title lets this look for documents that name it.'));
    const accept = button('', () => {
      const room = Math.max(0, MAX_BOARD_CONNECTIONS - s.data.connections.length);
      rows.filter(c => data.chosen.has(suggestionKey(c))).slice(0, room).forEach(c => {
        s.data.connections.push({ id: newId(), from: c.from, to: c.to, label: c.label, color: 'default', directed: c.directed });
      });
      previewLink(null);
      commit();
      renderInspector();
    }, { className: 'board-suggest-accept' });
    const update = () => {
      const n = rows.filter(c => data.chosen.has(suggestionKey(c))).length;
      accept.textContent = `Add ${n.toLocaleString()} connection${n === 1 ? '' : 's'}`;
      accept.disabled = !n;
    };
    const list = el('div', 'board-suggest-list');
    rows.forEach(c => {
      const key = suggestionKey(c);
      const row = el('div', 'board-suggest-row');
      const label = el('label', 'board-suggest-pick');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = data.chosen.has(key);
      box.addEventListener('change', () => {
        if (box.checked) data.chosen.add(key);
        else data.chosen.delete(key);
        update();
      });
      const body = el('span', 'board-suggest-body');
      body.append(el('span', 'board-suggest-kind', c.label),
        el('span', 'board-suggest-names', `${itemName(c.from)} ${c.directed ? '→' : '↔'} ${itemName(c.to)}`),
        el('span', 'board-suggest-reason', c.reason));
      label.append(box, body);
      const dismiss = button('×', () => {
        previewLink(null);
        s.data.dismissed.push(key);
        // The oldest make way, within what a board can keep.
        if (s.data.dismissed.length > MAX_DISMISSED) s.data.dismissed.shift();
        data.connections = data.connections.filter(x => x !== c);
        data.chosen.delete(key);
        commit();
        renderInspector();
      }, { className: 'board-suggest-dismiss', title: 'Don\'t suggest this one again' });
      dismiss.setAttribute('aria-label', `Don't suggest ${itemName(c.from)} and ${itemName(c.to)} again`);
      row.append(label, dismiss);
      row.addEventListener('mouseenter', () => previewLink(c));
      row.addEventListener('mouseleave', () => previewLink(null));
      list.append(row);
    });
    update();
    root.append(list, accept);
    const more = data.connections_total - data.connections.length;
    if (more > 0) root.append(el('p', 'board-note', `${more.toLocaleString()} more weren't listed. Add or dismiss these, then choose Suggest again to see more.`));
  }

  function renderGroupingChoice(root, data) {
    root.append(el('div', 'board-suggest-title', 'Group by'));
    if (!data.groupings.length) {
      root.append(el('p', 'board-note', data.groupingApplied ? 'Applied. Undo takes it back, and Suggest looks again.' : 'No useful way to divide the cards that aren\'t already in a group.'));
      return;
    }
    const tabs = el('div', 'board-suggest-tabs');
    data.groupings.forEach(g => {
      tabs.append(button(g.label, () => {
        data.grouping = g.key;
        renderInspector();
      }, { className: g.key === data.grouping ? 'active' : '' }));
    });
    const chosen = data.groupings.find(g => g.key === data.grouping);
    // Which are ticked, per grouping, as this redraws. Short notes and unclear
    // topics can still be ticked, as some real topics rate as unclear, but they
    // aren't a topic until someone says so.
    if (!data.ticked) data.ticked = {};
    if (!data.ticked[chosen.key]) {
      data.ticked[chosen.key] = new Set(chosen.groups.filter(g => !g.short && !(g.quality && g.quality.rating === 'unclear')).map(g => g.title));
    }
    const ticked = data.ticked[chosen.key];
    const nameOf = id => (data.names && data.names[id]) || itemName(id);
    const quality = chosen.quality;
    const parts = [tabs];
    if (quality) {
      const shown = Object.entries(QUALITY_LABELS).filter(([key]) => quality[key]).map(([key, label]) => `${quality[key]} ${label}`);
      parts.push(el('p', 'board-note', `${shown.join(', ')}. This is about how clearly a group's documents share wording, not whether it's right: some real topics show as unclear, so check them rather than dismissing them.`));
    }
    const preview = el('ul', 'board-suggest-groups');
    chosen.groups.forEach(g => {
      const item = el('li');
      const pick = el('label', 'board-suggest-pick');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = ticked.has(g.title);
      box.addEventListener('change', () => {
        if (box.checked) ticked.add(g.title);
        else ticked.delete(g.title);
        updateApply();
      });
      const body = el('span', 'board-suggest-body');
      const line = el('span', 'board-suggest-names', g.title);
      line.append(el('span', 'board-group-count', ` ${g.members.length}`));
      if (g.quality) {
        const chip = el('span', `board-quality ${g.quality.rating}`, QUALITY_LABELS[g.quality.rating]);
        chip.title = `Key words found in ${Math.round(g.quality.shared * 100)}% of a test half of this group. Average similarity ${g.quality.alike.toFixed(2)}.`;
        body.append(chip);
      }
      body.append(line);
      pick.append(box, body);
      item.append(pick);
      const weakFits = g.quality ? g.quality.weak_fits : [];
      if (weakFits.length) {
        const list = el('details', 'board-weak-fits');
        list.append(el('summary', null, `${weakFits.length} weak fit${weakFits.length === 1 ? '' : 's'}`));
        const names = el('ul');
        weakFits.forEach(id => names.append(el('li', null, nameOf(id))));
        list.append(names);
        item.append(list);
      }
      preview.append(item);
    });
    parts.push(preview);
    if (quality && quality.unclear) {
      parts.push(button(`Untick ${quality.unclear} unclear`, () => {
        chosen.groups.filter(g => g.quality.rating === 'unclear').forEach(g => ticked.delete(g.title));
        renderInspector();
      }));
    }
    const totalWeak = quality ? quality.weak_fits : 0;
    if (totalWeak) {
      const check = el('label', 'board-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = Boolean(data.leaveOutWeak);
      box.addEventListener('change', () => {
        data.leaveOutWeak = box.checked;
        updateApply();
      });
      check.append(box, document.createTextNode(`Leave out the ${totalWeak.toLocaleString()} weak fit${totalWeak === 1 ? '' : 's'}`));
      parts.push(check);
    }
    const apply = button('', () => applyGrouping({ ...chosen, groups: applying() }, data.arrange || ''), {
      className: 'board-suggest-accept', title: 'Makes the frames and moves these cards into them',
    });
    const applyNote = el('p', 'board-note');
    // What would go in: frames of two or more, biggest first, so that if they
    // don't all fit, the smallest are what's left out.
    const wanted = () => {
      const leavingOut = new Set(data.leaveOutWeak && quality ? chosen.groups.flatMap(g => g.quality.weak_fits) : []);
      return chosen.groups.filter(g => ticked.has(g.title))
        .map(g => {
          const members = g.members.filter(id => !leavingOut.has(id));
          return { ...g, members, left_out: g.members.length - members.length };
        })
        .filter(g => g.members.length >= 2);
    };
    const room = () => Math.max(0, MAX_BOARD_GROUPS - s.data.groups.length);
    const applying = () => wanted().slice(0, room());
    // Not a redraw, which would lose the place in the list.
    function updateApply() {
      const groups = applying();
      const covered = groups.reduce((sum, g) => sum + g.members.length, 0);
      apply.textContent = `Apply ${groups.length} group${groups.length === 1 ? '' : 's'}`;
      apply.disabled = !groups.length;
      const notes = [`Moves ${covered.toLocaleString()} card${covered === 1 ? '' : 's'} into frames. Cards already in a group stay where they are.`];
      const noRoom = wanted().length - groups.length;
      if (noRoom) notes.push(`${noRoom.toLocaleString()} smaller group${noRoom === 1 ? '' : 's'} won't fit, as a board holds up to ${MAX_BOARD_GROUPS} groups.`);
      if (chosen.left_out) notes.push(`${chosen.left_out.toLocaleString()} smaller group${chosen.left_out === 1 ? ' was' : 's were'} not offered.`);
      applyNote.textContent = notes.join(' ');
    }
    updateApply();
    parts.push(arrangeChoice('Arrange each group by', data.arrange || '', value => { data.arrange = value; }), apply, applyNote);
    root.append(...parts);
  }

  // A grid for cards in a frame, and the frame's size around it.
  function gridFor(cards) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(cards.length)));
    const rowH = Math.max(CARD_H, ...cards.map(o => (s.sizes.get(o.id) || {}).h || CARD_H)) + GROUP_GAP;
    const rows = Math.ceil(cards.length / cols);
    return {
      cols, rowH,
      w: Math.max(MIN_GROUP_W, cols * (CARD_W + GROUP_GAP) - GROUP_GAP + GROUP_PAD * 2),
      h: Math.max(MIN_GROUP_H, rows * rowH - GROUP_GAP + GROUP_HEAD + GROUP_PAD),
    };
  }

  function placeInFrame(cards, frame, { cols, rowH }) {
    cards.forEach((o, i) => {
      o.x = frame.x + GROUP_PAD + (i % cols) * (CARD_W + GROUP_GAP);
      o.y = frame.y + GROUP_HEAD + Math.floor(i / cols) * rowH;
    });
  }

  // Frames in rows to the right of whatever isn't moving, each with its cards in a grid.
  function applyGrouping(chosen, arrange = '') {
    const moving = new Set(chosen.groups.flatMap(g => g.members));
    const staying = [...s.nodes.keys()].filter(id => !moving.has(id)).map(rectOf).filter(Boolean);
    const originX = staying.length ? Math.max(...staying.map(r => r.x + r.w)) + 80 : 0;
    const originY = staying.length ? Math.min(...staying.map(r => r.y)) : 0;
    const shapes = chosen.groups.map(g => {
      const cards = g.members.map(objectById).filter(o => o && !o.group);
      if (!cards.length) return { cards };
      const frame = { id: newId(), title: g.title, color: 'default', collapsed: false, x: 0, y: 0, w: 0, h: 0, ...(arrange && { arrange }) };
      if (g.quality) {
        const { rating, basis, alike, shared, weak_fits: weakFits } = g.quality;
        const members = cards.map(o => o.id);
        frame.quality = { rating, basis, alike, shared, members, weak_fits: weakFits.filter(id => members.includes(id)), left_out: g.left_out || 0 };
      }
      cards.forEach(o => { o.group = frame.id; });
      s.data.groups.push(frame);
      layOutGroup(frame);
      return { frame, cards, w: frame.w, h: frame.h };
    }).filter(shape => shape.frame);
    const totalArea = shapes.reduce((sum, f) => sum + (f.w + GROUP_MARGIN) * (f.h + GROUP_MARGIN), 0);
    const widest = Math.max(0, ...shapes.map(f => f.w));
    const rowWidth = Math.max(widest, Math.sqrt(totalArea) * 1.3);
    let [x, y, tallest] = [0, 0, 0];
    shapes.forEach(({ frame, cards, w, h }) => {
      if (x && x + w > rowWidth) {
        x = 0;
        y += tallest + GROUP_MARGIN;
        tallest = 0;
      }
      frame.x = originX + x;
      frame.y = originY + y;
      cards.forEach(o => {
        o.x += frame.x;
        o.y += frame.y;
      });
      x += w + GROUP_MARGIN;
      tallest = Math.max(tallest, h);
    });
    commit();
    // The cards have moved and their groups changed, so the other options are out of date.
    s.suggest.groupings = [];
    s.suggest.groupingApplied = true;
    renderInspector();
    fitView();
  }

  // ----- Timeline -----
  function buildTime() {
    const { time } = s.els;
    const tools = el('div', 'board-time-tools');
    const play = button('Play', togglePlay, { title: 'Move through time, up to the end of the timeline' });
    const reset = button('All dates', () => {
      stopPlay();
      s.range = null;
      syncSliders();
      applyRange();
    });
    const hide = button(s.root.classList.contains('hide-out') ? 'Hiding' : 'Fading', () => {
      const on = s.root.classList.toggle('hide-out');
      hide.textContent = on ? 'Hiding' : 'Fading';
      savePref(HIDE_KEY, on ? '1' : '0');
    }, { title: 'Whether what\'s outside the period fades or disappears' });
    tools.append(play, reset, hide);
    const track = el('div', 'board-time-track');
    const bars = el('div', 'board-time-bars');
    const makeRange = name => {
      const input = el('input');
      input.type = 'range';
      input.setAttribute('aria-label', name);
      input.addEventListener('input', onSlider);
      return input;
    };
    const from = makeRange('Start of period');
    const to = makeRange('End of period');
    track.append(bars, from, to);
    const label = el('div', 'board-time-label');
    const spacer = el('div');
    time.append(tools, track, spacer, label);
    Object.assign(s.els, { play, resetRange: reset, bars, from, to, timeLabel: label, track, timeTools: tools });
  }

  function onSlider(e) {
    stopPlay();
    const { from, to } = s.els;
    let [lo, hi] = [Number(from.value), Number(to.value)];
    if (lo > hi) {
      if (e.target === from) lo = hi;
      else hi = lo;
    }
    setRange(lo, hi);
  }

  function setRange(lo, hi) {
    const { min, max } = s.bounds;
    s.range = lo <= min && hi >= max ? null : { from: lo, to: hi };
    syncSliders();
    applyRange();
  }

  function syncSliders() {
    if (!s.bounds) return;
    const { min, max } = s.bounds;
    const { from, to } = s.els;
    [from, to].forEach(input => { input.min = min; input.max = max; });
    from.value = s.range ? s.range.from : min;
    to.value = s.range ? s.range.to : max;
  }

  function renderTime() {
    const days = s.data.objects.map(timeOf).filter(t => t !== null).map(toDay);
    const had = s.bounds;
    s.bounds = days.length ? { min: Math.min(...days), max: Math.max(...days) } : null;
    const usable = s.bounds && s.bounds.max > s.bounds.min;
    s.els.track.hidden = !usable;
    s.els.timeTools.hidden = !usable;
    s.dayCounts = days;
    if (!usable) {
      s.range = null;
      stopPlay();
      s.els.bars.replaceChildren();
      return;
    }
    // A period that no longer fits, after dates change, is dropped.
    if (s.range && (!had || s.range.to < s.bounds.min || s.range.from > s.bounds.max)) s.range = null;
    if (s.range) {
      s.range = { from: Math.max(s.range.from, s.bounds.min), to: Math.min(s.range.to, s.bounds.max) };
    }
    const span = s.bounds.max - s.bounds.min + 1;
    const bins = new Array(Math.min(HIST_BINS, span)).fill(0);
    days.forEach(d => { bins[Math.min(bins.length - 1, Math.floor((d - s.bounds.min) / span * bins.length))]++; });
    const peak = Math.max(...bins);
    s.els.bars.replaceChildren(...bins.map((n, i) => {
      const bar = el('div', 'board-time-bar');
      bar.style.height = n ? `max(3px, ${n / peak * 100}%)` : '0';
      const start = s.bounds.min + Math.floor(i * span / bins.length);
      const end = s.bounds.min + Math.floor((i + 1) * span / bins.length) - 1;
      bar.dataset.from = start;
      bar.dataset.to = end;
      bar.title = `${start === end ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end)}`}: ${n.toLocaleString()}`;
      return bar;
    }));
    syncSliders();
  }

  function isOut(item) {
    if (!s.range) return false;
    const t = timeOf(item);
    if (t === null) return false;
    const day = toDay(t);
    return day < s.range.from || day > s.range.to;
  }

  function applyLinkRange() {
    s.els.links.querySelectorAll('.board-link').forEach(shape => {
      const c = s.data.connections.find(x => x.id === shape.dataset.link);
      const outside = id => {
        const o = objectById(id);
        if (o) return isOut(o);
        const members = membersOf(id);
        return Boolean(s.range) && members.length > 0 && members.every(isOut);
      };
      shape.classList.toggle('out-of-range', Boolean(c) && (outside(c.from) || outside(c.to)));
    });
  }

  function applyRange() {
    s.data.objects.forEach(o => s.nodes.get(o.id)?.classList.toggle('out-of-range', isOut(o)));
    // A group fades once everything in it has; an empty one always stays.
    s.data.groups.forEach(g => {
      const members = membersOf(g.id);
      s.nodes.get(g.id)?.classList.toggle('out-of-range', Boolean(s.range) && members.length > 0 && members.every(isOut));
    });
    applyLinkRange();
    s.els.bars.querySelectorAll('.board-time-bar').forEach(bar => {
      const on = !s.range || (Number(bar.dataset.to) >= s.range.from && Number(bar.dataset.from) <= s.range.to);
      bar.classList.toggle('on', on);
    });
    if (s.els.resetRange) s.els.resetRange.disabled = !s.range;
    updateTimeLabel();
    // What can't be seen shouldn't be moved or deleted by accident.
    const stillSelected = [...s.selected].filter(id => !s.nodes.get(id)?.classList.contains('out-of-range'));
    if (stillSelected.length !== s.selected.size) select(stillSelected);
    else if (s.selectedLink && s.els.links.querySelector(`[data-link="${s.selectedLink}"].out-of-range`)) select([]);
  }

  function updateTimeLabel() {
    const { timeLabel } = s.els;
    timeLabel.replaceChildren();
    const objects = s.data.objects;
    const dated = objects.filter(o => timeOf(o) !== null);
    const undated = objects.length - dated.length;
    const undatedNote = undated ? ` · ${undated.toLocaleString()} undated, always shown` : '';
    if (!s.bounds) {
      timeLabel.textContent = objects.length ? `Nothing on the board has a date yet${undatedNote}` : 'The timeline fills in as dated items are added to the board.';
      return;
    }
    if (s.bounds.max === s.bounds.min) {
      timeLabel.textContent = `Everything dated is on ${fmtDay(s.bounds.min)}${undatedNote}`;
      return;
    }
    const lo = s.range ? s.range.from : s.bounds.min;
    const hi = s.range ? s.range.to : s.bounds.max;
    const shown = dated.filter(o => !isOut(o)).length;
    timeLabel.append(el('strong', null, `${fmtDay(lo)} to ${fmtDay(hi)}`),
      document.createTextNode(` · ${shown.toLocaleString()} of ${dated.length.toLocaleString()} dated item${dated.length === 1 ? '' : 's'}${undatedNote}`));
  }

  function togglePlay() {
    if (s.playTimer) return stopPlay();
    if (!s.bounds) return;
    const { min, max } = s.bounds;
    const lo = s.range ? s.range.from : min;
    let hi = s.range && s.range.to < max ? s.range.to : lo;
    const step = Math.max(1, Math.ceil((max - lo) / PLAY_STEPS));
    s.els.play.textContent = 'Pause';
    setRange(lo, hi);
    s.playTimer = setInterval(() => {
      hi = Math.min(max, hi + step);
      setRange(lo, hi);
      if (hi >= max) stopPlay();
    }, PLAY_TICK);
  }

  function stopPlay() {
    if (!s || !s.playTimer) return;
    clearInterval(s.playTimer);
    s.playTimer = null;
    s.els.play.textContent = 'Play';
  }

  // ----- Keyboard -----
  function setSpaceHeld(on) {
    s.spaceHeld = on;
    s.els.canvas.classList.toggle('pan-ready', on);
  }

  function onKeyDown(e) {
    if (!s.loaded) {
      if (e.key === 'Escape') closeBoard();
      return;
    }
    // Space still works a focused control, and types in a field.
    if (e.code === 'Space' && !e.target.matches?.('button, a, input, textarea')) {
      e.preventDefault();
      setSpaceHeld(true);
      return;
    }
    const typing = e.target.matches && e.target.matches('input:not([type="range"]):not([type="checkbox"]), textarea');
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (typing) return e.target.blur();
      if (s.connecting) return setConnecting(null);
      if (s.selected.size || s.selectedLink) return select([]);
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (typing) e.target.blur();
      return saveByHand();
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      return showSide('find', true);
    }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? restore(s.redo, s.undo) : restore(s.undo, s.redo);
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return restore(s.redo, s.undo);
    }
    if (mod || e.target.matches?.('input[type="range"]')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!s.selected.size && !s.selectedLink) return;
      e.preventDefault();
      return removeSelection();
    }
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (move && s.selected.size) {
      e.preventDefault();
      const amount = e.shiftKey ? 50 : 10;
      const moved = new Set();
      s.selected.forEach(id => {
        const o = objectById(id);
        if (o) moved.add(o);
        const g = groupById(id);
        if (g) {
          moved.add(g);
          membersOf(id).forEach(m => moved.add(m));
        }
      });
      moved.forEach(item => {
        item.x += move[0] * amount;
        item.y += move[1] * amount;
      });
      const focused = document.activeElement?.dataset?.node;
      commit();
      if (focused) s.nodes.get(focused)?.focus({ preventScroll: true });
    }
  }
})();
