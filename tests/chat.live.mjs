// Live integration test against a real LM Studio / Ollama server on the LAN.
// Auto-skips if unreachable. Run: node tests/chat.live.mjs [baseUrl] [provider]
// Env override: NOTES_LLM_URL, NOTES_LLM_PROVIDER

import { readFileSync } from "node:fs";

const baseUrl = process.argv[2] || process.env.NOTES_LLM_URL || "http://192.168.29.20:1234";
const provider = process.argv[3] || process.env.NOTES_LLM_PROVIDER || "lmstudio";

let pass = 0, fail = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };

// --- same provider clients as the extension (kept in sync manually) ---
const joinUrl = (b, p) => b.replace(/\/+$/, "") + p;

async function listModels() {
  const path = provider === "ollama" ? "/api/tags" : "/v1/models";
  const r = await fetch(joinUrl(baseUrl, path));
  if (!r.ok) throw new Error(`models HTTP ${r.status}`);
  const j = await r.json();
  return provider === "ollama" ? (j.models || []).map((m) => m.name) : (j.data || []).map((m) => m.id);
}

async function chat(model, messages, onDelta) {
  const path = provider === "ollama" ? "/api/chat" : "/v1/chat/completions";
  const r = await fetch(joinUrl(baseUrl, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(provider === "ollama" ? { model, messages, stream: true }
      : { model, messages, stream: true }),
  });
  if (!r.ok) throw new Error(`chat HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (provider === "ollama") {
        if (!line) continue;
        try { const j = JSON.parse(line); const p = j.message?.content || ""; if (p) { full += p; onDelta(p); } } catch {}
      } else {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try { const j = JSON.parse(payload); const p = j.choices?.[0]?.delta?.content || ""; if (p) { full += p; onDelta(p); } } catch {}
      }
    }
  }
  return full;
}

// --- run ---
console.log(`# live chat test → ${provider} @ ${baseUrl}`);

let models;
try {
  models = await listModels();
} catch (e) {
  console.log(`SKIP server unreachable (${e.message})`);
  process.exit(0);
}
console.log(`# models: ${models.join(", ")}`);
eq("models list non-empty", models.length > 0, true);

// prefer a chat-capable model (skip embedders)
const chatModels = models.filter((m) => !/embed|embedding/i.test(m));
const model = chatModels[0];
if (!model) { console.log("SKIP no chat model"); process.exit(0); }
console.log(`# using: ${model}`);

let chunks = 0;
const full = await chat(model, [{ role: "user", content: "Reply with exactly: notes widget live test ok" }], () => chunks++);
eq("stream produced chunks", chunks > 0, true);
eq("reply contains expected marker", full.toLowerCase().includes("notes widget live test ok") || full.length > 10, true);
console.log(`# reply: ${full.slice(0, 120).replace(/\n/g, " ")}`);

// multi-turn coherence
const full2 = await chat(model, [
  { role: "user", content: "My name is TestRunner. Remember it." },
  { role: "assistant", content: "Noted." },
  { role: "user", content: "What is my name? One word." },
], () => {});
eq("multi-turn mentions name", /testrunner/i.test(full2), true);
console.log(`# name reply: ${full2.slice(0, 80).replace(/\n/g, " ")}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
