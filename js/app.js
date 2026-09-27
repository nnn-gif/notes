"use strict";

/* ================= storage adapter ================= */
/* chrome.storage.local inside the extension; localStorage fallback so the page
   also works when opened directly as a file (dev/testing). */

const hasChromeStorage =
  typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

const store = {
  get(keys) {
    if (hasChromeStorage) return chrome.storage.local.get(keys);
    const arr = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of arr) {
      const raw = localStorage.getItem(k);
      if (raw != null) {
        try { out[k] = JSON.parse(raw); } catch (_) { /* ignore */ }
      }
    }
    return Promise.resolve(out);
  },
  set(obj) {
    if (hasChromeStorage) return chrome.storage.local.set(obj);
    for (const [k, v] of Object.entries(obj)) {
      localStorage.setItem(k, JSON.stringify(v));
    }
    return Promise.resolve();
  },
  onChanged(cb) {
    if (hasChromeStorage) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local") cb();
      });
    } else {
      window.addEventListener("storage", (e) => {
        if (e.key === "notes" || e.key === "theme") cb();
      });
    }
  },
};

/* ================= constants & state ================= */

const COLORS = [
  { id: 0, hex: "#6366f1", name: "indigo" },
  { id: 1, hex: "#f59e0b", name: "amber" },
  { id: 2, hex: "#34d399", name: "green" },
  { id: 3, hex: "#60a5fa", name: "blue" },
  { id: 4, hex: "#f472b6", name: "pink" },
  { id: 5, hex: "#a78bfa", name: "purple" },
];

const TYPES = {
  note:  { id: "note",  label: "Note",       glyph: "✎", hint: "plain text" },
  list:  { id: "list",  label: "List",       glyph: "☰", hint: "checklist items" },
  daily: { id: "daily", label: "Daily todo", glyph: "✓", hint: "checklist for a date" },
};
const TYPE_ORDER = ["note", "list", "daily"];

const WIDGETS = {
  calendar: {
    id: "calendar",
    label: "Calendar",
    icon: "▦",
    defaults: { x: 16, y: 16, w: 380, h: 420 },
    minW: 300, minH: 340,
  },
  today: {
    id: "today",
    label: "Today",
    icon: "✓",
    defaults: { x: 420, y: 16, w: 380, h: 260 },
    minW: 260, minH: 180,
  },
};

const state = {
  notes: [],
  theme: "dark",
  query: "",
  editingId: null,
  hydrated: false,
  calCursor: null, // {y, m} month shown in calendar widget
  selectedDay: null, // "YYYY-MM-DD" day opened in day panel
  widgets: [], // [{ id, type, x, y, w, h }]
  layoutMode: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  clock: $("clock"), date: $("date"), greeting: $("greeting"),
  search: $("search"), quick: $("quick"), quickType: $("quick-type"),
  grid: $("grid"), stats: $("stats"), empty: $("empty"),
  emptyTitle: $("empty-title"), emptySub: $("empty-sub"),
  backdrop: $("editor-backdrop"), edTitle: $("ed-title"), edBody: $("ed-body"),
  edPin: $("ed-pin"), edDelete: $("ed-delete"), edDone: $("ed-done"),
  edCount: $("ed-count"), colorDots: $("color-dots"),
  edType: $("ed-type"), edItems: $("ed-items"), edNewItem: $("ed-new-item"),
  edAddRow: $("ed-add-row"), edDate: $("ed-date"),
  btnNew: $("btn-new"), btnNewList: $("btn-new-list"), btnNewDaily: $("btn-new-daily"),
  btnTheme: $("btn-theme"),
  btnExport: $("btn-export"), btnImport: $("btn-import"),
  fileImport: $("file-import"), toast: $("toast"),
  todaySection: $("today-section"), todayDate: $("today-date"),
  todayProgress: $("today-progress"), todayCards: $("today-cards"),
  calendar: $("calendar"), calTitle: $("cal-title"), calGrid: $("cal-grid"),
  calPrev: $("cal-prev"), calNext: $("cal-next"), calToday: $("cal-today-btn"),
  dayPanel: $("day-panel"),
  widgetBoard: $("widget-board"), btnWidgets: $("btn-widgets"),
};

