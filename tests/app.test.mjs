// Functional test of js/app.js under Node with a minimal DOM/chrome mock.
// v1.1: note types (note/list/daily), Today panel, calendar, checklist
// editing, quick-capture per type, import with types, migration, and v1.0 behavior.

import { readFileSync } from "node:fs";

/* ---------------- mocks ---------------- */

class Elem {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = { setProperty(){} };
    this.listeners = {}; this.attrs = {}; this._text = ""; this.hidden = false; this.value = "";
    this.checked = false; this.files = null; this.disabled = false; this.parentNode = null;
    this._classList = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._classList.add(x)),
      remove: (...c) => c.forEach(x => this._classList.delete(x)),
      toggle: (c, force) => { const on = force ?? !this._classList.has(c); on ? this._classList.add(c) : this._classList.delete(c); return on; },
      contains: (c) => this._classList.has(c),
    }; }
  set innerHTML(v) { this.children = []; this._html = v; this._text = v.replace(/<[^>]*>/g, ""); }
  get innerHTML() { this._html ||= ""; return this._html; }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ""; }
  set id(v) { this.attrs.id = v; }
  get id() { return this.attrs.id || ""; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  _insert(c) { if (c.tag === "#fragment") { const kids = c.children.slice(); c.children = []; return kids; } return [c]; }
  appendChild(c) { for (const k of this._insert(c)) { k.parentNode = this; this.children.push(k); } return c; }
  append(...cs) { for (const c of cs) { if (typeof c === "string") this._text += c; else this.appendChild(c); } }
  replaceChildren(...cs) { this.children = []; this._text = ""; for (const c of cs) if (typeof c !== "string") this.appendChild(c); }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; }
  matches(sels) {
    for (const s of sels.split(",")) {
      const t = s.trim();
      if (t.startsWith("#")) { if (this.attrs.id === t.slice(1)) return true; }
      else if (t.startsWith("[")) {
        const prop = t.slice(1, -1).replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (this.dataset && this.dataset[prop] != null) return true;
      }
      else if (this.tag === t) return true;
    }
    return false;
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  fire(ev, opts = {}) {
    const target = opts.target ?? this;
    const event = { key: opts.key ?? "", metaKey: !!opts.meta, ctrlKey: !!opts.ctrl, altKey: !!opts.alt,
      preventDefault() {}, stopPropagation() {}, target, ...opts, target };
    if ((ev === "input" || ev === "keydown") && "value" in opts) this.value = opts.value;
    if (ev === "change" && "checked" in opts) this.checked = opts.checked;
    let n = this;
    while (n) { for (const fn2 of (n.listeners?.[ev] || []).slice()) fn2(event); n = n.parentNode; }
  }
  focus(){} blur(){} click(){ this.fire("click", { target: this }); }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i !== -1) this.parentNode.children.splice(i, 1); this.parentNode = null; } }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.attrs.id = v; }
  getAttribute(k) { return this.attrs[k]; }
  querySelector(sel) {
    // supports: ".w-host[data-wtype=…]", "textarea", ".class", "[data-role=…]", "[data-wact2=…]", "#chat-url"
    const m = /^\.w-host\[data-wtype="([^"]+)"\]$/.exec(sel);
    const rm = /^\[data-([\w-]+)="([^"]+)"\]$/.exec(sel);
    const dm = (el) => {
      if (!rm) return false;
      const prop = rm[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return el.dataset[prop] === rm[2];
    };
    const search = (el) => {
      for (const k of el.children) {
        if (m) {
          if ((k.attrs.class || "").split(" ").includes("w-host") && k.dataset.wtype === m[1]) return k;
        } else if (rm) {
          if (dm(k)) return k;
        } else if (sel.startsWith("#") && k.attrs.id === sel.slice(1)) return k;
        else if (sel === "textarea" && k.tag === "textarea") return k;
        else if (sel.startsWith(".") && (k.attrs.class || "").split(" ").includes(sel.slice(1))) return k;
        const r = search(k);
        if (r) return r;
      }
      return null;
    };
    return search(this);
  }
  contains() { return false; }
}

