// The Node Studio canvas. The document (`ed.doc`) is the source of truth: every change goes through mutate(), which
// feeds undo and autosave; the server answers each save with a check (what is done, what is missing, what Run costs),
// and a running workflow reports step by step (`ed.live`). Cards are DOM, wires are one SVG under them.
import { ic } from "./flows.js";

let ctx = null;
let cat = null;      // the catalogue: node types, groups, bridges
let ed = null;       // the open workflow
let clip = null;     // copied steps
let models = null;   // the image models, for the Artist menu

const CARD_W = 300, GAP_X = 96, GAP_Y = 40;
const MIN_Z = 0.25, MAX_Z = 1.6;
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const spec = (node) => cat.nodes[typeof node === "string" ? node : node.type];
const nodeOf = (id) => ed.doc.nodes.find((n) => n.id === id);
const a = (word) => (word === "words" ? "words" : `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`);
const esc = (v) => ctx.esc(v);

// ---------- entry points for flows.js ----------

export const isOpen = (id) => Boolean(ed && ed.id === id && document.getElementById("flEditor"));
export const title = () => (ed ? ed.doc.name : "");
export const current = () => (ed ? { workflow: ed.id, name: ed.doc.name, steps: ed.doc.nodes.map((n) => spec(n).label) } : null);

export function leave() {
  document.getElementById("content")?.classList.remove("fl-full");
  if (!ed) return;
  const old = ed;
  ed = null;
  clearTimeout(old.timer);
  if (old.dirty) persist(old).catch(() => {});
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("paste", onPaste, true);
  old.observer.disconnect();
}

export function open(context, data) {
  leave();
  ctx = context;
  cat = data.catalogue;
  const narrow = matchMedia("(max-width: 820px)").matches;
  let mode = null;
  try { mode = localStorage.getItem("tessera.flow.mode"); } catch { /* private window */ }
  ed = { id: data.id, doc: data.doc, check: data.check, live: data.live, sections: data.sections, undo: [], redo: [], coalesce: "", dirty: false, timer: 0, saving: Promise.resolve(),
    cards: new Map(), sel: new Set(), cam: { x: 60, y: 120, z: 1 }, pointers: new Map(), drag: null, mode: narrow ? "steps" : mode === "steps" ? "steps" : "canvas", target: "", goOn: false };
  const content = document.getElementById("content");
  content.classList.add("fl-full");
  content.scrollTop = 0;
  content.innerHTML = `<div class="fl" id="flEditor">
    <div class="fl-canvas" id="flCanvas"><div class="fl-world" id="flWorld"><svg class="fl-wires" id="flWires"></svg><div class="fl-cards" id="flCards"></div></div></div>
    <div class="fl-top fl-chrome">
      <button type="button" class="fl-btn" data-act="back" title="All workflows">${ic("back")}<span>Workflows</span></button>
      <input id="flName" value="${esc(ed.doc.name)}" maxlength="80" aria-label="Name of this workflow" spellcheck="false">
      <span class="fl-state" id="flState"></span><span class="fl-grow"></span>
      <div class="fl-mode" role="group" aria-label="View"><button type="button" data-act="mode" data-mode="canvas" title="Canvas: steps and wires">${ic("canvas")}<span>Canvas</span></button><button type="button" data-act="mode" data-mode="steps" title="Steps: one after the other">${ic("steps")}<span>Steps</span></button></div>
      <button type="button" class="fl-run" id="flRun" data-act="run"></button>
    </div>
    <div class="fl-tools fl-chrome">
      <button type="button" class="fl-add" data-act="add" title="Add a step (Tab, or double-click the canvas)" aria-label="Add a step">${ic("plus")}</button>
      <button type="button" data-act="undo" title="Undo (Ctrl Z)" aria-label="Undo">${ic("undo")}</button>
      <button type="button" data-act="redo" title="Redo (Ctrl Shift Z)" aria-label="Redo">${ic("redo")}</button>
      <button type="button" data-act="fit" class="canvas-only" title="See everything (F)" aria-label="See everything">${ic("fit")}</button>
      <button type="button" data-act="tidy" class="canvas-only" title="Tidy up (T)" aria-label="Tidy up">${ic("tidy")}</button>
    </div>
    <button type="button" class="fl-coach fl-chrome" id="flCoach" data-act="coach" hidden></button>
    <div class="fl-start"><h2>Start with…</h2><div>${["idea", "list", "my_picture", "my_model"].map((k) => `<button type="button" data-act="first" data-kind="${k}" data-t="${cat.nodes[k].out}"><span class="fl-ic">${ic(cat.nodes[k].icon)}</span><b>${esc(cat.nodes[k].label)}</b><small>${esc(cat.nodes[k].blurb)}</small></button>`).join("")}</div><p>or double-click anywhere for every step</p></div>
    <div class="fl-layer" id="flLayer"></div>
  </div>`;
  const root = $("#flEditor"), canvas = $("#flCanvas");
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("focusout", () => setTimeout(() => ed && draw(), 0));
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDouble);
  canvas.addEventListener("dragenter", onDragOver);
  canvas.addEventListener("dragover", onDragOver);
  canvas.addEventListener("dragleave", () => canvas.classList.remove("dropping"));
  canvas.addEventListener("drop", onDrop);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("paste", onPaste, true);
  ed.observer = new ResizeObserver(() => { if (ed?.doc.tidy && !ed.drag) tidy(); drawWires(); });
  draw();
  setMode(ed.mode);
  if (ed.doc.tidy) tidy();
  opening();
}

// The workspace changed (an asset was saved, a file arrived): what is done may have changed, the steps have not.
export async function refresh() {
  if (!ed || ed.live || ed.dirty) return;
  const mine = ed;
  const check = await ctx.api("/api/flows/check", { method: "POST", body: { id: mine.id, doc: mine.doc } }).catch(() => null);
  if (check && mine === ed && !ed.live) { ed.check = check; draw(); }
}

// ---------- changes, undo and saving ----------

function mutate(change, coalesce = "") {
  if (!coalesce || coalesce !== ed.coalesce) {
    ed.undo.push(JSON.stringify(ed.doc));
    if (ed.undo.length > 120) ed.undo.shift();
  }
  ed.redo.length = 0;
  ed.coalesce = coalesce;
  change();
  touched();
}

function touched() {
  ed.dirty = true;
  setState("");
  clearTimeout(ed.timer);
  ed.timer = setTimeout(() => ed && persist(ed).catch(() => {}), 450);
  draw();
}

function back(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(ed.doc));
  ed.doc = JSON.parse(from.pop());
  ed.coalesce = "";
  ed.sel = new Set([...ed.sel].filter(nodeOf));
  $("#flName").value = ed.doc.name;
  document.activeElement?.closest?.(".fl-card") && document.activeElement.blur();
  touched();
}

function persist(e) {
  clearTimeout(e.timer);
  e.saving = e.saving.catch(() => {}).then(async () => {
    if (!e.dirty) return;
    e.dirty = false;
    try {
      const { check } = await ctx.api("/api/flows/save", { method: "POST", body: { id: e.id, doc: e.doc } });
      if (e !== ed) return;
      if (!e.dirty) { e.check = check; setState("Saved"); }
      draw();
    } catch (err) {
      e.dirty = true;
      if (e === ed) { setState("Not saved"); ctx.toast(err.message, true); }
      throw err;
    }
  });
  return e.saving;
}

async function flush() { if (ed.dirty) { await persist(ed); } else await ed.saving.catch(() => {}); }
const setState = (text) => { const el = $("#flState"); if (el) el.textContent = text; };

// ---------- the graph ----------

const newId = () => { for (;;) { const id = `n${Math.random().toString(36).slice(2, 8)}`; if (!nodeOf(id)) return id; } };

function leadsTo(start, goal) {
  const seen = new Set(), stack = [start];
  while (stack.length) {
    const at = stack.pop();
    if (at === goal) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    ed.doc.edges.forEach((e) => { if (e.from === at) stack.push(e.to); });
  }
  return false;
}

const fits = (out, accepts) => Boolean(out) && (out === accepts || (accepts === "any" && out !== "text" && out !== "style"));
const wiresInto = (id, port) => ed.doc.edges.filter((e) => e.to === id && (port === undefined || e.in === port));
const wiresFrom = (id) => ed.doc.edges.filter((e) => e.from === id);

// The input of `node` a wire carrying `out` belongs in: an empty one it needs, else an empty one, else one that takes more.
function bestInput(node, out, from = "") {
  const open = spec(node).inputs.filter((i) => fits(out, i.type) && !wiresInto(node.id, i.id).some((e) => e.from === from));
  const free = (i) => !wiresInto(node.id, i.id).length;
  return (open.find((i) => i.required && free(i)) || open.find(free) || open.find((i) => i.many) || open[0])?.id || "";
}

// The steps that turn `out` into something `node` takes ([] when it fits already, null when nothing does).
function bridge(out, node, port = "") {
  const takes = spec(node).inputs.filter((i) => !port || i.id === port);
  const path = [];
  for (let t = out; t && path.length < 5; ) {
    if (takes.some((i) => fits(t, i.type))) return path;
    const step = cat.bridges[t];
    if (!step) return null;
    path.push(step);
    t = cat.nodes[step].out;
  }
  return null;
}

function wire(from, to, port) {
  const input = spec(to).inputs.find((i) => i.id === port);
  if (!input || leadsTo(to.id, from.id)) return false;
  if (ed.doc.edges.some((e) => e.from === from.id && e.to === to.id && e.in === port)) return false;
  if (!input.many) ed.doc.edges = ed.doc.edges.filter((e) => !(e.to === to.id && e.in === port));
  ed.doc.edges.push({ from: from.id, to: to.id, in: port });
  return true;
}