/* ================= helpers ================= */

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayKey = () => dayKey(new Date());
const parseKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const isDailyForToday = (n) => n.type === "daily" && n.date === todayKey();

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return "just now";
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m ago`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h ago`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)}d ago`;
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateKey(key) {
  return parseKey(key).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function migrateNotes(list) {
  return (Array.isArray(list) ? list : [])
    .filter((n) => n && typeof n === "object")
    .map((n) => ({
      type: "note",
      date: null,
      ...n,
      type: TYPES[n.type] ? n.type : "note",
      items: Array.isArray(n.items) ? n.items : [],
      date: n.type === "daily" && /^\d{4}-\d{2}-\d{2}$/.test(n.date || "") ? n.date : (n.date ?? null),
    }));
}

function persist() {
  return store.set({ notes: state.notes, widgets: state.widgets });
}

/* ================= clock ================= */

function tick() {
  const d = new Date();
  els.clock.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  els.date.textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const h = d.getHours();
  els.greeting.textContent =
    h < 5 ? "Up late?" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Good night";
}

/* ================= rendering: cards ================= */

function visibleNotes() {
  const q = state.query.trim().toLowerCase();
  const list = q
    ? state.notes.filter((n) => {
        if (n.title.toLowerCase().includes(q)) return true;
        if ((n.body || "").toLowerCase().includes(q)) return true;
        if (Array.isArray(n.items)) return n.items.some((it) => (it.text || "").toLowerCase().includes(q));
        return false;
      })
    : state.notes.slice();
  // pinned first, then daily-for-today, then freshest
  list.sort((a, b) => {
    const ap = a.pinned ? 1 : 0, bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (!q) {
      const ad = isDailyForToday(a) ? 1 : 0, bd = isDailyForToday(b) ? 1 : 0;
      if (ad !== bd) return bd - ad;
    }
    return b.updated - a.updated;
  });
  return list;
}

const PIN_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
const UNPIN_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"></path></svg>';

function itemProgress(items) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0, all: total > 0 && done === total };
}

function createCardEl(note) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = note.id;

  const color = COLORS[note.color] || COLORS[0];
  if (note.color) card.style.setProperty("--card-accent", color.hex);

  const type = TYPES[note.type] || TYPES.note;
  const typeTag = document.createElement("span");
  typeTag.className = "type-tag" + (note.type === "daily" && isDailyForToday(note) ? " today" : "");
  typeTag.textContent = type.glyph;
  typeTag.title = type.label + (note.type === "daily" && note.date ? ` · ${fmtDateKey(note.date)}` : "");
  card.appendChild(typeTag);

  const title = document.createElement("div");
  title.className = "card-title" + (note.title ? "" : " untitled");
  title.textContent = note.title || (note.type === "daily" ? fmtDateKey(note.date) : "Untitled");
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "card-body";
  if (note.type === "note") {
    body.textContent = note.body || "";
    if (!note.body) body.style.opacity = "0.5";
  } else if (Array.isArray(note.items)) {
    const { done, total, all } = itemProgress(note.items);
    if (total === 0) {
      body.textContent = "No items yet";
      body.style.opacity = "0.5";
    } else {
      const ul = document.createElement("div");
      ul.className = "card-items";
      for (const it of note.items.slice(0, 5)) {
        const row = document.createElement("div");
        row.className = "card-item" + (it.done ? " done" : "");
        const box = document.createElement("span");
        box.className = "mini-check" + (it.done ? " on" : "");
        row.appendChild(box);
        const txt = document.createElement("span");
        txt.textContent = it.text;
        row.appendChild(txt);
        ul.appendChild(row);
      }
      const more = note.items.length - 5;
      const summary = document.createElement("div");
      summary.className = "item-summary";
      summary.textContent = all ? `✓ all ${total} done` : `${done}/${total} done${more > 0 ? ` · ${more} more` : ""}`;
      body.appendChild(ul);
      body.appendChild(summary);
    }
  }
  card.appendChild(body);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (note.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-glyph";
    pin.innerHTML = PIN_SVG;
    pin.title = "Pinned";
    meta.appendChild(pin);
  }
  const time = document.createElement("span");
  time.textContent = note.type === "daily" && note.date ? fmtDateKey(note.date) : relTime(note.updated);
  time.title = "updated " + relTime(note.updated);
  meta.appendChild(time);
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const pinBtn = document.createElement("button");
  pinBtn.dataset.act = "pin";
  pinBtn.title = note.pinned ? "Unpin" : "Pin";
  pinBtn.setAttribute("aria-label", pinBtn.title);
  if (note.pinned) { pinBtn.classList.add("pinned"); pinBtn.innerHTML = PIN_SVG; }
  else pinBtn.innerHTML = UNPIN_SVG;
  actions.appendChild(pinBtn);

  const delBtn = document.createElement("button");
  delBtn.dataset.act = "del";
  delBtn.className = "danger";
  delBtn.title = "Delete";
  delBtn.setAttribute("aria-label", "Delete note");
  delBtn.innerHTML = TRASH_SVG;
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

function render() {
  if (!state.hydrated) return;

  const list = visibleNotes();
  const frag = document.createDocumentFragment();
  for (const n of list) frag.appendChild(createCardEl(n));
  els.grid.replaceChildren(frag);

  renderToday();

  const pinnedCount = state.notes.filter((n) => n.pinned).length;
  const q = state.query.trim();
  els.stats.textContent = state.notes.length
    ? `${state.notes.length} note${state.notes.length === 1 ? "" : "s"}${pinnedCount ? ` · ${pinnedCount} pinned` : ""}${q ? ` · ${list.length} match${list.length === 1 ? "" : "es"}` : ""}`
    : "";

  if (state.notes.length === 0) {
    els.emptyTitle.textContent = "No notes yet";
    els.emptySub.replaceChildren(
      "Capture with ", kbd("Enter"), " · press ", kbd("N"), " for a daily todo · lists and notes from the + buttons"
    );
    els.empty.hidden = false;
  } else if (list.length === 0) {
    els.emptyTitle.textContent = `No notes match “${q}”`;
    els.emptySub.replaceChildren("Try a different search term.");
    els.empty.hidden = false;
  } else {
    els.empty.hidden = true;
  }
}

function kbd(text) {
  const k = document.createElement("kbd");
  k.textContent = text;
  return k;
}

/* ================= today section ================= */

function renderToday() {
  const dailies = state.notes.filter(isDailyForToday);
  if (dailies.length === 0) {
    els.todaySection.hidden = true;
    return;
  }
  els.todaySection.hidden = false;
  els.todayDate.textContent = fmtDateKey(todayKey());
  let done = 0, total = 0;
  const frag = document.createDocumentFragment();
  for (const n of dailies) {
    const row = document.createElement("div");
    row.className = "today-item";
    row.dataset.id = n.id;
    const head = document.createElement("div");
    head.className = "today-item-head";
    const label = document.createElement("span");
    label.className = "today-item-title";
    label.textContent = n.title || "Daily list";
    head.appendChild(label);
    if (Array.isArray(n.items)) {
      const p = itemProgress(n.items);
      done += p.done; total += p.total;
      const badge = document.createElement("span");
      badge.className = "today-badge" + (p.all ? " all" : "");
      badge.textContent = p.total ? `${p.done}/${p.total}` : "empty";
      head.appendChild(badge);
    }
    row.appendChild(head);
    if (Array.isArray(n.items)) {
      const list = document.createElement("div");
      list.className = "today-item-list";
      for (const it of n.items) {
        const line = document.createElement("label");
        line.className = "today-line" + (it.done ? " done" : "");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = it.done;
        box.dataset.itemId = it.id;
        line.appendChild(box);
        const txt = document.createElement("span");
        txt.textContent = it.text;
        line.appendChild(txt);
        list.appendChild(line);
      }
      row.appendChild(list);
    }
    frag.appendChild(row);
  }
  els.todayCards.replaceChildren(frag);
  els.todayProgress.textContent = total ? `${done}/${total} done` : "";
}

/* ================= calendar ================= */

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function renderCalendar() {
  const now = new Date();
  const cursor = state.calCursor || { y: now.getFullYear(), m: now.getMonth() };
  state.calCursor = cursor;
  els.calTitle.textContent = new Date(cursor.y, cursor.m, 1)
    .toLocaleDateString([], { month: "long", year: "numeric" });

  const dailiesByDay = new Map();
  for (const n of state.notes) {
    if (n.type === "daily" && n.date) {
      const arr = dailiesByDay.get(n.date) || [];
      arr.push(n);
      dailiesByDay.set(n.date, arr);
    }
  }

  const frag = document.createDocumentFragment();
  for (const lbl of DAY_LABELS) {
    const h = document.createElement("div");
    h.className = "cal-dow";
    h.textContent = lbl;
    frag.appendChild(h);
  }

  const first = new Date(cursor.y, cursor.m, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const tk = todayKey();

  for (let i = 0; i < startOffset; i++) {
    frag.appendChild(document.createElement("div"));
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${cursor.y}-${pad2(cursor.m + 1)}-${pad2(day)}`;
    const cell = document.createElement("button");
    cell.className = "cal-day";
    cell.dataset.day = key;
    cell.dataset.count = dailiesByDay.get(key)?.length || 0;
    if (key === tk) cell.classList.add("is-today");
    if (state.selectedDay === key) cell.classList.add("is-selected");
    cell.innerHTML = `<span class="cal-num">${day}</span>`;
    const dayNotes = dailiesByDay.get(key) || [];
    let done = 0, total = 0;
    for (const n of dayNotes) {
      if (Array.isArray(n.items)) {
        const p = itemProgress(n.items);
        done += p.done; total += p.total;
      }
    }
    if (total > 0) {
      const bar = document.createElement("span");
      bar.className = "cal-bar";
      bar.style.setProperty("--p", `${(done / total) * 100}%`);
      if (done === total) bar.classList.add("all");
      cell.appendChild(bar);
      cell.title = `${done}/${total} done`;
    }
    frag.appendChild(cell);
  }
  els.calGrid.replaceChildren(frag);

  if (state.selectedDay) renderDayPanel(state.selectedDay);
  else els.dayPanel.replaceChildren();
}

