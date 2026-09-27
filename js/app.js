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

const state = {
  notes: [],
  theme: "dark",
  query: "",
  editingId: null,
  hydrated: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  clock: $("clock"), date: $("date"), greeting: $("greeting"),
  search: $("search"), quick: $("quick"),
  grid: $("grid"), stats: $("stats"), empty: $("empty"),
  emptyTitle: $("empty-title"), emptySub: $("empty-sub"),
  backdrop: $("editor-backdrop"), edTitle: $("ed-title"), edBody: $("ed-body"),
  edPin: $("ed-pin"), edDelete: $("ed-delete"), edDone: $("ed-done"),
  edCount: $("ed-count"), colorDots: $("color-dots"),
  btnNew: $("btn-new"), btnTheme: $("btn-theme"),
  btnExport: $("btn-export"), btnImport: $("btn-import"),
  fileImport: $("file-import"), toast: $("toast"),
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

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return "just now";
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m ago`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h ago`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)}d ago`;
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function persist() {
  return store.set({ notes: state.notes });
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

/* ================= rendering ================= */

function visibleNotes() {
  const q = state.query.trim().toLowerCase();
  const list = q
    ? state.notes.filter((n) =>
        (n.title || "").toLowerCase().includes(q) || (n.body || "").toLowerCase().includes(q))
    : state.notes.slice();
  list.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  return list;
}

const PIN_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
const UNPIN_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"></path></svg>';

function createCardEl(note) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = note.id;

  const color = COLORS[note.color] || COLORS[0];
  if (note.color) card.style.setProperty("--card-accent", color.hex);

  const title = document.createElement("div");
  title.className = "card-title" + (note.title ? "" : " untitled");
  title.textContent = note.title || "Untitled";
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "card-body";
  body.textContent = note.body || "";
  if (!note.body) body.style.opacity = "0.5";
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
  time.textContent = relTime(note.updated);
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

  const pinnedCount = state.notes.filter((n) => n.pinned).length;
  const q = state.query.trim();
  els.stats.textContent = state.notes.length
    ? `${state.notes.length} note${state.notes.length === 1 ? "" : "s"}${pinnedCount ? ` · ${pinnedCount} pinned` : ""}${q ? ` · ${list.length} match${list.length === 1 ? "" : "es"}` : ""}`
    : "";

  if (state.notes.length === 0) {
    els.emptyTitle.textContent = "No notes yet";
    els.emptySub.innerHTML = "";
    els.emptySub.append(
      "Type above and hit ", kbd("Enter"), " to capture your first note, or press ", kbd("N"), " to write a longer one."
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

/* ================= CRUD ================= */

function makeNote(partial = {}) {
  const now = Date.now();
  return {
    id: uid(),
    title: "",
    body: "",
    color: 0,
    pinned: false,
    created: now,
    updated: now,
    ...partial,
  };
}

function quickCapture() {
  const text = els.quick.value.trim();
  if (!text) return;
  const title = text.length <= 80 ? text : text.slice(0, 80);
  const body = text.length <= 80 ? "" : text;
  state.notes.unshift(makeNote({ title, body }));
  els.quick.value = "";
  persist().then(render);
}

function newNote() {
  const note = makeNote();
  state.notes.unshift(note);
  openEditor(note.id);
}

function togglePin(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  n.pinned = !n.pinned;
  n.updated = Date.now();
  persist().then(render);
}

let lastDeleted = null;

function deleteNote(id) {
  const idx = state.notes.findIndex((x) => x.id === id);
  if (idx === -1) return;
  lastDeleted = { note: state.notes[idx], index: idx };
  state.notes.splice(idx, 1);
  if (state.editingId === id) hideEditor(false);
  persist().then(render);
  toast(`Note deleted`, "Undo", () => {
    if (!lastDeleted) return;
    state.notes.splice(Math.min(lastDeleted.index, state.notes.length), 0, lastDeleted.note);
    lastDeleted = null;
    persist().then(render);
  });
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
      persist().then(render);
    });
    els.colorDots.appendChild(b);
  }
}

function syncEditorChrome(note) {
  els.edPin.setAttribute("aria-pressed", note.pinned ? "true" : "false");
  for (const dot of els.colorDots.children) {
    dot.classList.toggle("selected", Number(dot.dataset.color) === note.color);
  }
  const words = (els.edBody.value.trim().match(/\S+/g) || []).length;
  els.edCount.textContent = `${words} word${words === 1 ? "" : "s"} · ${els.edBody.value.length} chars · saved automatically`;
}

function openEditor(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  state.editingId = id;
  els.edTitle.value = n.title;
  els.edBody.value = n.body;
  syncEditorChrome(n);
  els.backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  (n.title ? els.edBody : els.edTitle).focus();
}

const editorAutosave = debounce(() => {
  const n = state.notes.find((x) => x.id === state.editingId);
  if (!n) return;
  n.title = els.edTitle.value;
  n.body = els.edBody.value;
  n.updated = Date.now();
  syncEditorChrome(n);
  persist().then(render);
}, 350);

function hideEditor(save = true) {
  const n = state.notes.find((x) => x.id === state.editingId);
  if (n && save) {
    n.title = els.edTitle.value.trim();
    n.body = els.edBody.value;
    n.updated = Date.now();
    if (!n.title && !n.body.trim()) {
      const idx = state.notes.indexOf(n);
      if (idx !== -1) state.notes.splice(idx, 1);
    }
  }
  state.editingId = null;
  els.backdrop.hidden = true;
  document.body.style.overflow = "";
  persist().then(render);
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
  a.download = `notes-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
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
    const cleaned = incoming.map((raw) => makeNote({
      title: typeof raw?.title === "string" ? raw.title.slice(0, 500) : "",
      body: typeof raw?.body === "string" ? raw.body : "",
      color: Number.isInteger(raw?.color) ? Math.min(Math.max(raw.color, 0), COLORS.length - 1) : 0,
      pinned: Boolean(raw?.pinned),
      created: Number.isFinite(raw?.created) ? raw.created : now,
      updated: Number.isFinite(raw?.updated) ? raw.updated : now,
    }));
    state.notes = [...cleaned, ...state.notes];
    persist().then(render);
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

  els.btnNew.addEventListener("click", newNote);

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
    const typing = e.target.matches("input, textarea");
    if (e.key === "Escape") {
      if (!els.backdrop.hidden) hideEditor(true);
      else if (typing) e.target.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); els.search.focus(); }
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); newNote(); }
  });

  // external changes (other windows/tabs)
  store.onChanged(debounce(async () => {
    if (state.editingId) return; // don't clobber an open editor
    const data = await store.get(["notes", "theme"]);
    if (Array.isArray(data.notes)) state.notes = data.notes;
    if (data.theme === "light" || data.theme === "dark") { state.theme = data.theme; applyTheme(); }
    render();
  }, 200));
}

/* ================= init ================= */

async function init() {
  wireEvents();
  buildColorDots();
  tick();
  setInterval(tick, 1000);

  const data = await store.get(["notes", "theme", "seeded"]);
  state.notes = Array.isArray(data.notes) ? data.notes : [];
  state.theme = data.theme === "light" ? "light" : "dark";

  if (!data.seeded && state.notes.length === 0) {
    state.notes = [makeNote({
      title: "Welcome to Notes 🎉",
      body:
        "This page replaces your Chrome new tab — every new tab is now a notepad.\n\n" +
        "· Type in the capture bar and press Enter for an instant note\n" +
        "· Press N to write a longer note, / to search\n" +
        "· Pin what matters — pinned notes stay on top\n" +
        "· Color-code notes from the editor\n" +
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
  render();
  els.quick.focus();
}

document.addEventListener("DOMContentLoaded", init);