const makeNode = (type, x, y) => ({ id: newId(), type, x, y, fields: structuredClone(defaults(type)), take: 0, ...(type === "pick" ? { picked: {} } : {}) });
function defaults(type) {
  return Object.fromEntries(cat.nodes[type].fields.map((f) => [f.id, f.default ?? ({ toggle: false, multi: [], number: f.min ?? 1 })[f.kind] ?? ""]));
}

// Wire two steps, adding whatever steps are missing in between.
function join(from, to, port = "") {
  if (from === to) return false;
  if (leadsTo(to.id, from.id)) { ctx.toast("That would go round in a circle.", true); return false; }
  const out = spec(from).out;
  const path = bridge(out, to, port);
  if (!path) { ctx.toast(`${spec(to).label} can't use ${a(cat.types[out])}.`, true); return false; }
  const want = port && fits(out, spec(to).inputs.find((i) => i.id === port).type) ? port : "";
  mutate(() => {
    let at = from;
    path.forEach((type, i) => {
      const node = makeNode(type, from.x + (CARD_W + GAP_X) * (i + 1), from.y);
      ed.doc.nodes.push(node);
      wire(at, node, bestInput(node, spec(at).out));
      at = node;
    });
    wire(at, to, (path.length ? port && fits(spec(at).out, spec(to).inputs.find((i) => i.id === port).type) && port : want) || bestInput(to, spec(at).out, at.id));
    if (path.length) makeRoom(to, at.x + CARD_W + GAP_X);
  });
  if (path.length) ctx.toast(`Added ${path.map((t) => `“${cat.nodes[t].label}”`).join(" and ")} in between.`);
  return true;
}

// Move a step and everything after it to the right, so a step that went in before it has space.
function makeRoom(node, x) {
  if (ed.doc.tidy || node.x >= x) return;
  const by = x - node.x;
  ed.doc.nodes.filter((n) => leadsTo(node.id, n.id)).forEach((n) => { n.x += by; });
}

function freeSpot(x, y) {
  const size = (n) => ed.cards.get(n.id)?.offsetHeight || 300;
  for (let i = 0; i < 40; i++) {
    const hit = ed.doc.nodes.find((n) => Math.abs(n.x - x) < CARD_W + 20 && y < n.y + size(n) + 24 && y + 260 > n.y);
    if (!hit) break;
    y = hit.y + size(hit) + GAP_Y;
  }
  return { x, y };
}

// A new step: after `from` (wired to its output), before `into` (wired to that input), or at a spot on the canvas.
function add(type, { from = null, into = null, port = "", at = null } = {}) {
  const spot = at || (from ? freeSpot(from.x + CARD_W + GAP_X, from.y) : into ? freeSpot(into.x - CARD_W - GAP_X, into.y) : freeSpot(...Object.values(viewCentre())));
  const node = makeNode(type, Math.round(spot.x), Math.round(spot.y)), whole = allInView();
  mutate(() => {
    ed.doc.nodes.push(node);
    if (from) wire(from, node, bestInput(node, spec(from).out));
    if (into) wire(node, into, port || bestInput(into, spec(node).out));
  });
  ed.sel = new Set([node.id]);
  draw();
  if (ed.doc.tidy) tidy();
  follow(node, whole);
  // Straight to typing when the step needs words.
  const field = $(".fl-fields textarea, .fl-fields input", ed.cards.get(node.id));
  if (field && !from && matchMedia("(pointer: fine)").matches) field.focus({ preventScroll: true });
  return node;
}

function insertOn(edge, type) {
  const from = nodeOf(edge.from), to = nodeOf(edge.to);
  const node = makeNode(type, Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2)), whole = allInView();
  mutate(() => {
    ed.doc.nodes.push(node);
    ed.doc.edges = ed.doc.edges.filter((e) => !(e.from === edge.from && e.to === edge.to && e.in === edge.in));
    wire(from, node, bestInput(node, spec(from).out));
    wire(node, to, edge.in);
    if (!ed.doc.tidy) { node.x = from.x + CARD_W + GAP_X; node.y = from.y; makeRoom(to, node.x + CARD_W + GAP_X); }
  });
  ed.sel = new Set([node.id]);
  draw();
  if (ed.doc.tidy) tidy();
  follow(node, whole);
}

function remove(ids) {
  mutate(() => {
    for (const id of ids) {
      const node = nodeOf(id);
      if (!node) continue;
      // What came in goes on to what came after, when it fits: taking a step out leaves the workflow whole.
      const first = spec(node).inputs[0]?.id;
      const before = wiresInto(id, first), after = wiresFrom(id);
      ed.doc.nodes = ed.doc.nodes.filter((n) => n !== node);
      ed.doc.edges = ed.doc.edges.filter((e) => e.from !== id && e.to !== id);
      for (const b of before) for (const x of after) {
        const from = nodeOf(b.from), to = nodeOf(x.to);
        const port = from && to && spec(to).inputs.find((i) => i.id === x.in);
        if (port && fits(spec(from).out, port.type)) wire(from, to, x.in);
      }
    }
    ed.sel.clear();
  });
  closePop();
}

function copyNodes(ids) {
  return structuredClone({ nodes: ed.doc.nodes.filter((n) => ids.has(n.id)), edges: ed.doc.edges.filter((e) => ids.has(e.to)) });
}

function pasteNodes(data, dx = 40, dy = 40) {
  const map = new Map(data.nodes.map((n) => [n.id, newId()]));
  mutate(() => {
    ed.doc.nodes.push(...data.nodes.map((n) => ({ ...structuredClone(n), id: map.get(n.id), x: n.x + dx, y: n.y + dy, ...(n.type === "pick" ? { picked: {} } : {}) })));
    // Wires inside the copy, and the ones that fed it, when their source is still here.
    for (const e of data.edges) {
      const from = nodeOf(map.get(e.from) || e.from), to = nodeOf(map.get(e.to));
      if (from && to) wire(from, to, e.in);
    }
    ed.sel = new Set(map.values());
    ed.doc.tidy = false;
  });
}

// ---------- layout and camera ----------

function depths() {
  const depth = new Map();
  const of = (id) => {
    if (!depth.has(id)) { depth.set(id, 0); depth.set(id, 1 + Math.max(-1, ...wiresInto(id).map((e) => of(e.from)))); }
    return depth.get(id);
  };
  ed.doc.nodes.forEach((n) => of(n.id));
  // A starting step sits right before what it feeds, not at the far left.
  ed.doc.nodes.forEach((n) => { const after = wiresFrom(n.id); if (!wiresInto(n.id).length && after.length) depth.set(n.id, Math.max(0, Math.min(...after.map((e) => depth.get(e.to))) - 1)); });
  return depth;
}

function topological() {
  const depth = depths();
  return [...ed.doc.nodes].sort((p, q) => depth.get(p.id) - depth.get(q.id));
}

// Columns by depth, each card level with what it comes from. Kept up to date until the user moves a card themselves.
function tidy() {
  const depth = depths();
  const columns = new Map();
  topological().forEach((n) => { const d = depth.get(n.id); columns.set(d, [...(columns.get(d) || []), n]); });
  const height = (n) => ed.cards.get(n.id)?.offsetHeight || 260;
  let moved = false;
  for (const d of [...columns.keys()].sort((p, q) => p - q)) {
    let y = -Infinity;
    const wanted = columns.get(d).map((n) => { const ups = wiresInto(n.id).map((e) => nodeOf(e.from).y); return { n, y: ups.length ? Math.min(...ups) : 0, own: !ups.length }; });
    wanted.sort((p, q) => p.own - q.own || p.y - q.y);
    for (const w of wanted) {
      const ny = Math.max(w.y, y === -Infinity ? w.y : y), nx = d * (CARD_W + GAP_X);
      if (w.n.x !== nx || Math.abs(w.n.y - ny) > 0.5) { w.n.x = nx; w.n.y = ny; moved = true; }
      y = ny + height(w.n) + GAP_Y;
    }
  }
  if (moved) { place(); drawWires(); }
}

const place = () => { if (ed.mode === "canvas") ed.doc.nodes.forEach((n) => { const el = ed.cards.get(n.id); if (el) el.style.transform = `translate(${n.x}px, ${n.y}px)`; }); };

function applyCam(glide = false) {
  const world = $("#flWorld"), canvas = $("#flCanvas"), { x, y, z } = ed.cam;
  world.classList.toggle("glide", glide);
  canvas.classList.toggle("glide", glide);
  world.style.transform = ed.mode === "canvas" ? `translate(${x}px, ${y}px) scale(${z})` : "";
  canvas.style.setProperty("--far", `${Math.round(15 / z)}px`);
  $("#flEditor").classList.toggle("far", ed.mode === "canvas" && z < 0.6);
  const dot = 26 * z * (z < 0.5 ? 2 : 1);
  canvas.style.backgroundSize = `${dot}px ${dot}px`;
  canvas.style.backgroundPosition = `${x}px ${y}px`;
}

function toWorld(cx, cy) {
  const r = $("#flCanvas").getBoundingClientRect();
  return { x: (cx - r.left - ed.cam.x) / ed.cam.z, y: (cy - r.top - ed.cam.y) / ed.cam.z };
}
function viewCentre() {
  const r = $("#flCanvas").getBoundingClientRect();
  const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  return { x: p.x - CARD_W / 2, y: p.y - 150 };
}