function renderDayPanel(key) {
  const dayNotes = state.notes.filter((n) => n.type === "daily" && n.date === key);
  const frag = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "dp-title";
  title.textContent = fmtDateKey(key);
  frag.appendChild(title);

  if (dayNotes.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "dp-empty";
    emptyMsg.textContent = "No daily todos for this day.";
    const add = document.createElement("button");
    add.className = "dp-add";
    add.textContent = "+ Add daily todo for this day";
    add.dataset.day = key;
    emptyMsg.appendChild(document.createElement("br"));
    emptyMsg.appendChild(add);
    frag.appendChild(emptyMsg);
  } else {
    for (const n of dayNotes) {
      const box = document.createElement("div");
      box.className = "dp-note";
      box.dataset.id = n.id;
      const head = document.createElement("div");
      head.className = "dp-note-head";
      const label = document.createElement("span");
      label.className = "dp-note-title";
      label.textContent = n.title || "Daily list";
      head.appendChild(label);
      if (Array.isArray(n.items) && n.items.length) {
        const p = itemProgress(n.items);
        const badge = document.createElement("span");
        badge.className = "today-badge" + (p.all ? " all" : "");
        badge.textContent = `${p.done}/${p.total}`;
        head.appendChild(badge);
      }
      box.appendChild(head);
      for (const it of n.items || []) {
        const line = document.createElement("label");
        line.className = "today-line" + (it.done ? " done" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = it.done;
        cb.dataset.itemId = it.id;
        line.appendChild(cb);
        const txt = document.createElement("span");
        txt.textContent = it.text;
        line.appendChild(txt);
        box.appendChild(line);
      }
      frag.appendChild(box);
    }
    const add = document.createElement("button");
    add.className = "dp-add";
    add.textContent = "+ Add another for this day";
    add.dataset.day = key;
    frag.appendChild(add);
  }
  els.dayPanel.replaceChildren(frag);
}

/* ================= widgets ================= */

let dragCtx = null; // { id, mode: "move"|"resize", startX, startY, orig }
let widgetsMenuEl = null;

function vw() { return (typeof window !== "undefined" && window.innerWidth) || 1440; }
function vh() { return (typeof window !== "undefined" && window.innerHeight) || 900; }

function clampWidget(w) {
  const def = WIDGETS[w.type];
  w.w = Math.max(def.minW, Math.min(w.w, vw() - 80));
  w.h = Math.max(def.minH, w.h);
  w.x = Math.max(0, Math.min(w.x, vw() - w.w - 64));
  w.y = Math.max(0, w.y);
}

function widgetFrameEl(w) {
  const def = WIDGETS[w.type];
  const frame = document.createElement("div");
  frame.className = "widget";
  frame.dataset.wid = w.id;
  frame.style.left = w.x + "px";
  frame.style.top = w.y + "px";
  frame.style.width = w.w + "px";
  frame.style.height = w.h + "px";

  const head = document.createElement("div");
  head.className = "widget-head";
  const icon = document.createElement("span");
  icon.className = "widget-icon";
  icon.textContent = def.icon;
  const label = document.createElement("span");
  label.className = "widget-label";
  label.textContent = def.label;
  const rm = document.createElement("button");
  rm.className = "widget-remove";
  rm.title = "Remove widget";
  rm.setAttribute("aria-label", "Remove " + def.label);
  rm.textContent = "×";
  rm.dataset.wact = "remove";
  head.appendChild(icon);
  head.appendChild(label);
  head.appendChild(rm);
  frame.appendChild(head);

  const body = document.createElement("div");
  body.className = "widget-body";
  if (w.type === "calendar") {
    els.calendar.hidden = false;
    body.appendChild(els.calendar);
  } else if (w.type === "today") {
    els.todaySection.hidden = false;
    body.appendChild(els.todaySection);
  }
  frame.appendChild(body);

  const resize = document.createElement("div");
  resize.className = "widget-resize";
  resize.dataset.wact = "resize";
  resize.title = "Resize";
  frame.appendChild(resize);
  return frame;
}

function renderWidgets() {
  if (!state.hydrated) return;
  const frag = document.createDocumentFragment();
  let maxBottom = 0;
  for (const w of state.widgets) {
    frag.appendChild(widgetFrameEl(w));
    maxBottom = Math.max(maxBottom, w.y + w.h);
  }
  els.widgetBoard.replaceChildren(frag);
  els.widgetBoard.style.height = state.widgets.length ? maxBottom + 16 + "px" : "0";
  if (!state.widgets.some((w) => w.type === "calendar")) els.calendar.hidden = true;
  if (!state.widgets.some((w) => w.type === "today")) els.todaySection.hidden = true;
}

function addWidget(type) {
  if (!WIDGETS[type]) return;
  if (state.widgets.some((w) => w.type === type)) return; // one instance per type
  const def = WIDGETS[type];
  const w = { id: uid(), type, ...def.defaults };
  const n = state.widgets.length;
  w.x = Math.min(def.defaults.x + n * 24, vw() - w.w - 8);
  w.y = Math.min(def.defaults.y + n * 24, vh() - w.h - 8);
  clampWidget(w);
  state.widgets.push(w);
  persist().then(() => { renderWidgets(); renderCalendar(); renderToday(); });
}

function removeWidget(id) {
  state.widgets = state.widgets.filter((w) => w.id !== id);
  persist().then(renderWidgets);
}

function removeWidgetByType(type) {
  const w = state.widgets.find((x) => x.type === type);
  if (w) removeWidget(w.id);
}

function closeWidgetsMenu() {
  if (widgetsMenuEl) { widgetsMenuEl.remove(); widgetsMenuEl = null; }
}

function toggleWidgetsMenu() {
  if (widgetsMenuEl) { closeWidgetsMenu(); return; }
  widgetsMenuEl = document.createElement("div");
  widgetsMenuEl.className = "widgets-menu";
  for (const def of Object.values(WIDGETS)) {
    const row = document.createElement("button");
    row.className = "wm-row";
    const active = state.widgets.some((w) => w.type === def.id);
    row.textContent = (active ? "−  Remove  " : "+  Add  ") + def.label;
    row.dataset.wtype = def.id;
    row.addEventListener("click", () => {
      if (active) removeWidgetByType(def.id);
      else addWidget(def.id);
      closeWidgetsMenu();
    });
    widgetsMenuEl.appendChild(row);
  }
  document.body.appendChild(widgetsMenuEl);
}

/* ================= CRUD ================= */

function makeNote(partial = {}) {
  const now = Date.now();
  return {
    id: uid(),
    type: "note",
    title: "",
    body: "",
    items: [],
    date: null,
    color: 0,
    pinned: false,
    created: now,
    updated: now,
    ...partial,
  };
}

function makeItem(text) {
  return { id: uid(), text, done: false };
}

function touch(n) { n.updated = Date.now(); }

function quickCapture() {
  const text = els.quick.value.trim();
  if (!text) return;
  const type = TYPE_ORDER.includes(els.quickType.value) ? els.quickType.value : "note";
  const partial = { type };
  if (type === "daily") {
    partial.date = todayKey();
    partial.title = text.slice(0, 80);
    partial.items = [makeItem(text)];
  } else if (type === "list") {
    partial.title = "List";
    partial.items = text.split(/\s*[,;]\s*|\n/).filter(Boolean).map(makeItem);
  } else {
    partial.title = text.length <= 80 ? text : text.slice(0, 80);
    partial.body = text.length <= 80 ? "" : text;
  }
  state.notes.unshift(makeNote(partial));
  els.quick.value = "";
  persist().then(renderAll);
}

function newNote(type = "note", date = null) {
  const t = TYPES[type] ? type : "note";
  const note = makeNote({ type: t });
  if (t === "daily") note.date = date || todayKey();
  if (t === "list") note.title = "List";
  state.notes.unshift(note);
  openEditor(note.id);
}

function togglePin(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  n.pinned = !n.pinned;
  touch(n);
  persist().then(renderAll);
}

let lastDeleted = null;

function deleteNote(id) {
  const idx = state.notes.findIndex((x) => x.id === id);
  if (idx === -1) return;
  lastDeleted = { note: state.notes[idx], index: idx };
  state.notes.splice(idx, 1);
  if (state.editingId === id) hideEditor(false);
  persist().then(renderAll);
  toast(`Note deleted`, "Undo", () => {
    if (!lastDeleted) return;
    state.notes.splice(Math.min(lastDeleted.index, state.notes.length), 0, lastDeleted.note);
    lastDeleted = null;
    persist().then(renderAll);
  });
}

function toggleItem(noteId, itemId) {
  const n = state.notes.find((x) => x.id === noteId);
  if (!n || !Array.isArray(n.items)) return;
  const it = n.items.find((i) => i.id === itemId);
  if (!it) return;
  it.done = !it.done;
  touch(n);
  persist().then(renderAll);
}

/* ================= editor ================= */

function buildColorDots() {
  els.colorDots.replaceChildren();
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "color-dot";
    b.style.background = c.hex;
    b.title = c.name;
    b.dataset.color = c.id;
    b.setAttribute("aria-label", `Accent ${c.name}`);
    b.addEventListener("click", () => {
      const n = state.notes.find((x) => x.id === state.editingId);
      if (!n) return;
      n.color = c.id;
      syncEditorChrome(n);
      persist().then(renderAll);
    });
    els.colorDots.appendChild(b);
  }
}

