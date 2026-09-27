# Notes — New Tab (Chrome Extension)

A local-first note-taking app that replaces the Chrome new tab page. No accounts, no servers — everything lives in `chrome.storage.local` on your machine.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. Open a new tab

> Tip: run `open -a "Google Chrome" chrome://extensions` from the terminal.

## Features

- New tab = notepad. Quick capture bar (Enter to save), or `N` for a longer note
- Live search (`/` to focus), pin to top, 6 accent colors
- Autosaving editor with word/char count (`Ctrl/Cmd+Enter` to close)
- Delete with Undo toast
- Dark/light theme, clock + greeting
- JSON export / import (backups merge into existing notes)
- Cross-tab sync: edits in one new tab appear in the others
- Data never leaves the browser

## Files

    manifest.json        MV3 manifest (newtab override + storage permissions)
    newtab.html          page markup
    css/style.css        styles (dark/light via [data-theme])
    js/app.js            app logic (zero dependencies)
    js/background.js    opens notes when toolbar icon is clicked
    icons/               generated PNG icons (16/48/128)
    tests/app.test.mjs   functional test suite (Node, no deps)

## Test

    node tests/app.test.mjs

The app has a localStorage fallback, so you can also open `newtab.html`
directly in a browser for quick dev iterations (import/export work; storage
is per-origin, so notes created there won't appear inside Chrome until the
extension is loaded).

## Data format

    { "notes": [ { "id", "title", "body", "color": 0-5, "pinned", "created", "updated" } ],
      "theme": "dark" | "light" }

Export produces exactly this shape with an `exported` timestamp; import
accepts it back (also a bare array of notes), sanitizing and clamping fields.
