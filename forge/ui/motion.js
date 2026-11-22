// Motion Studio: a page of its own for keyframing rigged models. Home lists every rig in the project; the editor is
// the 3D viewport (motion-rig.js) with a floating toolbar and a timeline (dope sheet and curves) along the bottom.
// The motion document is the source of truth: every change goes through mutate(), which also feeds undo and autosave.
import * as THREE from "three";
import { createRig, evalKeys, easeTime, CHANNELS } from "./motion-rig.js";

let ctx = null;      // helpers handed over by app.js: api, fileUrl, thumbUrl, esc, toast, state, renderView, humanize
let ed = null;       // the open editor
let poseClip = null; // Copy Pose keeps its pose here, across motions

const $ = (sel) => document.querySelector(sel);
const LABEL_W = 148, RULER_H = 24, MARK_H = 18, TOP = RULER_H + MARK_H, ROW_H = 20, EASE_H = 46;
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2];
const AXIS = ["#ff6b6b", "#51cf66", "#4dabf7"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const short = (key) => key.replace(/^.*[:|]/, "");

const PATHS = {
  move: `<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>`,
  rotate: `<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>`,
  scale: `<path d="M4 13h7v7H4zM14 4h6v6M20 4l-7 7"/>`,
  bones: `<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="m8 16 8-8"/>`,
  xray: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>`,
  onion: `<circle cx="9" cy="12" r="5.5"/><path d="M13 7.2a5.5 5.5 0 0 1 0 9.6M17 8a5.5 5.5 0 0 1 0 8"/>`,
  copy: `<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>`,
  paste: `<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3.5h6V5M9 11h6M9 15h6"/>`,
  mirror: `<path d="M12 3v18M8 7l-4.5 5L8 17zM16 7l4.5 5-4.5 5z"/>`,
  reset: `<circle cx="12" cy="5" r="2"/><path d="M4 9.5h16M12 9.5V15M12 15l-3.5 6M12 15l3.5 6"/>`,
  ik: `<circle cx="5" cy="6" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="19" cy="7" r="2"/><path d="m6.3 7.5 4.4 6M13.4 13.6l4.3-5"/>`,
  horror: `<path d="M12 3a7.5 7.5 0 0 0-4.5 13.5V19a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2.5A7.5 7.5 0 0 0 12 3z"/><circle cx="9.2" cy="11" r="1.3"/><circle cx="14.8" cy="11" r="1.3"/>`,
  play: `<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>`,
  pause: `<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>`,
  first: `<path d="M6 5v14M19 5l-9 7 9 7z"/>`,
  last: `<path d="M18 5v14M5 5l9 7-9 7z"/>`,
  loop: `<path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4"/>`,
  fold: `<path d="m6 9 6 6 6-6"/>`,
  back: `<path d="M15 5l-7 7 7 7"/>`,
  undo: `<path d="M8 6 3 11l5 5M3 11h11a5 5 0 0 1 0 10h-4"/>`,
  redo: `<path d="m16 6 5 5-5 5M21 11H10a5 5 0 0 0 0 10h4"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  trash: `<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>`,
};
const ic = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;

// ---------- entry points for app.js ----------

export async function render(context) {
  ctx = context;
  const sel = ctx.state.motionSel;
  if (ed && ed.sel === sel && document.getElementById("moEditor")) return adopt();  // a workspace change must not reload the editor
  leave();
  if (sel) return openEditor(sel);
  return renderHome();
}

// What Tess is told about the editor: which motion is on screen, and what she would need to create it.
export function current() {
  if (!ed) return null;
  const s = ed.rig.selection;
  return { asset: ed.asset, name: ed.name, source: ed.doc.source, saved: Boolean(ed.savedName), frame: Math.round(ed.rig.frame), selected_bone: s?.type === "bone" ? s.key : "" };
}

// Easy mode is what a first-time animator gets: poses in a strip instead of keys on a timeline. The choice is kept.
const MODE_KEY = "tessera.motion.mode";
function easyWanted() { try { return localStorage.getItem(MODE_KEY) !== "pro"; } catch { return true; } }

// The document as text, without what only the server writes; two equal texts are the same motion.
const stable = (doc) => JSON.stringify({ ...doc, name: undefined, baked: undefined });

// The file changed on disk and it wasn't this page saving it: Tess (or a coding agent) edited the motion. Take her
// version, as one undo step, unless there are edits here that are not saved yet.
async function adopt() {
  const mine = ed;
  if (mine.dirty || mine.adopting) return;
  mine.adopting = true;
  try {
    await mine.saving.catch(() => {});
    const saved = await ctx.api(`/api/motion?asset=${encodeURIComponent(mine.asset)}&name=${encodeURIComponent(mine.name)}`).catch(() => null);
    if (!saved || mine !== ed || mine.dirty) return;
    delete saved.name;
    if (stable(saved) === mine.serverText) return;
    mine.undo.push(JSON.stringify(mine.doc));
    mine.redo.length = 0;
    mine.doc = saved;
    mine.serverText = stable(saved);
    mine.savedName = mine.sel.name = mine.name;
    mine.rig.setDoc(saved);
    mine.keys.clear();
    syncBar(); paintTools(); paintSel(); paintPop(); paintStrip(); drawTimeline();
    setState("Saved");
    ctx.toast("The motion was updated from the chat. Ctrl Z brings back yours.");
  } finally { mine.adopting = false; }
}

export function leave() {
  $("#content")?.classList.remove("mo-full");
  if (!ed) return;
  const old = ed;
  ed = null;
  clearTimeout(old.timer);
  clearTimeout(old.thumbTimer);
  if (old.dirty) persist(old).catch(() => {});
  window.removeEventListener("keydown", onKey, true);
  old.observer?.disconnect();
  old.rig?.dispose();
}

// ---------- home ----------

async function renderHome() {
  const content = $("#content");
  let data;
  try { data = await ctx.api("/api/motion/home"); } catch (err) { content.innerHTML = `<div class="empty"><img class="tess-art" src="/ui/art/tess-error.webp" alt="" aria-hidden="true" draggable="false"><h1>Motion Studio</h1><p>${ctx.esc(err.message)}</p></div>`; return; }
  if (ctx.state.view.type !== "motion" || ctx.state.motionSel) return;
  const { esc } = ctx;
  const card = (r) => {
    const taken = [...r.motions.map((m) => m.name), ...r.sources.map((s) => s.label)];
    const starts = r.sources.filter((s) => !s.made_here);
    return `<article class="mo-rig">
      <div class="mo-rig-pic">${r.thumb ? `<img src="${esc(ctx.thumbUrl(r.thumb, 480))}" alt="" loading="lazy">` : ic("bones")}</div>
      <div class="mo-rig-body">
        <strong>${esc(r.title)}</strong>
        <small>Start from</small>
        <div class="mo-chips">${starts.map((s) => `<button type="button" data-mo-new="${esc(JSON.stringify({ asset: r.asset, title: r.title, scale: r.scale, source: s.path, kind: s.kind, label: s.label, taken }))}">${esc(s.kind === "rig" ? "Bind pose" : ctx.humanize(s.label))}${s.seconds ? `<i>${s.seconds.toFixed(1)} s</i>` : ""}</button>`).join("")}</div>
        ${r.motions.length ? `<small>Your motions</small><div class="mo-chips">${r.motions.map((m) => `<button type="button" class="made" data-mo-open="${esc(JSON.stringify({ asset: r.asset, title: r.title, scale: r.scale, name: m.name }))}">${esc(ctx.humanize(m.name))}<i>${m.seconds.toFixed(1)} s${m.baked ? " · baked" : ""}</i></button>`).join("")}</div>` : ""}
      </div></article>`;
  };
  content.innerHTML = `<div class="mo-home" id="moHome">
    <header><span class="mo-eyebrow">${ic("bones")} Motion Studio</span><h1>Animate your rigs</h1>
      <p>Pose bones, set keys and shape the timing by hand, from the bind pose or on top of a generated take. Baking writes a clip your game can play.</p></header>
    ${data.rigs.length ? `<div class="mo-rigs">${data.rigs.map(card).join("")}</div>`
      : `<div class="mo-none"><img class="tess-art md" src="/ui/art/tess-rig.webp" alt="" aria-hidden="true" draggable="false"><strong>No rigged models yet</strong><p>Open a 3D character's page and press Rig, or drop a rigged .glb onto an asset. It will show up here.</p></div>`}
  </div>`;
  $("#moHome").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-mo-new], [data-mo-open]");
    if (!pick) return;
    ctx.state.motionSel = JSON.parse(pick.dataset.moNew || pick.dataset.moOpen);
    ctx.renderView();
  });
}

// ---------- the editor ----------

function newDoc(sel) {
  const take = sel.kind === "take";
  return { source: sel.source, base_clip: take ? 0 : null, fps: 30, frames: 60, range: [0, 60], loop: true, ik: { horror: false, chains: [] },
    layers: [{ id: "layer1", name: take ? "Adjust" : "Keys", mode: take ? "additive" : "override", weight: 1, mute: false, tracks: {} }], modifiers: [], markers: [], baked: null };
}

function freeName(sel) {
  const stem = (sel.kind === "take" ? `${sel.label}_edit` : "motion").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "motion";
  const taken = new Set((sel.taken || []).map((n) => n.toLowerCase()));
  let name = stem;
  for (let n = 2; taken.has(name); n += 1) name = `${stem}_${n}`;
  return name;
}

async function openEditor(sel) {
  const content = $("#content");
  const { esc } = ctx;
  content.classList.add("mo-full");
  content.innerHTML = `<div class="mo" id="moEditor">
    <div class="mo-view" id="moView"><div class="mo-loading">Loading the rig…</div></div>
    <div class="mo-top">
      <button type="button" class="mo-back" data-mo="home">${ic("back")}<span>Motion Studio</span></button>
      <span class="mo-asset">${esc(sel.title || "")}</span>
      <input id="moName" spellcheck="false" maxlength="48" aria-label="Motion name" title="The clip's name: the baked file and the animation inside it are called this">
      <span class="mo-state" id="moState"></span>
      <span class="mo-grow"></span>
      <div class="mo-mode" role="group" aria-label="Editor mode"><button type="button" data-mo="mode-easy" title="Easy: pose the character, add poses, press play">Easy</button><button type="button" data-mo="mode-pro" title="Pro: the full timeline, curves, layers and modifiers">Pro</button></div>
      <button type="button" class="primary" data-mo="bake" title="Merge everything into one clip and write it as a .glb in this asset's animations"></button>
    </div>
    <div class="mo-tools" id="moTools"></div>
    <div class="mo-sel" id="moSel"></div>
    <div class="mo-time" id="moTime">
      <div class="mo-bar" id="moBar"></div>
      <canvas id="moCanvas"></canvas>
    </div>
    <div class="mo-pop" id="moPop" hidden></div>
    <div class="mo-easy" id="moEasy"></div></div>`;
  let doc, name = "";
  try {
    if (sel.name) { const saved = await ctx.api(`/api/motion?asset=${encodeURIComponent(sel.asset)}&name=${encodeURIComponent(sel.name)}`); name = saved.name; doc = saved; delete doc.name; } else { doc = newDoc(sel); name = freeName(sel); }
    const rig = await createRig($("#moView"), ctx.fileUrl(doc.source), { scale: sel.scale || 1 });
    if (ctx.state.motionSel !== sel || !document.getElementById("moEditor")) { rig.dispose(); return; }
    $("#moView .mo-loading")?.remove();
    if (!sel.name) {
      const clip = rig.clips[0];
      if (doc.base_clip !== null && !clip) doc.base_clip = null;
      if (doc.base_clip !== null) { doc.frames = Math.max(1, Math.round(clip.seconds * doc.fps)); doc.range = [0, doc.frames]; }
    }
    ed = { sel, asset: sel.asset, name, savedName: sel.name ? name : "", doc, rig, dirty: false, timer: 0, saving: Promise.resolve(), undo: [], redo: [],
      autoKey: true, playing: false, speed: 1, loopOn: true, seconds: false, mode: "dope", curveCh: "r", keys: new Set(), view: { x0: 0, ppf: 8, scroll: 0 }, folded: false,
      gizmo: "rotate", space: "local", bonesOn: true, xray: true, onion: false, drag: null, pop: null, sounds: null, liveBefore: null,
      easy: easyWanted(), thumbs: new Map(), thumbTimer: 0 };
    ed.serverText = sel.name ? stable(doc) : "";
    rig.setDoc(doc);
    if (!sel.name) rig.ik.auto();  // arms, legs, tail and head get IK handles without any setup
    rig.on("select", () => {
      if (ed.easy && ed.gizmo !== "rotate") { ed.gizmo = "rotate"; rig.setMode("rotate"); }  // only the root is ever moved, and only when asked
      paintSel(); drawTimeline();
    });
    rig.on("scratch", paintSel);
    rig.on("edit", (changes) => {
      if (ed.playing) { ed.playing = false; syncBar(); }
      if (ed.autoKey) record(changes);
      else paintSel();
    });
    rig.onTick = tick;
  } catch (err) {
    $("#moView").innerHTML = `<div class="mo-loading error">${esc(err.message)}</div>`;
    return;
  }
  $("#moName").value = name;
  setState(sel.name ? "Saved" : "");
  buildBar();
  buildEasy();
  applyMode();
  fitView();
  const root = $("#moEditor");
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  const canvas = $("#moCanvas");
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDouble);
  ed.observer = new ResizeObserver(() => { if (!ed.fitted) fitView(); drawTimeline(); });
  ed.observer.observe(canvas);
  window.addEventListener("keydown", onKey, true);
}

const setState = (text) => { const el = $("#moState"); if (el) el.textContent = text; };

// Every change to the document goes through here: one undo step, a redraw, and a save a moment later.
function mutate(change) {
  ed.undo.push(JSON.stringify(ed.doc));
  if (ed.undo.length > 100) ed.undo.shift();
  ed.redo.length = 0;
  change();
  touched();
}
function touched() {
  ed.dirty = true;
  setState("Unsaved");
  clearTimeout(ed.timer);
  const mine = ed;
  ed.timer = setTimeout(() => persist(mine).catch(() => {}), 1200);
  ed.rig.invalidate();
  syncBar();
  paintTools();
  paintSel();
  paintPop();
  paintStrip();
  drawTimeline();
}
function restore(text) {
  ed.doc = JSON.parse(text);
  ed.rig.setDoc(ed.doc);
  ed.keys.clear();
  touched();
}
function undo() { if (!ed.undo.length) return; ed.redo.push(JSON.stringify(ed.doc)); restore(ed.undo.pop()); }
function redo() { if (!ed.redo.length) return; ed.undo.push(JSON.stringify(ed.doc)); restore(ed.redo.pop()); }

function persist(e) {
  clearTimeout(e.timer);
  e.saving = e.saving.then(async () => {
    if (!e.dirty) return;
    const typed = ($("#moName")?.value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    const name = e === ed && typed ? typed : e.name;
    e.dirty = false;
    if (e === ed) setState("Saving…");
    try {
      const saved = await ctx.api("/api/motion/save", { method: "POST", body: { asset: e.asset, name, doc: e.doc } });
      if (e.savedName && e.savedName !== saved.name) await ctx.api("/api/motion/delete", { method: "POST", body: { asset: e.asset, name: e.savedName } }).catch(() => {});
      e.name = e.savedName = e.sel.name = saved.name;
      e.serverText = stable(saved);
      if (e === ed) { setState(e.dirty ? "Unsaved" : "Saved"); if (document.activeElement !== $("#moName")) $("#moName").value = saved.name; }
    } catch (err) {
      e.dirty = true;
      if (e === ed) { setState("Not saved"); ctx.toast(err.message, true); }
      throw err;
    }
  });
  return e.saving;
}

async function bake(button) {
  const mine = ed;
  button.disabled = true;
  button.textContent = "Baking…";
  try {
    mine.dirty = true;  // the server bakes the saved document, so it must be current
    await persist(mine);
    const samples = mine.rig.bakeSamples();
    const out = await ctx.api("/api/motion/bake", { method: "POST", body: { asset: mine.asset, name: mine.name, ...samples } });
    mine.doc.baked = out.baked;
    const speed = out.baked.root_speed ? ` · root ${out.baked.root_speed} m/s` : "";
    ctx.toast(`Baked ${mine.name}.glb: ${out.baked.seconds} s, ${out.baked.tracks} bone tracks${speed}. Listed in ASSETS.md.`);
  } catch (err) { ctx.toast(err.message, true); }
  if (button.isConnected) { button.disabled = false; button.textContent = bakeLabel(); }
}

// ---------- toolbar and selection chip ----------

function paintTools() {
  const tool = (act, icon, tip, on = false) => `<button type="button" data-mo="${act}" class="${on ? "on" : ""}" title="${ctx.esc(tip)}" aria-label="${ctx.esc(tip)}">${ic(icon)}</button>`;
  if (ed.easy) {
    $("#moTools").innerHTML = `${tool("undo", "undo", "Undo (Ctrl Z)")}${tool("redo", "redo", "Redo (Ctrl Shift Z)")}<hr>
      ${tool("mirror", "mirror", "Flip the pose: left and right swap")}${tool("reset", "reset", "Back to the standing pose")}<hr>
      ${tool("copy", "copy", "Copy this pose")}${tool("paste", "paste", "Paste the copied pose here")}`;
    return;
  }
  $("#moTools").innerHTML = `
    ${tool("g-translate", "move", "Move (W)", ed.gizmo === "translate")}${tool("g-rotate", "rotate", "Rotate (E)", ed.gizmo === "rotate")}${tool("g-scale", "scale", "Scale (R)", ed.gizmo === "scale")}
    <button type="button" data-mo="space" class="txt" title="Gizmo axes: the bone's own (Local) or the world's">${ed.space === "local" ? "Local" : "World"}</button>
    <hr>
    ${tool("bones", "bones", "Show bones", ed.bonesOn)}${tool("xray", "xray", "X-ray: bones show through the mesh", ed.xray)}${tool("onion", "onion", "Onion skin: ghosts of the 2 frames before and after", ed.onion)}
    <hr>
    ${tool("copy", "copy", "Copy pose (Ctrl C)")}${tool("paste", "paste", "Paste pose (Ctrl V)")}${tool("mirror", "mirror", "Mirror pose: swap left and right")}${tool("reset", "reset", "Reset to the bind pose")}
    <hr>
    ${tool("ik-auto", "ik", "Find IK chains: arms, legs, tail and head")}${tool("horror", "horror", "Horror mode: unlock anatomical limits so joints can bend the wrong way", ed.doc.ik.horror)}`;
}

function paintSel() {
  const el = $("#moSel");
  if (!el || !ed) return;
  const { esc } = ctx;
  const s = ed.rig.selection;
  const picker = `<select id="moBone" title="Pick a bone by name"><option value="">${s?.type === "bone" ? esc(short(s.key)) : "Pick a bone…"}</option>${ed.rig.bones.map((b) => `<option value="${esc(b.key)}">${"  ".repeat(Math.min(b.depth, 8))}${esc(short(b.key))}</option>`).join("")}</select>`;
  let body;
  if (ed.easy) {
    const name = s ? esc(ctx.humanize(short(s.type === "ik" ? s.name : s.key))) : "";
    const root = s?.type === "bone" && !ed.rig.bones.find((b) => b.key === s.key)?.parent;
    if (s?.type === "ik") body = `<strong>${name}</strong><span>Drag the arrows to move it</span><button type="button" data-mo="pin" class="${ed.rig.ik.pinned(s.name) ? "on" : ""}" title="Keep this hand or foot where it is while you move the rest of the body">Hold in place</button>`;
    else if (root) body = `<strong>${name}</strong><div class="mo-seg"><button type="button" data-mo="g-rotate" class="${ed.gizmo === "rotate" ? "on" : ""}">Turn</button><button type="button" data-mo="g-translate" class="${ed.gizmo === "translate" ? "on" : ""}" title="Move the whole body: jump, crouch, step">Move</button></div>`;
    else if (s) body = `<strong>${name}</strong><span>Drag a ring to turn it</span>`;
    else body = `<span>${ed.doc.ik.chains.length ? "Drag a teal square to move a hand or foot, or click a bone to turn it" : "Click a bone, then drag a ring to turn it"}</span>`;
    el.innerHTML = body;
    return;
  }
  if (s?.type === "ik") {
    body = `<strong>IK · ${esc(s.name)}</strong><button type="button" data-mo="pin" class="${ed.rig.ik.pinned(s.name) ? "on" : ""}" title="Keep this hand or foot where it is while you move other bones">Pin</button>
      <button type="button" data-mo="invert" title="Bend the middle joint the other way (Horror mode)">Flip bend</button><button type="button" data-mo="ik-remove" title="Remove this IK chain">Remove</button>`;
  } else if (s) {
    body = `${picker}<button type="button" data-mo="ik-add" title="Make an IK chain ending at this bone (it and its two parents)">IK here</button>`;
  } else body = `<span>Click a bone or an IK handle</span>${picker}`;
  el.innerHTML = body + (ed.rig.unkeyed && !ed.autoKey ? `<em>Unkeyed pose · press I to key it</em>` : "");
}

function buildBar() {
  $("#moBar").innerHTML = `
    <button type="button" data-mo="first" title="First frame (Home)">${ic("first")}</button>
    <button type="button" data-mo="play" class="mo-play" title="Play or pause (Space)"></button>
    <button type="button" data-mo="last" title="Last frame (End)">${ic("last")}</button>
    <input id="moFrame" class="mo-num" inputmode="decimal" title="Playhead" aria-label="Playhead"><span class="mo-dim" id="moTotal"></span>
    <button type="button" data-mo="units" class="txt" title="Show frames or seconds"></button>
    <select id="moSpeed" title="Playback speed">${SPEEDS.map((v) => `<option value="${v}">${v}×</option>`).join("")}</select>
    <button type="button" data-mo="loop" title="Loop between the two range handles on the ruler">${ic("loop")}</button>
    <i class="mo-sep"></i>
    <button type="button" data-mo="key" class="txt" title="Key the selected bone at this frame (I)">◆ Key</button>
    <button type="button" data-mo="auto" class="txt" title="Auto-key: every move of a bone records a key">● Auto-key</button>
    <button type="button" data-mo="marker-add" class="txt" title="Add an event marker at the playhead (M)">⚑ Marker</button>
    <select id="moInterp" title="How the selected keys travel to the next key (1, 2, 3)"><option value="">Interpolation</option><option value="smooth">Smooth</option><option value="linear">Linear</option><option value="step">Stepped</option></select>
    <span class="mo-grow"></span>
    <button type="button" data-mo="layers" class="txt" title="Layers: stack poses on top of the base clip"></button>
    <button type="button" data-mo="mods" class="txt" title="Modifiers: procedural changes on top of the keys"></button>
    <select id="moCurveCh" title="Which curves to show"><option value="r">Rotation</option><option value="t">Position</option><option value="s">Scale</option></select>
    <div class="mo-seg"><button type="button" data-mo="dope">Dope sheet</button><button type="button" data-mo="curves">Curves</button></div>
    <label class="mo-field">Length<input id="moLen" class="mo-num" type="number" min="1" max="6000"></label>
    <label class="mo-field">FPS<input id="moFps" class="mo-num" type="number" min="1" max="120"></label>
    <button type="button" data-mo="fold" title="Hide or show the timeline">${ic("fold")}</button>`;
  syncBar();
}

const frameText = (f) => (ed.seconds ? (f / ed.doc.fps).toFixed(2) : String(Math.round(f)));

function syncBar() {
  const bar = $("#moBar");
  if (!bar || !ed) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = value; };
  const on = (act, flag) => bar.querySelector(`[data-mo="${act}"]`)?.classList.toggle("on", flag);
  bar.querySelector(`[data-mo="play"]`).innerHTML = ic(ed.playing ? "pause" : "play");
  bar.querySelector(`[data-mo="units"]`).textContent = ed.seconds ? "Seconds" : "Frames";
  set("moFrame", frameText(ed.rig.frame));
  $("#moTotal").textContent = `/ ${frameText(ed.doc.frames)}${ed.seconds ? " s" : ""}`;
  set("moSpeed", String(ed.speed));
  set("moLen", ed.doc.frames);
  set("moFps", ed.doc.fps);
  on("layers", ed.pop?.type === "layers"); on("mods", ed.pop?.type === "mods");
  bar.querySelector(`[data-mo="layers"]`).textContent = `Layers ${ed.doc.layers.length}`;
  bar.querySelector(`[data-mo="mods"]`).textContent = `Modifiers${ed.doc.modifiers.length ? ` ${ed.doc.modifiers.length}` : ""}`;
  on("loop", ed.loopOn); on("auto", ed.autoKey); on("dope", ed.mode === "dope"); on("curves", ed.mode === "curves");
  $("#moCurveCh").hidden = ed.mode !== "curves";
  $("#moCurveCh").value = ed.curveCh;
  const kinds = new Set(selectedKeys().map((k) => k.i));
  $("#moInterp").value = kinds.size === 1 ? [...kinds][0] : "";
  $("#moTime").classList.toggle("folded", ed.folded);
  bar.querySelector(`[data-mo="fold"]`).classList.toggle("flip", ed.folded);
  syncEasy();
}

// ---------- playback ----------

function tick(dt) {
  if (!ed || !ed.playing) return;
  const [a, b] = ed.doc.range, was = ed.rig.frame;
  let f = was + dt * ed.doc.fps * ed.speed;
  if (f >= b) {
    if (ed.loopOn) f = a + ((f - a) % Math.max(1e-6, b - a));
    else { f = b; ed.playing = false; }
  }
  for (const m of ed.doc.markers) if (m.audio && (f >= was ? was < m.f && m.f <= f : m.f > was || m.f <= f)) playSound(m.audio);
  ed.rig.setFrame(f);
  syncFrame();
  if (!ed.playing) syncBar();
}
function syncFrame() {
  const el = $("#moFrame");
  if (el && document.activeElement !== el) el.value = frameText(ed.rig.frame);
  syncEasy();
  drawTimeline();
}
function setFrame(f) {
  ed.rig.setFrame(clamp(Math.round(f), 0, ed.doc.frames));
  syncFrame();
}
function togglePlay() {
  ed.playing = !ed.playing;
  if (ed.playing && ed.rig.frame >= ed.doc.range[1]) ed.rig.setFrame(ed.doc.range[0]);
  if (!ed.playing) setFrame(ed.rig.frame);
  syncBar();
}

// ---------- keys ----------

const layer = () => ed.doc.layers[ed.rig.activeLayer];
const keyId = (bone, f) => `${bone}|${f}`;
const splitId = (id) => { const at = id.lastIndexOf("|"); return [id.slice(0, at), Number(id.slice(at + 1))]; };

function framesOf(bone) {
  const tracks = layer().tracks;
  const set = new Set();
  for (const key of bone === "*" ? Object.keys(tracks) : [bone]) for (const ch in tracks[key] || {}) tracks[key][ch].forEach((k) => set.add(k.f));
  return [...set].sort((x, y) => x - y);
}
function selectedKeys() {
  if (!ed) return [];
  const out = [];
  for (const id of ed.keys) {
    const [bone, f] = splitId(id);
    for (const ch in layer().tracks[bone] || {}) { const k = layer().tracks[bone][ch].find((x) => x.f === f); if (k) out.push(k); }
  }
  return out;
}

function keySelected() {
  const s = ed.rig.selection;
  const list = new Map(ed.rig.unkeyedList());
  if (s?.type === "bone") list.set(s.key, [...new Set([...(list.get(s.key) || []), ...ed.rig.keyChannels(s.key)])]);
  if (s?.type === "ik") { const c = ed.doc.ik.chains.find((x) => x.name === s.name); [c.root, c.mid, c.tip].forEach((key) => list.set(key, [...new Set([...(list.get(key) || []), "r"])])); }
  if (!list.size) return ctx.toast("Select a bone first, then press I to key it.");
  mutate(() => ed.rig.keyBones([...list]));
}

function deleteKeys() {
  if (!ed.keys.size) return;
  mutate(() => {
    const tracks = layer().tracks;
    for (const id of ed.keys) {
      const [bone, f] = splitId(id);
      for (const ch in tracks[bone] || {}) { tracks[bone][ch] = tracks[bone][ch].filter((k) => k.f !== f); if (!tracks[bone][ch].length) delete tracks[bone][ch]; }
      if (tracks[bone] && !Object.keys(tracks[bone]).length) delete tracks[bone];
    }
    ed.keys.clear();
  });
}

// Move (or, with `copy`, duplicate) the selected keys by `df` frames; a key landing on another replaces it.
function shiftKeys(df, copy = false) {
  const tracks = layer().tracks;
  const next = new Set();
  const byBone = new Map();
  for (const id of ed.keys) { const [bone, f] = splitId(id); (byBone.get(bone) || byBone.set(bone, new Set()).get(bone)).add(f); }
  for (const [bone, frames] of byBone) {
    for (const ch in tracks[bone] || {}) {
      const moving = tracks[bone][ch].filter((k) => frames.has(k.f));
      const landed = moving.map((k) => ({ ...(copy ? structuredClone(k) : k), f: clamp(k.f + df, 0, ed.doc.frames) }));
      const taken = new Set(landed.map((k) => k.f));
      const rest = tracks[bone][ch].filter((k) => (copy || !frames.has(k.f)) && !taken.has(k.f));
      tracks[bone][ch] = [...rest, ...new Map(landed.map((k) => [k.f, k])).values()].sort((x, y) => x.f - y.f);
    }
    frames.forEach((f) => next.add(keyId(bone, clamp(f + df, 0, ed.doc.frames))));
  }
  ed.keys = next;
}
function duplicateKeys() {
  if (!ed.keys.size) return;
  const first = Math.min(...[...ed.keys].map((id) => splitId(id)[1]));
  const df = Math.round(ed.rig.frame) - first;
  if (!df) return ctx.toast("Move the playhead to where the copies should go, then duplicate.");
  mutate(() => shiftKeys(df, true));
}
function setInterp(kind) {
  if (!ed.keys.size) return ctx.toast("Select keys in the timeline first.");
  mutate(() => selectedKeys().forEach((k) => { k.i = kind; }));
}

// ---------- pose and IK actions ----------

// Record moved bones as keys. In Easy mode a pose is the whole body, so a pose never shifts when another is edited.
function record(changes) {
  mutate(() => ed.rig.keyBones(ed.easy ? wholeBody(changes) : changes));
}

function applyPose(pose) {
  const changes = ed.rig.applyPose(pose);
  if (changes.length && ed.autoKey) record(changes);
  else paintSel();
  return changes.length;
}

function act(what, button) {
  const rig = ed.rig, s = rig.selection;
  if (what === "home") { ctx.state.motionSel = null; return ctx.renderView(); }
  if (what === "bake") return bake(button);
  if (what === "mode-easy" || what === "mode-pro") return setMode(what === "mode-easy");
  if (what === "undo") return undo();
  if (what === "redo") return redo();
  if (what === "pose-add") return addPose();
  if (what === "pose-go") { if (ed.playing) togglePlay(); return setFrame(Number(button.dataset.f)); }
  if (what === "pose-dup") return copyPoseToEnd(Number(button.dataset.f));
  if (what === "pose-del") return deletePose(Number(button.dataset.f));
  if (what === "pose-gap") return cycleGap(Number(button.dataset.f));
  if (what.startsWith("feel-")) return mutate(() => { for (const track of Object.values(layer().tracks)) for (const keys of Object.values(track)) keys.forEach((k) => { k.i = what.slice(5); }); });
  if (what.startsWith("g-")) { ed.gizmo = what.slice(2); rig.setMode(ed.gizmo); paintSel(); return paintTools(); }
  if (what === "space") { ed.space = ed.space === "local" ? "world" : "local"; rig.setSpace(ed.space); return paintTools(); }
  if (what === "bones") { ed.bonesOn = !ed.bonesOn; rig.setBones(ed.bonesOn); return paintTools(); }
  if (what === "xray") { ed.xray = !ed.xray; rig.setXray(ed.xray); return paintTools(); }
  if (what === "onion") { ed.onion = !ed.onion; rig.setOnion(ed.onion); return paintTools(); }
  if (what === "copy") { poseClip = rig.copyPose(); return ctx.toast("Pose copied"); }
  if (what === "paste") { if (!poseClip) return ctx.toast("Copy a pose first."); return void applyPose(poseClip); }
  if (what === "mirror") return void applyPose(rig.mirroredPose());
  if (what === "reset") return void applyPose(rig.restPose());
  if (what === "ik-auto") { let n = 0; mutate(() => { n = rig.ik.auto(); }); return ctx.toast(n ? `${n} IK chains ready: drag the teal handles` : "No arms, legs or tails found by name. Select a bone and press IK here."); }
  if (what === "ik-add" && s?.type === "bone") { let chain = null; mutate(() => { chain = rig.ik.add(s.key); }); return chain ? rig.select({ type: "ik", name: chain.name }) : ctx.toast("An IK chain needs two parent bones above this one."); }
  if (what === "ik-remove" && s?.type === "ik") return mutate(() => rig.ik.remove(s.name));
  if (what === "pin" && s?.type === "ik") { rig.ik.pin(s.name, !rig.ik.pinned(s.name)); return paintSel(); }
  if (what === "invert" && s?.type === "ik") {
    if (!ed.doc.ik.horror) return ctx.toast("Turn on Horror mode (the skull) to bend a joint the wrong way.");
    const changes = rig.ik.invert(s.name);
    return ed.autoKey ? record(changes) : paintSel();
  }
  if (what === "horror") return mutate(() => { ed.doc.ik.horror = !ed.doc.ik.horror; });
  if (what === "layers" || what === "mods") return openPop({ type: what });
  const row = button?.closest?.("[data-layer], [data-mod]");
  const li = Number(row?.dataset.layer ?? -1), mi = Number(row?.dataset.mod ?? -1);
  const layers = ed.doc.layers, mods = ed.doc.modifiers;
  if (what === "layer-add") return mutate(() => { layers.push({ id: `layer${Date.now().toString(36)}`, name: `Layer ${layers.length + 1}`, mode: "additive", weight: 1, mute: false, tracks: {} }); rig.activeLayer = layers.length - 1; ed.keys.clear(); });
  if (what === "layer-pick") { rig.activeLayer = li; ed.keys.clear(); paintPop(); syncBar(); return drawTimeline(); }
  if (what === "layer-mode") return mutate(() => { layers[li].mode = layers[li].mode === "additive" ? "override" : "additive"; });
  if (what === "layer-mute") return mutate(() => { layers[li].mute = !layers[li].mute; });
  if (what === "layer-up") return mutate(() => { [layers[li], layers[li + 1]] = [layers[li + 1], layers[li]]; rig.activeLayer = rig.activeLayer === li ? li + 1 : rig.activeLayer === li + 1 ? li : rig.activeLayer; });
  if (what === "layer-del") return mutate(() => { const now = rig.activeLayer; layers.splice(li, 1); rig.activeLayer = now > li ? now - 1 : now; ed.keys.clear(); });
  if (what === "mod-on") return mutate(() => { mods[mi].on = mods[mi].on === false; });
  if (what === "mod-del") return mutate(() => mods.splice(mi, 1));
  if (what === "mod-up") return mi > 0 ? mutate(() => { [mods[mi - 1], mods[mi]] = [mods[mi], mods[mi - 1]]; }) : undefined;
  if (what === "mod-seed") return mutate(() => { mods[mi].seed = 1 + Math.floor(Math.random() * 9998); });
  if (what === "mod-lock") return mutate(() => { mods[mi].lock = !mods[mi].lock; });
  if (what === "marker-add") return addMarker(Math.round(rig.frame));
  if (what === "marker-del") return mutate(() => { ed.doc.markers.splice(ed.doc.markers.indexOf(ed.pop.marker), 1); ed.pop = null; });
  if (what === "marker-preset") return mutate(() => { ed.pop.marker.name = button.dataset.name; });
  if (what === "marker-play") return ed.pop.marker.audio ? playSound(ed.pop.marker.audio) : ctx.toast("Pick a sound for this marker first.");
  if (what === "first") return setFrame(ed.doc.range[0]);
  if (what === "last") return setFrame(ed.doc.range[1]);
  if (what === "play") return togglePlay();
  if (what === "units") { ed.seconds = !ed.seconds; return syncFrame(), syncBar(); }
  if (what === "loop") { ed.loopOn = !ed.loopOn; return syncBar(); }
  if (what === "key") return keySelected();
  if (what === "auto") { ed.autoKey = !ed.autoKey; syncBar(); return paintSel(); }
  if (what === "dope" || what === "curves") { ed.mode = what; syncBar(); return drawTimeline(); }
  if (what === "fold") { ed.folded = !ed.folded; syncBar(); return requestAnimationFrame(drawTimeline); }
  return undefined;
}

function onClick(event) {
  const button = event.target.closest("[data-mo]");
  if (button && ed) act(button.dataset.mo, button);
}

function onChange(event) {
  const t = event.target;
  if (!ed) return;
  if (t.id === "moName") { ed.dirty = true; persist(ed).catch(() => {}); }
  const field = t.dataset.field, picked = ed.rig.selection?.type === "bone" ? ed.rig.selection.key : "";
  const li = Number(t.closest("[data-layer]")?.dataset.layer ?? -1), mi = Number(t.closest("[data-mod]")?.dataset.mod ?? -1);
  if (field === "layer-weight" || field === "mod-num") commitLive();
  if (field === "layer-name") mutate(() => { ed.doc.layers[li].name = t.value.trim() || `Layer ${li + 1}`; });
  if (field === "mod-set") {
    if (t.value === "branch" && !picked) { ctx.toast("Select a bone first: the modifier acts on it and the bones below it."); return paintPop(); }
    mutate(() => { const m = ed.doc.modifiers[mi]; m.set = t.value; if (t.value === "branch") m.root = picked; else delete m.root; });
  }
  if (field === "marker-name") mutate(() => { ed.pop.marker.name = t.value.trim() || "event"; });
  if (field === "marker-audio") { mutate(() => { ed.pop.marker.audio = t.value; }); if (t.value) playSound(t.value); }
  if (t.id === "moModAdd" && t.value) mutate(() => ed.doc.modifiers.push(MODS[t.value].make(picked)));
  if (t.id === "moBone" && t.value) ed.rig.select({ type: "bone", key: t.value });
  if (t.id === "moSpeed") ed.speed = Number(t.value) || 1;
  if (t.id === "moInterp" && t.value) setInterp(t.value);
  if (t.id === "moCurveCh") { ed.curveCh = t.value; drawTimeline(); }
  if (t.id === "moFrame") setFrame(ed.seconds ? Number(t.value) * ed.doc.fps : Number(t.value) || 0);
  if (t.id === "moLen") { const n = clamp(Math.round(Number(t.value) || ed.doc.frames), 1, 6000); mutate(() => { ed.doc.frames = n; ed.doc.range = [Math.min(ed.doc.range[0], n - 1), n]; }); ed.fitted = false; fitView(); setFrame(Math.min(ed.rig.frame, n)); }
  if (t.id === "moFps") mutate(() => { ed.doc.fps = clamp(Math.round(Number(t.value) || 30), 1, 120); });
}

function onKey(event) {
  if (!ed || !document.getElementById("moEditor")) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) { if (event.key === "Escape" || event.key === "Enter") event.target.blur(); return; }
  if (document.querySelector("dialog[open], #palette") || String(getSelection()).length) return;
  const mod = event.ctrlKey || event.metaKey, k = event.key.toLowerCase();
  let used = true;
  if (ed.easy && !mod && !event.altKey) {  // Easy mode keeps play, undo and pose-to-pose stepping; the timeline's keys are Pro's
    if (k === "arrowleft" || k === "arrowright") {
      const cur = Math.round(ed.rig.frame), frames = poseFrames();
      const to = k === "arrowleft" ? frames.filter((f) => f < cur).pop() : frames.find((f) => f > cur);
      if (to !== undefined) { if (ed.playing) togglePlay(); setFrame(to); }
    } else if (k === " ") togglePlay();
    else if (k === "escape") ed.rig.select(null);
    else used = false;
    if (used) { event.preventDefault(); event.stopPropagation(); }
    return;
  }
  if (mod && k === "z") (event.shiftKey ? redo : undo)();
  else if (mod && k === "y") redo();
  else if (mod && k === "s") { ed.dirty = true; persist(ed).catch(() => {}); }
  else if (mod && k === "c") act("copy");
  else if (mod && k === "v") act("paste");
  else if ((mod || event.shiftKey) && k === "d") duplicateKeys();
  else if (mod || event.altKey) used = false;
  else if (k === " ") togglePlay();
  else if (k === "i") keySelected();
  else if (k === "w") act("g-translate");
  else if (k === "e") act("g-rotate");
  else if (k === "r") act("g-scale");
  else if (k === "delete" || k === "backspace" || k === "x") deleteKeys();
  else if (k === "arrowleft" || k === "arrowright") setFrame(Math.round(ed.rig.frame) + (k === "arrowleft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
  else if (k === "home") setFrame(ed.doc.range[0]);
  else if (k === "end") setFrame(ed.doc.range[1]);
  else if (k === "1" || k === "2" || k === "3") setInterp(["smooth", "linear", "step"][Number(k) - 1]);
  else if (k === "m") act("marker-add");
  else if (k === "escape") { if (ed.pop) openPop(null); else { ed.keys.clear(); ed.rig.select(null); } syncBar(); drawTimeline(); }
  else used = false;
  if (used) { event.preventDefault(); event.stopPropagation(); }
}

// ---------- the popover above the timeline: layers, modifiers, or one marker ----------

const MODS = {
  reverse: { label: "Time-reverse", hint: "These bones play the clip backwards", make: () => ({ type: "reverse", on: true, set: "legs" }) },
  quantize: { label: "Stop-motion", hint: "Hold each pose for a few frames", make: () => ({ type: "quantize", on: true, step: 3, set: "all" }) },
  twitch: { label: "Twitch", hint: "Noise spasms on these bones", make: (bone) => ({ type: "twitch", on: true, amount: 12, speed: 8, seed: 1, set: bone ? "branch" : "all", ...(bone ? { root: bone } : {}) }) },
  stride: { label: "Stride and speed", hint: "Longer or shorter steps, faster or slower", make: () => ({ type: "stride", on: true, stride: 1, speed: 1 }) },
  clamp: { label: "Foot floor clamp", hint: "Feet never sink through the floor", make: () => ({ type: "clamp", on: true, lock: false }) },
};
const MARKS = ["footstep", "hit", "hitbox_active", "hitbox_off", "bone_crack_sfx", "whoosh"];
const players = new Map();

function playSound(path) {
  let audio = players.get(path);
  if (!audio) { audio = new Audio(ctx.fileUrl(path)); players.set(path, audio); }
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

// Sliders preview as they move; the undo step is taken once, when the slider is let go.
function live(change) {
  if (!ed.liveBefore) ed.liveBefore = JSON.stringify(ed.doc);
  change();
  ed.rig.invalidate();
}
function commitLive() {
  if (!ed.liveBefore) return;
  ed.undo.push(ed.liveBefore);
  ed.redo.length = 0;
  ed.liveBefore = null;
  touched();
}

function openPop(pop) {
  ed.pop = pop && ed.pop && pop.type === ed.pop.type && pop.type !== "marker" ? null : pop;
  paintPop();
  syncBar();
  drawTimeline();
}

function addMarker(f) {
  mutate(() => {
    const marker = { f, name: "event", audio: "" };
    ed.doc.markers.push(marker);
    ed.doc.markers.sort((p, q) => p.f - q.f);
    ed.pop = { type: "marker", marker };
  });
  const field = $("#moPop [data-field='marker-name']");
  if (field) { field.focus(); field.select(); }
}

function paintPop() {
  const el = $("#moPop");
  if (!el || !ed) return;
  const pop = ed.pop, { esc } = ctx, { doc, rig } = ed;
  if (!pop || (pop.type === "marker" && !doc.markers.includes(pop.marker))) { ed.pop = null; el.hidden = true; el.innerHTML = ""; return; }
  if (el.contains(document.activeElement) && document.activeElement.type === "text" && el.dataset.kind === pop.type) return;  // a field being typed in stays as it is
  const slider = (attrs, value, min, max, step) => `<input type="range" ${attrs} min="${min}" max="${max}" step="${step}" value="${value}">`;
  let html;
  if (pop.type === "layers") {
    const rows = doc.layers.map((l, i) => `<div class="mo-row${i === rig.activeLayer ? " active" : ""}" data-layer="${i}">
      <button type="button" data-mo="layer-pick" class="dot" title="New keys go to this layer"></button>
      <input type="text" data-field="layer-name" value="${esc(l.name)}" maxlength="60" aria-label="Layer name">
      <button type="button" data-mo="layer-mode" class="txt" title="Override replaces the pose below. Additive adds to it.">${l.mode === "additive" ? "Additive" : "Override"}</button>
      ${slider(`data-field="layer-weight" title="How strongly this layer applies"`, l.weight, 0, 1, 0.01)}
      <button type="button" data-mo="layer-mute" class="txt${l.mute ? " on" : ""}" title="Mute this layer">${l.mute ? "Muted" : "On"}</button>
      <button type="button" data-mo="layer-up" title="Move up the stack" ${i === doc.layers.length - 1 ? "disabled" : ""}>↑</button>
      <button type="button" data-mo="layer-del" title="Delete this layer" ${doc.layers.length === 1 ? "disabled" : ""}>✕</button></div>`).reverse().join("");
    html = `<div class="mo-pop-head"><strong>Layers</strong><button type="button" data-mo="layer-add" class="txt">+ Layer</button></div>${rows}
      <div class="mo-row base"><span>Base</span><em>${esc(doc.base_clip !== null ? rig.clips[doc.base_clip]?.name || "Clip" : "Bind pose")}</em></div>
      <p class="mo-hint">The top layer is applied last. Keys you set go to the layer with the lit dot. Baking merges them all.</p>`;
  } else if (pop.type === "mods") {
    const sets = (m) => `<select data-field="mod-set" title="Which bones">${[["all", "All bones"], ["legs", "Legs"], ["arms", "Arms"], ["branch", m.set === "branch" && m.root ? `${short(m.root)} and below` : "Picked bone and below"]]
      .map(([v, label]) => `<option value="${v}"${(m.set || "all") === v ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
    const num = (name, label, m, min, max, step, unit) => `<label>${label}${slider(`data-field="mod-num" data-param="${name}" data-unit="${unit}"`, m[name], min, max, step)}<output>${m[name]}${unit}</output></label>`;
    const body = (m) => ({
      reverse: () => sets(m),
      quantize: () => sets(m) + num("step", "Hold", m, 1, 12, 1, " fr"),
      twitch: () => sets(m) + num("amount", "Amount", m, 0, 90, 1, "°") + num("speed", "Speed", m, 0.5, 20, 0.5, " Hz") + `<button type="button" data-mo="mod-seed" class="txt" title="Another random pattern">Reroll</button>`,
      stride: () => num("stride", "Stride", m, 0, 2, 0.05, "×") + num("speed", "Speed", m, 0.25, 3, 0.05, "×"),
      clamp: () => `<button type="button" data-mo="mod-lock" class="txt${m.lock ? " on" : ""}" title="Hold each foot where it lands while it is down. For clips whose root travels.">Lock planted feet</button>${doc.ik.chains.some((c) => /foot|ankle/i.test(c.tip)) ? "" : `<em>Needs IK chains on the feet: press Find IK chains.</em>`}`,
    })[m.type]();
    html = `<div class="mo-pop-head"><strong>Modifiers</strong><select id="moModAdd"><option value="">Add a modifier…</option>${Object.entries(MODS).map(([v, d]) => `<option value="${v}">${d.label}</option>`).join("")}</select></div>
      ${doc.modifiers.map((m, i) => `<div class="mo-mod${m.on === false ? " off" : ""}" data-mod="${i}">
        <div class="mo-mod-head"><button type="button" data-mo="mod-on" class="dot${m.on === false ? "" : " on"}" title="On or off"></button><strong>${MODS[m.type].label}</strong><span>${MODS[m.type].hint}</span>
          <button type="button" data-mo="mod-up" title="Apply earlier" ${i ? "" : "disabled"}>↑</button><button type="button" data-mo="mod-del" title="Remove">✕</button></div>
        <div class="mo-mod-body">${body(m)}</div></div>`).join("") || `<p class="mo-hint">Nothing yet. Modifiers change the motion on top of your keys, live, and are merged in when you bake.</p>`}`;
  } else {
    const m = pop.marker;
    if (ed.sounds === null) { ed.sounds = []; ctx.api("/api/motion/sounds").then((d) => { if (ed) { ed.sounds = d.sounds; paintPop(); } }).catch(() => {}); }
    html = `<div class="mo-pop-head"><strong>Marker at ${frameText(m.f)}${ed.seconds ? " s" : ""}</strong><button type="button" data-mo="marker-del" class="txt">Delete</button></div>
      <div class="mo-row"><input type="text" data-field="marker-name" value="${esc(m.name)}" maxlength="60" placeholder="event name" aria-label="Event name"></div>
      <div class="mo-marks">${MARKS.map((n) => `<button type="button" data-mo="marker-preset" data-name="${n}">${n}</button>`).join("")}</div>
      <div class="mo-row"><select data-field="marker-audio" title="A sound from this project, played when the playhead passes"><option value="">No sound</option>${ed.sounds.map((snd) => `<option value="${esc(snd.path)}"${snd.path === m.audio ? " selected" : ""}>${esc(snd.name)}</option>`).join("")}</select>
        <button type="button" data-mo="marker-play" class="txt">Play</button></div>
      <p class="mo-hint">Drag the flag to move it. The baked clip lists this event with its time in ASSETS.md.</p>`;
  }
  el.dataset.kind = pop.type;
  el.innerHTML = html;
  el.hidden = false;
}

function onInput(event) {
  const t = event.target, field = t.dataset?.field;
  if (ed && t.id === "moScrub") { if (ed.playing) togglePlay(); return setFrame(Number(t.value)); }
  if (!ed || !field) return;
  if (field === "layer-weight") live(() => { ed.doc.layers[Number(t.closest("[data-layer]").dataset.layer)].weight = Number(t.value); });
  if (field === "mod-num") {
    live(() => { ed.doc.modifiers[Number(t.closest("[data-mod]").dataset.mod)][t.dataset.param] = Number(t.value); });
    t.nextElementSibling.textContent = `${t.value}${t.dataset.unit}`;
  }
}

function hitMarker(x) {
  return [...ed.doc.markers].reverse().find((m) => x >= xOf(m.f) - 5 && x <= xOf(m.f) + 16 + m.name.length * 6.2);
}

function onDouble(event) {
  const { x, y } = spot(event);
  if (ed && y >= RULER_H && y < TOP && x >= LABEL_W && !hitMarker(x)) addMarker(clamp(Math.round(fAt(x)), 0, ed.doc.frames));
}

// ---------- Easy mode: a strip of poses instead of a timeline ----------

const GAPS = [0.2, 0.4, 0.8, 1.5];  // seconds between two poses; the chip between two cards steps through them
const FEELS = [["smooth", "Smooth", "Glide from pose to pose"], ["linear", "Robot", "Straight, even moves with hard stops"], ["step", "Snap", "Hold each pose, then jump to the next"]];
const bakeLabel = () => (ed.easy ? "Export clip" : "Bake to GLB");
const poseFrames = () => framesOf("*");
const fromScratch = () => ed.doc.base_clip === null;  // on top of a generated take the length is the take's

function setMode(easy) {
  if (ed.easy === easy) return;
  ed.easy = easy;
  try { localStorage.setItem(MODE_KEY, easy ? "easy" : "pro"); } catch { /* private window: the choice lasts this visit */ }
  applyMode();
}

function applyMode() {
  const { rig } = ed;
  $("#moEditor").classList.toggle("easy", ed.easy);
  if (ed.easy) {
    ed.autoKey = true; ed.gizmo = "rotate"; ed.space = "local"; ed.bonesOn = true; ed.pop = null;
    rig.setMode("rotate"); rig.setSpace("local"); rig.setBones(true);
    ed.keys.clear();
    if (ed.playing) togglePlay(); else setFrame(rig.frame);
  } else ed.fitted = false;
  document.querySelector(`[data-mo="mode-easy"]`).classList.toggle("on", ed.easy);
  document.querySelector(`[data-mo="mode-pro"]`).classList.toggle("on", !ed.easy);
  document.querySelector(`[data-mo="bake"]`).textContent = bakeLabel();
  syncBar(); paintTools(); paintSel(); paintPop(); paintStrip();
  requestAnimationFrame(() => { if (!ed) return; if (!ed.fitted) fitView(); drawTimeline(); });
}

// Every bone, with the channels a key on it takes, plus whatever `changes` adds: one whole-body pose.
function wholeBody(changes) {
  const list = new Map(changes.map(([key, channels]) => [key, new Set(channels)]));
  for (const b of ed.rig.bones) {
    const set = list.get(b.key) || list.set(b.key, new Set()).get(b.key);
    ed.rig.keyChannels(b.key).forEach((ch) => set.add(ch));
  }
  return [...list].map(([key, set]) => [key, [...set]]);
}

function copyKeys(from, to) {
  for (const track of Object.values(layer().tracks)) {
    for (const ch in track) {
      const key = track[ch].find((k) => k.f === from);
      if (key) track[ch] = [...track[ch].filter((k) => k.f !== to), { ...structuredClone(key), f: to }].sort((x, y) => x.f - y.f);
    }
  }
}

// From scratch, the clip is as long as its poses: it ends on the last one.
function fitLength() {
  if (!fromScratch()) return;
  const n = Math.max(1, poseFrames().pop() || 0);
  ed.doc.frames = n;
  ed.doc.range = [0, n];
}

const gapFrames = () => Math.max(1, Math.round(GAPS[1] * ed.doc.fps));

// Add pose: between two poses it captures the moment on screen; on a pose it starts a new one after the last,
// as a copy of it, ready to be changed.
function addPose() {
  if (ed.playing) togglePlay();
  const frames = poseFrames(), cur = Math.round(ed.rig.frame), here = frames.includes(cur);
  const last = frames.length ? frames[frames.length - 1] : cur, to = last + gapFrames();
  const extend = fromScratch() && (here || !frames.length);
  if (here && !extend) return ctx.toast("Slide to the moment you want to change, then move the character: that makes a pose there.");
  if (extend && to > 6000) return ctx.toast("This motion is as long as it can get.", true);
  mutate(() => {
    if (!here) ed.rig.keyBones(wholeBody([]));
    if (extend) { copyKeys(last, to); fitLength(); }
  });
  if (extend) setFrame(to);
}

function copyPoseToEnd(f) {
  if (ed.playing) togglePlay();
  const to = poseFrames().pop() + gapFrames();
  if (!fromScratch() || to > 6000) return;
  mutate(() => { copyKeys(f, to); fitLength(); });
  setFrame(to);
}

function deletePose(f) {
  if (ed.playing) togglePlay();
  mutate(() => {
    const tracks = layer().tracks;
    for (const bone of Object.keys(tracks)) {
      for (const ch of Object.keys(tracks[bone])) { tracks[bone][ch] = tracks[bone][ch].filter((k) => k.f !== f); if (!tracks[bone][ch].length) delete tracks[bone][ch]; }
      if (!Object.keys(tracks[bone]).length) delete tracks[bone];
    }
    fitLength();
  });
  setFrame(Math.min(ed.rig.frame, ed.doc.frames));
}

// The time it takes to reach the pose at `f` from the one before: the next of GAPS, and every later pose moves along.
function cycleGap(f) {
  const frames = poseFrames(), at = frames.indexOf(f);
  if (at < 1 || !fromScratch()) return;
  const gap = f - frames[at - 1], options = GAPS.map((sec) => Math.max(1, Math.round(sec * ed.doc.fps)));
  const delta = (options.find((g) => g > gap) || options[0]) - gap;
  if (!delta || frames[frames.length - 1] + delta > 6000) return;
  const cur = Math.round(ed.rig.frame);
  mutate(() => {
    for (const track of Object.values(layer().tracks)) for (const keys of Object.values(track)) keys.forEach((k) => { if (k.f >= f) k.f += delta; });
    ed.doc.markers.forEach((m) => { if (m.f >= f) m.f += delta; });
    fitLength();
  });
  setFrame(cur >= f ? cur + delta : cur);
}

function buildEasy() {
  $("#moEasy").innerHTML = `<div class="mo-ebar">
      <button type="button" data-mo="play" class="mo-eplay" title="Play or pause (Space)"></button>
      <input type="range" id="moScrub" min="0" step="1" aria-label="Scrub through the motion" title="Slide through the motion">
      <span class="mo-etime" id="moClock"></span>
      <button type="button" data-mo="loop" class="mo-chip" title="Play it round and round">${ic("loop")}<span>Loop</span></button>
      <div class="mo-seg" id="moFeel" title="How the character travels between poses"></div>
    </div>
    <div class="mo-strip" id="moStrip"></div>`;
}

// What makes the pose at f look the way it does; two poses with the same text share a picture.
function poseSig(f) {
  const tracks = layer().tracks, parts = [fromScratch() ? "" : f];
  for (const bone in tracks) for (const ch in tracks[bone]) { const k = tracks[bone][ch].find((x) => x.f === f); if (k) parts.push(bone, ch, k.v.join(",")); }
  return parts.join("|");
}

function paintStrip() {
  const el = $("#moStrip");
  if (!el || !ed || !ed.easy) return;
  const { esc } = ctx, { doc } = ed;
  const frames = poseFrames(), scratch = fromScratch(), secs = (f) => `${(f / doc.fps).toFixed(1)} s`;
  const kinds = new Set();
  for (const track of Object.values(layer().tracks)) for (const keys of Object.values(track)) keys.forEach((k) => kinds.add(k.i));
  const feel = kinds.size === 1 ? [...kinds][0] : kinds.size ? "" : "smooth";
  $("#moFeel").innerHTML = FEELS.map(([kind, label, tip]) => `<button type="button" data-mo="feel-${kind}" class="${feel === kind ? "on" : ""}" title="${esc(tip)}" ${frames.length ? "" : "disabled"}>${label}</button>`).join("");
  const cards = frames.map((f, i) => {
    const gap = i ? (scratch ? `<button type="button" class="mo-gap" data-mo="pose-gap" data-f="${f}" title="Time to get from pose ${i} to pose ${i + 1}. Click to make it slower or faster.">${secs(f - frames[i - 1])}</button>` : `<span class="mo-gap">${secs(f - frames[i - 1])}</span>`) : "";
    const shot = ed.thumbs.get(poseSig(f));
    return `${gap}<div class="mo-pose" data-pose="${f}">
      <button type="button" class="mo-pose-pic" data-mo="pose-go" data-f="${f}" title="Go to pose ${i + 1}"><img alt=""${shot ? ` src="${shot}"` : " hidden"}><b>${i + 1}</b><i>${secs(f)}</i></button>
      <span class="mo-pose-acts">${scratch ? `<button type="button" data-mo="pose-dup" data-f="${f}" title="Copy this pose to the end${i ? "" : ": ending on pose 1 makes a seamless loop"}" aria-label="Copy this pose to the end">${ic("copy")}</button>` : ""}<button type="button" data-mo="pose-del" data-f="${f}" title="Delete this pose" aria-label="Delete this pose">${ic("trash")}</button></span></div>`;
  }).join("");
  const coach = !frames.length ? (scratch ? "Pose your character in the view above. That is pose 1." : "Slide to a moment in the take, then move the character to change it there.")
    : frames.length === 1 && scratch ? "Now press Add pose and change it. Tessera fills in the movement between the two."
    : scratch ? "Press play to watch it. For a seamless loop, copy pose 1 to the end." : "Press play to watch it. Each pose changes the take around its moment.";
  el.innerHTML = `${cards}<button type="button" class="mo-add" data-mo="pose-add" title="${scratch ? "Start the next pose, as a copy of the last one" : "Make the moment on screen a pose"}">${ic("plus")}<span>Add pose</span></button><p class="mo-coach">${coach}</p>`;
  syncEasy();
  clearTimeout(ed.thumbTimer);
  ed.thumbTimer = setTimeout(shootPoses, 180);
}

// Pictures for the pose cards, taken from the viewport once the hands are off it.
function shootPoses() {
  if (!ed || !ed.easy) return;
  if (ed.playing || ed.rig.dragging) { ed.thumbTimer = setTimeout(shootPoses, 400); return; }
  if (ed.thumbs.size > 300) ed.thumbs.clear();
  for (const card of document.querySelectorAll("#moStrip .mo-pose")) {
    const f = Number(card.dataset.pose), sig = poseSig(f), img = card.querySelector("img");
    if (!ed.thumbs.has(sig)) ed.thumbs.set(sig, ed.rig.snapshot(f, 132, 132));
    if (ed.thumbs.get(sig) && img.getAttribute("src") !== ed.thumbs.get(sig)) { img.src = ed.thumbs.get(sig); img.hidden = false; }
  }
}

// The parts of the strip that follow the playhead; cheap enough for every frame of playback.
function syncEasy() {
  const el = $("#moEasy");
  if (!el || !ed || !ed.easy || !el.firstChild) return;
  const f = Math.round(ed.rig.frame), fps = ed.doc.fps;
  const play = el.querySelector(`[data-mo="play"]`);
  if (play.dataset.on !== String(ed.playing)) { play.dataset.on = String(ed.playing); play.innerHTML = ic(ed.playing ? "pause" : "play"); }
  const scrub = $("#moScrub");
  scrub.max = ed.doc.frames;
  scrub.value = f;
  $("#moClock").textContent = `${(ed.rig.frame / fps).toFixed(1)} / ${(ed.doc.frames / fps).toFixed(1)} s`;
  el.querySelector(`[data-mo="loop"]`).classList.toggle("on", ed.loopOn);
  for (const card of el.querySelectorAll(".mo-pose")) {
    const on = Number(card.dataset.pose) === f;
    if (card.classList.contains("on") !== on) { card.classList.toggle("on", on); if (on && !ed.playing) card.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }
}

// ---------- the timeline canvas ----------

const xOf = (f) => LABEL_W + (f - ed.view.x0) * ed.view.ppf;
const fAt = (x) => (x - LABEL_W) / ed.view.ppf + ed.view.x0;

function fitView() {
  const canvas = $("#moCanvas");
  if (!canvas || !canvas.clientWidth) return;
  ed.view.ppf = Math.max(0.5, (canvas.clientWidth - LABEL_W - 36) / ed.doc.frames);
  ed.view.x0 = -18 / ed.view.ppf;
  ed.fitted = true;
}

function rowsNow() {
  const tracks = layer().tracks;
  const picked = ed.rig.selection?.type === "bone" ? ed.rig.selection.key : "";
  return [{ key: "*", label: "All bones" }, ...ed.rig.bones.filter((b) => tracks[b.key] || b.key === picked).map((b) => ({ key: b.key, label: short(b.key) }))];
}

function curveBone() {
  return ed.rig.selection?.type === "bone" ? ed.rig.selection.key : "";
}
const _euler = new THREE.Euler(), _quat = new THREE.Quaternion();
// The curve channel of the selected bone, sampled along the visible frames: [{ x, v: [a, b, c] }], rotation in degrees.
function sampleCurves(keys, width) {
  const out = [], raw = [];
  let prev = null;
  for (let x = LABEL_W; x <= width; x += 2) {
    evalKeys(keys, fAt(x), CHANNELS[ed.curveCh].size, raw);
    let v = raw.slice(0, 3);
    if (ed.curveCh === "r") {
      _euler.setFromQuaternion(_quat.set(raw[0], raw[1], raw[2], raw[3]), "XYZ");
      v = [_euler.x, _euler.y, _euler.z].map((a) => THREE.MathUtils.radToDeg(a));
      if (prev) v = v.map((a, i) => a + 360 * Math.round((prev[i] - a) / 360));  // no jumps at ±180°
    }
    prev = v;
    out.push({ x, v });
  }
  return out;
}

function drawTimeline() {
  const canvas = $("#moCanvas");
  if (!ed || !canvas || ed.folded || !canvas.clientWidth) return;
  const W = canvas.clientWidth, H = canvas.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = "11px Inter, system-ui, sans-serif";
  g.textBaseline = "middle";
  const { doc, view, drag } = ed;
  const picked = curveBone();

  // the clip, and the loop range inside it
  g.fillStyle = "rgba(255,255,255,.035)";
  g.fillRect(xOf(0), RULER_H, xOf(doc.frames) - xOf(0), H - RULER_H);
  g.fillStyle = "rgba(157,140,255,.07)";
  g.fillRect(xOf(doc.range[0]), RULER_H, xOf(doc.range[1]) - xOf(doc.range[0]), H - RULER_H);

  // frame lines and the ruler
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => s * view.ppf >= 58) || 2000;
  const minor = step >= 10 ? step / 5 : step >= 5 ? 1 : 0;
  for (let f = Math.max(0, Math.floor(view.x0 / (minor || step)) * (minor || step)); xOf(f) < W; f += minor || step) {
    const x = Math.round(xOf(f)) + 0.5, major = f % step === 0;
    if (x < LABEL_W) continue;
    g.strokeStyle = major ? "rgba(255,255,255,.09)" : "rgba(255,255,255,.035)";
    g.beginPath(); g.moveTo(x, major ? 0 : RULER_H); g.lineTo(x, H); g.stroke();
    if (major) { g.fillStyle = "#8b8b9c"; g.fillText(ed.seconds ? `${(f / doc.fps).toFixed(2)}s` : String(f), x + 4, RULER_H / 2); }
  }

  if (ed.mode === "dope") {
    const rows = rowsNow();
    rows.forEach((row, i) => {
      const y = TOP + i * ROW_H - view.scroll;
      if (y + ROW_H < TOP || y > H) return;
      if (row.key === picked) { g.fillStyle = "rgba(255,176,32,.08)"; g.fillRect(LABEL_W, y, W - LABEL_W, ROW_H); }
      g.strokeStyle = "rgba(255,255,255,.04)";
      g.beginPath(); g.moveTo(LABEL_W, y + ROW_H + 0.5); g.lineTo(W, y + ROW_H + 0.5); g.stroke();
      for (const f of framesOf(row.key)) {
        const chosen = row.key === "*" ? [...ed.keys].some((id) => splitId(id)[1] === f) : ed.keys.has(keyId(row.key, f));
        const x = xOf(f + (chosen && drag?.type === "move" ? drag.df : 0)), cy = y + ROW_H / 2;
        if (x < LABEL_W - 6 || x > W + 6) continue;
        const track = row.key === "*" ? null : layer().tracks[row.key];
        const kind = track ? (Object.values(track).map((list) => list.find((k) => k.f === f)).find(Boolean) || {}).i : "smooth";
        g.fillStyle = chosen ? "#ffb020" : row.key === "*" ? "#8f8fa3" : "#e4e6ee";
        g.strokeStyle = g.fillStyle;
        g.beginPath();
        if (kind === "step") g.rect(x - 4, cy - 4, 8, 8);
        else { g.moveTo(x, cy - 5.5); g.lineTo(x + 5.5, cy); g.lineTo(x, cy + 5.5); g.lineTo(x - 5.5, cy); g.closePath(); }
        if (kind === "linear") { g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1; } else g.fill();
      }
    });
    // names
    g.fillStyle = "#0e0e12";
    g.fillRect(0, RULER_H, LABEL_W, H - RULER_H);
    rows.forEach((row, i) => {
      const y = TOP + i * ROW_H - view.scroll;
      if (y < TOP - ROW_H || y > H) return;
      g.fillStyle = row.key === picked ? "#ffb020" : row.key === "*" ? "#8b8b9c" : "#c9cbd6";
      g.fillText(row.label.length > 20 ? `${row.label.slice(0, 19)}…` : row.label, 12, y + ROW_H / 2, LABEL_W - 18);
    });
    if (rows.length === 1) { g.fillStyle = "#6f6f80"; g.fillText("No keys yet. Pose a bone: Auto-key records it here.", LABEL_W + 14, TOP + ROW_H * 1.5); }
    if (drag?.type === "box") {
      g.fillStyle = "rgba(157,140,255,.15)"; g.strokeStyle = "rgba(157,140,255,.7)";
      g.fillRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0); g.strokeRect(drag.x0 + 0.5, drag.y0 + 0.5, drag.x1 - drag.x0, drag.y1 - drag.y0);
    }
  } else drawCurves(g, W, H, picked);

  // the marker lane: frame events, between the ruler and the rows
  g.fillStyle = "#101015";
  g.fillRect(0, RULER_H, W, MARK_H);
  g.fillStyle = "#6f6f80";
  g.fillText("Markers", 12, RULER_H + MARK_H / 2);
  if (!doc.markers.length) g.fillText("Double-click here to add an event", LABEL_W + 14, RULER_H + MARK_H / 2);
  for (const m of doc.markers) {
    const x = xOf(m.f);
    if (x < LABEL_W - 1 || x > W) continue;
    g.fillStyle = "rgba(61,214,198,.14)";
    g.fillRect(Math.round(x), TOP, 1, H - TOP);
    g.fillStyle = ed.pop?.marker === m ? "#ffb020" : "#3dd6c6";
    g.fillRect(Math.round(x), RULER_H + 2, 1, MARK_H - 3);
    g.beginPath(); g.moveTo(x, RULER_H + 2); g.lineTo(x + 7, RULER_H + 6); g.lineTo(x, RULER_H + 10); g.closePath(); g.fill();
    g.fillText(`${m.audio ? "♪ " : ""}${m.name}`, x + 10, RULER_H + MARK_H / 2);
  }
  g.strokeStyle = "rgba(255,255,255,.06)";
  g.beginPath(); g.moveTo(0, TOP + 0.5); g.lineTo(W, TOP + 0.5); g.stroke();

  // ruler furniture: the label corner, range handles, playhead
  g.fillStyle = "#0e0e12";
  g.fillRect(0, 0, LABEL_W, RULER_H);
  g.fillStyle = "#8b8b9c";
  g.fillText(`${layer().name} ▾`, 12, RULER_H / 2, LABEL_W - 18);
  g.strokeStyle = "rgba(255,255,255,.08)";
  g.beginPath(); g.moveTo(0, RULER_H + 0.5); g.lineTo(W, RULER_H + 0.5); g.moveTo(LABEL_W + 0.5, 0); g.lineTo(LABEL_W + 0.5, H); g.stroke();
  doc.range.forEach((f, i) => {
    const x = xOf(f);
    if (x < LABEL_W - 1) return;
    g.fillStyle = "#9d8cff";
    g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, 4); g.lineTo(x + (i ? -7 : 7), 4); g.lineTo(x + (i ? -7 : 7), 11); g.lineTo(x, 16); g.closePath(); g.fill();
  });
  const px = xOf(ed.rig.frame);
  if (px >= LABEL_W) {
    g.strokeStyle = "#ff5d73"; g.fillStyle = "#ff5d73";
    g.beginPath(); g.moveTo(px + 0.5, RULER_H - 6); g.lineTo(px + 0.5, H); g.stroke();
    g.beginPath(); g.moveTo(px - 5, RULER_H - 12); g.lineTo(px + 5, RULER_H - 12); g.lineTo(px + 5, RULER_H - 6); g.lineTo(px, RULER_H); g.lineTo(px - 5, RULER_H - 6); g.closePath(); g.fill();
  }
}

function drawCurves(g, W, H, picked) {
  const say = (text) => { g.fillStyle = "#6f6f80"; g.fillText(text, LABEL_W + 14, TOP + 22); };
  ed.ease = [];
  ed.dots = [];
  g.fillStyle = "#0e0e12";
  g.fillRect(0, RULER_H, LABEL_W, H - RULER_H);
  if (!picked) return say("Select a bone to see its curves.");
  const keys = layer().tracks[picked]?.[ed.curveCh];
  const names = { r: "Rotation °", t: "Position", s: "Scale" };
  ["X", "Y", "Z"].forEach((axis, i) => { g.fillStyle = AXIS[i]; g.fillText(`${names[ed.curveCh]} ${axis}`, 12, TOP + 18 + i * 17); });
  g.fillStyle = "#6f6f80";
  g.fillText("Ease", 12, H - EASE_H / 2);
  if (!keys?.length) return say(`No ${names[ed.curveCh].toLowerCase().replace(" °", "")} keys on this bone yet.`);
  const top = TOP + 10, bottom = H - EASE_H - 10;
  const samples = sampleCurves(keys, W);
  let lo = Infinity, hi = -Infinity;
  samples.forEach((s) => s.v.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
  if (hi - lo < 1e-4) { lo -= 1; hi += 1; }
  const yOf = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  g.fillStyle = "#6f6f80";
  g.fillText(hi.toFixed(ed.curveCh === "r" ? 0 : 2), LABEL_W + 6, top);
  g.fillText(lo.toFixed(ed.curveCh === "r" ? 0 : 2), LABEL_W + 6, bottom);
  g.lineWidth = 1.5;
  for (let axis = 0; axis < 3; axis += 1) {
    g.strokeStyle = AXIS[axis];
    g.beginPath();
    samples.forEach((s, i) => (i ? g.lineTo(s.x, yOf(s.v[axis])) : g.moveTo(s.x, yOf(s.v[axis]))));
    g.stroke();
  }
  g.lineWidth = 1;
  // keys: a dot on each curve
  for (const k of keys) {
    const chosen = ed.keys.has(keyId(picked, k.f));
    const x = xOf(k.f + (chosen && ed.drag?.type === "move" ? ed.drag.df : 0));
    if (x < LABEL_W || x > W) continue;
    const at = samples[clamp(Math.round((xOf(k.f) - LABEL_W) / 2), 0, samples.length - 1)];
    g.strokeStyle = chosen ? "rgba(255,176,32,.5)" : "rgba(255,255,255,.1)";
    g.beginPath(); g.moveTo(x + 0.5, top - 4); g.lineTo(x + 0.5, bottom + 4); g.stroke();
    at.v.forEach((v, axis) => { g.fillStyle = chosen ? "#ffb020" : AXIS[axis]; g.beginPath(); g.arc(x, yOf(v), 3.5, 0, Math.PI * 2); g.fill(); });
    ed.dots.push({ x: xOf(k.f), f: k.f });
  }
  // the ease lane: how fast each stretch between two keys is travelled, with a handle at each end
  const yB = H - 8, yT = H - EASE_H + 6;
  g.strokeStyle = "rgba(255,255,255,.06)";
  g.beginPath(); g.moveTo(LABEL_W, H - EASE_H + 0.5); g.lineTo(W, H - EASE_H + 0.5); g.stroke();
  for (let i = 0; i + 1 < keys.length; i += 1) {
    const a = keys[i], b = keys[i + 1], xa = xOf(a.f), xb = xOf(b.f);
    if (xb < LABEL_W || xa > W) continue;
    g.strokeStyle = "#c9cbd6";
    g.beginPath();
    if (a.i === "step") { g.moveTo(xa, yB); g.lineTo(xb, yB); g.lineTo(xb, yT); } else for (let n = 0; n <= 24; n += 1) { const u = n / 24, y = yB - easeTime(u, a.i === "linear" && !a.eo && !b.ei ? 0 : a.eo || 0, b.ei || 0) * (yB - yT); if (n) g.lineTo(xa + u * (xb - xa), y); else g.moveTo(xa, y); }
    g.stroke();
    if (a.i === "step" || xb - xa < 24) continue;
    const out = { x: xa + (a.eo || 0) * (xb - xa), y: yB, key: a, prop: "eo", xa, xb }, inn = { x: xb - (b.ei || 0) * (xb - xa), y: yT, key: b, prop: "ei", xa, xb };
    for (const h of [out, inn]) {
      g.strokeStyle = "rgba(157,140,255,.6)";
      g.beginPath(); g.moveTo(h.prop === "eo" ? xa : xb, h.y); g.lineTo(h.x, h.y); g.stroke();
      g.fillStyle = "#9d8cff";
      g.beginPath(); g.arc(h.x, h.y, 4.5, 0, Math.PI * 2); g.fill();
      ed.ease.push(h);
    }
  }
}

function hitKey(x, y) {
  if (ed.mode === "curves") {
    const picked = curveBone();
    const dot = y < $("#moCanvas").clientHeight - EASE_H && (ed.dots || []).find((d) => Math.abs(d.x - x) <= 6);
    return dot ? [keyId(picked, dot.f)] : null;
  }
  const rows = rowsNow();
  const row = rows[Math.floor((y - TOP + ed.view.scroll) / ROW_H)];
  if (!row) return null;
  const f = framesOf(row.key).find((v) => Math.abs(xOf(v) - x) <= 6);
  if (f === undefined) return null;
  return row.key === "*" ? Object.keys(layer().tracks).filter((bone) => framesOf(bone).includes(f)).map((bone) => keyId(bone, f)) : [keyId(row.key, f)];
}

const spot = (event) => { const r = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };

function onDown(event) {
  if (!ed || event.button !== 0) return;
  const { x, y } = spot(event);
  event.currentTarget.setPointerCapture(event.pointerId);
  if (y < RULER_H && x >= LABEL_W) {
    const which = ed.doc.range.findIndex((f) => Math.abs(xOf(f) - x) <= 7 && y < 18);
    if (which >= 0) { ed.drag = { type: "range", which, before: JSON.stringify(ed.doc), moved: false }; return; }
    ed.drag = { type: "scrub" };
    if (ed.playing) togglePlay();
    return setFrame(fAt(x));
  }
  if (x < LABEL_W && y < RULER_H) return openPop({ type: "layers" });
  if (y < TOP && x >= LABEL_W) {
    const marker = hitMarker(x);
    if (marker) ed.drag = { type: "marker", marker, before: JSON.stringify(ed.doc), moved: false };
    return;
  }
  if (x < LABEL_W) {
    const row = ed.mode === "dope" && rowsNow()[Math.floor((y - TOP + ed.view.scroll) / ROW_H)];
    if (row && row.key !== "*") ed.rig.select({ type: "bone", key: row.key });
    return;
  }
  const handle = ed.mode === "curves" && (ed.ease || []).find((h) => Math.hypot(h.x - x, h.y - y) <= 8);
  if (handle) { ed.drag = { type: "ease", handle, before: JSON.stringify(ed.doc), moved: false }; return; }
  const ids = hitKey(x, y);
  if (ids) {
    const all = ids.every((id) => ed.keys.has(id));
    if (event.shiftKey) ids.forEach((id) => (all ? ed.keys.delete(id) : ed.keys.add(id)));
    else if (!all) ed.keys = new Set(ids);
    ed.drag = { type: "move", start: fAt(x), df: 0 };
  } else ed.drag = { type: "box", x0: x, y0: y, x1: x, y1: y, add: event.shiftKey };
  syncBar();
  drawTimeline();
}

function onMove(event) {
  const drag = ed?.drag;
  if (!drag) return;
  const { x, y } = spot(event);
  if (drag.type === "scrub") return setFrame(fAt(x));
  if (drag.type === "range") {
    const f = clamp(Math.round(fAt(x)), 0, ed.doc.frames);
    ed.doc.range[drag.which] = drag.which ? Math.max(f, ed.doc.range[0] + 1) : Math.min(f, ed.doc.range[1] - 1);
    drag.moved = true;
  } else if (drag.type === "ease") {
    const h = drag.handle, u = clamp((x - h.xa) / (h.xb - h.xa), 0, 1);
    h.key[h.prop] = Math.round(clamp(h.prop === "eo" ? u : 1 - u, 0, 0.95) * 100) / 100;
    drag.moved = true;
  } else if (drag.type === "marker") {
    const f = clamp(Math.round(fAt(x)), 0, ed.doc.frames);
    if (f !== drag.marker.f) { drag.marker.f = f; drag.moved = true; }
  } else if (drag.type === "move") drag.df = Math.round(fAt(x) - drag.start);
  else { drag.x1 = x; drag.y1 = y; }
  drawTimeline();
}

function onUp(event) {
  const drag = ed?.drag;
  if (!drag) return;
  ed.drag = null;
  const { x } = spot(event);
  if ((drag.type === "range" || drag.type === "ease" || drag.type === "marker") && drag.moved) {
    ed.undo.push(drag.before);
    ed.redo.length = 0;
    ed.doc.markers.sort((p, q) => p.f - q.f);
    touched();
  } else if (drag.type === "marker") { ed.pop = { type: "marker", marker: drag.marker }; paintPop(); } else if (drag.type === "move" && drag.df) mutate(() => shiftKeys(drag.df));
  else if (drag.type === "box") {
    const wide = Math.abs(drag.x1 - drag.x0) > 4 || Math.abs(drag.y1 - drag.y0) > 4;
    if (!drag.add) ed.keys.clear();
    if (wide && ed.mode === "dope") {
      const [xa, xb] = [drag.x0, drag.x1].sort((p, q) => p - q), [ya, yb] = [drag.y0, drag.y1].sort((p, q) => p - q);
      rowsNow().forEach((row, i) => {
        const cy = TOP + i * ROW_H - ed.view.scroll + ROW_H / 2;
        if (row.key === "*" || cy < ya || cy > yb) return;
        framesOf(row.key).forEach((f) => { if (xOf(f) >= xa && xOf(f) <= xb) ed.keys.add(keyId(row.key, f)); });
      });
    } else if (!wide) { if (ed.playing) togglePlay(); setFrame(fAt(x)); }
  }
  syncBar();
  drawTimeline();
}

function onWheel(event) {
  if (!ed) return;
  event.preventDefault();
  const { x } = spot(event);
  if (event.ctrlKey || event.metaKey) {
    const f = fAt(x);
    ed.view.ppf = clamp(ed.view.ppf * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 0.3, 80);
    ed.view.x0 = f - (x - LABEL_W) / ed.view.ppf;
  } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    ed.view.x0 += (event.deltaX || event.deltaY) / ed.view.ppf;
  } else {
    const rows = ed.mode === "dope" ? rowsNow().length : 0;
    ed.view.scroll = clamp(ed.view.scroll + event.deltaY, 0, Math.max(0, rows * ROW_H - (event.currentTarget.clientHeight - TOP) + 8));
  }
  ed.view.x0 = Math.max(ed.view.x0, -40 / ed.view.ppf);
  drawTimeline();
}