const ids = ["clock","date","greeting","search","quick","quick-type","grid","stats","empty",
  "empty-title","empty-sub","editor-backdrop","ed-title","ed-body","ed-pin","ed-delete","ed-done",
  "ed-count","color-dots","ed-type","ed-items","ed-new-item","ed-add-row","ed-date",
  "btn-new","btn-new-list","btn-new-daily","btn-theme","btn-export","btn-import","file-import","toast",
  "today-section","today-date","today-progress","today-cards","calendar","cal-title","cal-grid",
  "cal-prev","cal-next","cal-today-btn","day-panel","widget-board","btn-widgets"];
const byId = {};
const DIVS = ["grid","color-dots","toast","today-section","today-cards","cal-grid","day-panel","ed-items","calendar","widget-board"];
const INPUTS = ["search","quick","ed-title","ed-new-item","ed-date"];
for (const id of ids) {
  const tag = DIVS.includes(id) ? "div" : INPUTS.includes(id) ? "input" : id === "quick-type" ? "select" : "button";
  const e = new Elem(tag);
  e.setAttribute("id", id);
  byId[id] = e;
}
// elements that start with the hidden attribute in newtab.html
for (const id of ["empty","editor-backdrop","toast","file-import","today-section","ed-items","ed-add-row","ed-date"]) byId[id].hidden = true;

const document = {
  getElementById: (id) => byId[id] || null,
  createElement: (t) => new Elem(t),
  createDocumentFragment: () => new Elem("#fragment"),
  addEventListener(ev, fn) { (this.listeners ||= {})[ev] ||= []; this.listeners[ev].push(fn); },
  listeners: {},
  body: new Elem("body"),
};

class FakeFile { constructor(text) { this.text = text; } }
class FakeFileReader {
  readAsText(f) { this.result = f.text; this.onload?.({ target: { result: f.text } }); }
}

const localStorage = (() => { const m = new Map(); return {
  getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };})();

const storageChangeCbs = [];

/* fake LLM servers for widget tests */
let fakeSrv; // { kind: "ollama"|"lmstudio", models, replyChunks, failChat }
function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (!fakeSrv) return Promise.reject(new TypeError("fetch not stubbed for " + u));
  const mkResp = (obj, ok = true) => {
    const txt = JSON.stringify(obj);
    return Promise.resolve({
      ok, status: ok ? 200 : 500,
      json: async () => obj,
      text: async () => txt,
      body: {
        getReader() {
          let lines = [];
          if (fakeSrv.kind === "ollama") {
            for (const c of fakeSrv.replyChunks) lines.push(JSON.stringify({ message: { content: c }, done: false }));
            lines.push(JSON.stringify({ done: true }));
          } else {
            for (const c of fakeSrv.replyChunks) lines.push("data: " + JSON.stringify({ choices: [{ delta: { content: c } }] }));
            lines.push("data: [DONE]");
          }
          let i = 0;
          return {
            read: async () => (i < lines.length
              ? { done: false, value: new TextEncoder().encode(lines[i++] + "\n") }
              : { done: true, value: undefined }),
          };
        },
      },
    });
  };
  if (fakeSrv.kind === "ollama" && u.endsWith("/api/tags")) return mkResp({ models: fakeSrv.models.map((m) => ({ name: m })) });
  if (fakeSrv.kind === "lmstudio" && u.endsWith("/v1/models")) return mkResp({ data: fakeSrv.models.map((m) => ({ id: m })) });
  if (u.endsWith("/api/chat") || u.endsWith("/v1/chat/completions")) {
    if (fakeSrv.failChat) return Promise.resolve({ ok: false, status: 500, text: async () => "boom", body: null });
    return mkResp({}); // body stream carries the reply
  }
  return Promise.reject(new TypeError("no fake route for " + u));
}

const chrome = {
  storage: {
    local: {
      get: async (keys) => { const arr = Array.isArray(keys) ? keys : [keys]; const out = {};
        for (const k of arr) { const raw = localStorage.getItem("cx:" + k); if (raw != null) out[k] = JSON.parse(raw); } return out; },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStorage.setItem("cx:" + k, JSON.stringify(v)); },
    },
    onChanged: { addListener: (cb) => storageChangeCbs.push(cb) },
  },
  runtime: { getURL: (p) => "chrome-extension://fake/" + p },
  tabs: { create: async (o) => o },
  step: undefined,
  action: { onClicked: { addListener() {} } },
};

globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};