function syncEditorChrome(note) {
  els.edPin.setAttribute("aria-pressed", note.pinned ? "true" : "false");
  for (const dot of els.colorDots.children) {
    dot.classList.toggle("selected", Number(dot.dataset.color) === note.color);
  }
  const t = TYPES[note.type] || TYPES.note;
  els.edType.textContent = t.glyph;
  els.edType.title = t.label;
  const words = (els.edBody.value.trim().match(/\S+/g) || []).length;
  const items = Array.isArray(note.items) ? note.items.length : 0;
  const itemBits = items ? ` · ${items} item${items === 1 ? "" : "s"}` : "";
  els.edCount.textContent = `${words} word${words === 1 ? "" : "s"}${itemBits} · saved automatically`;
}

function renderEditorItems(note) {
  if (note.type === "note") {
    els.edItems.hidden = true;
    els.edAddRow.hidden = true;
    els.edBody.style.display = "";
    return;
  }
  els.edBody.style.display = "none";
  els.edItems.hidden = false;
  els.edAddRow.hidden = false;
  const frag = document.createDocumentFragment();
  for (const it of note.items || []) {
    const row = document.createElement("div");
    row.className = "ed-item" + (it.done ? " done" : "");
    row.dataset.itemId = it.id;

    const check = document.createElement("button");
    check.className = "item-check" + (it.done ? " on" : "");
    check.dataset.act = "toggle";
    check.title = it.done ? "Mark undone" : "Mark done";
    row.appendChild(check);

    const input = document.createElement("input");
    input.type = "text";
    input.value = it.text;
    input.dataset.act = "edit";
    input.placeholder = "Item";
    row.appendChild(input);

    const del = document.createElement("button");
    del.className = "item-del";
    del.dataset.act = "delitem";
    del.title = "Remove item";
    del.textContent = "×";
    row.appendChild(del);

    frag.appendChild(row);
  }
  els.edItems.replaceChildren(frag);
  els.edDate.hidden = note.type !== "daily";
  if (note.type === "daily" && note.date) els.edDate.value = note.date;
}