const PAD = { left: 76, top: 140, right: 40, bottom: 120 };
function bounds(nodes = ed.doc.nodes) {
  if (!nodes.length) return null;
  const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
  const x1 = Math.max(...nodes.map((n) => n.x + CARD_W + 30)), y1 = Math.max(...nodes.map((n) => n.y + (ed.cards.get(n.id)?.offsetHeight || 260)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function fit(glide = true, floor = MIN_Z) {
  const b = bounds();
  if (!b) return;
  const r = $("#flCanvas").getBoundingClientRect();
  const w = r.width - PAD.left - PAD.right, h = r.height - PAD.top - PAD.bottom;
  const z = clamp(Math.min(w / b.w, h / b.h), floor, 1);
  ed.cam = { z, x: PAD.left + Math.max(0, (w - b.w * z) / 2) - b.x * z, y: PAD.top + Math.max(0, Math.min(60, (h - b.h * z) / 2)) - b.y * z };
  applyCam(glide);
}

// Bring a step into view, moving as little as needed.
function look(node, { glide = true, zoomIn = false } = {}) {
  const el = ed.cards.get(node.id);
  if (ed.mode === "steps") return el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const r = $("#flCanvas").getBoundingClientRect(), cam = ed.cam;
  if (zoomIn && cam.z < 0.75) cam.z = 0.9;
  const h = Math.min(el?.offsetHeight || 260, (r.height - PAD.top - PAD.bottom) / cam.z);
  const left = node.x * cam.z + cam.x, top = node.y * cam.z + cam.y;
  const dx = left < PAD.left ? PAD.left - left : Math.min(0, r.width - PAD.right - 40 - (left + CARD_W * cam.z));
  const dy = top < PAD.top ? PAD.top - top : Math.min(0, r.height - PAD.bottom - (top + h * cam.z));
  cam.x += dx; cam.y += dy;
  applyCam(glide);
}

// Someone who sees the whole workflow keeps seeing it as it grows, while it stays readable.
function allInView() {
  const b = bounds(), r = $("#flCanvas").getBoundingClientRect(), c = ed.cam;
  return Boolean(b) && ed.mode === "canvas" && b.x * c.z + c.x > 0 && (b.x + b.w) * c.z + c.x < r.width && b.y * c.z + c.y > 0;
}
function follow(node, whole) {
  if (!whole || allInView()) return look(node);
  const cam = ed.cam;
  fit();
  if (ed.cam.z < 0.5) { ed.cam = cam; look(node); }
}

// The first look at a workflow: all of it when that is readable, else up close at the step to start with.
function opening() {
  if (!ed.doc.nodes.length) { applyCam(); return; }
  fit(false);
  if (ed.cam.z < 0.62) {
    const start = nodeOf(coach()?.node) || topological()[0];
    const b = bounds();
    ed.cam = { z: 0.8, x: PAD.left - b.x * 0.8, y: PAD.top - b.y * 0.8 };
    applyCam();
    look(start, { glide: false });
  }
}

function zoomAt(cx, cy, factor) {
  const r = $("#flCanvas").getBoundingClientRect(), cam = ed.cam;
  const z = clamp(cam.z * factor, MIN_Z, MAX_Z), k = z / cam.z, px = cx - r.left, py = cy - r.top;
  cam.x = px - (px - cam.x) * k; cam.y = py - (py - cam.y) * k; cam.z = z;
  applyCam();
}

function setMode(mode) {
  ed.mode = mode;
  const root = $("#flEditor");
  root.classList.toggle("steps", mode === "steps");
  root.querySelectorAll(".fl-mode button").forEach((b) => { b.classList.toggle("on", b.dataset.mode === mode); b.setAttribute("aria-pressed", String(b.dataset.mode === mode)); });
  ed.cards.forEach((el) => { el.style.transform = ""; });
  closePop();
  draw();
  applyCam();
}

// ---------- drawing ----------

// Only what changed is written, and nothing under a field being typed in.
function put(el, html) {
  if (el._html === html || (el.contains(document.activeElement) && document.activeElement.matches("textarea, input"))) return;
  el._html = html;
  el.innerHTML = html;
}

function stepOf(node) {
  const seen = ed.check.steps[node.id] || { status: "todo", values: [], todo: 0, done: 0 };
  const live = ed.live?.[node.id];
  if (!live) return seen;
  if (live.status === "waiting") return { ...seen, status: seen.status === "done" ? "done" : "waiting", error: "" };
  return { ...seen, error: "", ...live, values: live.values || seen.values, groups: live.groups || seen.groups, saved: live.saved || seen.saved };
}

function draw() {
  if (!ed || !document.getElementById("flEditor")) return;
  const host = $("#flCards");
  const order = ed.mode === "steps" ? topological() : ed.doc.nodes;
  const ids = new Set(order.map((n) => n.id));
  ed.cards.forEach((el, id) => { if (!ids.has(id)) { ed.observer.unobserve(el); el.remove(); ed.cards.delete(id); } });
  order.forEach((node, i) => {
    let el = ed.cards.get(node.id);
    if (!el) {
      el = document.createElement("article");
      el.className = "fl-card";
      el.dataset.id = node.id;
      el.innerHTML = `<header class="fl-h"></header><div class="fl-ports"></div><div class="fl-fields"></div><div class="fl-out"></div><div class="fl-msg"></div>`;
      ed.cards.set(node.id, el);
      host.append(el);
      ed.observer.observe(el);
    }
    if (ed.mode === "steps" && host.children[i] !== el) host.insertBefore(el, host.children[i]);
    fill(node, el, i);
  });
  place();
  drawWires();
  drawChrome();
}

function fill(node, el, index) {
  const s = spec(node), st = stepOf(node);
  el.className = `fl-card s-${st.status}${ed.sel.has(node.id) ? " sel" : ""}${node.type === "note" ? " is-note" : ""}`;
  el.dataset.label = s.label;
  el.dataset.t = s.out || (node.type === "note" ? "note" : "none");
  const [head, ports, fields, out, msg] = el.children;
  put(head, `<span class="fl-ic">${ic(s.icon)}</span><strong>${ed.mode === "steps" && node.type !== "note" ? `${index + 1}. ` : ""}${esc(s.label)}</strong>${badge(node, st)}
    <span class="fl-h-acts"><button type="button" data-act="help" title="What is this?" aria-label="What does ${esc(s.label)} do?">${ic("help")}</button><button type="button" data-act="more" title="More" aria-label="More">${ic("more")}</button></span>
    ${s.out ? `<button type="button" class="fl-plus" data-t="${s.out}" data-out title="Next step: click, or drag to another step" aria-label="Add the next step after ${esc(s.label)}">${ic("plus")}</button>` : ""}`);
  put(ports, s.inputs.map((i) => {
    const wires = wiresInto(node.id, i.id);
    const names = ed.mode === "steps" && wires.length ? ` <em>from ${esc(wires.map((w) => spec(nodeOf(w.from)).label).join(", "))}</em>` : "";
    return `<button type="button" class="fl-port${wires.length ? " on" : ""}${!wires.length && i.required && !i.field ? " need" : ""}" data-in="${i.id}" data-t="${i.type}" title="${wires.length ? "Drag to unplug" : `Takes ${i.type === "any" ? "anything" : esc(a(cat.types[i.type]))}`}"><i></i><span>${esc(i.label)}</span>${names || (wires.length ? (wires.length > 1 ? `<em>${wires.length}</em>` : "") : i.required ? "" : "<em>optional</em>")}</button>`;
  }).join(""));
  const shown = s.fields.filter((f) => !s.inputs.some((i) => i.field === f.id && wiresInto(node.id, i.id).length));
  const plain = shown.filter((f) => !f.more), more = shown.filter((f) => f.more);
  put(fields, plain.map((f) => field(node, f)).join("") + (more.length ? `<button type="button" class="fl-more-toggle${node.more ? " open" : ""}" data-act="fold">${node.more ? "Fewer options" : "More options"}${ic("down")}</button>${node.more ? more.map((f) => field(node, f)).join("") : ""}` : ""));
  put(out, results(node, st));
  put(msg, message(node, st));
}

function badge(node, st) {
  if (node.type === "note") return "";
  if (st.status === "running") return `<span class="fl-badge run"><span class="spinner"></span>${st.total > 1 ? `${st.done || 0}/${st.total}` : ""}</span>`;
  if (st.status === "done") return `<span class="fl-badge ok" title="Done">${ic("check")}</span>`;
  if (st.status === "choose") return `<span class="fl-badge pick">Your turn</span>`;
  if (st.status === "failed") return `<span class="fl-badge bad">!</span>`;
  if (st.status === "waiting") return `<span class="fl-badge wait">Next</span>`;
  return "";
}

function field(node, f) {
  const v = node.fields[f.id];
  const label = `<span class="fl-label">${esc(f.label)}${f.kind === "lines" ? `<em>${countLines(v) ? plural(countLines(v), "line") : ""}</em>` : ""}</span>`;
  const attr = `data-field="${f.id}"`;
  if (f.kind === "text" || f.kind === "lines") return `<label class="fl-f">${label}<textarea ${attr} rows="${f.rows || 2}" placeholder="${esc(f.placeholder || "")}" spellcheck="true">${esc(v)}</textarea></label>`;
  if (f.kind === "line") return `<label class="fl-f">${label}<input ${attr} type="text" value="${esc(v)}" placeholder="${esc(f.placeholder || "")}" autocomplete="off"></label>`;
  if (f.kind === "toggle") return `<button type="button" class="fl-switch${v ? " on" : ""}" ${attr} data-act="toggle" role="switch" aria-checked="${Boolean(v)}"><span>${esc(f.label)}</span><i></i></button>`;
  if (f.kind === "number") return `<div class="fl-f">${label}<div class="fl-seg">${Array.from({ length: f.max - f.min + 1 }, (_, i) => f.min + i).map((n) => `<button type="button" ${attr} data-act="set" data-value="${n}" class="${v === n ? "on" : ""}">${n}</button>`).join("")}</div></div>`;
  if (f.kind === "multi") return `<div class="fl-f">${label}<div class="fl-chips">${f.choices.map((c) => `<button type="button" ${attr} data-act="multi" data-value="${esc(c.value)}" class="${v.includes(c.value) ? "on" : ""}" aria-pressed="${v.includes(c.value)}">${f.id === "colours" ? `<i class="sw" data-c="${esc(c.value)}"></i>` : ""}${esc(c.label)}</button>`).join("")}</div></div>`;
  if (f.kind === "choice" && f.choices.length <= 4 && f.choices.every((c) => c.label.length < 16)) return `<div class="fl-f">${label}<div class="fl-seg wrap">${f.choices.map((c) => `<button type="button" ${attr} data-act="set" data-value="${esc(c.value)}" class="${v === c.value ? "on" : ""}"${c.hint ? ` title="${esc(c.hint)}"` : ""}>${esc(c.label)}</button>`).join("")}</div></div>`;
  if (f.kind === "picture" || f.kind === "model") {
    const word = f.kind === "picture" ? "picture" : "model";
    const img = f.kind === "picture" ? v : v.replace(/\.glb$/i, "_thumb.png");
    return `<div class="fl-f" ${attr}><div class="fl-file${v ? " has" : ""}">${v
      ? `<button type="button" class="fl-pic" data-act="${f.kind === "picture" ? "zoom" : "view"}" data-path="${esc(v)}"${f.kind === "model" ? ` data-view-model="${esc(v)}"` : ""}><img src="${esc(ctx.thumbUrl(img, 480))}" alt="" onerror="this.remove()">${f.kind === "model" ? ic("cube") : ""}</button>`
      : `<span>${ic(f.kind === "picture" ? "upload" : "cube")}Drop a ${word} here</span>`}
      <div class="fl-file-acts"><button type="button" data-act="upload">${v ? "Replace" : "From my computer"}</button><button type="button" data-act="project">From this project</button></div></div></div>`;
  }
  // Longer choices, models and sections open a menu.
  return `<div class="fl-f">${label}<button type="button" class="fl-select" ${attr} data-act="choose"><span>${esc(valueLabel(f, v))}</span>${ic("down")}</button></div>`;
}

const countLines = (v) => new Set(String(v || "").split("\n").map((l) => l.trim()).filter(Boolean)).size;

function choicesOf(f) {
  if (f.kind === "section") return [{ value: "", label: "Decide for me", hint: "The section that fits what it is" }, ...ed.sections.map((s) => ({ value: s.path, label: s.name }))];
  if (f.kind === "image_model") return [{ value: "", label: "Decide for me", hint: "The model chosen in Settings" }, ...(models || [])];
  return f.choices;
}
const valueLabel = (f, v) => choicesOf(f).find((c) => c.value === v)?.label || (v ? ctx.humanize(v) : "Decide for me");

function message(node, st) {
  const fixes = { settings: "Open Settings", input: "Connect" };
  if (st.status === "failed" || (st.error && st.status !== "running" && st.status !== "problem")) return `<div class="fl-note bad"><span>${esc(st.error)}</span><button type="button" data-act="retry">Try again</button></div>`;
  const rows = [];
  if (st.problem && !(ed.live && st.status !== "problem") && (st.problem.fix !== "field" || ed.nudged)) rows.push(`<div class="fl-note warn"><span>${esc(st.problem.text)}</span>${fixes[st.problem.fix] ? `<button type="button" data-act="fix">${fixes[st.problem.fix]}</button>` : ""}</div>`);
  if (st.advice && !st.done) rows.push(`<div class="fl-note tip"><span>${esc(st.advice.text)}</span><button type="button" data-act="advice">Choose first</button></div>`);
  (st.notes || []).forEach((n) => rows.push(`<div class="fl-note tip"><span>${esc(n)}</span></div>`));
  return rows.join("");
}

// What a step made, shown where it was made.
function results(node, st) {
  if (node.type === "pick") return st.groups?.length ? st.groups.map((g) => `${st.groups.length > 1 ? `<span class="fl-label">${esc(g.name)}</span>` : ""}
    <div class="fl-pics choose n${Math.min(g.options.length, 4)}">${g.options.map((o) => `<span class="fl-opt${g.chosen === o.path ? " on" : ""}"><button type="button" class="fl-pic" data-act="pick" data-group="${esc(g.group)}" data-path="${esc(o.path)}" aria-pressed="${g.chosen === o.path}" title="Choose this one">${img(o)}<b>${ic("check")}</b></button><button type="button" class="fl-loupe" data-act="zoom" data-path="${esc(o.path)}" title="Look closer" aria-label="Look closer">${ic("zoom")}</button></span>`).join("")}</div>`).join("") : "";
  if (node.type === "save") return st.saved?.length ? `<div class="fl-saved">${st.saved.map((x) => `<button type="button" data-act="asset" data-path="${esc(x.asset)}">${x.thumb ? `<img src="${esc(ctx.thumbUrl(x.thumb, 160))}" alt="" onerror="this.remove()">` : ic("save")}<span>${esc(x.name)}</span>${ic("arrow")}</button>`).join("")}</div>` : "";
  if (!spec(node).inputs.length || !st.values?.length) return st.status === "running" && spec(node).out !== "text" ? `<div class="fl-ghosts n${Math.min(4, st.total || 1)}">${"<i></i>".repeat(Math.min(4, st.total || 1))}</div>` : "";
  const kind = spec(node).out;
  const left = st.status === "running" ? "<i class=\"fl-ghost\"></i>".repeat(Math.min(3, Math.max(0, (st.total || 0) - (st.done || 0)))) : "";
  if (kind === "text") return `<ul class="fl-words">${st.values.map((v) => `<li>${esc(v.text)}</li>`).join("")}</ul>`;
  if (kind === "sound") return `<div class="fl-sounds">${st.values.map((v) => `<div>${st.values.length > 1 ? `<span>${esc(v.name)}</span>` : ""}<audio controls preload="none" src="${esc(ctx.fileUrl(v.path))}"></audio></div>`).join("")}</div>`;
  if (kind === "surface") return `<div class="fl-pics n${Math.min(st.values.length, 4)}">${st.values.map((v) => `<button type="button" class="fl-pic tiled" data-act="zoom" data-path="${esc(v.path)}" title="${esc(v.name)}" style="background-image:url('${esc(ctx.thumbUrl(v.path, 320))}')"></button>`).join("")}</div>`;
  if (kind === "picture") return `<div class="fl-pics n${Math.min(st.values.length, 4)}${st.values.length > 4 ? " many" : ""}">${st.values.map((v) => `<button type="button" class="fl-pic" data-act="zoom" data-path="${esc(v.path)}" title="${esc(v.label ? `${v.name}, ${v.label}` : v.name)}">${img(v)}${v.label ? `<em>${esc(v.label)}</em>` : ""}</button>`).join("")}${left}</div>`;
  return `<div class="fl-pics n${Math.min(st.values.length, 4)}">${st.values.map((v) => `<button type="button" class="fl-pic model" data-view-model="${esc(v.path)}" title="${esc(v.name)}: open in 3D">${v.thumb ? `<img src="${esc(ctx.thumbUrl(v.thumb, 480))}" alt="" onerror="this.remove()">` : ""}<span class="fl-3d">${ic("cube")}${kind === "clip" ? "Play" : "Open 3D"}</span></button>`).join("")}${left}</div>`;
}

const img = (v) => `<img src="${esc(v.pixel ? ctx.fileUrl(v.path) : ctx.thumbUrl(v.path, 480))}" alt="${esc(v.name)}" class="${v.pixel ? "px" : ""}" draggable="false" loading="lazy">`;

// ---------- wires ----------

function portAt(nid, port) {
  const card = ed.cards.get(nid), node = nodeOf(nid);
  const dot = card && (port === null ? $(".fl-plus", card) : $(`.fl-port[data-in="${port}"] i`, card));
  if (!dot) return { x: node?.x || 0, y: node?.y || 0 };
  let x = dot.offsetWidth / 2, y = dot.offsetHeight / 2;
  for (let el = dot; el && el !== card; el = el.offsetParent) { x += el.offsetLeft; y += el.offsetTop; }
  return { x: node.x + x, y: node.y + y };
}
function curve(p, q) {
  const dx = Math.max(46, Math.min(220, Math.abs(q.x - p.x) * 0.5));
  return `M${p.x} ${p.y}C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`;
}

function drawWires() {
  if (!ed || ed.mode !== "canvas") return;
  const svg = $("#flWires");
  if (!svg) return;
  let html = ed.doc.edges.map((e, i) => {
    const d = curve(portAt(e.from, null), portAt(e.to, e.in));
    const busy = ed.live && stepOf(nodeOf(e.to)).status === "running";
    const full = (stepOf(nodeOf(e.from)).values || []).length > 0;
    return `<g class="fl-wire${busy ? " busy" : ""}${full ? " full" : ""}${ed.drag?.kind === "wire" && ed.drag.edge === e ? " off" : ""}" data-t="${spec(nodeOf(e.from)).out}"><path class="hit" data-edge="${i}" d="${d}"/><path class="line" d="${d}"/></g>`;
  }).join("");
  if (ed.drag?.kind === "wire" && ed.drag.at) {
    const { from, to, at } = ed.drag;
    html += `<g class="fl-wire live" data-t="${ed.drag.type}"><path class="line" d="${from ? curve(portAt(from.id, null), at) : curve(at, portAt(to.id, ed.drag.port))}"/></g>`;
  }
  if (svg._html !== html) { svg._html = html; svg.innerHTML = html; }
}

// ---------- the top bar and the coach ----------

function costWords(seen) {
  const words = { image: "picture", "3d": "3D model", rig: "skeleton", animate: "set of moves", sound: "sound" };
  const what = Object.entries(seen.counts).map(([k, n]) => (k === "animate" ? `${n} ${n === 1 ? "set" : "sets"} of moves` : plural(n, words[k])));
  const price = seen.usd ? `about $${seen.usd.toFixed(2)}` : "";
  return { what: what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0] || "", price: [price, ...seen.credits].filter(Boolean).join(" + ") };
}

function drawChrome() {
  const run = $("#flRun"), seen = ed.check;
  const { what, price } = costWords(seen);
  const works = ed.doc.nodes.some((n) => spec(n).inputs.length);
  const small = ed.live ? "Stop" : !works ? "" : !seen.left && !seen.choose.length && !seen.problems.length ? "Everything is made" : seen.demo && what ? "Demo · placeholders" : what ? price || what : "Free";
  const html = ed.live ? `${ic("stop")}<span><b>Running</b><small>Click to stop</small></span>` : `${ic("play")}<span><b>Run</b>${small ? `<small>${esc(small)}</small>` : ""}</span>`;
  if (run._html !== html) { run._html = html; run.innerHTML = html; }
  run.classList.toggle("busy", Boolean(ed.live));
  run.classList.toggle("idle", !ed.live && (!ed.doc.nodes.length || (!seen.left && !seen.choose.length)));
  run.title = ed.live ? "Stop" : what ? `Makes ${what}${price && !seen.demo ? `, ${price}` : ""} (Ctrl Enter)` : "Run (Ctrl Enter)";
  $("[data-act=undo]").disabled = !ed.undo.length;
  $("[data-act=redo]").disabled = !ed.redo.length;
  $("#flEditor").classList.toggle("empty-flow", !ed.doc.nodes.length);
  const tip = coach(), box = $("#flCoach");
  box.hidden = !tip;
  if (!tip) return;
  const say = `<img src="/ui/art/face-${tip.face}.png" alt=""><span>${esc(tip.text)}</span>${tip.act ? `<em>${esc(tip.act)}</em>` : ""}`;
  if (box._html !== say) { box._html = say; box.innerHTML = say; box.classList.remove("in"); void box.offsetWidth; box.classList.add("in"); }
}

// One sentence: the next thing to do. The whole guidance of the page is this and the sentence on a step that needs one.
function coach() {
  const seen = ed.check, nodes = ed.doc.nodes;
  if (ed.live) {
    const busy = nodes.map((n) => ({ n, st: stepOf(n) })).find((x) => x.st.status === "running");
    return busy ? { face: "focused", text: `${spec(busy.n).label}${busy.st.total > 1 ? `, ${busy.st.done || 0} of ${busy.st.total}` : ""}…${spec(busy.n).paid === "3d" ? " This takes a few minutes." : ""}`, node: busy.n.id, go: () => look(busy.n) } : { face: "thinking", text: "Getting ready…" };
  }
  if (!nodes.length) return null;
  const broken = nodes.find((n) => stepOf(n).error);
  if (broken) return { face: "apologetic", text: `${spec(broken).label} didn't work out. What was made is kept.`, act: "Show me", node: broken.id, go: () => look(broken, { zoomIn: true }) };
  const choose = seen.choose[0];
  if (choose) return { face: "happy", text: "Pick your favourite, then the rest carries on.", act: "Show me", node: choose, go: () => look(nodeOf(choose), { zoomIn: true }) };
  const p = seen.problems[0];
  if (p && nodeOf(p.node)) return { face: "happy", text: `${spec(nodeOf(p.node)).label}: ${p.text.charAt(0).toLowerCase()}${p.text.slice(1)}`, act: p.fix === "settings" ? "Open Settings" : "Show me", node: p.node, go: () => fix(p) };
  const loose = nodes.find((n) => spec(n).group === "start" && spec(n).out && !wiresFrom(n.id).length);
  if (loose && !nodes.some((n) => spec(n).inputs.length && spec(n).group !== "start")) return { face: "happy", text: `Good. Now say what happens with ${spec(loose).out === "text" ? "it" : `the ${cat.types[spec(loose).out]}`}.`, act: "What next?", node: loose.id, go: () => palette({ from: loose, anchor: $(".fl-plus", ed.cards.get(loose.id)) }) };
  const ends = nodes.filter((n) => spec(n).out && spec(n).out !== "text" && spec(n).out !== "style" && !wiresFrom(n.id).length);
  if (ends.length && !nodes.some((n) => n.type === "save")) return { face: "thinking", text: "Keep what it makes: send it to your project.", act: "Add “Save to project”", node: ends[0].id, go: () => {
    const last = ends.at(-1);
    const save = add("save", { from: last });
    if (ends.length > 1) mutate(() => ends.slice(0, -1).forEach((n) => wire(n, save, "any")));
  } };
  if (seen.left) return { face: "proud", text: "Ready. Press Run and watch it work.", act: "Run", go: () => run() };
  const saved = nodes.map((n) => stepOf(n).saved?.[0]).find(Boolean);
  return saved ? { face: "laughing", text: "All done, and saved in your project.", act: `Open ${saved.name}`, go: () => ctx.go({ type: "doc", path: saved.asset }) } : { face: "laughing", text: "All done." };
}

function nudge(node) {
  ed.nudged = true;
  draw();
  const el = ed.cards.get(node.id);
  el?.classList.remove("nudge");
  void el?.offsetWidth;
  el?.classList.add("nudge");
}

function fix(problem) {
  const node = nodeOf(problem.node);
  if (!node) return;
  if (problem.fix === "settings") return ctx.settingsDialog("accounts");
  look(node, { zoomIn: true });
  nudge(node);
  const card = ed.cards.get(node.id);
  if (problem.fix === "input") return setTimeout(() => ed && palette({ into: node, port: problem.input, anchor: $(`.fl-port[data-in="${problem.input}"]`, card) }), 320);
  $(`[data-field="${problem.field}"]`, card)?.focus?.({ preventScroll: true });
}

// ---------- running ----------

async function run(target = "", agreed = false) {
  if (!ed) return;
  const mine = ed;
  closePop();
  if (ed.live) return ctx.api("/api/flows/stop", { method: "POST", body: { id: ed.id } }).catch((err) => ctx.toast(err.message, true));
  if (!ed.doc.nodes.length) return palette();
  try {
    await flush();
    const seen = target ? await ctx.api("/api/flows/check", { method: "POST", body: { id: mine.id, doc: mine.doc, target } }) : mine.check;
    if (mine !== ed) return;
    if (seen.problems.length) return fix(seen.problems[0]);
    if (!seen.left && !seen.choose.length) return ctx.toast("It's all made already. Change something, or use “Make new ones” on a step.");
    if (!agreed && !seen.demo && Object.keys(seen.counts).length) return confirmCost(seen, target);
    ed.live = Object.fromEntries(ed.doc.nodes.map((n) => [n.id, { status: "waiting" }]));
    ed.target = target;
    ed.nudged = false;
    draw();
    await ctx.api("/api/flows/run", { method: "POST", body: { id: mine.id, target } });
  } catch (err) {
    if (mine === ed) { ed.live = null; draw(); }
    ctx.toast(err.message, true);
  }
}

function confirmCost(seen, target) {
  const { what, price } = costWords(seen);
  pop($("#flRun"), `<div class="fl-cost"><strong>This makes ${esc(what)}.</strong><p>${price ? `It costs ${esc(price)}, paid to the service that makes them.` : "It uses your connected account."} What is already made stays and is not paid for again.</p>
    <div class="row"><button type="button" class="ghost" data-act="close">Not now</button><button type="button" class="primary" data-act="agree" data-target="${esc(target)}">Run</button></div></div>`, { width: 320, right: true });
  $("[data-act=agree]")?.focus();
}

// Called for every workflow's events; true when this one is on screen and took it.
export function onRun(msg) {
  if (!ed || msg.flow !== ed.id || msg.project !== ctx.state.project || !document.getElementById("flEditor")) return false;
  if (!msg.ended) {
    ed.live ||= {};
    ed.live[msg.node] = msg.step;
    if (!ed.queued) { ed.queued = true; requestAnimationFrame(() => { if (ed) { ed.queued = false; draw(); } }); }
    return true;
  }
  ended(msg.ended);
  return true;
}

async function ended(result) {
  const mine = ed;
  await flush().catch(() => {});
  const check = await ctx.api("/api/flows/check", { method: "POST", body: { id: mine.id, doc: mine.doc } }).catch(() => null);
  if (mine !== ed) return;
  if (check) ed.check = check;
  ed.live = null;
  ed.goOn = result === "choose";
  draw();
  if (ed.again) { ed.again = false; return run(ed.target, true); }
  const choose = ed.check.choose[0];
  if (result === "choose" && choose) look(nodeOf(choose), { zoomIn: true });
  if (result === "failed") { const bad = ed.doc.nodes.find((n) => stepOf(n).error); if (bad) look(bad); }
  if (result === "stopped") ctx.toast("Stopped. What was made is kept.");
}

async function pick(node, group, path) {
  mutate(() => { node.picked = { ...node.picked, [group]: path }; });
  const st = stepOf(node);
  const groups = st.groups || [];
  groups.forEach((g) => { if (g.group === group) g.chosen = path; });
  draw();
  // The run stopped here to ask, and what comes next was agreed to when it started: carry on.
  if (groups.some((g) => !g.chosen)) return;
  if (ed.live) ed.again = true;
  else if (ed.goOn) { await flush(); if (ed && !ed.check.choose.length) run(ed.target, true); }
}

async function makeNew(node) {
  mutate(() => { node.take += 1; });
  await run(node.id);
}

// ---------- popovers: one at a time, gone when you click away ----------

function pop(anchor, html, { width = 260, right = false, className = "" } = {}) {
  closePop();
  const layer = $("#flLayer"), box = $("#flEditor").getBoundingClientRect();
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const el = document.createElement("div");
  el.className = `fl-pop fl-chrome ${className}`;
  el.style.width = `${Math.min(width, box.width - 24)}px`;
  el.innerHTML = html;
  layer.append(el);
  el._place = () => {
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = (right ? r.right - w : r.left) - box.left, y = r.bottom - box.top + 8;
    const floor = box.height - (document.body.dataset.chat === "bar" ? 92 : 12);  // above Tess's bar
    if (y + h > floor) { const above = r.top - box.top - h - 8; y = above > 12 ? above : Math.max(12, floor - h); if (above <= 12 && !right) x = r.right - box.left + 12; }
    if (x + w > box.width - 12) x = Math.max(12, (above(r, box, w)));
    el.style.left = `${clamp(x, 12, Math.max(12, box.width - w - 12))}px`;
    el.style.top = `${y}px`;
  };
  el._place();
  ed.pop = el;
  return el;
}
const above = (r, box, w) => (r.left - box.left > w + 24 && r.width < 60 ? r.left - box.left - w - 8 : box.width - w - 12);

function closePop() {
  if (!ed?.pop) return false;
  ed.pop.remove();
  ed.pop = null;
  if (ed.drag?.kind === "wire" && ed.drag.parked) { ed.drag = null; drawWires(); }
  return true;
}

// The step menu: everything, or only what fits after `from`, before `into`, or on a wire.
function palette({ from = null, into = null, port = "", edge = null, anchor = null, at = null } = {}) {
  const out = from && spec(from).out;
  const input = into && spec(into).inputs.find((i) => i.id === port);
  const fitsHere = (n) => (edge ? n.out && n.inputs.some((i) => fits(spec(nodeOf(edge.from)).out, i.type)) && fits(n.out, spec(nodeOf(edge.to)).inputs.find((i) => i.id === edge.in).type) && n.type !== "save"
    : from ? n.inputs.some((i) => fits(out, i.type)) : into ? n.out && (input ? fits(n.out, input.type) : spec(into).inputs.some((i) => fits(n.out, i.type))) : true);
  const all = Object.values(cat.nodes).filter(fitsHere);
  const usual = from ? [cat.bridges[out], out === "picture" && (from.fields?.count || 1) > 1 ? "pick" : "", "save"].filter(Boolean) : into && input?.type === "picture" ? ["draw", "my_picture"] : !ed.doc.nodes.length ? ["idea", "list", "my_picture"] : [];
  all.sort((p, q) => (usual.includes(q.type) - usual.includes(p.type)));
  const heading = edge ? "Put a step in between" : from ? "What next?" : into ? `Where does the ${input && input.type !== "any" ? cat.types[input.type] : "result"} come from?` : "Add a step";
  const el = pop(anchor || $(".fl-add"), `<div class="fl-pal"><strong>${esc(heading)}</strong><input type="text" placeholder="Search" aria-label="Search steps" autocomplete="off" spellcheck="false"><div class="fl-pal-list" role="listbox"></div></div>`, { width: 340, className: "pal" });
  const list = $(".fl-pal-list", el), box = $("input", el);
  let shown = [], on = 0;
  const choose = (type) => {
    closePop();
    if (edge) return insertOn(edge, type);
    add(type, { from, into, port, at });
  };
  const row = (n) => `<button type="button" role="option" data-type="${n.type}" data-t="${n.out || "none"}"><span class="fl-ic">${ic(n.icon)}</span><span><b>${esc(n.label)}</b><small>${esc(n.blurb)}</small></span>${n.paid ? "" : n.group === "start" || n.group === "finish" ? "" : `<em>Free</em>`}</button>`;
  const paint = () => {
    const q = box.value.trim().toLowerCase();
    shown = all.filter((n) => !q || `${n.label} ${n.blurb} ${n.help}`.toLowerCase().includes(q));
    if (q) shown.sort((p, r) => r.label.toLowerCase().includes(q) - p.label.toLowerCase().includes(q));
    on = 0;
    const groups = q || from || into || edge ? [["", shown]] : cat.groups.map((g) => [g.label, shown.filter((n) => n.group === g.id)]);
    shown = groups.flatMap(([, ns]) => ns);
    list.innerHTML = groups.filter(([, ns]) => ns.length).map(([label, ns]) => `${label ? `<span class="fl-label">${esc(label)}</span>` : ""}${ns.map(row).join("")}`).join("") || `<p class="fl-none">Nothing called that. Try “picture”, “3D” or “sound”.</p>`;
    mark();
  };
  const mark = () => list.querySelectorAll("button").forEach((b, i) => { b.classList.toggle("on", i === on); if (i === on && el._keys) b.scrollIntoView({ block: "nearest" }); });
  box.addEventListener("input", (e) => { e.stopPropagation(); paint(); });
  box.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); el._keys = true; on = clamp(on + (e.key === "ArrowDown" ? 1 : -1), 0, shown.length - 1); mark(); }
    if (e.key === "Enter" && shown[on]) { e.preventDefault(); e.stopPropagation(); choose(shown[on].type); }
  });
  list.addEventListener("click", (e) => { const b = e.target.closest("[data-type]"); if (b) { e.stopPropagation(); choose(b.dataset.type); } });
  paint();
  el._place();
  if (matchMedia("(pointer: fine)").matches) box.focus({ preventScroll: true });
}