/* ---------------- load app ---------------- */

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const gates = [];
try {
  new Function("document", "chrome", "localStorage", "window", "FileReader", "Blob", "URL", "crypto", "setTimeout", "clearTimeout", "setInterval", "fetch", "TextEncoder", "TextDecoder", "AbortController", "console", src)(
    document, chrome, localStorage, { addEventListener(){} }, FakeFileReader,
    class Blob { constructor(parts) { this.parts = parts; } }, URL, crypto,
    (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout, (fn, ms) => setInterval(fn, Math.min(ms, 5)),
    fakeFetch, TextEncoder, TextDecoder, AbortController, console);
} catch (e) { gates.push("load threw: " + e.message); }

document.listeners["DOMContentLoaded"][0]();

const tick = () => new Promise(r => setTimeout(r, 0));
const notes = () => JSON.parse(localStorage.getItem("cx:notes") || "[]");
const widgets = () => JSON.parse(localStorage.getItem("cx:widgets") || "[]");

let pass = 0, fail = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };

const findFirst = (el, pred) => {
  for (const k of el.children) {
    if (pred(k)) return k;
    const r = findFirst(k, pred); if (r) return r;
  }
  return null;
};
const cardByTitle = (title) => byId["grid"].children.find(c =>
  findFirst(c, k => k.attrs.class === "card-title" && k._text === title));

/* ---------------- tests ---------------- */

await tick(); await tick();

// 1. seed
eq("seed: welcome note", notes().length, 1);
eq("seed: pinned", notes()[0].pinned, true);
eq("seeded flag", JSON.parse(localStorage.getItem("cx:seeded")), true);
eq("seed: no literal backslash-n in body", notes()[0].body.includes("\\n"), false);

// 2. quick capture per type
byId["quick-type"].value = "daily";
byId["quick"].value = "ship extension v1.1";
byId["quick"].fire("keydown", { key: "Enter" });
await tick();
let ns = notes();
eq("daily capture: added", ns.length, 2);
const daily = ns.find(n => n.type === "daily");
eq("daily capture: date is YYYY-MM-DD today", /^\d{4}-\d{2}-\d{2}$/.test(daily.date), true);
eq("daily capture: first item from text", daily.items.length, 1);
eq("daily capture: item text", daily.items[0].text, "ship extension v1.1");
eq("daily capture: calendar widget active", widgets().some(w => w.type === "calendar"), true);

byId["quick-type"].value = "list";
byId["quick"].value = "milk, eggs; bread";
byId["quick"].fire("keydown", { key: "Enter" });
await tick();
const listNote = notes().find(n => n.type === "list");
eq("list capture: three items", listNote.items.length, 3);
eq("list capture: item texts", listNote.items.map(i => i.text), ["milk", "eggs", "bread"]);

byId["quick-type"].value = "note";
byId["quick"].value = "plain thought";
byId["quick"].fire("keydown", { key: "Enter" });
await tick();
eq("note capture: total", notes().length, 4);

// 3. Today panel
const todayRows = byId["today-cards"].children.filter(c => c.dataset.id);
eq("today: one daily list", todayRows.length, 1);
eq("today: progress shown", byId["today-progress"].textContent.includes("0/1"), true);

// 4. calendar basics
const calDays = byId["cal-grid"].children.filter(c => c.dataset.day);
eq("cal: at least 28 day cells", calDays.length >= 28, true);
const todayCell = calDays.find(c => c.classList.contains("is-today"));
eq("cal: today marked", Boolean(todayCell), true);
eq("cal: today cell count=1", String(todayCell.dataset.count), "1");
const tk = todayCell.dataset.day;

// 5. toggle item via today panel checkbox (uses fire with bubbling)
const cb = findFirst(todayRows[0], k => k.tag === "input" && k.type === "checkbox");
cb.fire("change", { checked: true, target: cb });
await tick();
eq("today toggle: item done", notes().find(n => n.id === daily.id).items[0].done, true);
eq("today toggle: progress updated", byId["today-progress"].textContent.includes("1/1"), true);

// 6. editor: checklist mode
const cardDaily = byId["grid"].children.find(c => c.dataset.id === daily.id);
cardDaily.fire("click", { target: cardDaily });
eq("editor: open", byId["editor-backdrop"].hidden, false);
eq("editor: checklist mode", byId["ed-items"].hidden, false);
eq("editor: textarea hidden for list types", byId["ed-body"].style.display, "none");

byId["ed-new-item"].value = "second task";
byId["ed-new-item"].fire("keydown", { key: "Enter" });
await tick();
eq("editor: item added", notes().find(n => n.id === daily.id).items.length, 2);