function openEditor(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  state.editingId = id;
  els.edTitle.value = n.title;
  els.edBody.value = n.body || "";
  renderEditorItems(n);
  syncEditorChrome(n);
  els.backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  if (n.type === "note") (n.title ? els.edBody : els.edTitle).focus();
  else els.edNewItem.focus();
}

const editorAutosave = debounce(() => {
  const n = state.notes.find((x) => x.id === state.editingId);
  if (!n) return;
  n.title = els.edTitle.value;
  if (n.type === "note") n.body = els.edBody.value;
  touch(n);
  syncEditorChrome(n);
  persist().then(renderAll);
}, 350);

function hideEditor(save = true) {
  const n = state.notes.find((x) => x.id === state.editingId);
  if (n && save) {
    n.title = els.edTitle.value.trim();
    if (n.type === "note") n.body = els.edBody.value;
    touch(n);
    const emptyBody = n.type === "note" ? !n.body.trim() : !(n.items || []).length && !n.title;
    if (!n.title && emptyBody) {
      const idx = state.notes.indexOf(n);
      if (idx !== -1) state.notes.splice(idx, 1);
    }
  }
  state.editingId = null;
  els.backdrop.hidden = true;
  document.body.style.overflow = "";
  persist().then(renderAll);
}

/* ================= theme / export / import ================= */