function menuFor(node, anchor) {
  const st = stepOf(node), s = spec(node);
  const items = [
    s.inputs.length && !ed.live && node.type !== "save" ? ["upto", "play", "Run up to here"] : null,
    s.paid && st.done && !ed.live ? ["anew", "again", "Make new ones"] : null,
    ["twin", "copy", "Make a copy"], ["bin", "trash", "Remove"],
  ].filter(Boolean);
  pop(anchor, `<div class="fl-list">${items.map(([act, i, label]) => `<button type="button" data-act="${act}" data-node="${node.id}">${ic(i)}${label}</button>`).join("")}</div>`, { width: 190 });
}

function helpFor(node, anchor) {
  const s = spec(node);
  const takes = s.inputs.map((i) => `<li data-t="${i.type}"><i></i>${esc(i.label)}: ${i.type === "any" ? "anything" : esc(a(cat.types[i.type]))}${i.required ? "" : ", optional"}</li>`).join("");
  pop(anchor, `<div class="fl-help"><strong>${esc(s.label)}</strong><p>${esc(s.help)}</p>${takes ? `<span class="fl-label">Takes</span><ul>${takes}</ul>` : ""}${s.out ? `<span class="fl-label">Gives</span><ul><li data-t="${s.out}"><i></i>${esc(a(cat.types[s.out]))}</li></ul>` : ""}</div>`, { width: 300 });
}