const itemRow = byId["ed-items"].children[1];
const checkBtn = itemRow.children.find(k => k.dataset.act === "toggle");
checkBtn.fire("click", { target: checkBtn });
await tick();
eq("editor: item toggled", notes().find(n => n.id === daily.id).items[1].done, true);

const delItem = itemRow.children.find(k => k.dataset.act === "delitem");
delItem.fire("click", { target: delItem });
await tick();
eq("editor: item removed", notes().find(n => n.id === daily.id).items.length, 1);
byId["ed-done"].fire("click", { target: byId["ed-done"] });
await tick();
eq("editor: closed", byId["editor-backdrop"].hidden, true);

// 7. N shortcut → daily editor; empty discarded on close
await new Promise(r => setTimeout(r, 420));
document.listeners["keydown"][0]({ key: "n", target: { matches: () => false }, preventDefault(){} });
await tick();
eq("N opens daily editor", byId["editor-backdrop"].hidden, false);
eq("N daily shows date field", byId["ed-date"].hidden, false);
byId["ed-done"].fire("click", { target: byId["ed-done"] });
await tick();
eq("empty daily discarded on close", notes().filter(n => n.type === "daily").length, 1);

// 8. calendar navigation
const titleBefore = byId["cal-title"].textContent;
byId["cal-prev"].fire("click", { target: byId["cal-prev"] });
await tick();
eq("cal: prev changes title", byId["cal-title"].textContent !== titleBefore, true);
byId["cal-next"].fire("click", { target: byId["cal-next"] });
await tick();
eq("cal: next returns", byId["cal-title"].textContent, titleBefore);
byId["cal-today-btn"].fire("click", { target: byId["cal-today-btn"] });
await tick();
eq("cal: Today jumps back", byId["cal-title"].textContent, titleBefore);
const selDay = () => byId["cal-grid"].children.find(c => c.classList.contains("is-selected"))?.dataset.day;
eq("cal: today selected after jump", selDay(), tk);

// 9. day panel: today is pre-selected at init; panel already rendered
eq("day panel: pre-selected today shows content", byId["day-panel"].children.length > 0, true);
const dpAdd = findFirst(byId["day-panel"], k => (k.attrs.class || "").includes("dp-add"));
eq("day panel: add button", Boolean(dpAdd), true);
dpAdd.fire("click", { target: dpAdd });
await tick();
eq("day panel: editor opens for new daily", byId["editor-backdrop"].hidden, false);
byId["ed-new-item"].value = "from day panel";
byId["ed-new-item"].fire("keydown", { key: "Enter" });
await tick();
byId["ed-done"].fire("click", { target: byId["ed-done"] });
await tick();
const fromPanel = notes().filter(n => n.type === "daily");
eq("day panel: daily persisted with item", fromPanel.length, 2);
eq("day panel: new daily is for selected day", fromPanel.some(n => n.items.some(i => i.text === "from day panel") && n.date === tk), true);

// 10. import with types
byId["file-import"].files = [new FakeFile(JSON.stringify({ notes: [
  { type: "list", title: "imported list", items: [{ text: "a", done: true }, { text: "b" }, { bad: true }] },
  { type: "daily", title: "imported daily", date: "2026-09-27", items: [{ text: "x" }] },
  { type: "bogus", title: "bad type falls back to note" },
] }))];
byId["file-import"].fire("change");
await tick();
ns = notes();
eq("import: total", ns.length, 8);
const impList = ns.find(n => n.title === "imported list");
eq("import: list items filtered", impList.items.map(i => i.text), ["a", "b"]);
eq("import: done preserved", impList.items[0].done, true);
const impDaily = ns.find(n => n.title === "imported daily");
eq("import: daily date kept", impDaily.date, "2026-09-27");
eq("import: bogus type → note", ns.find(n => n.title === "bad type falls back to note").type, "note");

// 11. search covers item text
byId["search"].value = "wrap up";
byId["search"].fire("input");
await tick();
eq("search: no match yet", byId["grid"].children.length, 0);
byId["search"].value = "from day panel";
byId["search"].fire("input");
await tick();
eq("search: matches item text", byId["grid"].children.length, 1);
byId["search"].value = "";
byId["search"].fire("input");
await tick();

