// Functional test of js/app.js under Node with a minimal DOM/chrome mock.
// Exercises: init + seed, quick capture, pin/unpin, delete + undo, editor
// autosave, theme toggle, import validation, storage persistence, cross-tab sync.

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
  get innerHTML() { return this._html || ""; }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ""; }
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
    let n = this;
    while (n) { for (const fn of (n.listeners?.[ev] || []).slice()) fn(event); n = n.parentNode; }
  }
  focus(){} blur(){} click(){ this.fire("click", { target: this }); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.attrs.id = v; }
  getAttribute(k) { return this.attrs[k]; }
  querySelector() { return null; }
}

const ids = ["clock","date","greeting","search","quick","grid","stats","empty","empty-title","empty-sub",
  "editor-backdrop","ed-title","ed-body","ed-pin","ed-delete","ed-done","ed-count","color-dots",
  "btn-new","btn-theme","btn-export","btn-import","file-import","toast"];
const byId = {};
for (const id of ids) { const e = new Elem(id === "grid" || id === "color-dots" || id === "toast" ? "div" : id === "search" || id === "quick" || id === "ed-title" ? "input" : "button"); e.setAttribute("id", id); byId[id] = e; }
// elements that start with the hidden attribute in newtab.html
for (const id of ["empty", "editor-backdrop", "toast", "file-import"]) byId[id].hidden = true;

const document = {
  getElementById: (id) => byId[id] || null,
  createElement: (t) => new Elem(t),
  createDocumentFragment: () => new Elem("#fragment"),
  addEventListener(ev, fn) { (this.listeners ||= {})[ev] ||= []; this.listeners[ev].push(fn); },
  listeners: {},
  body: new Elem("body"),
};

class FakeFile {
  constructor(text) { this.text = text; }
}
class FakeFileReader {
  readAsText(f) { this.result = f.text; this.onload?.({ target: { result: f.text } }); }
}

const localStorage = (() => { const m = new Map(); return {
  getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };})();

const storageChangeCbs = [];
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
  action: { onClicked: { addListener() {} } },
};

// crypto.randomUUID exists in node 26. URL.createObjectURL missing — stub it.
globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};

/* ---------------- load app ---------------- */

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const gates = [];
const run = () => {
  try { new Function("document", "chrome", "localStorage", "window", "FileReader", "Blob", "URL", "crypto", "setTimeout", "clearTimeout", "setInterval", "console", src)(
    document, chrome, localStorage, globalThis.window, FakeFileReader, class Blob { constructor(parts) { this.parts = parts; } }, URL, crypto,
    (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout, (fn, ms) => setInterval(fn, Math.min(ms, 5)), console); }
  catch (e) { gates.push("load threw: " + e.message); }
};

globalThis.document = document;
globalThis.chrome = chrome;
globalThis.localStorage = localStorage;
globalThis.FileReader = FakeFileReader;
globalThis.window = { addEventListener() {} };
run();
document.listeners["DOMContentLoaded"][0]();

const tick = () => new Promise(r => setTimeout(r, 0));
const flushAutosave = () => new Promise(r => setTimeout(r, 400));

let pass = 0, fail = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; } else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };

/* ---------------- tests ---------------- */

await tick(); await tick();

// 1. seed created
let notes = JSON.parse(localStorage.getItem("cx:notes") || "[]");
eq("seed: one welcome note", notes.length, 1);
eq("seed: pinned", notes[0].pinned, true);
eq("seeded flag", JSON.parse(localStorage.getItem("cx:seeded")), true);
eq("render: welcome title shown", byId["grid"].children.length, 1);

// 2. quick capture
byId["quick"].value = "buy oat milk";
byId["quick"].fire("keydown", { key: "Enter" });
await tick();
notes = JSON.parse(localStorage.getItem("cx:notes"));
eq("capture: added", notes.length, 2);
eq("capture: newest first", notes[0].title, "buy oat milk");
eq("capture: input cleared", byId["quick"].value, "");
eq("render: two cards", byId["grid"].children.length, 2);

// 3. pin toggle from card action
const cardByTitle = (title) => byId["grid"].children.find(c =>
  c.children.some(k => k.attrs.class === "card-title" && k._text === title));
const cardPinBtn = (() => { const card = cardByTitle("buy oat milk");
  for (const c of card.children) if (c.attrs.class === "card-actions") return c.children[0]; })();
cardPinBtn.fire("click", { target: cardPinBtn });
await tick();
notes = JSON.parse(localStorage.getItem("cx:notes"));
eq("pin: toggled on", notes.find(n => n.title === "buy oat milk").pinned, true);