async function chooseMenu(node, f, anchor) {
  if (f.kind === "image_model" && !models) {
    const data = await ctx.api("/api/studio/options").catch(() => ({ models: [] }));
    models = data.models.filter((m) => m.available).map((m) => ({ value: m.id, label: m.label || m.name || m.id, hint: m.price ? `about $${Number(m.price).toFixed(2)} each` : "" }));
    if (!ed) return;
  }
  const v = node.fields[f.id];
  pop(anchor, `<div class="fl-list tall">${choicesOf(f).map((c) => `<button type="button" data-act="choice" data-node="${node.id}" data-for="${f.id}" data-value="${esc(c.value)}" class="${c.value === v ? "on" : ""}"><span><b>${esc(c.label)}</b>${c.hint ? `<small>${esc(c.hint)}</small>` : ""}</span>${c.value === v ? ic("check") : ""}</button>`).join("")}</div>`, { width: Math.max(260, anchor.offsetWidth) });
}

async function projectFiles(node, kind, anchor) {
  const board = await ctx.api("/api/board").catch(() => ({ groups: [] }));
  if (!ed) return;
  const rows = board.groups.flatMap((g) => g.assets).map((x) => ({ title: x.title, path: kind === "picture" ? x.image : x.model?.path || x.model, thumb: x.image })).filter((x) => typeof x.path === "string" && (kind === "picture" ? /\.(png|jpe?g|webp)$/i : /\.glb$/i).test(x.path));
  const el = pop(anchor, `<div class="fl-pal"><strong>${kind === "picture" ? "Pictures" : "3D models"} in this project</strong>${rows.length ? `<input type="text" placeholder="Search" aria-label="Search" autocomplete="off">` : ""}<div class="fl-shelf"></div></div>`, { width: 380 });
  const shelf = $(".fl-shelf", el), box = $("input", el);
  const paint = () => {
    const q = (box?.value || "").toLowerCase();
    shelf.innerHTML = rows.filter((x) => x.title.toLowerCase().includes(q)).slice(0, 120).map((x) => `<button type="button" data-act="take" data-node="${node.id}" data-path="${esc(x.path)}" data-name="${esc(x.title)}">${x.thumb ? `<img src="${esc(ctx.thumbUrl(x.thumb, 160))}" alt="" loading="lazy">` : ic("cube")}<span>${esc(x.title)}</span></button>`).join("") || `<p class="fl-none">${rows.length ? "Nothing called that." : `No ${kind === "picture" ? "pictures" : "3D models"} in this project yet.`}</p>`;
  };
  box?.addEventListener("input", (e) => { e.stopPropagation(); paint(); });
  paint();
  el._place();
}