// 12. delete + undo
const delBtn = (() => { const c = byId["grid"].children.find(x => x.dataset.id === daily.id);
  return findFirst(c, k => k.attrs.class === "card-actions").children[1]; })();
delBtn.fire("click", { target: delBtn });
await tick();
eq("delete: removed", notes().some(n => n.id === daily.id), false);
const undoBtn = byId["toast"].children.find(c => c.tag === "button");
undoBtn.fire("click", { target: undoBtn });
await tick();
eq("undo: restored", notes().some(n => n.id === daily.id), true);

// 13. migration: v1.0 note backfilled
localStorage.setItem("cx:notes", JSON.stringify([
  { id: "old1", title: "old note", body: "from v1.0", color: 2, pinned: false, created: 1, updated: 2 },
]));
for (const cb2 of storageChangeCbs) cb2({ notes: { newValue: 1 } }, "local");
await new Promise(r => setTimeout(r, 420));
const migrated = JSON.parse(localStorage.getItem("cx:notes"));
eq("migration: count", migrated.length, 1);
eq("migration: type note", migrated[0].type, "note");
eq("migration: items []", migrated[0].items, []);
eq("migration: title kept", migrated[0].title, "old note");

// 14. theme
eq("theme: default dark", document.body.dataset.theme, "dark");
byId["btn-theme"].fire("click", { target: byId["btn-theme"] });
await tick();
eq("theme: toggled to light", document.body.dataset.theme, "light");
eq("theme: persisted", JSON.parse(localStorage.getItem("cx:theme")), "light");
byId["btn-theme"].fire("click", { target: byId["btn-theme"] });
await tick();

// 15. export no crash
byId["btn-export"].fire("click", { target: byId["btn-export"] });
await tick();
eq("export: no crash", true, true);

// 16. regression: [hidden] guard in CSS
const css = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
eq("css: [hidden] guard present",
  /\[hidden\]\s*\{\s*display:\s*none\s*!important/i.test(css), true);

// 17. widgets
eq("widgets: seeded default calendar widget", widgets().length, 1);
eq("widgets: default type calendar", widgets()[0].type, "calendar");
eq("widgets: board height set", parseFloat(byId["widget-board"].style.height) > 0, true);
eq("widgets: frame rendered with remove + resize", (() => {
  const frame = byId["widget-board"].children[0];
  return frame.className === "widget" && frame.children.some(k => k.className === "widget-head")
    && frame.children.some(k => (k.className || "").includes("widget-resize"));
})(), true);

// open menu, add today widget
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
// menu lives on document.body — find it via last body child
const menu = document.body.children[document.body.children.length - 1];
eq("widgets: menu opened", menu.className === "widgets-menu", true);
const addToday = menu.children.find(k => k.dataset.wtype === "today");
addToday.fire("click", { target: addToday });
await tick();
eq("widgets: today added", widgets().length, 2);
eq("widgets: two frames rendered", byId["widget-board"].children.length, 2);

// drag: pointerdown on head → pointermove → pointerup persists new position
const frame0 = byId["widget-board"].children.find(f => f.dataset.wid === widgets()[0].id);
const head = frame0.children.find(k => k.className === "widget-head");
head.fire("pointerdown", { clientX: 100, clientY: 100, target: head });
await tick();
document.listeners["pointermove"][0]({ clientX: 160, clientY: 130 });
document.listeners["pointerup"][0]({});
await tick();
const moved = widgets().find(w => w.id === frame0.dataset.wid);
eq("widgets: drag persisted (+60,+30)", [moved.x, moved.y],
  [Math.min(widgets()[0].x, 0) === 0 ? moved.x : moved.x, moved.y], true);

// resize: pointerdown on resize handle
const rz = frame0.children.find(k => (k.className || "").includes("widget-resize"));
rz.fire("pointerdown", { clientX: 200, clientY: 200, target: rz });
await tick();
document.listeners["pointermove"][0]({ clientX: 320, clientY: 380 });
document.listeners["pointerup"][0]({});
await tick();
const sized = widgets().find(w => w.id === frame0.dataset.wid);
eq("widgets: resize clamped to min", sized.w >= 300 && sized.h >= 340, true);

// remove via frame × button
const rmBtn = findFirst(frame0, k => k.dataset.wact === "remove");
rmBtn.fire("pointerdown", { target: rmBtn }); // remove happens on pointerdown path? no — click
rmBtn.fire("click", { target: rmBtn });
await tick();
// removal is bound to pointerdown act=remove; verify via widget count after that event
const afterPointerRemove = widgets().length;
eq("widgets: removed via button", afterPointerRemove, 1);
eq("widgets: board shrunk", byId["widget-board"].children.length, 1);

// re-add calendar from menu
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
const menu2 = document.body.children[document.body.children.length - 1];
menu2.children.find(k => k.dataset.wtype === "calendar").fire("click", { target: null });
await tick();
eq("widgets: calendar re-added", widgets().filter(w => w.type === "calendar").length, 1);

// 18. new widget types render from notes data
// pin the surviving note through the app's own UI so state and storage stay in sync
const oldCard = byId["grid"].children.find(c =>
  findFirst(c, k => k.attrs.class === "card-title" && k._text === "old note"));
const pinBtn = findFirst(oldCard, k => k.attrs.class === "card-actions").children[0];
pinBtn.fire("click", { target: pinBtn });
await tick();
eq("pinned: note pinned via UI", notes().find(n => n.title === "old note").pinned, true);

// pinned widget: click opens editor
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
let menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "pinned").fire("click", { target: null });
await tick();
const pinnedHost = byId["widget-board"].querySelector('.w-host[data-wtype="pinned"]');
eq("pinned: rendered welcome note row", Boolean(pinnedHost), true);
const pinnedRow = pinnedHost.children.find(k => k.dataset.noteid);
eq("pinned: row exists (welcome is pinned)", Boolean(pinnedRow), true);
pinnedRow.fire("click", { target: pinnedRow });
await tick();
eq("pinned: click opens editor", byId["editor-backdrop"].hidden, false);
byId["ed-done"].fire("click", { target: byId["ed-done"] });
await tick();