function applyTheme() {
  document.body.dataset.theme = state.theme;
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
  store.set({ theme: state.theme });
}

function exportJSON() {
  const payload = { app: "notes-newtab", exported: new Date().toISOString(), notes: state.notes };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  a.href = url;
  a.download = `notes-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${state.notes.length} note${state.notes.length === 1 ? "" : "s"}`);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); } catch (_) { toast("Import failed: not valid JSON"); return; }
    const incoming = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.notes) ? parsed.notes : null;
    if (!incoming) { toast("Import failed: expected an array of notes"); return; }
    const now = Date.now();
    const cleaned = incoming.map((raw) => {
      const type = TYPES[raw?.type] ? raw.type : "note";
      const items = Array.isArray(raw?.items)
        ? raw.items.filter((i) => i && typeof i.text === "string").map((i) => ({
            id: typeof i.id === "string" ? i.id : uid(),
            text: i.text.slice(0, 2000),
            done: Boolean(i.done),
          }))
        : [];
      return makeNote({
        type,
        title: typeof raw?.title === "string" ? raw.title.slice(0, 500) : "",
        body: typeof raw?.body === "string" ? raw.body : "",
        items: type === "note" ? [] : items,
        date: type === "daily" && /^\d{4}-\d{2}-\d{2}$/.test(raw?.date || "") ? raw.date : null,
        color: Number.isInteger(raw?.color) ? Math.min(Math.max(raw.color, 0), COLORS.length - 1) : 0,
        pinned: Boolean(raw?.pinned),
        created: Number.isFinite(raw?.created) ? raw.created : now,
        updated: Number.isFinite(raw?.updated) ? raw.updated : now,
      });
    });
    state.notes = [...cleaned, ...state.notes];
    persist().then(renderAll);
    toast(`Imported ${cleaned.length} note${cleaned.length === 1 ? "" : "s"}`);
  };
  reader.readAsText(file);
}

/* ================= toast ================= */

let toastTimer = null;
function toast(message, actionLabel, onAction) {
  clearTimeout(toastTimer);
  els.toast.replaceChildren();
  els.toast.append(message);
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => { els.toast.hidden = true; onAction?.(); });
    els.toast.appendChild(btn);
  }
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, actionLabel ? 6000 : 2600);
}

/* ================= events ================= */

