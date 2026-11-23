// Node Studio: a page of its own for workflows made of steps and wires. Home is a sentence box, ready-made workflows
// and your own; the editor (flows-editor.js) is the canvas. What a step is comes from the server (forge/flow_nodes.py),
// so this page knows how to draw steps, not which ones there are.
import * as editor from "./flows-editor.js";

let ctx = null;   // helpers handed over by app.js: api, fileUrl, thumbUrl, esc, toast, state, renderView, humanize, ask, go, settingsDialog
let home = null;  // { catalogue, flows, sections, running }
let typed = "";   // the sentence box, kept while the page redraws
let drafting = false;

const PATHS = {
  idea: `<path d="M9 18h6M10 21h4M12 3a6.5 6.5 0 0 0-3.8 11.8c.6.5.8 1 .8 1.7v.5h6v-.5c0-.7.2-1.2.8-1.7A6.5 6.5 0 0 0 12 3z"/>`,
  list: `<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>`,
  upload: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>`,
  cube: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>`,
  palette: `<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.5 0 2-1 1.6-2.1-.5-1.4.3-2.6 1.8-2.6h2a3.1 3.1 0 0 0 3.1-3.2c-.2-5-4-9.1-8.5-9.1z"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7.6" r="1"/><circle cx="16" cy="10" r="1"/>`,
  fork: `<path d="M4 12h5M9 12c4 0 3-6.5 7-6.5h4M9 12h11M9 12c4 0 3 6.5 7 6.5h4"/>`,
  sparkle: `<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>`,
  grid: `<path d="M8 4h8v4h4v8h-4v4H8v-4H4V8h4z"/><path d="M8 8h8v8H8z"/>`,
  star: `<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>`,
  edit: `<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>`,
  turn: `<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>`,
  scissors: `<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18M8 16.5 20 6"/>`,
  drop: `<path d="M12 3.5s6 6.4 6 10.6a6 6 0 0 1-12 0c0-4.2 6-10.6 6-10.6z"/><path d="M9.2 14.5a2.9 2.9 0 0 0 2.6 2.7"/>`,
  icons: `<rect x="3.5" y="3.5" width="10" height="10" rx="2"/><rect x="15.5" y="8.5" width="5" height="5" rx="1.2"/><rect x="8.5" y="15.5" width="5" height="5" rx="1.2"/><rect x="15.5" y="15.5" width="3" height="3" rx=".8"/>`,
  cut: `<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.4"/><circle cx="8.8" cy="9" r="2.2"/><path d="m13.5 11 3-4.5 2.2 4.5z"/><rect x="7" y="14" width="4" height="4" rx=".8"/><circle cx="16" cy="16" r="2"/>`,
  material: `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M4 15h16M9.5 4v5.5M15 9.5V15M9 15v5"/>`,
  bones: `<circle cx="12" cy="4.5" r="2"/><path d="M12 6.5v7M12 13.5l-4 6.5M12 13.5l4 6.5M6 10.5h12"/>`,
  film: `<circle cx="14.5" cy="4.5" r="1.8"/><path d="M13.5 8 9 10.5 7 14M13.5 8l2.5 4 4 1M13.5 8 11 14l4 3v4M11 14l-2 3.5-4 1"/>`,
  sound: `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>`,
  save: `<path d="M4 13.5 6.5 5h11l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M4 13.5h4.5l1.2 2.5h4.6l1.2-2.5H20"/><path d="m9.5 9 2 2 3.5-4"/>`,
  note: `<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M8.5 8.5h7M8.5 12h4"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  back: `<path d="M15 5l-7 7 7 7"/>`,
  undo: `<path d="M8 6 3 11l5 5M3 11h11a5 5 0 0 1 0 10h-4"/>`,
  redo: `<path d="m16 6 5 5-5 5M21 11H10a5 5 0 0 0 0 10h4"/>`,
  fit: `<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>`,
  tidy: `<rect x="3.5" y="4" width="6" height="6" rx="1.4"/><rect x="14.5" y="4" width="6" height="6" rx="1.4"/><rect x="14.5" y="14" width="6" height="6" rx="1.4"/><path d="M9.5 7h5M12 7v10h2.5"/>`,
  play: `<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>`,
  stop: `<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>`,
  more: `<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>`,
  help: `<path d="M9 9.2a3 3 0 1 1 4.3 2.7c-.9.5-1.3 1-1.3 2.1"/><circle cx="12" cy="17.4" r=".6" fill="currentColor"/>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7.5"/>`,
  down: `<path d="m6 9 6 6 6-6"/>`,
  zoom: `<circle cx="11" cy="11" r="6"/><path d="m20 20-4.6-4.6"/>`,
  trash: `<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>`,
  copy: `<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>`,
  again: `<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>`,
  arrow: `<path d="M4 12h15M13 6l6 6-6 6"/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>`,
  canvas: `<rect x="3" y="8" width="7" height="8" rx="1.6"/><rect x="14" y="4" width="7" height="6" rx="1.6"/><rect x="14" y="14" width="7" height="6" rx="1.6"/><path d="M10 12h2M14 7h-2v10h2"/>`,
  steps: `<rect x="5" y="3.5" width="14" height="5" rx="1.4"/><rect x="5" y="15.5" width="14" height="5" rx="1.4"/><path d="M12 8.5v7M9.8 13.2 12 15.5l2.2-2.3"/>`,
  close: `<path d="m6 6 12 12M18 6 6 18"/>`,
};
export const ic = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || PATHS.sparkle}</svg>`;

// ---------- entry points for app.js ----------

const lastKey = () => `tessera.flow.${ctx.state.project}`;
const remember = (id) => { try { id ? localStorage.setItem(lastKey(), id) : localStorage.removeItem(lastKey()); } catch { /* private window */ } };

export async function render(context) {
  ctx = context;
  const s = ctx.state;
  if (s.flowSel === undefined) { try { s.flowSel = localStorage.getItem(lastKey()); } catch { s.flowSel = null; } }
  if (s.flowSel && editor.isOpen(s.flowSel)) return editor.refresh();  // a workspace change must not reload the editor
  editor.leave();
  if (!s.flowSel) return renderHome();
  const id = s.flowSel;
  try {
    const [data, fresh] = await Promise.all([ctx.api(`/api/flows?id=${encodeURIComponent(id)}`), ctx.api("/api/flows/home")]);
    if (s.view.type !== "nodes" || s.flowSel !== id) return;
    home = fresh;
    remember(id);
    editor.open(ctx, { id, ...data, catalogue: home.catalogue, sections: home.sections });
  } catch (err) {
    if (s.flowSel !== id) return;
    remember(null);
    s.flowSel = null;
    if (err.message) ctx.toast(err.message, true);
    return renderHome();
  }
}

export function leave() { editor.leave(); }
export const title = () => editor.title();
export const current = () => editor.current();

// A step of a running workflow finished something, or the run ended. The run goes on when you leave the page.
export function onRun(msg) {
  if (editor.onRun(msg) || !msg.ended) return;
  const open = { label: "Open", run: () => show(msg.flow) };
  if (msg.ended === "done") ctx?.toast(`${msg.name} is done`, false, open);
  else if (msg.ended === "choose") ctx?.toast(`${msg.name} is waiting for you to choose`, false, open);
  else if (msg.ended === "failed") ctx?.toast(`${msg.name}: a step needs another try`, true, open);
  if (ctx?.state.view.type === "nodes" && !ctx.state.flowSel) renderHome();
}

function show(id) {
  ctx.state.flowSel = id;
  if (ctx.state.view.type === "nodes") ctx.renderView(); else ctx.go({ type: "nodes" });
}

// ---------- home ----------

const EXAMPLES = ["An animated 3D knight", "Icons: sword, shield, potion, key", "Turn my drawing into a 3D model", "A pixel art slime with a crown", "Sounds: door creak, coin, footstep", "Seamless mossy stone texture"];

// A workflow at a glance: its steps as coloured tiles on one thread.
function thread(types) {
  const nodes = home.catalogue.nodes;
  const shown = types.length > 7 ? [...types.slice(0, 6), "…"] : types;
  return `<span class="fl-thread">${shown.map((t) => (t === "…" ? `<i class="dots">+${types.length - 6}</i>` : `<i data-t="${nodes[t].out || "none"}" title="${ctx.esc(nodes[t].label)}">${ic(nodes[t].icon)}</i>`)).join("<b></b>")}</span>`;
}

function ago(seconds) {
  const s = Date.now() / 1000 - seconds;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

async function renderHome() {
  const content = document.getElementById("content");
  content.classList.remove("fl-full");
  remember(null);
  try { home = await ctx.api("/api/flows/home"); } catch (err) {
    content.innerHTML = `<div class="empty"><img class="tess-art" src="ui/art/tess-error.webp" alt="" aria-hidden="true" draggable="false"><h1>Node Studio</h1><p>${ctx.esc(err.message)}</p></div>`;
    return;
  }
  if (ctx.state.view.type !== "nodes" || ctx.state.flowSel) return;
  if (document.activeElement?.id === "flAsk" && document.getElementById("flHome")) return paintMine();  // never under the typist's hands
  const { esc } = ctx;
  content.innerHTML = `<div class="fl-home" id="flHome">
    <section class="fl-hero">
      <svg class="fl-hero-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${[[10, "text"], [30, "picture"], [50, "model"], [70, "clip"], [90, "sound"]].map(([y, t]) => `<path data-t="${t}" d="M0 50 C 45 50, 45 ${y}, 100 ${y}"/>`).join("")}
      </svg>
      <div class="fl-hero-ends" aria-hidden="true">${[["list", "text"], ["sparkle", "picture"], ["cube", "model"], ["film", "clip"], ["sound", "sound"]].map(([i, t]) => `<i data-t="${t}">${ic(i)}</i>`).join("")}</div>
      <div class="fl-hero-in">
        <span class="fl-eyebrow">${ic("canvas")} Node Studio</span>
        <h1>What do you<br>want to make?</h1>
        <form class="fl-ask" id="flAskForm">
          <textarea id="flAsk" rows="2" placeholder="An animated 3D knight that walks and attacks" aria-label="What do you want to make?">${esc(typed)}</textarea>
          <button class="fl-go" type="submit"${drafting ? " disabled" : ""}>${drafting ? `<span class="spinner"></span> Building…` : `Build it ${ic("arrow")}`}</button>
        </form>
        <div class="fl-examples">${EXAMPLES.map((e) => `<button type="button" data-fl-example="${esc(e)}">${esc(e)}</button>`).join("")}</div>
        <p class="fl-hero-note">Say it in your own words and the steps are laid out for you. Nothing is made until you press Run.</p>
      </div>
    </section>
    <div id="flMine"></div>
    <h2 class="fl-h2">Ready-made</h2>
    <div class="fl-templates">
      ${home.catalogue.templates.map((t) => `<button type="button" class="fl-template" data-fl-template="${t.id}">
        ${thread(t.steps)}<strong>${esc(t.title)}</strong><span>${esc(t.blurb)}</span>${t.free ? `<em>Free</em>` : ""}</button>`).join("")}
      <button type="button" class="fl-template blank" data-fl-blank><span class="fl-thread"><i data-t="none">${ic("plus")}</i></span><strong>Empty canvas</strong><span>Add your own steps, one by one.</span></button>
    </div></div>`;
  paintMine();
  const root = document.getElementById("flHome");
  root.addEventListener("click", onHomeClick);
  const box = document.getElementById("flAsk");
  box.addEventListener("input", () => { typed = box.value; });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); build(); } });
  document.getElementById("flAskForm").addEventListener("submit", (e) => { e.preventDefault(); build(); });
  if (!matchMedia("(pointer: coarse)").matches) box.focus({ preventScroll: true });
}

function paintMine() {
  const host = document.getElementById("flMine");
  if (!host) return;
  const { esc } = ctx;
  host.innerHTML = home.flows.length ? `<h2 class="fl-h2">Your workflows</h2><div class="fl-mine">${home.flows.map((f) => `
    <article class="fl-flow" data-fl-open="${esc(f.id)}" tabindex="0" role="button" aria-label="Open ${esc(f.name)}">
      <div class="fl-flow-pics n${f.thumbs.length}">${f.thumbs.length ? f.thumbs.map((t) => `<img src="${esc(ctx.thumbUrl(t, 320))}" alt="" loading="lazy">`).join("") : thread(f.steps)}</div>
      <div class="fl-flow-text"><strong>${esc(f.name)}</strong><small>${home.running.includes(f.id) ? `<span class="fl-live">Running…</span>` : `${f.steps.length} step${f.steps.length === 1 ? "" : "s"} · ${ago(f.updated)}`}</small></div>
      <span class="fl-flow-acts"><button type="button" data-fl-copy="${esc(f.id)}" title="Make a copy" aria-label="Make a copy">${ic("copy")}</button><button type="button" data-fl-del="${esc(f.id)}" title="Delete" aria-label="Delete">${ic("trash")}</button></span>
    </article>`).join("")}</div>` : "";
  host.querySelectorAll("[data-fl-open]").forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === el) show(el.dataset.flOpen); }));
}

async function create(body) {
  const doc = await ctx.api("/api/flows/create", { method: "POST", body });
  show(doc.id);
}

async function build() {
  const text = typed.trim();
  if (drafting) return;
  if (!text) return document.getElementById("flAsk")?.focus();
  drafting = true;
  const button = document.querySelector(".fl-go");
  if (button) { button.disabled = true; button.innerHTML = `<span class="spinner"></span> Building…`; }
  try {
    const { doc } = await ctx.api("/api/flows/draft", { method: "POST", body: { text } });
    typed = "";
    drafting = false;
    await create({ doc });
  } catch (err) {
    drafting = false;
    ctx.toast(err.message, true);
    if (button) { button.disabled = false; button.innerHTML = `Build it ${ic("arrow")}`; }
  }
}

async function onHomeClick(event) {
  const t = event.target.closest("[data-fl-example],[data-fl-template],[data-fl-blank],[data-fl-copy],[data-fl-del],[data-fl-open]");
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.flExample !== undefined) {
      const box = document.getElementById("flAsk");
      box.value = typed = d.flExample;
      return box.focus();
    }
    if (d.flTemplate) return await create({ template: d.flTemplate });
    if (d.flBlank !== undefined) return await create({ doc: { name: "My workflow" } });
    if (d.flCopy) { event.stopPropagation(); await ctx.api("/api/flows/duplicate", { method: "POST", body: { id: d.flCopy } }); return renderHome(); }
    if (d.flDel) {
      event.stopPropagation();
      const flow = home.flows.find((f) => f.id === d.flDel);
      const { trashed } = await ctx.api("/api/flows/delete", { method: "POST", body: { id: d.flDel } });
      await renderHome();
      return ctx.toast(`${flow?.name || "Workflow"} deleted. Saved assets stay.`, false, { label: "Undo", run: async () => {
        try { await ctx.api("/api/flows/restore", { method: "POST", body: { id: d.flDel, trashed } }); if (ctx.state.view.type === "nodes" && !ctx.state.flowSel) renderHome(); } catch (err) { ctx.toast(err.message, true); }
      } });
    }
    if (d.flOpen) show(d.flOpen);
  } catch (err) { ctx.toast(err.message, true); }
}