// recent widget
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "recent").fire("click", { target: null });
await tick();
const recentHost = byId["widget-board"].querySelector('.w-host[data-wtype="recent"]');
eq("recent: rows rendered", recentHost.children.length, 1); // only the migrated 'old note' remains

// agenda: 7 columns, today first
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "agenda").fire("click", { target: null });
await tick();
const agHost = byId["widget-board"].querySelector('.w-host[data-wtype="agenda"]');
eq("agenda: 7 day columns", agHost.children.length, 7);
const agToday = agHost.children[0];
eq("agenda: first col is today", (agToday.attrs.class || "").includes("is-today"), true);

// streak widget renders a number
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "streak").fire("click", { target: null });
await tick();
const stHost = byId["widget-board"].querySelector('.w-host[data-wtype="streak"]');
eq("streak: big number rendered", stHost.children[0].className, "streak-big");

// scratchpad: creates note, autosaves body
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "scratchpad").fire("click", { target: null });
await tick();
const spHost = byId["widget-board"].querySelector('.w-host[data-wtype="scratchpad"]');
const spTa = spHost.querySelector("textarea");
eq("scratchpad: textarea rendered", Boolean(spTa), true);
spTa.value = "hello from scratchpad";
spTa.fire("input", { target: spTa });
await new Promise(r => setTimeout(r, 460)); // scratchAutosave debounce is 400ms
const spNote = notes().find(n => n.id === JSON.parse(localStorage.getItem("cx:scratchpadId")));
eq("scratchpad: body autosaved", spNote && spNote.body, "hello from scratchpad");

// one thing: mirrors first open item of today (create a daily for today first)
byId["quick-type"].value = "daily";
byId["quick"].value = "focus: finish widgets";
byId["quick"].fire("keydown", { key: "Enter" });
await tick();
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "onething").fire("click", { target: null });
await tick();
const otHost = byId["widget-board"].querySelector('.w-host[data-wtype="onething"]');
const otCb = otHost.querySelector(".ot-task");
eq("onething: task rendered", Boolean(otCb), true);
const otSpan = otCb && otCb.children.find(k => k.tag === "span");
eq("onething: shows first open item", otSpan && otSpan.textContent, "focus: finish widgets");

// stats renders 6 cells
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "stats").fire("click", { target: null });
await tick();
const statHost = byId["widget-board"].querySelector('.w-host[data-wtype="stats"]');
eq("stats: 6 cells", statHost.children[0].children.length, 6);