function browse(node) {
  const kind = node.type === "my_model" ? ".glb" : "image/png,image/jpeg,image/webp";
  const input = Object.assign(document.createElement("input"), { type: "file", accept: kind });
  input.onchange = () => input.files[0] && bring(input.files[0], node);
  input.click();
}

// A file becomes a step's picture or model; without a step to go into, a new one.
async function bring(file, node = null, at = null) {
  const mine = ed;
  const form = new FormData();
  form.append("file", file, file.name || "picture.png");
  try {
    const res = await fetch(`/api/flows/upload?id=${encodeURIComponent(ed.id)}&project=${encodeURIComponent(ctx.state.project)}`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "That file couldn't be read.");
    if (mine !== ed) return;
    const type = /\.glb$/i.test(data.path) ? "my_model" : "my_picture";
    if (!node || node.type !== type) node = add(type, { at });
    mutate(() => { node.fields.path = data.path; });
  } catch (err) { ctx.toast(err.message, true); }
}

function zoom(path) {
  const list = [...new Set([...$("#flEditor").querySelectorAll(".fl-cards [data-act=zoom][data-path]")].map((b) => b.dataset.path))];
  let i = Math.max(0, list.indexOf(path));
  const el = document.createElement("div");
  el.className = "fl-zoom";
  const paint = () => { el.innerHTML = `<img src="${esc(ctx.fileUrl(list[i]))}" alt=""><button type="button" class="x" aria-label="Close">${ic("close")}</button>${list.length > 1 ? `<button type="button" class="l" aria-label="Previous">${ic("back")}</button><button type="button" class="r" aria-label="Next">${ic("back")}</button>` : ""}`; const im = $("img", el); im.onload = () => im.classList.toggle("px", im.naturalWidth <= 128); };
  el._step = (by) => { i = (i + by + list.length) % list.length; paint(); };
  el.addEventListener("click", (e) => { e.stopPropagation(); if (e.target.closest(".l")) return el._step(-1); if (e.target.closest(".r")) return el._step(1); unzoom(); });
  paint();
  $("#flEditor").append(el);
  ed.zoom = el;
}
function unzoom() { if (!ed?.zoom) return false; ed.zoom.remove(); ed.zoom = null; return true; }