function wireEvents() {
  els.quick.addEventListener("keydown", (e) => {
    if (e.key === "Enter") quickCapture();
    if (e.key === "Escape") els.quick.blur();
  });

  els.btnNew.addEventListener("click", () => newNote("note"));
  els.btnNewList.addEventListener("click", () => newNote("list"));
  els.btnNewDaily.addEventListener("click", () => newNote("daily"));

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    render();
  });

  els.grid.addEventListener("click", (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const btn = e.target.closest("[data-act]");
    const id = card.dataset.id;
    if (btn?.dataset.act === "pin") togglePin(id);
    else if (btn?.dataset.act === "del") deleteNote(id);
    else openEditor(id);
  });

  // today section checkbox toggles
  els.todayCards.addEventListener("change", (e) => {
    const row = e.target.closest("[data-id]");
    if (!row || e.target.type !== "checkbox") return;
    toggleItem(row.dataset.id, e.target.dataset.itemId);
  });

  // calendar navigation
  els.calPrev.addEventListener("click", () => shiftMonth(-1));
  els.calNext.addEventListener("click", () => shiftMonth(1));
  els.calToday.addEventListener("click", () => {
    const now = new Date();
    state.calCursor = { y: now.getFullYear(), m: now.getMonth() };
    state.selectedDay = todayKey();
    renderCalendar();
  });
  els.calGrid.addEventListener("click", (e) => {
    const cell = e.target.closest("[data-day]");
    if (!cell) return;
    const key = cell.dataset.day;
    state.selectedDay = state.selectedDay === key ? null : key;
    renderCalendar();
  });
  els.dayPanel.addEventListener("click", (e) => {
    if (e.target.dataset.day) {
      newNote("daily", e.target.dataset.day);
      return;
    }
    const box = e.target.closest("[data-id]");
    if (box && e.target.type === "checkbox") return; // handled by change
    if (box && !e.target.closest("[data-act]")) openEditor(box.dataset.id);
  });
  els.dayPanel.addEventListener("change", (e) => {
    const box = e.target.closest("[data-id]");
    if (!box || e.target.type !== "checkbox") return;
    toggleItem(box.dataset.id, e.target.dataset.itemId);
  });

  // editor
  els.edTitle.addEventListener("input", editorAutosave);
  els.edBody.addEventListener("input", editorAutosave);
  els.edDone.addEventListener("click", () => hideEditor(true));
  els.edPin.addEventListener("click", () => {
    if (!state.editingId) return;
    togglePin(state.editingId);
    const n = state.notes.find((x) => x.id === state.editingId);
    if (n) syncEditorChrome(n);
  });
  els.edDelete.addEventListener("click", () => state.editingId && deleteNote(state.editingId));
  els.backdrop.addEventListener("mousedown", (e) => {
    if (e.target === els.backdrop) hideEditor(true);
  });
  els.edBody.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") hideEditor(true);
  });
  els.edDate.addEventListener("change", () => {
    const n = state.notes.find((x) => x.id === state.editingId);
    if (!n || n.type !== "daily") return;
    n.date = els.edDate.value || todayKey();
    touch(n);
    persist().then(renderAll);
  });

  // checklist editing inside editor
  els.edItems.addEventListener("click", (e) => {
    const row = e.target.closest("[data-item-id]");
    if (!row) return;
    const n = state.notes.find((x) => x.id === state.editingId);
    if (!n) return;
    const it = (n.items || []).find((i) => i.id === row.dataset.itemId);
    if (!it) return;
    const act = e.target.dataset.act;
    if (act === "toggle") {
      it.done = !it.done;
      touch(n);
      persist().then(() => { renderEditorItems(n); renderAll(); });
    } else if (act === "delitem") {
      n.items = n.items.filter((i) => i.id !== it.id);
      touch(n);
      persist().then(() => { renderEditorItems(n); renderAll(); });
    }
  });
  els.edItems.addEventListener("input", (e) => {
    if (e.target.dataset.act !== "edit") return;
    const row = e.target.closest("[data-item-id]");
    const n = state.notes.find((x) => x.id === state.editingId);
    if (!n || !row) return;
    const it = (n.items || []).find((i) => i.id === row.dataset.itemId);
    if (!it) return;
    it.text = e.target.value;
    touch(n);
    itemAutosave();
  });
  els.edNewItem.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = els.edNewItem.value.trim();
    if (!text) return;
    const n = state.notes.find((x) => x.id === state.editingId);
    if (!n) return;
    n.items = [...(n.items || []), makeItem(text)];
    touch(n);
    els.edNewItem.value = "";
    persist().then(() => { renderEditorItems(n); renderAll(); });
    els.edNewItem.focus();
  });

  // header actions
  els.btnTheme.addEventListener("click", toggleTheme);
  els.btnExport.addEventListener("click", exportJSON);
  els.btnImport.addEventListener("click", () => els.fileImport.click());
  els.fileImport.addEventListener("change", () => {
    const f = els.fileImport.files?.[0];
    if (f) importJSON(f);
    els.fileImport.value = "";
  });

  // global shortcuts
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input, textarea, select");
    if (e.key === "Escape") {
      if (!els.backdrop.hidden) hideEditor(true);
      else if (typing) e.target.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); els.search.focus(); }
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); newNote("daily"); }
  });

  // widgets
  els.btnWidgets.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWidgetsMenu();
  });
  document.addEventListener("click", (e) => {
    if (widgetsMenuEl && !widgetsMenuEl.contains(e.target) && e.target !== els.btnWidgets) closeWidgetsMenu();
  });

  els.widgetBoard.addEventListener("pointerdown", (e) => {
    const frame = e.target.closest("[data-wid]");
    if (!frame) return;
    const wid = frame.dataset.wid;
    const w = state.widgets.find((x) => x.id === wid);
    if (!w) return;
    const act = e.target.dataset.wact;
    if (act === "remove") { removeWidget(wid); return; }
    if (e.target.closest(".cal-day, .cal-arrow, .cal-jump, .dp-add, .dp-note-head, .today-line, input")) return;
    if (act === "resize") dragCtx = { id: wid, mode: "resize", startX: e.clientX, startY: e.clientY, orig: { ...w } };
    else if (e.target.closest(".widget-head")) dragCtx = { id: wid, mode: "move", startX: e.clientX, startY: e.clientY, orig: { ...w } };
    else return;
    frame.classList.add(dragCtx.mode === "move" ? "dragging" : "resizing");
    e.preventDefault();
  });
  document.addEventListener("pointermove", (e) => {
    if (!dragCtx) return;
    const w = state.widgets.find((x) => x.id === dragCtx.id);
    if (!w) return;
    const dx = e.clientX - dragCtx.startX;
    const dy = e.clientY - dragCtx.startY;
    if (dragCtx.mode === "move") {
      w.x = dragCtx.orig.x + dx;
      w.y = dragCtx.orig.y + dy;
    } else {
      w.w = dragCtx.orig.w + dx;
      w.h = dragCtx.orig.h + dy;
    }
    clampWidget(w);
    const frame = els.widgetBoard.querySelector(`[data-wid="${dragCtx.id}"]`);
    if (frame) {
      frame.style.left = w.x + "px";
      frame.style.top = w.y + "px";
      frame.style.width = w.w + "px";
      frame.style.height = w.h + "px";
      els.widgetBoard.style.height = Math.max(
        parseFloat(els.widgetBoard.style.height) || 0,
        w.y + w.h + 16
      ) + "px";
    }
  });
  const endDrag = () => {
    if (!dragCtx) return;
    const { id } = dragCtx;
    dragCtx = null;
    const frame = els.widgetBoard.querySelector(`[data-wid="${id}"]`);
    if (frame) frame.classList.remove("dragging", "resizing");
    renderWidgets(); // recompute board height
    persist();
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  // external changes (other windows/tabs)
  store.onChanged(debounce(async () => {
    if (state.editingId) return; // don't clobber an open editor
    const data = await store.get(["notes", "theme"]);
    if (Array.isArray(data.notes)) {
      const migrated = migrateNotes(data.notes);
      const changed = JSON.stringify(migrated) !== JSON.stringify(data.notes);
      state.notes = migrated;
      if (changed) persist(); // normalize in storage too
    }
    if (data.theme === "light" || data.theme === "dark") { state.theme = data.theme; applyTheme(); }
    renderAll();
  }, 200));
}