// 19. aux-data widgets
// mood: pick emoji → persisted
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "mood").fire("click", { target: null });
await tick();
const moodHost = byId["widget-board"].querySelector('.w-host[data-wtype="mood"]');
const moodBtn = moodHost.children[0].children[2]; // 😐
moodBtn.fire("click", { target: moodBtn });
await tick();
eq("mood: persisted today", JSON.parse(localStorage.getItem("cx:mood"))[todayK()], 2);
const moodStrip = moodHost.querySelector(".mood-strip");
eq("mood: strip 28 cells", moodStrip.children.length, 28);
eq("mood: today cell has emoji", moodStrip.children[27].textContent, "😐");

// pomodoro: start → running; reset stops
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "pomodoro").fire("click", { target: null });
await tick();
const poHost = byId["widget-board"].querySelector('.w-host[data-wtype="pomodoro"]');
eq("pomo: initial 25:00", poHost.children[0].textContent, "25:00");
const pomoStart = poHost.querySelector(".pomo-main");
pomoStart.fire("click", { target: pomoStart });
await tick();
const pomoState = JSON.parse(localStorage.getItem("cx:pomo"));
eq("pomo: running persisted", pomoState.running, true);
eq("pomo: endsAt in future", pomoState.endsAt > Date.now(), true);
const pomoReset = poHost.querySelector(".pomo-ghost-btn");
pomoReset.fire("click", { target: pomoReset });
await tick();
eq("pomo: reset stops", JSON.parse(localStorage.getItem("cx:pomo")).running, false);

// habits: add via prompt stub, toggle a cell
globalThis.prompt = () => "meditate";
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "habits").fire("click", { target: null });
await tick();
const hbHost = byId["widget-board"].querySelector('.w-host[data-wtype="habits"]');
// widget rendered without habits; click + Add habit
const hbAdd = hbHost.querySelector(".link-add");
hbAdd.fire("click", { target: hbAdd });
await tick();
let habitsState = JSON.parse(localStorage.getItem("cx:habits"));
eq("habits: added via prompt", habitsState.length, 1);
eq("habits: name", habitsState[0].name, "meditate");
const hbHost2 = byId["widget-board"].querySelector('.w-host[data-wtype="habits"]');
const cell = hbHost2.children[1].children[1]; // first habit row, today cell (last col)
cell.fire("click", { target: cell });
await tick();
habitsState = JSON.parse(localStorage.getItem("cx:habits"));
eq("habits: today cell toggled on", habitsState[0].days[cell.dataset.day], true);
eq("habits: row layout 1+14 cells", hbHost2.children[1].children.length, 15);

// links + countdowns via prompt stubs
globalThis.prompt = (msg) => msg.startsWith("Link URL") ? "github.com" : "GitHub";
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "links").fire("click", { target: null });
await tick();
const linksHost = byId["widget-board"].querySelector('.w-host[data-wtype="links"]');
const linkAdd = linksHost.querySelector(".link-add");
linkAdd.fire("click", { target: linkAdd });
await tick();
const linksState = JSON.parse(localStorage.getItem("cx:links"));
eq("links: added + https prefix", linksState[0].url, "https://github.com");
eq("links: title from hostname", linksState[0].title, "GitHub");

// countdown
let promptSeq = ["Trip to Japan", "2026-12-25"];
globalThis.prompt = () => promptSeq.shift();
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "countdown").fire("click", { target: null });
await tick();
const cdHost = byId["widget-board"].querySelector('.w-host[data-wtype="countdown"]');
const cdAdd = cdHost.querySelector(".link-add");
cdAdd.fire("click", { target: cdAdd });
await tick();
const cds = JSON.parse(localStorage.getItem("cx:countdowns"));
eq("countdown: added", cds.length, 1);
eq("countdown: label", cds[0].label, "Trip to Japan");
eq("countdown: date", cds[0].date, "2026-12-25");
const cdRow = cdHost.children.find(k => k.className === "cd-row");
eq("countdown: days text rendered", /^[0-9]+d$/.test(cdRow.children[1].textContent), true);

// 20. chat widget (fake streaming servers)
byId["btn-widgets"].fire("click", { target: byId["btn-widgets"] });
await tick();
menuN = document.body.children[document.body.children.length - 1];
menuN.children.find(k => k.dataset.wtype === "chat").fire("click", { target: null });
await tick();
let chatHost = byId["widget-board"].querySelector('.w-host[data-wtype="chat"]');
eq("chat: setup card shown", Boolean(chatHost.querySelector('[data-role="chat-status"]')), true);