// ---------- clicks and typing ----------

function onClick(event) {
  const t = event.target.closest("[data-act]");
  if (ed.pop && !event.target.closest(".fl-pop") && !ed.popHeld) closePop();
  ed.popHeld = false;
  const card = event.target.closest(".fl-card");
  if (ed.mode === "steps") {  // on the canvas, ports answer to the pointer handlers below
    const plus = event.target.closest(".fl-plus"), port = event.target.closest(".fl-port");
    if (plus) return palette({ from: nodeOf(card.dataset.id), anchor: plus });
    if (port && !port.classList.contains("on")) return palette({ into: nodeOf(card.dataset.id), port: port.dataset.in, anchor: port });
  }
  if (!t) return;
  const d = t.dataset;
  const node = nodeOf(d.node || card?.dataset.id);
  const f = node && spec(node).fields.find((x) => x.id === (d.for || d.field));
  const acts = {
    back: () => { ctx.state.flowSel = null; ctx.renderView(); },
    mode: () => { try { localStorage.setItem("tessera.flow.mode", d.mode); } catch { /* private window */ } setMode(d.mode); if (d.mode === "canvas") { if (ed.doc.tidy) tidy(); opening(); } },
    run: () => run(),
    agree: () => run(d.target, true),
    close: closePop,
    add: () => palette({ anchor: t }),
    first: () => add(d.kind),
    undo: () => back(ed.undo, ed.redo),
    redo: () => back(ed.redo, ed.undo),
    fit: () => fit(),
    tidy: () => { mutate(() => { ed.doc.tidy = true; }); tidy(); fit(); },
    coach: () => coach()?.go?.(),
    help: () => helpFor(node, t),
    more: () => menuFor(node, t),
    upto: () => { closePop(); run(node.id); },
    anew: () => { closePop(); makeNew(node); },
    twin: () => { closePop(); const data = copyNodes(new Set([node.id])); pasteNodes(data, 40, (ed.cards.get(node.id)?.offsetHeight || 200) + GAP_Y); },
    bin: () => remove([node.id]),
    fold: () => mutate(() => { node.more = !node.more; }, `fold${node.id}`),
    toggle: () => mutate(() => { node.fields[d.field] = !node.fields[d.field]; }),
    set: () => mutate(() => { node.fields[d.field] = f.kind === "number" ? Number(d.value) : d.value; }),
    multi: () => mutate(() => { const v = new Set(node.fields[d.field]); v.has(d.value) ? v.delete(d.value) : v.add(d.value); node.fields[d.field] = f.choices.map((c) => c.value).filter((c) => v.has(c)); }),
    choose: () => chooseMenu(node, f, t),
    choice: () => { closePop(); mutate(() => { node.fields[d.for] = d.value; }); },
    upload: () => browse(node),
    project: () => projectFiles(node, node.type === "my_model" ? "model" : "picture", t),
    take: () => { closePop(); mutate(() => { node.fields.path = d.path; if ("name" in node.fields) node.fields.name = d.name; }); },
    zoom: () => zoom(d.path),
    pick: () => pick(node, d.group, d.path),
    asset: () => ctx.go({ type: "doc", path: d.path }),
    retry: () => run(node.id),
    fix: () => fix({ node: node.id, ...stepOf(node).problem }),
    advice: () => { const edge = wiresInto(node.id, "picture")[0]; if (edge) insertOn(edge, "pick"); },
    unwire: () => { closePop(); const edge = ed.doc.edges[Number(d.edge)]; mutate(() => { ed.doc.edges = ed.doc.edges.filter((e) => e !== edge); }); },
    between: () => palette({ edge: ed.doc.edges[Number(d.edge)], anchor: ed.wireAt }),
  };
  acts[d.act]?.();
}

function onInput(event) {
  const el = event.target;
  if (el.id === "flName") { const v = el.value; return mutate(() => { ed.doc.name = v.trim() || "Workflow"; }, "name"); }
  const card = el.closest(".fl-card"), id = el.dataset.field;
  if (!card || !id) return;
  mutate(() => { nodeOf(card.dataset.id).fields[id] = el.value; }, `${card.dataset.id}.${id}`);
  const count = el.closest(".fl-f")?.querySelector(".fl-label em");
  if (count) count.textContent = countLines(el.value) ? plural(countLines(el.value), "line") : "";
}

function onChange(event) { if (event.target.id === "flName") { ed.coalesce = ""; ctx.onTitle?.(); } else if (event.target.closest(".fl-card")) ed.coalesce = ""; }

// ---------- pointer: pan, zoom, move, wire, select ----------

const INTERACTIVE = "button, input, textarea, select, audio, a, [data-view-model]";

function onDown(event) {
  if (ed.mode !== "canvas") return;
  const canvas = $("#flCanvas");
  ed.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (ed.pointers.size === 2) { ed.drag = { kind: "pinch" }; return; }
  if (event.button !== 0 && event.button !== 1) return;
  const card = event.target.closest(".fl-card");
  const node = card && nodeOf(card.dataset.id);
  const plus = event.target.closest(".fl-plus"), port = event.target.closest(".fl-port");
  const hit = event.target.closest(".hit");
  const start = { x: event.clientX, y: event.clientY, id: event.pointerId };
  if (event.button === 1 || (!card && !hit)) {
    if (event.button === 1) event.preventDefault();
    if (document.activeElement?.closest?.("#flEditor") && event.button === 0) document.activeElement.blur();
    if (ed.pop) { closePop(); ed.popHeld = true; }
    ed.drag = event.shiftKey ? { kind: "marquee", ...start, from: toWorld(event.clientX, event.clientY), had: new Set(ed.sel) } : { kind: "pan", ...start, cam: { ...ed.cam } };
  } else if (plus) {
    event.preventDefault();
    ed.drag = { kind: "wire", ...start, from: node, type: spec(node).out, tap: plus };
  } else if (port) {
    event.preventDefault();
    const wires = wiresInto(node.id, port.dataset.in);
    const input = spec(node).inputs.find((i) => i.id === port.dataset.in);
    // A plugged-in wire comes off in your hand; an empty input starts one that looks for where it comes from.
    ed.drag = wires.length ? { kind: "wire", ...start, from: nodeOf(wires.at(-1).from), type: spec(nodeOf(wires.at(-1).from)).out, edge: wires.at(-1), tap: port }
      : { kind: "wire", ...start, to: node, port: input.id, type: input.type, tap: port };
  } else if (hit) {
    ed.drag = { kind: "edge", ...start, edge: ed.doc.edges[Number(hit.dataset.edge)], index: hit.dataset.edge };
  } else {
    if (event.shiftKey) { ed.sel.has(node.id) ? ed.sel.delete(node.id) : ed.sel.add(node.id); } else if (!ed.sel.has(node.id)) ed.sel = new Set([node.id]);
    draw();
    if (event.target.closest(INTERACTIVE)) return;
    if (document.activeElement?.closest?.(".fl-card")) document.activeElement.blur();
    ed.drag = { kind: "move", ...start, at: new Map([...ed.sel].map((id) => [id, { x: nodeOf(id).x, y: nodeOf(id).y }])) };
  }
  if (ed.drag) canvas.setPointerCapture(event.pointerId);
}