const itemAutosave = debounce(() => {
  persist().then(renderAll);
}, 350);

function shiftMonth(delta) {
  const c = state.calCursor || (() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; })();
  const d = new Date(c.y, c.m + delta, 1);
  state.calCursor = { y: d.getFullYear(), m: d.getMonth() };
  renderCalendar();
}

function renderAll() {
  render();
  renderCalendar();
  renderWidgets();
}

/* ================= init ================= */

async function init() {
  wireEvents();
  buildColorDots();
  tick();
  setInterval(tick, 1000);

  const data = await store.get(["notes", "theme", "seeded", "widgets"]);
  state.notes = migrateNotes(data.notes);
  state.theme = data.theme === "light" ? "light" : "dark";
  state.widgets = Array.isArray(data.widgets)
    ? data.widgets.filter((w) => w && WIDGETS[w.type]).map((w) => {
        const def = WIDGETS[w.type];
        const out = { id: typeof w.id === "string" ? w.id : uid(), type: w.type,
          x: Number(w.x) || 0, y: Number(w.y) || 0,
          w: Number(w.w) || def.defaults.w, h: Number(w.h) || def.defaults.h };
        clampWidget(out);
        return out;
      })
    : [];
  if (!Array.isArray(data.widgets)) {
    // first run of v1.2: seed default layout — calendar widget, no today widget
    state.widgets = [{ id: uid(), type: "calendar", ...WIDGETS.calendar.defaults }];
    clampWidget(state.widgets[0]);
  }

  if (!data.seeded && state.notes.length === 0) {
    const now = new Date();
    state.notes = [makeNote({
      title: "Welcome to Notes 🎉",
      body:
        "This page replaces your Chrome new tab — every new tab is now a notepad.\n\n" +
        "· Three types: Note (text), List (checklist), Daily todo (per-day checklist)\n" +
        "· Daily todos for today sit in the Today panel at the top and on the calendar\n" +
        "· Press N for a new daily todo, / to search\n" +
        "· Pin what matters — pinned notes stay on top\n" +
        "· Everything is stored locally in your browser (chrome.storage)\n" +
        "· Export a JSON backup anytime from the top-right icons\n\n" +
        "Delete this note whenever you're ready. Happy noting!",
      pinned: true,
      color: 0,
    })];
    await store.set({ notes: state.notes, seeded: true });
  }

  state.hydrated = true;
  applyTheme();
  state.selectedDay = todayKey();
  renderAll();
  els.quick.focus();
}

document.addEventListener("DOMContentLoaded", init);