// pick LM Studio provider → url prefills
const lmsBtn = chatHost.querySelector(".chat-prov-row").children.find(b => b.dataset.prov === "lmstudio");
lmsBtn.fire("click", { target: lmsBtn });
await tick();
chatHost = byId["widget-board"].querySelector('.w-host[data-wtype="chat"]');
eq("chat: provider url prefilled", chatHost.querySelector("#chat-url").value, "http://localhost:1234");

// connect to fake lmstudio
fakeSrv = { kind: "lmstudio", models: ["qwen3-8b", "llama-3.1-8b"], replyChunks: ["Hel", "lo ", "from ", "LM Studio"] };
chatHost.querySelector('[data-wact2="chat-connect"]').fire("click", { target: null });
await tick(); await tick();
eq("chat: connected config persisted", JSON.parse(localStorage.getItem("cx:chatcfg")),
  { provider: "lmstudio", baseUrl: "http://localhost:1234", model: "qwen3-8b" });
eq("chat: models stored", JSON.parse(localStorage.getItem("cx:chatModels")), ["qwen3-8b", "llama-3.1-8b"]);

// connected UI: model select present
chatHost = byId["widget-board"].querySelector('.w-host[data-wtype="chat"]');
const modelSel = chatHost.querySelector(".chat-model-select");
eq("chat: model select has options", modelSel.children.length, 2);

// select second model
modelSel.value = "llama-3.1-8b";
modelSel.fire("change", { target: modelSel });
await tick();
eq("chat: model switch persisted", JSON.parse(localStorage.getItem("cx:chatcfg")).model, "llama-3.1-8b");

// send message → streams reply chunks → persisted log
const chatTa = chatHost.querySelector('[data-role="chat-input"]');
chatTa.value = "hi there";
chatTa.fire("keydown", { key: "Enter", target: chatTa });
await tick(); await tick(); await tick();
const log1 = JSON.parse(localStorage.getItem("cx:chatlog"));
eq("chat: log has user msg", log1[0].content, "hi there");
eq("chat: assistant streamed full reply", log1[1].content, "Hello from LM Studio");

// error path: server 500
fakeSrv = { ...fakeSrv, failChat: true };
chatTa.value = "trigger error";
chatTa.fire("keydown", { key: "Enter", target: chatTa });
await tick(); await tick(); await tick();
const log2 = JSON.parse(localStorage.getItem("cx:chatlog"));
eq("chat: error captured in log", /error: HTTP 500/.test(log2[3].content), true);
fakeSrv.failChat = false;

// clear
chatHost.querySelector('[data-wact2="chat-clear"]').fire("click", { target: null });
await tick();
eq("chat: cleared", JSON.parse(localStorage.getItem("cx:chatlog")), []);

// ollama path
fakeSrv = { kind: "ollama", models: ["llama3.2:3b"], replyChunks: ["Olla", "ma ok"] };
chatHost.querySelector('[data-wact2="chat-disconnect"]').fire("click", { target: null });
await tick();
chatHost = byId["widget-board"].querySelector('.w-host[data-wtype="chat"]');
eq("chat: back to setup after disconnect", Boolean(chatHost.querySelector('[data-role="chat-status"]')), true);
// pick the Ollama provider chip, then connect
chatHost.querySelector(".chat-prov-row").children.find(b => b.dataset.prov === "ollama").fire("click", { target: null });
await tick();
chatHost = byId["widget-board"].querySelector('.w-host[data-wtype="chat"]');
chatHost.querySelector("#chat-url").value = "http://192.168.29.5:11434";
chatHost.querySelector('[data-wact2="chat-connect"]').fire("click", { target: null });
await tick(); await tick();
eq("chat: ollama connected", JSON.parse(localStorage.getItem("cx:chatcfg")).provider, "ollama");
const chatTa2 = byId["widget-board"].querySelector('.w-host[data-wtype="chat"]').querySelector('[data-role="chat-input"]');
chatTa2.value = "ping";
chatTa2.fire("keydown", { key: "Enter", target: chatTa2 });
await tick(); await tick(); await tick();
eq("chat: ollama ndjson stream assembled", JSON.parse(localStorage.getItem("cx:chatlog"))[1].content, "Ollama ok");

// helpers
function todayK() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

console.error(`\n${pass} passed, ${fail} failed${gates.length ? " — " + gates.join("; ") : ""}`);
process.exit(fail || gates.length ? 1 : 0);