function onMove(event) {
  const p = ed.pointers.get(event.pointerId);
  if (!p) return;
  const prev = { ...p };
  p.x = event.clientX; p.y = event.clientY;
  const g = ed.drag;
  if (!g) return;
  if (g.kind === "pinch" && ed.pointers.size === 2) {
    const other = [...ed.pointers.entries()].find(([id]) => id !== event.pointerId)[1];
    const was = Math.hypot(prev.x - other.x, prev.y - other.y) || 1, now = Math.hypot(p.x - other.x, p.y - other.y) || 1;
    ed.cam.x += (p.x - prev.x) / 2; ed.cam.y += (p.y - prev.y) / 2;
    return zoomAt((p.x + other.x) / 2, (p.y + other.y) / 2, now / was);
  }
  const dx = event.clientX - g.x, dy = event.clientY - g.y;
  if (!g.moved && Math.hypot(dx, dy) < 4) return;
  if (!g.moved) {
    g.moved = true;
    $("#flEditor").classList.add(`is-${g.kind}`);
    closePop();
    if (g.kind === "move") { ed.undo.push(JSON.stringify(ed.doc)); ed.redo.length = 0; ed.coalesce = ""; ed.doc.tidy = false; }
    if (g.kind === "wire") markTargets(g);
  }
  if (g.kind === "pan") { ed.cam.x = g.cam.x + dx; ed.cam.y = g.cam.y + dy; applyCam(); }
  if (g.kind === "move") {
    g.at.forEach((at, id) => { const n = nodeOf(id); if (n) { n.x = Math.round(at.x + dx / ed.cam.z); n.y = Math.round(at.y + dy / ed.cam.z); } });
    place();
    drawWires();
  }
  if (g.kind === "wire") {
    g.at = toWorld(event.clientX, event.clientY);
    const over = overCard(event);
    $("#flEditor").querySelectorAll(".fl-card.aim").forEach((el) => el.classList.remove("aim"));
    if (over) ed.cards.get(over.node.id).classList.add("aim");
    drawWires();
  }
  if (g.kind === "marquee") {
    const q = toWorld(event.clientX, event.clientY);
    const box = { x: Math.min(g.from.x, q.x), y: Math.min(g.from.y, q.y), w: Math.abs(q.x - g.from.x), h: Math.abs(q.y - g.from.y) };
    let el = $(".fl-marquee");
    if (!el) { el = document.createElement("div"); el.className = "fl-marquee"; $("#flWorld").append(el); }
    Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    ed.sel = new Set(g.had);
    ed.doc.nodes.forEach((n) => { const h = ed.cards.get(n.id)?.offsetHeight || 0; if (n.x < box.x + box.w && n.x + CARD_W > box.x && n.y < box.y + box.h && n.y + h > box.y) ed.sel.add(n.id); });
    ed.cards.forEach((c, id) => c.classList.toggle("sel", ed.sel.has(id)));
  }
}

function overCard(event) {
  const el = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".fl-card, .fl-port");
  const card = el?.closest(".fl-card");
  const node = card && nodeOf(card.dataset.id);
  if (!node || node === ed.drag.from || node === ed.drag.to) return null;
  const port = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".fl-port");
  return { node, port: port?.dataset.in || "" };
}

// While a wire is in the air, steps it can't reach step back.
function markTargets(g) {
  ed.cards.forEach((el, id) => {
    const n = nodeOf(id);
    const ok = g.from ? n !== g.from && !leadsTo(n.id, g.from.id) && bridge(g.type, n) !== null : n !== g.to && !leadsTo(g.to.id, n.id) && spec(n).out && bridge(spec(n).out, g.to, g.port) !== null;
    el.classList.toggle("dim", !ok && n !== (g.from || g.to));
  });
}

function onUp(event) {
  ed.pointers.delete(event.pointerId);
  const g = ed.drag;
  if (!g || g.kind === "pinch") { if (!ed.pointers.size) ed.drag = null; return; }
  ed.drag = null;
  $("#flEditor").classList.remove("is-pan", "is-move", "is-wire", "is-marquee", "is-edge");
  ed.cards.forEach((el) => el.classList.remove("aim", "dim"));
  $(".fl-marquee")?.remove();
  if (g.kind === "move" && g.moved) { if (g.at.size) touched(); return; }
  if (g.kind === "pan" && !g.moved && event.button === 0) { ed.sel.clear(); return draw(); }
  if (g.kind === "edge" && !g.moved) {
    ed.wireAt = { x: event.clientX, y: event.clientY };
    ed.popHeld = true;
    return pop(ed.wireAt, `<div class="fl-list"><button type="button" data-act="between" data-edge="${g.index}">${ic("plus")}Put a step here</button><button type="button" data-act="unwire" data-edge="${g.index}">${ic("close")}Unplug</button></div>`, { width: 180 });
  }
  if (g.kind !== "wire") return;
  ed.popHeld = true;  // the click that follows must not close what this opens
  if (!g.moved) {
    drawWires();
    if (g.from && !g.edge) return palette({ from: g.from, anchor: g.tap });
    if (g.to) return palette({ into: g.to, port: g.port, anchor: g.tap });
    return;
  }
  const over = overCardOf(event, g);
  if (over) {
    if (g.edge) ed.doc.edges = ed.doc.edges.filter((e) => e !== g.edge);
    const ok = g.from ? join(g.from, over.node, over.port) : join(over.node, g.to, g.port);
    if (!ok && g.edge) ed.doc.edges.push(g.edge);
    return draw();
  }
  if (g.edge) return mutate(() => { ed.doc.edges = ed.doc.edges.filter((e) => e !== g.edge); });
  const spot = toWorld(event.clientX, event.clientY);
  drawWires();
  ed.doc.tidy = false;
  palette({ from: g.from, into: g.to, port: g.port, anchor: { x: event.clientX, y: event.clientY }, at: { x: g.from ? spot.x + 10 : spot.x - CARD_W - 10, y: spot.y - 26 } });
}

function overCardOf(event, g) {
  const el = document.elementFromPoint(event.clientX, event.clientY);
  const node = nodeOf(el?.closest?.(".fl-card")?.dataset.id);
  if (!node || node === g.from || node === g.to) return null;
  const port = el.closest(".fl-port")?.dataset.in || "";
  const wanted = g.from ? port : "";
  return { node, port: wanted };
}

function onWheel(event) {
  if (ed.mode !== "canvas" || ed.zoom) return;
  const scroller = event.target.closest(".fl-pics.many, .fl-words, textarea:focus");
  if (scroller && scroller.scrollHeight > scroller.clientHeight && !event.ctrlKey) return;
  event.preventDefault();
  // A mouse wheel zooms, two fingers on a trackpad pan (and pinch, which arrives as ctrl + wheel).
  const wheel = event.deltaMode !== 0 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 80);
  if (event.ctrlKey || event.metaKey || wheel) return zoomAt(event.clientX, event.clientY, Math.exp(-clamp(event.deltaY, -160, 160) * (wheel ? 0.0016 : 0.01)));
  ed.cam.x -= event.deltaX; ed.cam.y -= event.deltaY;
  applyCam();
}

function onDouble(event) {
  if (ed.mode !== "canvas" || document.elementFromPoint(event.clientX, event.clientY)?.closest(".fl-card, .hit, .fl-chrome")) return;
  const spot = toWorld(event.clientX, event.clientY);
  palette({ anchor: { x: event.clientX, y: event.clientY }, at: { x: spot.x - CARD_W / 2, y: spot.y - 24 } });
}

// ---------- keys, files ----------

function onKey(event) {
  if (!ed || !document.getElementById("flEditor") || document.querySelector("dialog[open], #palette") || !document.getElementById("settingsView")?.hidden || !document.getElementById("projectsView")?.hidden) return;
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  const inside = event.target === document.body || event.target.closest?.("#flEditor") || event.target.closest?.("#content");
  const cmd = event.ctrlKey || event.metaKey, k = event.key.toLowerCase();
  const take = () => { event.preventDefault(); event.stopImmediatePropagation(); };
  if (ed.zoom) {
    if (k === "escape") { take(); unzoom(); }
    if (k === "arrowleft" || k === "arrowright") { take(); ed.zoom._step(k === "arrowleft" ? -1 : 1); }
    return;
  }
  if (!inside) return;
  if (cmd && k === "enter") { take(); if (!ed.live) run(); return; }
  if (k === "escape") {
    if (closePop()) return take();
    if (typing) { take(); return event.target.blur(); }
    if (ed.sel.size) { take(); ed.sel.clear(); return draw(); }
    return;
  }
  if (typing) return;
  if (cmd && k === "z") { take(); return event.shiftKey ? back(ed.redo, ed.undo) : back(ed.undo, ed.redo); }
  if (cmd && k === "y") { take(); return back(ed.redo, ed.undo); }
  if (cmd && k === "a") { take(); ed.sel = new Set(ed.doc.nodes.map((n) => n.id)); return draw(); }
  if (cmd && k === "d" && ed.sel.size) { take(); return pasteNodes(copyNodes(ed.sel), 40, 60); }
  if (cmd && k === "c" && ed.sel.size && !String(getSelection())) { take(); clip = copyNodes(ed.sel); return ctx.toast(`${plural(clip.nodes.length, "step")} copied`); }
  if (cmd && k === "v" && clip) { take(); return pasteNodes(clip); }
  if (cmd || event.altKey) return;
  if ((k === "delete" || k === "backspace") && ed.sel.size) { take(); return remove([...ed.sel]); }
  if (k === "f") { take(); return fit(); }
  if (k === "t") { take(); mutate(() => { ed.doc.tidy = true; }); tidy(); return fit(); }
  if (k === "tab" && (event.target === document.body || event.target.id === "content")) { take(); return palette({ at: viewCentre() }); }
}

const pictureOf = (list) => [...(list || [])].find((f) => /\.(png|jpe?g|webp|glb)$/i.test(f.name) || /^image\/(png|jpeg|webp)$/.test(f.type));

function onPaste(event) {
  if (!ed || !document.getElementById("flEditor") || event.target.closest?.("input, textarea, [contenteditable]") || document.querySelector("dialog[open]")) return;
  const file = pictureOf(event.clipboardData?.files);
  if (!file) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const chosen = ed.sel.size === 1 ? nodeOf([...ed.sel][0]) : null;
  bring(file, chosen?.type === "my_picture" ? chosen : null);
}

// A file dropped here belongs to the workflow, not to the project's general import (drops.js).
function onDragOver(event) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "copy";
  $("#flCanvas").classList.add("dropping");
}
function onDrop(event) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  $("#flCanvas").classList.remove("dropping");
  document.body.classList.remove("dropping");
  const tip = document.getElementById("dropTip");
  if (tip) tip.hidden = true;
  const file = pictureOf(event.dataTransfer.files);
  if (!file) return ctx.toast("Drop a PNG, JPG or WebP picture, or a .glb 3D model.", true);
  const node = nodeOf(event.target.closest(".fl-card")?.dataset.id);
  const spot = toWorld(event.clientX, event.clientY);
  bring(file, node && /^my_/.test(node.type) ? node : null, ed.mode === "canvas" ? { x: spot.x - CARD_W / 2, y: spot.y - 40 } : null);
}