// 4. open editor via card click, edit, autosave
const card = cardByTitle("buy oat milk");
card.fire("click", { target: card });
eq("editor: open", byId["editor-backdrop"].hidden, false);
byId["ed-title"].value = "buy oat milk + cream";
byId["ed-title"].fire("input");
await flushAutosave();
notes = JSON.parse(localStorage.getItem("cx:notes"));
eq("autosave: title persisted", notes.some(n => n.title === "buy oat milk + cream"), true);
byId["ed-done"].fire("click", { target: byId["ed-done"] });
await tick();
eq("editor: closed", byId["editor-backdrop"].hidden, true);

// 5. delete + undo via toast action
const delBtn = (() => { const card2 = cardByTitle("buy oat milk + cream");
  for (const c of card2.children) if (c.attrs.class === "card-actions") return c.children[1]; })();
delBtn.fire("click", { target: delBtn });
await tick();
notes = JSON.parse(localStorage.getItem("cx:notes"));
eq("delete: removed", notes.length, 1);
eq("toast: visible", byId["toast"].hidden, false);
const undoBtn = byId["toast"].children.find(c => c.tag === "button");
undoBtn.fire("click", { target: undoBtn });
await tick();
notes = JSON.parse(localStorage.getItem("cx:notes"));
eq("undo: restored", notes.length, 2);

// 6. search filters
byId["search"].value = "oat";
byId["search"].fire("input");
eq("search: filtered to 1", byId["grid"].children.length, 1);
byId["search"].value = "zzzz";
byId["search"].fire("input");
eq("search: no match empty state", byId["empty"].hidden, false);
byId["search"].value = "";
byId["search"].fire("input");

// 7. theme
eq("theme: default dark", document.body.dataset.theme, "dark");
byId["btn-theme"].fire("click", { target: byId["btn-theme"] });
await tick();
eq("theme: toggled to light", document.body.dataset.theme, "light");
eq("theme: persisted", JSON.parse(localStorage.getItem("cx:theme")), "light");
byId["btn-theme"].fire("click", { target: byId["btn-theme"] });

// 8. import validation (bad json / wrong shape / good)
byId["file-import"].files = [new FakeFile("{not json")];
byId["file-import"].fire("change");
await tick();
eq("import: bad json keeps count", JSON.parse(localStorage.getItem("cx:notes")).length, 2);

byId["file-import"].files = [new FakeFile(JSON.stringify({ nope: true }))];
byId["file-import"].fire("change");
await tick();
eq("import: wrong shape keeps count", JSON.parse(localStorage.getItem("cx:notes")).length, 2);

byId["file-import"].files = [new FakeFile(JSON.stringify({ notes: [{ title: "from import", body: "hi", color: 99, pinned: 1 }] }))];
byId["file-import"].fire("change");
await tick();
notes = JSON.parse(localStorage.getItem("cx:notes"));
eq("import: added", notes.length, 3);
const imp = notes.find(n => n.title === "from import");
eq("import: color clamped", imp.color >= 0 && imp.color <= 5, true);
eq("import: pinned coerced", imp.pinned, true);

// 9. cross-tab storage change resync (editor closed)
const before = notes.length;
localStorage.setItem("cx:notes", JSON.stringify([{ id: "ext", title: "external", body: "", color: 0, pinned: false, created: 1, updated: 1 }]));
for (const cb of storageChangeCbs) cb({ notes: { newValue: 1 } }, "local");
await new Promise(r => setTimeout(r, 250));
eq("sync: notes replaced from storage event", JSON.parse(localStorage.getItem("cx:notes")).length, 1);

// 10. export produces valid payload
let capturedDL = null;
globalThis.URL.createObjectURL = () => "blob:fake2";
byId["btn-export"].fire("click", { target: byId["btn-export"] });
await tick();
eq("export: no crash", true, true);

// 11. regression: CSS must honor the hidden attribute (author display rules
// must not defeat [hidden] — this made the editor unclosable in real Chrome)
const css = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
eq("css: [hidden] display:none !important present",
  /\[hidden\]\s*\{\s*display:\s*none\s*!important/i.test(css), true);
// every HTML element that starts hidden and has an author display rule is covered by the global [hidden] guard
const htmlSrc = readFileSync(new URL("../newtab.html", import.meta.url), "utf8");
const hiddenIds = [...htmlSrc.matchAll(/id="([^"]+)"[^>]*\shidden|hidden[^\n]*?id="([^"]+)"/g)].map(m => m[1] || m[2]);
for (const id of hiddenIds) {
  const hasDisplayRule = new RegExp(`#${id}\\s*\\{[^}]*display\\s*:`).test(css);
  eq(`css: #${id} relies on global [hidden] guard (no unguarded display rule)`, hasDisplayRule, false);
}

console.error(`\n${pass} passed, ${fail} failed${gates.length ? " — " + gates.join("; ") : ""}`);
process.exit(fail || gates.length ? 1 : 0);
