// Tessera Studio: the project's pages in an editor frame (tree, page, inspector, bottom panel), and Tess's chat.
// The overview is built from whatever folders the project has; nothing here knows folder names.
import { initDrops, dropFiles } from "./drops.js";
import { ask } from "./ask.js";
import * as shell from "./shell.js";   // relative, so the website's demo copy (served from a sub-folder) finds it too

const $ = (sel) => document.querySelector(sel);
// Tessera's native window (forge/native_window.py) sends new windows to the browser. WebView2 has chrome.webview from
// the start; pywebview adds its own object once the page loads (and is the only sign on macOS).
const nativeWindow = () => Boolean(window.chrome?.webview || window.pywebview);
const state = {
  project: "",
  projects: [],
  sessions: [],
  sessionId: "",
  session: null,
  sending: false,
  attachments: [],
  models: [],
  model: "",
  effort: "medium",
  connect: null, // the game folder this project is linked to
  overview: null,
  jobs: {},
  preview: null,
  trail: [], // views visited before the current one, for the Back button
  view: { type: "home" }, // {type:"home"} | {type:"vault"} | {type:"folder", path} | {type:"doc", path, editing}
};

let motionLoaded = null; // motion.js once Motion Studio has been opened; it owns the editor on screen
let flowsLoaded = null;  // flows.js, the same for Node Studio

// ---------- helpers ----------

async function api(path, options = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = path.startsWith("/api/projects") || path.startsWith("/api/config") || path.startsWith("/api/agent/models")
    ? path
    : `${path}${sep}project=${encodeURIComponent(state.project)}`;
  const init = { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A structured answer (like the This PC "needs PyTorch first" 409) keeps its details on the error.
    const detail = data.detail;
    const err = new Error((typeof detail === "string" ? detail : detail?.message) || `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return data;
}

// Pages draw at once from what they showed last time, then ask the server again and draw once more only if the
// answer changed. Hovering a link or tile fetches its page ahead (prefetchPath), so a first visit is instant too.
const pageData = new Map();
function pageApi(path, { redraw = true } = {}) {
  const key = `${state.project}|${path}`;
  const view = state.view;
  const fresh = api(path).then((data) => {
    const text = JSON.stringify(data);
    const old = pageData.get(key);
    pageData.set(key, { data, text });
    if (pageData.size > 400) pageData.delete(pageData.keys().next().value);  // the oldest page goes first
    if (redraw && old && old.text !== text && state.view === view && !view.editing) renderView();
    return data;
  });
  const hit = pageData.get(key);
  if (!hit) return fresh;
  fresh.catch(() => {  // gone or broken now (deleted, moved): draw again without it, which shows the real answer
    pageData.delete(key);
    if (redraw && state.view === view && !view.editing) renderView();
  });
  return Promise.resolve(hit.data);
}

function prefetchPath(path) {
  if (!path || !state.project) return;
  const q = encodeURIComponent(path);
  if (/\.md$/i.test(path)) {
    if (/(^|\/)README\.md$/i.test(path)) return prefetchPath(dirOf(path));
    for (const p of [`/api/overview/file?path=${q}`, `/api/studio/asset?path=${q}`]) if (!pageData.has(`${state.project}|${p}`)) pageApi(p, { redraw: false }).catch(() => {});
  } else if (!/\.[a-z0-9]+$/i.test(path)) {
    const section = `/api/overview/section?path=${encodeURIComponent(path.split("/")[0])}`;  // a folder is shown on its section's page
    if (!pageData.has(`${state.project}|${section}`)) pageApi(section, { redraw: false }).catch(() => {});
  }
}

let prefetchTimer = 0;
document.addEventListener("pointerover", (event) => {
  const el = event.target.closest?.("[data-open],[data-folder],[data-levels]");
  clearTimeout(prefetchTimer);
  if (!el) return;
  prefetchTimer = setTimeout(() => {
    if (el.dataset.open !== undefined) prefetchPath(el.dataset.open);
    else if (el.dataset.folder !== undefined) prefetchPath(el.dataset.folder);
    else if (el.dataset.levels !== undefined && !pageData.has(`${state.project}|/api/studio/levels`)) pageApi("/api/studio/levels", { redraw: false }).catch(() => {});
  }, 60);  // a pointer passing over on its way somewhere else doesn't fetch
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fileUrl(rel) {
  const parts = String(rel).split("/").map(encodeURIComponent).join("/");
  return `${new URL("projects/", document.baseURI).pathname}${encodeURIComponent(state.project)}/workspace/${parts}`;
}

// A small copy for grids and strips (the server makes and caches it), so a page of tiles doesn't pull 3 MB originals.
// The lightbox and downloads keep fileUrl, the full image.
function thumbUrl(rel, width = 320) {
  return /\.(png|jpe?g|webp)$/i.test(String(rel)) ? `${fileUrl(rel)}?w=${width}` : fileUrl(rel);
}

function dirOf(rel) {
  const i = String(rel || "").lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function joinPath(base, rel) {
  const out = base ? base.split("/") : [];
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function humanize(name) {
  const stem = String(name).replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]+/, "").replace(/[_-]+/g, " ").trim();
  return stem ? stem[0].toUpperCase() + stem.slice(1) : name;
}

let toastTimer;
// `action` adds one button to the toast, e.g. { label: "Undo", run() {…} }, and keeps it up a little longer.
function toast(message, isError = false, action = null) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}${action ? " has-action" : ""}`;
  if (action) {
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "toast-act", textContent: action.label });
    btn.addEventListener("click", () => { el.hidden = true; action.run(); }, { once: true });
    el.append(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3500);
}

function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

// ---------- markdown ----------

function inline(text, baseDir) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => `<img alt="${alt}" src="${resolveSrc(src, baseDir)}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (/^(https?:|mailto:)/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    if (href.startsWith("#")) return label;
    return `<a href="#" data-open="${esc(joinPath(baseDir, decodeURIComponent(href)))}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>");
  return s;
}

function resolveSrc(src, baseDir) {
  const raw = src.replace(/&amp;/g, "&");
  if (/^(https?:|data:)/i.test(raw)) return esc(raw);
  return esc(fileUrl(joinPath(baseDir, decodeURIComponent(raw))));
}

const LABEL_RE = /^\*\*([^*]{1,40}?):?\*\*:?\s+(.+)$/;

function kvRow(match, baseDir) {
  return `<div class="kv-row"><span class="kv-k">${inline(match[1], baseDir)}</span><span class="kv-v">${inline(match[2], baseDir)}</span></div>`;
}

// "On this page" links for documents with several sections.
function withToc(html) {
  const heads = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)];
  if (heads.length < 3) return `<div class="md">${html}</div>`;
  return `<div class="doc-layout"><div class="md">${html}</div><nav class="toc"><span>On this page</span>${heads.map((m) => `<a href="#" data-toc="${m[1]}">${m[2].replace(/<[^>]+>/g, "")}</a>`).join("")}</nav></div>`;
}

function renderMarkdown(md, baseDir = "") {
  const text = String(md || "").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = text.split("\n");
  const html = [];
  let i = 0;
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*<!--.*-->\s*$/.test(line)) { i++; continue; }
    const fence = line.match(/^```/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      const id = n <= 3 ? ` id="h-${h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}"` : "";
      html.push(`<h${n}${id}>${inline(h[2], baseDir)}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { html.push("<hr>"); i++; continue; }
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote>${renderMarkdown(buf.join("\n"), baseDir)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, baseDir)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, baseDir)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) { items.push({ depth: m[1].length, text: m[3] }); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      // "- **Label:** text" lists read better as a label/value block.
      const labelled = items.map((it) => it.text.match(LABEL_RE));
      if (!ordered && items.length > 1 && labelled.every(Boolean)) {
        html.push(`<div class="kv">${labelled.map((m) => kvRow(m, baseDir)).join("")}</div>`);
        continue;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((it) => {
        const box = it.text.match(/^\[([ xX])\]\s+(.*)$/);
        const body = box ? `<input type="checkbox" disabled ${box[1] !== " " ? "checked" : ""}>${inline(box[2], baseDir)}` : inline(it.text, baseDir);
        return `<li${it.depth >= 2 ? ' style="margin-left:1.2em"' : ""}>${body}</li>`;
      }).join("")}</${tag}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    const label = buf.length === 1 && buf[0].match(LABEL_RE);
    if (label) {
      // Consecutive "**Label:** text" paragraphs join into one block.
      const prev = html[html.length - 1];
      if (prev?.startsWith('<div class="kv">')) html[html.length - 1] = prev.replace(/<\/div>$/, `${kvRow(label, baseDir)}</div>`);
      else html.push(`<div class="kv">${kvRow(label, baseDir)}</div>`);
      continue;
    }
    html.push(`<p>${inline(buf.join(" "), baseDir)}</p>`);
  }
  return html.join("\n");
}

// Front pages repeat their title and pitch in the hero; drop those from the body.
function stripLead(md) {
  const body = String(md || "").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i] && /^#\s/.test(lines[i])) i++;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i] && !/^(#|>|\||-|\*|!|```|<|\d+\.)/.test(lines[i].trim())) {
    while (i < lines.length && lines[i].trim()) i++;
  }
  return lines.slice(i).join("\n");
}

// ---------- projects ----------

async function loadProjects(preferred) {
  const data = await api("/api/projects");
  state.projects = data.projects || [];
  // `?project=` comes from a coding agent opening Tessera on the project it works on; read it once.
  const url = new URL(location.href);
  const linked = url.searchParams.get("project");
  if (linked) { url.searchParams.delete("project"); history.replaceState(null, "", url); }
  const remembered = preferred || linked || storeGet("forge.project") || data.default_project;
  state.project = state.projects.includes(remembered) ? remembered : (state.projects[0] || "default");
  $("#projectName").textContent = humanize(state.project);
  storeSet("forge.project", state.project);
}

// ---------- projects page ----------

const projectFileUrl = (project, rel) => `${new URL("projects/", document.baseURI).pathname}${encodeURIComponent(project)}/workspace/${String(rel).split("/").map(encodeURIComponent).join("/")}`;

function timeAgo(seconds) {
  if (!seconds) return "Empty";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "Just now";
  const steps = [[3600, 60, "minute"], [86400, 3600, "hour"], [86400 * 30, 86400, "day"], [86400 * 365, 86400 * 30, "month"]];
  for (const [limit, unit, word] of steps) if (diff < limit) { const n = Math.floor(diff / unit); return `${n} ${word}${n === 1 ? "" : "s"} ago`; }
  return `${Math.floor(diff / (86400 * 365))} years ago`;
}

async function openProjects() {
  showScene($("#projectsView"));
  $("#closeProjectsBtn").hidden = !state.project;
  $("#projectGrid").innerHTML = `<div class="pv-loading">Loading projects…</div>`;
  try { state.cards = (await api("/api/projects/cards")).projects; } catch (err) { toast(err.message, true); state.cards = []; }
  renderProjectGrid();
  api("/api/storage").then((info) => {
    const where = `Projects are saved in <code>${esc(info.projects_dir)}</code> <button class="link-btn" data-st-open="projects">Open folder</button> · <button class="link-btn" data-st-move>Change</button>`;
    $("#projectsFoot").innerHTML = where;
    // Also under the title, where it is seen: two Tessera windows can read different folders, and this says which one this is.
    const head = $("#projectsWhere") || $("#projectGrid").insertAdjacentElement("beforebegin", Object.assign(document.createElement("p"), { id: "projectsWhere", className: "pv-where" }));
    if (head) head.innerHTML = `Showing <code>${esc(info.projects_dir)}</code>`;
  }).catch(() => {});
}

function closeProjects() { hideScene($("#projectsView")); }

// ---------- full-screen scenes ----------
// Projects, settings, setup, new project and import each cover the app. Going from one to the next
// cross-fades: the old scene stays up under the new one until it has faded in, so the app never shows
// through. A scene is only taken down after a short buffer, in case the next one opens right after.
const SCENE_BUFFER = 140;
const SCENE_FADE = 520;
const sceneCovers = () => [...document.querySelectorAll("#projectsView, #settingsView, .onboard")];

function showScene(el) {
  const behind = sceneCovers().some((s) => s !== el && !s.hidden);
  clearTimeout(el._sceneTimer);
  delete el.dataset.leaving;
  el.classList.remove("scene-out");
  if (!el.hidden) return;
  el.classList.toggle("scene-over", behind);
  el.hidden = false;
  el._sceneTimer = setTimeout(() => el.classList.remove("scene-over"), SCENE_FADE);
}

function hideScene(el) {
  if (el.hidden || el.dataset.leaving) return;
  el.dataset.leaving = "1";
  el._sceneTimer = setTimeout(() => {
    const next = sceneCovers().some((s) => s !== el && !s.hidden && !s.dataset.leaving);
    const done = () => { el.hidden = true; el.classList.remove("scene-out", "scene-over"); delete el.dataset.leaving; };
    if (next) { el._sceneTimer = setTimeout(done, SCENE_FADE); return; } // the next scene fades in over this one
    el.classList.add("scene-out");
    el._sceneTimer = setTimeout(done, 320);
  }, SCENE_BUFFER);
}

function renderProjectGrid() {
  const query = $("#projectSearch").value.trim().toLowerCase();
  const sort = $("#projectSort").value;
  // The empty starter "Default" project is clutter once the user has a real one; it comes back as soon as it has anything.
  const spareDefault = (c) => c.project === "default" && !c.assets && !c.sections && state.project !== "default" && (state.cards || []).length > 1;
  const cards = (state.cards || [])
    .filter((c) => !spareDefault(c))
    .filter((c) => !query || `${c.title} ${c.project} ${c.excerpt}`.toLowerCase().includes(query))
    .sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) : b.updated - a.updated);
  $("#projectGrid").innerHTML = `
    <button class="pcard pcard-new" data-new-project><span>New project</span><i>+</i></button>
    ${cards.map((c) => {
      const imgs = c.images.map((img) => `<img src="${esc(projectFileUrl(c.project, img))}" alt="" loading="lazy">`);
      const initials = c.title.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
      // Two projects with one name: say which folder each is.
      const twin = cards.filter((x) => x.title.toLowerCase() === c.title.toLowerCase()).length > 1;
      return `<div class="pcard${c.project === state.project ? " current" : ""}" data-open-project="${esc(c.project)}" tabindex="0" role="button">
        <div class="pcard-head"><div><strong>${esc(c.title)}</strong>${twin ? `<small class="pcard-folder">${esc(humanize(c.project))}</small>` : ""}<small>${esc(timeAgo(c.updated))}</small>
          <small>${c.sections} section${c.sections === 1 ? "" : "s"} · ${c.assets} asset${c.assets === 1 ? "" : "s"}</small></div>
          <button class="pcard-del" data-st-export="${esc(c.project)}" title="Export workspace as .zip" aria-label="Export ${esc(c.title)} workspace as .zip"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
          ${c.project === "default" ? "" : `<button class="pcard-del" data-delete-project="${esc(c.project)}" title="Delete project" aria-label="Delete ${esc(c.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>`}</div>
        ${c.cover ? `<div class="pcard-art cover"><img src="${esc(projectFileUrl(c.project, c.cover))}" alt="" loading="lazy"></div>`
          : `<div class="pcard-art n${Math.min(imgs.length, 3)}">${imgs.length ? imgs.join("") : `<span class="pcard-initials">${esc(initials || "T")}</span>`}
            ${c.assets ? `<button class="pcard-keyart" data-key-art="${esc(c.project)}" title="Generate a cover image for this project from its pitch">${icon("sparkle")}Make key art</button>` : ""}</div>`}
        ${c.project === state.project ? `<span class="pcard-badge">Open</span>` : ""}
      </div>`;
    }).join("")}
    ${(state.cards || []).some((c) => c.project.startsWith("pocket_kaiju")) || query ? "" : `<button class="pcard pcard-sample" data-install-sample><span class="pcard-sample-art"><img src="ui/sample-cover.jpg" alt=""></span>
      <span class="pcard-sample-text"><strong>Explore a finished project</strong><small>Pocket Kaiju: characters, 3D models and sounds, ready to click through. No credits used.</small></span></button>`}`;
}

function deleteProjectDialog(project) {
  const card = (state.cards || []).find((c) => c.project === project);
  openDialog(`
    <form class="dlg" id="deleteProjectForm">
      <h2>Delete ${esc(card?.title || humanize(project))}?</h2>
      <p>Tessera forgets the project (its entry goes to <code>projects/.trash/</code>). A project that lives in a game folder keeps its files there, in <code>tessera/</code>.</p>
      <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button class="danger">Delete project</button></div>
    </form>`);
  $("#deleteProjectForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/projects/${encodeURIComponent(project)}`, { method: "DELETE" });
      closeDialog();
      toast("Project moved to trash");
      if (project === state.project) {
        storeSet("forge.project", "");
        await loadProjects();
        await switchProject(state.project);
      }
      await openProjects();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- new project onboarding ----------

const GENRES = ["Action", "Arcade", "Action RPG", "Survival horror", "Cozy sim", "Platformer", "Strategy", "Puzzle", "Racing", "Roguelike", "Visual novel", "Shooter"];
const LOOKS = ["Low-poly", "Stylized hand-painted", "Realistic PBR", "Toon / cel-shaded", "Pixel art", "Voxel", "Dark fantasy", "Sci-fi hard-surface"];

// Tess stands on the right of the welcome, setup and new-project screens, in a pose for each step: the old pose
// fades out as the next one slides in. Every pose has Tess on the right and her gesture reaching toward the text.
const TESS_POSES = { hero: "ui/tess-hero.webp", bust: "ui/tess-bust.webp",
  drops: "ui/art/tess-drops.webp", "step-1": "ui/art/tess-step-1.webp", pixel: "ui/art/tess-pixel.webp",
  connect: "ui/art/tess-connect.webp", pick: "ui/art/tess-pick.webp", success: "ui/art/tess-success.webp" };
const OB_POSES = ["hero", "drops", "bust", "step-1", "pixel", "bust"];  // intro, game folder (files land), name, pitch (design list), look, blank
const SETUP_POSES = ["hero", "connect", "pick", "success"];           // welcome, agent (plug in), generators (pick), all set

// Tess beside an empty page, an error or a quiet panel: one shot from forge/ui/art/ (tools/make_tess_art.py).
// "sm" for panels and popovers, "md" for in-page notes; the default is for full empty pages.
const tessArt = (shot, size = "") => `<img class="tess-art${size ? ` ${size}` : ""}" src="ui/art/tess-${shot}.webp" alt="" aria-hidden="true" draggable="false">`;
// Her face in the chat, by mood: thinking while she works, apologetic on an error.
const tessFace = (mood) => (mood ? `/ui/art/face-${mood}.png` : "ui/tess-avatar.png");
new Image().src = "ui/art/tess-offline.webp";  // loaded now: once Tessera is stopped, nothing new can load

function setTess(scene, pose) {
  let cast = scene.querySelector(":scope > .ob-cast");
  if (!cast) {
    cast = Object.assign(document.createElement("div"), { className: "ob-cast" });
    cast.setAttribute("aria-hidden", "true");
    scene.prepend(cast);
    for (const src of Object.values(TESS_POSES)) new Image().src = src;  // warm, so the next step never pops in
  }
  scene.classList.toggle("has-cast", Boolean(pose));
  if (cast.dataset.pose === (pose || "")) return;
  cast.dataset.pose = pose || "";
  for (const old of cast.querySelectorAll("img:not(.out)")) { old.classList.add("out"); setTimeout(() => old.remove(), 700); }
  if (pose) cast.append(Object.assign(document.createElement("img"), { src: TESS_POSES[pose], alt: "", className: `pose-${pose}` }));
}

// `seamless` comes from first-run setup: same backdrop, so it swaps in without a fade and skips the intro.
function startOnboarding(seamless = false) {
  closeProjects();
  state.ob = { step: seamless === true ? 1 : 0, seamless: seamless === true, game: "", home: "", name: "", pitch: "", genres: [], looks: [], dimension: "3D", rules: "" };
  const el = $("#onboarding");
  el.classList.toggle("instant", seamless === true);
  showScene(el);
  el.classList.remove("forging");
  renderOnboarding();
}

function chipGroup(name, options, selected) {
  return `<div class="ob-chips">${options.map((o) => `<button type="button" class="ob-chip${selected.includes(o) ? " on" : ""}" data-ob-chip="${esc(name)}" data-value="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
}

// The game folder, and where Tessera keeps the project: in the game's tessera/ folder unless the user picks another place.
// Where the game is: pick it (a Windows/macOS folder window), paste its path, or have none yet.
function obFolders(ob) {
  if (ob.noGame) {
    return `<div class="ob-folder on static"><strong>No game folder yet</strong><small>Tessera keeps the project in its own folder. Link your game any time in Settings → Your game.</small></div>
      <p class="ob-alt"><button type="button" class="link-btn" data-ob-hasgame>I have a game folder</button></p>`;
  }
  const where = ob.home ? `${ob.home.replace(/[\\/]+$/, "")}/${ob.name || "<project name>"}` : ob.game ? `${ob.game.replace(/[\\/]+$/, "")}/tessera` : "your game folder, in tessera/";
  return `<button type="button" class="ob-folder${ob.game ? " on" : ""}" data-ob-game>${ob.game ? `<strong>${esc(ob.game.split(/[\\/]/).filter(Boolean).pop())}</strong><small>${esc(ob.game)}</small>` : `<strong>Choose game folder…</strong><small>Godot, Unity, Unreal or anything else</small>`}</button>
    ${ob.picking ? `<p class="ob-picking"><span class="spinner"></span>A folder window opened. If you can't see it, it's behind this window.</p>` : ""}
    <div class="ob-path"><input id="obGamePath" spellcheck="false" placeholder="or paste the folder's path, e.g. D:\\Games\\MyGame" value="${esc(ob.typed || "")}"><button type="button" class="ob-back" data-ob-path>Use</button></div>
    ${ob.game && ob.gameMissing ? `<p class="ob-picking">That folder doesn't exist yet. Tessera creates it when it makes the project.</p>` : ""}
    ${ob.game ? `<div class="ob-home"><span>Tessera's workspace</span><code title="${esc(where)}"><bdi>${esc(where)}</bdi></code>
      <button type="button" class="link-btn" data-ob-home>${ob.home ? "Change…" : "Keep it somewhere else…"}</button>
      ${ob.home ? `<button type="button" class="link-btn" data-ob-home-reset>Back to the game folder</button>` : ""}</div>` : ""}
    <p class="ob-alt"><button type="button" class="link-btn" data-ob-nogame>No game folder yet? Start without one</button></p>`;
}

function renderOnboarding() {
  const ob = state.ob;
  const steps = [
    () => `<div class="ob-step intro"><img class="ob-mark" src="ui/tessera-mark.svg" alt=""><p class="ob-kicker">New project</p><h1>Every world is<br>built <em>tile by tile</em>.</h1>
      <p class="ob-sub">Four quick questions and the agent builds your project: sections, pages, first assets and a style bible.</p>
      <div class="ob-nav"><button class="ob-next" data-ob-next>Begin</button><button class="ob-back" data-imp-open title="Import a Godot, Unity or Unreal project">Import a game</button></div>
      <button class="ob-sample" data-install-sample>${icon("eye")} Or look around a finished sample project first</button></div>`,
    () => `<div class="ob-step"><p class="ob-kicker">1 / 4 · Your game</p><h1>Where's your <em>game</em>?</h1>
      <p class="ob-sub">Pick the game's folder, even an empty one. Tessera keeps this project inside it in <code>tessera/</code> (or wherever you choose), and your coding agent finds finished assets in <code>tessera/ASSETS.md</code>.</p>
      ${obFolders(ob)}
      <div class="ob-nav">${ob.step > 0 && !ob.seamless ? `<button class="ob-back" data-ob-back>Back</button>` : ""}<button class="ob-next" data-ob-next ${ob.game || ob.noGame ? "" : "disabled"}>Continue</button></div>
      ${ob.game || ob.noGame ? "" : `<p class="ob-why">Pick, paste or skip the game folder to continue.</p>`}</div>`,
    () => `<div class="ob-step"><p class="ob-kicker">2 / 4 · Name</p><h1>What's it called?</h1>
      <input id="obName" class="ob-input" maxlength="60" placeholder="The Hollow Below" value="${esc(ob.name)}" autofocus>
      <div class="ob-nav"><button class="ob-back" data-ob-back>Back</button><button class="ob-next" data-ob-next>Continue</button></div></div>`,
    () => `<div class="ob-step"><p class="ob-kicker">3 / 4 · The game</p><h1>Tell me about it.</h1>
      <textarea id="obPitch" class="ob-input" rows="3" placeholder="A cozy farming game on floating islands where you tame storm spirits…">${esc(ob.pitch)}</textarea>
      ${ob.pitch && ob.pitch === ob.autoPitch ? `<p class="ob-why">Taken from your game's docs. Change anything.</p>` : ""}
      ${chipGroup("genres", GENRES, ob.genres)}
      <div class="ob-nav"><button class="ob-back" data-ob-back>Back</button><button class="ob-next" data-ob-next>Continue</button></div></div>`,
    () => `<div class="ob-step"><p class="ob-kicker">4 / 4 · The look</p><h1>How should it look?</h1>
      ${chipGroup("looks", LOOKS, ob.looks)}
      <div class="ob-dim">${["3D", "2D"].map((d) => `<button type="button" class="ob-chip${ob.dimension === d ? " on" : ""}" data-ob-dim="${d}">${d}</button>`).join("")}</div>
      <textarea id="obRules" class="ob-input small" rows="3" placeholder="Asset rules for every image, e.g. T-pose, front view, under 10k triangles, muted palette…">${esc(ob.rules)}</textarea>
      <div class="ob-nav"><button class="ob-back" data-ob-back>Back</button><button class="ob-next forge" data-ob-forge>✦ Build my project</button></div></div>`,
    // "Skip · start blank": no questions, but the project still needs its game and a home.
    () => `<div class="ob-step"><p class="ob-kicker">Blank project</p><h1>Start <em>blank</em>.</h1>
      <p class="ob-sub">An empty project. Fill it yourself or ask Tess in the chat.</p>
      <input id="obName" class="ob-input" maxlength="60" placeholder="Project name" value="${esc(ob.name)}">
      ${obFolders(ob)}
      <div class="ob-nav">${ob.seamless ? "" : `<button class="ob-back" data-ob-restart>Answer the questions instead</button>`}<button class="ob-next" data-ob-blank ${ob.game || ob.noGame ? "" : "disabled"}>Create the project</button></div></div>`,
  ];
  $("#onboarding").classList.toggle("blank", ob.step === OB_BLANK);
  setTess($("#onboarding"), OB_POSES[ob.step]);
  $("#obStage").innerHTML = steps[ob.step]();
  // Animate in only on a new step: picking a folder or a chip redraws the same step, which should stay still.
  if (ob.shown !== ob.step) {
    ob.shown = ob.step;
    $("#obStage").firstElementChild.classList.add("enter");
    setTimeout(() => $("#obStage [autofocus], #obStage textarea")?.focus(), 350);
  }
}

function syncOnboarding() {
  const ob = state.ob;
  // Windows "Copy as path" wraps the path in quotes; a pasted path should work as it is.
  if ($("#obGamePath")) ob.typed = $("#obGamePath").value.trim().replace(/^["']+|["']+$/g, "").trim();
  if ($("#obName")) ob.name = $("#obName").value.trim();
  if ($("#obPitch")) ob.pitch = $("#obPitch").value.trim();
  if ($("#obRules")) ob.rules = $("#obRules").value.trim();
}

async function createProject(name, gameFolder, homeFolder = "") {
  const created = await api("/api/projects", { method: "POST", body: { name: name || "Untitled project", unique: true, game_folder: gameFolder || undefined, home_folder: homeFolder || undefined, create_game_folder: Boolean(gameFolder) } });
  state.project = created.project;
  storeSet("forge.project", created.project);
  if (created.existing) toast(`This game already has a Tessera project: opened ${humanize(created.project)}`);
  return created.project;
}

async function chooseGameFolder() {
  syncOnboarding();
  state.ob.picking = true;
  renderOnboarding();
  const folder = await chooseFolder("Choose your game's folder");
  state.ob.picking = false;
  if (!folder) return renderOnboarding();
  state.ob.game = folder;
  state.ob.noGame = false;
  applyAutoName(state.ob, folder);
  renderOnboarding();
  peekGame();
}

// What the game folder can tell the questions ahead: whether it exists, the game's own title (project.godot,
// Unity's product name, the .uproject) and its pitch from the README. Fills only what the user hasn't written.
async function peekGame() {
  const ob = state.ob;
  const folder = ob.game;
  let info;
  try { info = await api("/api/system/peek-folder", { method: "POST", body: { path: folder } }); } catch { return; }
  if (state.ob !== ob || ob.game !== folder) return;
  syncOnboarding();
  ob.gameMissing = !info.exists;
  if (info.exists && info.engine !== "folder" && info.title && (!ob.name || ob.name === ob.autoName)) { ob.name = info.title; ob.autoName = info.title; }
  if (info.pitch && (!ob.pitch || ob.pitch === ob.autoPitch)) { ob.pitch = info.pitch; ob.autoPitch = info.pitch; }
  if ([1, OB_BLANK].includes(ob.step)) renderOnboarding();
}

// The project name follows the game folder until the user types their own: picking a different folder
// replaces a name Tessera filled in, but never one the user wrote.
function applyAutoName(ob, folder) {
  const guess = folder.split(/[\\/]/).filter(Boolean).pop().replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  if (!ob.name || ob.name === ob.autoName) { ob.name = guess; ob.autoName = guess; }
}

const OB_BLANK = 5;

// Back to where the user was, with nothing created.
function cancelOnboarding() {
  hideScene($("#onboarding"));
}

function skipOnboarding() {
  syncOnboarding();
  state.ob.step = OB_BLANK;
  renderOnboarding();
}

async function chooseHomeFolder() {
  syncOnboarding();
  const folder = await chooseFolder("Where should Tessera keep this project's workspace?");
  if (!folder) return;
  state.ob.home = folder;
  renderOnboarding();
}

async function createBlank() {
  syncOnboarding();
  if (!state.ob.game && !state.ob.noGame) return toast("Pick, paste or skip your game's folder first.", true);
  try {
    const project = await createProject(state.ob.name, state.ob.game, state.ob.home);
    await switchProject(project); // load behind the scene, so the app is ready when it fades out
    hideScene($("#onboarding"));
    toast(`Created ${humanize(project)}: a blank workspace`);
  } catch (err) { toast(err.message, true); }
}

async function forgeWorld() {
  syncOnboarding();
  const ob = state.ob;
  if (!ob.game && !ob.noGame) { ob.step = 1; renderOnboarding(); toast("Pick, paste or skip your game's folder first.", true); return; }
  if (!ob.name) { ob.step = 2; renderOnboarding(); toast("Give your project a name first.", true); return; }
  $("#onboarding").classList.add("forging");
  setTess($("#onboarding"), "reach");
  $("#obStage").innerHTML = `<div class="ob-step forging-step enter"><div class="ob-orb"><span></span><span></span><span></span></div>
    <p class="ob-kicker">Building</p><h1>${esc(ob.name)}</h1><ul class="ob-log" id="obLog"><li>Creating the project…</li></ul></div>`;
  // The log is gone once the user went in early (below): the build carries on in the chat, and this just stops talking.
  const gone = () => state.ob !== ob || ob.left;
  const log = (text, cls = "") => { if (!gone()) $("#obLog")?.insertAdjacentHTML("beforeend", `<li class="${cls}">${text}</li>`); };
  let poll, early;
  try {
    const project = await createProject(ob.name, ob.game, ob.home);
    await api("/api/bible", { method: "PUT", body: { project_dimension: ob.dimension === "2D" ? "2d" : "3d" } }).catch(() => {});
    const look = [ob.dimension, ...ob.looks].join(", ");
    // Spell the dimension out: image models read a bare "3D, Toon" as a flat cartoon drawing.
    const lookLine = ob.dimension === "3D"
      ? `- Look: rendered 3D game asset${ob.looks.length ? ` (${ob.looks.join(", ")})` : ""}, like a model in the game engine, not a flat 2D drawing`
      : `- Look: 2D game art${ob.looks.length ? ` (${ob.looks.join(", ")})` : ""}`;
    const rules = [lookLine, ...ob.rules.split(/\n|;/).map((r) => r.trim()).filter(Boolean).map((r) => `- ${r}`)].filter(Boolean);
    if (rules.length) {
      await api("/api/overview/file", { method: "PUT", body: { path: "pillars/style-bible.md", content: `# Style bible\n\n${rules.join("\n")}\n` } });
      log("Style bible written: put in front of every image prompt", "ok");
    }
    if (!state.models.some((m) => m.ready)) {
      // No chat model: the coding agent (or the user) builds the structure with the tessera prompt instead.
      const brief = [`/tessera Create a project structure for my game "${ob.name}".`, ob.pitch && `Pitch: ${ob.pitch}`, ob.genres.length && `Genre: ${ob.genres.join(", ")}.`, look && `Look: ${look}.`].filter(Boolean).join(" ");
      await api("/api/overview/file", { method: "PUT", body: { path: "README.md", content: `# ${ob.name}\n\n${ob.pitch || "A new game."}\n` } });
      log("Front page written", "ok");
      log("No chat model is connected, so Tess can't design the sections here. Connect your game in Settings → Coding agent and give your agent this:", "");
      $("#obLog").insertAdjacentHTML("afterend", `<pre class="cn-cmd ob-brief"><code>${esc(brief)}</code></pre><button class="ob-back" data-cn-copy="${esc(brief)}">Copy</button>`);
      $(".ob-brief + button").insertAdjacentHTML("afterend", `<button class="ob-next forge" data-ob-enter>Open your project →</button>`);
      forged();
      return;
    }
    const session = await api("/api/agent/sessions", { method: "POST", body: { title: "Project setup" } });
    log("The agent is designing your project…");
    // A full build takes the agent minutes. After a short look the user may go in and watch it in the chat instead.
    early = setTimeout(() => {
      if (gone() || $("[data-ob-enter]")) return;
      $("#obLog").insertAdjacentHTML("afterend", `<div class="ob-early"><button class="ob-back" data-ob-enter data-early>Go in now</button><small>Tess keeps building in the chat; sections appear as they're made.</small></div>`);
    }, 8000);
    const seen = new Set();
    poll = setInterval(async () => {
      if (gone()) return clearInterval(poll);
      try {
        const ov = await api("/api/overview");
        for (const s of ov.sections) if (!seen.has(s.path)) { seen.add(s.path); log(`＋ ${esc(s.number)} · ${esc(s.title)}`, "ok"); }
      } catch { /* keep polling */ }
    }, 1500);
    const text = [
      `Create a project structure for my game "${ob.name}".`,
      ob.pitch && `Pitch: ${ob.pitch}`,
      ob.genres.length && `Genre: ${ob.genres.join(", ")}.`,
      look && `Look: ${look}.`,
      rules.length && "A style bible already exists at pillars/style-bible.md; keep it and refine it if useful.",
      "Start with the root README.md front page (title and a one-line pitch), then the sections, then a few first assets in the collections.",
    ].filter(Boolean).join("\n");
    const result = await api(`/api/agent/sessions/${session.id}/messages`, { method: "POST", body: { text, model: state.model || undefined } });
    clearInterval(poll);
    clearTimeout(early);
    if (gone()) { if (state.project === project) loadOverview(); return; }  // went in early: just show what was made
    $(".ob-early")?.remove();
    const ov = await api("/api/overview").catch(() => ({ sections: [] }));
    for (const sec of ov.sections) if (!seen.has(sec.path)) log(`＋ ${esc(sec.number)} · ${esc(sec.title)}`, "ok");
    const done = (result.messages?.at(-1)?.actions || []).filter((a) => a.changed).length;
    log(`Done: ${done} change${done === 1 ? "" : "s"} made`, "ok");
  } catch (err) {
    clearInterval(poll);
    clearTimeout(early);
    if (gone()) return toast(`Project setup stopped: ${err.message}. Continue in the chat.`, true);
    $(".ob-early")?.remove();
    log(`The agent stopped: ${esc(err.message)}. Your project is still created; you can continue in the chat.`, "bad");
  }
  $("#obLog").insertAdjacentHTML("afterend", `<button class="ob-next forge" data-ob-enter>Open your project →</button>`);
  forged();
}

// The project is made: the "Building" screen settles so it no longer looks busy.
function forged() {
  $(".forging-step")?.classList.add("forged");
  setTess($("#onboarding"), "present");
  const kicker = $(".forging-step .ob-kicker");
  if (kicker) kicker.textContent = "Ready";
  $("[data-ob-enter]")?.focus();
}

async function finishOnboarding() {
  if (state.ob) state.ob.left = true;
  await switchProject(state.project);
  hideScene($("#onboarding"));
}

async function switchProject(name) {
  motionLoaded?.leave();  // saves an open motion while its project is still the current one
  state.motionSel = null;
  flowsLoaded?.leave();
  state.flowSel = undefined;  // the workflow last open in the project switched to
  // The last project's page must not stand in for this one while it loads.
  if (name !== state.project) $("#content").innerHTML = `<div class="view-loading"><span class="spinner"></span></div>`;
  await loadProjects(name);
  state.view = { type: "home" };
  state.trail = [];
  await loadJobs();
  renderJobDock();
  state.palette = state.board = state.boardView = null;
  state.plQuery = "";
  state.plFilter = "";
  await Promise.all([loadSessions(), loadOverview(), loadConnect()]);
}

// ---------- chat ----------

async function loadSessions() {
  const data = await api("/api/agent/sessions");
  state.sessions = (data.sessions || []).filter((s) => s.group !== "Archive" || s.message_count);
  applyChatMode();
  const remembered = storeGet(`forge.session.${state.project}`);
  const pick = state.sessions.find((s) => s.id === remembered) || state.sessions[state.sessions.length - 1];
  if (pick) await openSession(pick.id);
  else { state.sessionId = ""; state.session = null; renderTabs(); renderMessages(); }
}

async function openSession(id) {
  state.sessionId = id;
  state.session = await api(`/api/agent/sessions/${id}`);
  storeSet(`forge.session.${state.project}`, id);
  if (state.session.model && modelUsable(state.session.model)) state.model = state.session.model;
  if (state.session.effort) state.effort = state.session.effort;
  renderModelPill();
  renderTabs();
  renderMessages();
}

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const created = await api("/api/agent/sessions", { method: "POST", body: { title: "New chat", model: state.model, effort: state.effort } });
  state.sessions.push(created);
  state.sessionId = created.id;
  state.session = created;
  storeSet(`forge.session.${state.project}`, created.id);
  renderTabs();
  return created.id;
}

async function newChat() {
  state.sessionId = "";
  state.session = null;
  await ensureSession();
  renderMessages();
  $("#input").focus();
}

async function deleteChat(id) {
  if (!(await ask({ title: "Delete this chat?", body: "It moves to the project's .trash folder.", ok: "Delete chat", danger: true }))) return;
  await api(`/api/agent/sessions/${id}`, { method: "DELETE" });
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessionId === id) {
    state.sessionId = "";
    state.session = null;
    const last = state.sessions[state.sessions.length - 1];
    if (last) await openSession(last.id);
    else { renderTabs(); renderMessages(); }
  } else renderTabs();
}

function renderTabs() {
  const tabs = state.sessions.map((s) => `
    <button class="tab${s.id === state.sessionId ? " active" : ""}" data-session="${s.id}" role="tab" title="${esc(s.title)}">
      <img src="ui/tessera-mark.svg" alt=""><span>${esc(s.title || "New chat")}</span><span class="x" data-delete="${s.id}" aria-label="Delete chat">×</span>
    </button>`).join("");
  $("#sessionTabs").innerHTML = `${tabs}<button class="tab add" id="newChatBtn" title="New chat" aria-label="New chat">+</button>`;
}

const SUGGESTIONS = [
  ["✦", "Create a project structure for my game. It's about "],
  ["◎", "Look at my project and suggest what's missing."],
  ["✎", "Write a short pitch and a feature list on the front page."],
];
// Three things worth asking on the page you are on. A trailing space means "you finish the sentence".
function chatSuggestions() {
  const view = state.view || {};
  if (!state.overview?.sections?.length) return SUGGESTIONS;
  const name = (path) => humanize(String(path || "").split("/").pop().replace(/\.md$/, ""));
  if (view.type === "doc") {
    const title = name(view.path);
    return [["✦", `Make three new takes of ${title}.`], ["◎", `Make a variant of ${title} that `], ["✎", `Rewrite the prompt for ${title} so it `]];
  }
  if (view.type === "folder") {
    const title = name(view.path);
    return [["✦", `Generate what is still missing in ${title}.`], ["◎", `Add an asset to ${title}: `], ["✎", `What is ${title} missing?`]];
  }
  return [["✦", "Generate everything that is still missing."], ["◎", "Look at my project and suggest what's missing."], ["✎", "Add a new asset: "]];
}
function suggestionButtons() {
  return chatSuggestions().map(([icon, s]) => `<button class="suggestion" data-suggest="${esc(s)}"><i>${icon}</i><span>${esc(s.trim())}${s.endsWith(" ") ? "…" : ""}</span></button>`).join("");
}
// The page changed: an empty chat offers what fits the new page.
function refreshChatEmpty() {
  const box = $("#messages .chat-empty .suggestions");
  if (box) box.innerHTML = suggestionButtons();
}
const TOOL_ICON = { write: "✎", append: "✎", create_folder: "▣", move: "↦", delete: "✕", generate: "✦", pick_winner: "★", file_order: "⇢", request_access: "🔒", import_game: "⇣", copy_in: "⇣" };

// No model ready: say exactly why, with the one button that fixes it.
function brainBanner() {
  const clis = (state.modelInfo?.clis || []).filter((c) => c.installed);
  const waiting = clis.find((c) => state.cliWait?.[c.id]);
  if (waiting) return `<div class="banner">Waiting for you to log in to ${esc(waiting.label)} in the window that opened…</div>`;
  const checking = clis.find((c) => c.status === "unknown");
  if (checking) return `<div class="banner">Checking your ${esc(checking.label)} login…</div>`;
  const out = clis.find((c) => c.status === "login") || clis.find((c) => c.status !== "error") || clis[0];
  if (out) return `<div class="banner">${esc(out.label)} isn't logged in yet, so Tess can't answer. <button class="ghost" data-cli-login="${esc(out.id)}">Log in to ${esc(out.label)}</button></div>`;
  return `<div class="banner">Tess runs on Claude Code or Codex, with your own login. <button class="ghost" data-settings>Set it up</button></div>`;
}

function renderMessages() {
  const box = $("#messages");
  const messages = state.session?.messages || [];
  const noModel = !state.models.some((m) => m.ready);
  const banner = noModel ? brainBanner() : "";
  if (!messages.length && !state.sending) {
    box.innerHTML = `${banner}<div class="chat-empty">
      ${tessArt("welcome", "chat")}
      <h2>What are we making?</h2>
      <div class="suggestions">${suggestionButtons()}</div>
    </div>`;
    return;
  }
  const running = state.sending || state.progress?.session === state.sessionId;
  const thinking = running ? `<div class="msg agent thinking"><img class="avatar tess live" src="${tessFace("thinking")}" alt=""><div class="bubble"><div class="who">Tess</div><div id="liveStatus">${liveStatusHtml()}</div><button type="button" class="ghost" id="chatStop" data-chat-stop hidden>Stop</button></div></div>` : "";
  // Only messages that are new since the last draw animate in; redraws of the same chat stay still.
  const seen = state.drawn?.session === state.sessionId ? state.drawn.count : messages.length;
  state.drawn = { session: state.sessionId, count: messages.length };
  box.innerHTML = banner + messages.map((m, i) => renderMessage(m).replace('<div class="msg ', `<div class="msg ${i >= seen ? "fresh " : ""}`)).join("") + thinking;
  box.scrollTo({ top: box.scrollHeight, behavior: "instant" }); // the box scrolls smoothly; a redraw must not glide through history
  syncComposer();
}

function renderMessage(m) {
  if (m.role === "user") {
    const imgs = (m.attachments || []).map((a) => `<img class="thumb" src="${esc(fileUrl(a.path))}" alt="">`).join("");
    return `<div class="msg user"><div class="bubble">${esc(m.text)}${imgs}</div></div>`;
  }
  if (m.role === "note") return `<div class="msg note">${esc(m.text)}</div>`;
  const actions = (m.actions || []).filter((a) => !["list", "read", "legacy"].includes(a.tool) || a.ok === false);
  const failed = actions.filter((a) => a.ok === false).length;
  const rows = actions.map((a) => {
    const openable = a.ok !== false && a.path && a.tool !== "delete";
    return `<li class="${a.ok === false ? "bad" : ""}${openable ? " link" : ""}"${openable ? ` data-open="${esc(a.path)}"` : ""}><i>${a.ok === false ? "!" : TOOL_ICON[a.tool] || "•"}</i><span>${esc(a.summary)}</span></li>`;
  }).join("");
  const card = actions.length ? `<details class="changes"${actions.length <= 3 ? " open" : ""}><summary><span class="spark">✦</span>${actions.length} change${actions.length === 1 ? "" : "s"}${failed ? ` <em>${failed} failed</em>` : ""}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></summary><ul>${rows}</ul></details>` : "";
  const last = m === state.session?.messages?.at(-1);
  const asks = (m.actions || []).filter((a) => a.access_request).map((a) => accessCard(a.access_request, last)).join("");
  return `<div class="msg agent${m.error ? " error" : ""}"><img class="avatar tess" src="${tessFace(m.error ? "apologetic" : "")}" alt=""><div class="bubble"><div class="who">Tess${m.model ? ` <small>${esc(m.model)}</small>` : ""}</div><div class="md">${renderMarkdown(m.text)}</div>${asks}${card}</div></div>`;
}

function syncComposer() {
  renderModelPill();
  const used = state.session?.context_tokens || 0;
  const limit = state.agentCfg?.agent_compact_at_tokens || 48000;
  $("#contextMeter").innerHTML = used
    ? `<span class="meter"><i style="width:${Math.min(100, (used / limit) * 100)}%"></i></span>Context ${(used / 1000).toFixed(1)}k / ${limit / 1000}k · <button type="button" class="link-btn" data-compact-now>Compact now</button>`
    : "Enter to send · Shift+Enter for a new line";
}

function renderAttachments() {
  $("#attachments").innerHTML = state.attachments.map((a, i) => `<figure><img src="${a.data_url}" alt="${esc(a.name)}"><button type="button" data-unattach="${i}" aria-label="Remove">×</button></figure>`).join("");
}

function addFiles(files) {
  const room = 4 - state.attachments.length;
  if ([...files].length > room) toast(room ? `Up to 4 images per message; added ${room}.` : "Up to 4 images per message.", true);
  for (const file of [...files].slice(0, Math.max(0, room))) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => { state.attachments.push({ name: file.name, data_url: reader.result }); renderAttachments(); };
    reader.readAsDataURL(file);
  }
}

async function send(override = {}) {
  const input = $("#input");
  const text = input.value.trim();
  if ((!text && !state.attachments.length) || state.sending) return;
  if (state.progress?.session === state.sessionId) return toast("Tess is still working on the last message.", true);
  state.sending = true;
  $("#sendBtn").disabled = true;
  const attachments = state.attachments;
  try {
    const id = await ensureSession();
    state.session.messages = [...(state.session.messages || []), { role: "user", text, attachments: [] }];
    input.value = "";
    autoGrow();
    state.attachments = [];
    renderAttachments();
    renderMessages();
    const page = state.view.type === "motion" ? { viewing: "Motion Studio", motion: motionLoaded?.current() || null } : state.view.type === "nodes" ? { viewing: "Node Studio", workflow: flowsLoaded?.current() || null } : state.view.path ? { viewing: state.view.path } : {};
    state.session = await api(`/api/agent/sessions/${id}/messages`, { method: "POST", body: { text, attachments, page, model: override.model || state.model || undefined, effort: override.effort || state.effort } });
    const entry = state.sessions.find((s) => s.id === id);
    if (entry) entry.title = state.session.title;
    renderTabs();
    const changed = (state.session.messages.at(-1)?.actions || []).some((a) => a.changed);
    if (changed) await loadOverview();
  } catch (err) {
    toast(err.message, true);
    if (state.sessionId) await openSession(state.sessionId).catch(() => {});
  } finally {
    state.sending = false;
    $("#sendBtn").disabled = false;
    await loadModels(); // a failed call marks its model as not ready: the pill and the banner say so
    renderMessages();
  }
}

// What the chat model is doing right now, from the server's progress messages: thinking, or writing (and how much).
function liveStatusHtml() {
  const p = state.progress;
  if (!p || p.session !== state.sessionId) return `<span class="shimmer">Working…</span>`;
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - p.started));
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const fileVerb = { write: "Writing", append: "Adding to", edit: "Editing" }[p.doing?.tool];
  const label = p.phase === "thinking" ? "Thinking"
    : p.phase === "writing" ? (fileVerb ? `${fileVerb} ${p.doing.path} · ${(p.chars / 1000).toFixed(1)}k characters` : "Writing its answer")
    : p.phase === "acting" ? "Working"
    : "Working out the next step…";
  const readable = (p.tail || "").split("\\n").join("\n").split('\\"').join('"').slice(-240);  // the model's reply is JSON text: show its newlines and quotes plainly
  const shown = p.phase === "thinking" ? (p.thought || "").trim() : p.phase === "writing" && fileVerb ? readable : "";
  const tail = shown ? `<pre class="live-tail${p.phase === "thinking" ? " thought" : ""}">${esc(shown)}</pre>` : "";
  return `${liveStepsHtml(p)}<span class="shimmer">${esc(label)}</span> <small class="live-time">${time}</small>${tail}`;
}

const STEP_VERB = { read: "Reading", list: "Looking in", write: "Writing", append: "Adding to", edit: "Editing", create_folder: "Making folder", move: "Moving", delete: "Removing", generate: "Generating", pick_winner: "Picking winner for", copy_in: "Copying", import_game: "Importing", save_url: "Saving", request_access: "Asking for access to", skill: "Opening guide", models: "Checking models", service_tools: "Looking at service tools", service_tool_info: "Looking at service tool", service_call: "Calling service tool" };

// What this answer has done so far, oldest first, like a coding agent's log: what it said, then each tool it ran.
function liveStepsHtml(p) {
  const steps = p.steps || [];
  if (!steps.length && !(p.say && p.phase === "writing")) return "";
  const hidden = Math.max(0, steps.length - 14);
  const rows = steps.slice(hidden).map((s) => {
    if (s.say) return `<li class="say">${esc(s.say)}</li>`;
    const mark = s.state === "failed" ? "!" : s.state === "done" ? "✓" : "…";
    return `<li class="${s.state || "running"}"><i>${mark}</i><span>${esc(s.summary || `${STEP_VERB[s.tool] || s.tool} ${s.path}`.trim())}</span></li>`;
  });
  if (p.say && p.phase === "writing" && steps.at(-1)?.say !== p.say) rows.push(`<li class="say">${esc(p.say)}</li>`);
  return `<ul class="live-steps">${hidden ? `<li class="more">${hidden} earlier steps</li>` : ""}${rows.join("")}</ul>`;
}

function updateLiveStatus() {
  const el = $("#liveStatus");
  if (!el) return;
  const box = $("#messages");
  const following = box.scrollHeight - box.scrollTop - box.clientHeight < 160;  // don't pull the view down if they scrolled up to read
  el.innerHTML = liveStatusHtml();
  const stop = $("#chatStop");  // outside the status, which is redrawn every second: a click must land on the same button it started on
  if (stop) stop.hidden = !(state.progress?.stoppable && state.progress.session === state.sessionId);
  if (following) box.scrollTo({ top: box.scrollHeight, behavior: "instant" });
}

// A run this page didn't start (it was reloaded mid-run, or another window asked): show it live, then its answer.
function chatProgress(msg) {
  const before = state.progress;
  state.progress = msg.done ? null : msg;
  if (msg.session === state.sessionId && !state.sending) {
    if (msg.done && before) openSession(state.sessionId).catch(() => {});
    else if (!msg.done && !before) renderMessages();
  }
  updateLiveStatus();
}
setInterval(updateLiveStatus, 1000);

// ---------- models & settings ----------

function modelUsable(id) {
  const model = state.models.find((m) => m.id === id);
  if (!model) return false;
  if (model.ready) return true;
  const cli = String(id).match(/^cli:([^/]+)/)?.[1];
  return Boolean(cli && (state.modelInfo?.clis || []).some((c) => c.id === cli && c.installed && c.status === "unknown"));
}

async function loadModels() {
  try {
    const data = await api("/api/agent/models");
    state.models = data.models || [];
    state.modelInfo = data;
    const ready = state.models.filter((m) => m.ready);
    // Just after a start the coding agents are still being checked. Their models aren't ready yet, but that's no
    // reason to move the chat to another provider: keep the choice until the check has answered.
    if (!modelUsable(state.model)) state.model = modelUsable(data.selected) ? data.selected : (ready[0]?.id || "");
    if (data.effort && !state.sessionId) state.effort = data.effort;
  } catch {
    state.models = [];
  }
  renderModelPill();
  renderStatusBar();
}

const EFFORT_LABEL = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

function currentModel() { return state.models.find((m) => m.id === state.model); }

function renderModelPill() {
  const m = currentModel();
  const ready = state.models.some((x) => x.ready);
  $("#statusDot").className = `dot ${ready ? "live" : "off"}`;
  $("#modelPillLabel").innerHTML = m
    ? `${esc(m.label)}${m.efforts?.length ? ` <em>· ${EFFORT_LABEL[state.effort] || "Medium"}</em>` : ""}`
    : ready ? "Pick a model" : "Connect a model";
}

// Coding agents running on the user's own login, with their logos (Tess model menu, setup, settings).
const AGENT_LOGO = { claude: "ui/logos/claude.svg", codex: "ui/logos/codex.svg", gemini: "ui/logos/gemini.svg", opencode: "ui/logos/opencode.svg" };
const MODEL_TABS = [["fav", "Favorites"], ["claude", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini"], ["opencode", "OpenCode"], ["custom", "API & custom"]];

const modelTab = (m) => (m.provider === "cli" ? m.id.slice(4).split("/")[0] : "custom");

function favoriteModels() {
  try { return JSON.parse(storeGet("tessera.favoriteModels") || storeGet("glob.favoriteModels") || "[]"); } catch { return []; }
}

function toggleFavorite(id) {
  const favs = favoriteModels();
  storeSet("tessera.favoriteModels", JSON.stringify(favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id]));
  renderModelPop();
}

function renderModelPop() {
  const ready = state.models.filter((x) => x.ready);
  const favs = favoriteModels().filter((id) => ready.some((m) => m.id === id));
  const tabs = MODEL_TABS.filter(([id]) => (id === "fav" ? favs.length : ready.some((m) => modelTab(m) === id)));
  const m = currentModel();
  if (!tabs.some(([id]) => id === state.modelTab)) state.modelTab = favs.length ? "fav" : (m ? modelTab(m) : tabs[0]?.[0]);
  const shown = state.modelTab === "fav" ? ready.filter((x) => favs.includes(x.id)) : ready.filter((x) => modelTab(x) === state.modelTab);
  const groups = {};
  for (const x of shown) (groups[state.modelTab === "custom" ? x.group || x.provider : ""] ||= []).push(x);
  const row = (x) => `<button type="button" class="pop-model${x.id === state.model ? " on" : ""}" data-pick-model="${esc(x.id)}">
    ${x.provider === "cli" && state.modelTab === "fav" ? `<img src="${AGENT_LOGO[modelTab(x)]}" alt="">` : ""}<span>${esc(x.label)}</span>
    <i class="pop-star${favs.includes(x.id) ? " on" : ""}" data-fav-model="${esc(x.id)}" title="${favs.includes(x.id) ? "Remove from favorites" : "Add to favorites"}">★</i>${x.id === state.model ? "<b>✓</b>" : ""}</button>`;
  $("#modelPop").innerHTML = `
    ${tabs.length > 1 ? `<div class="pop-tabs">${tabs.map(([id, label]) => `<button type="button" class="${id === state.modelTab ? "on" : ""}" data-model-tab="${id}" title="${label}">${id === "fav" ? "★" : AGENT_LOGO[id] ? `<img src="${AGENT_LOGO[id]}" alt="">` : "API"}</button>`).join("")}</div>
      <div class="pop-tab-name">${esc(MODEL_TABS.find(([id]) => id === state.modelTab)?.[1] || "")}</div>` : ""}
    <div class="pop-list">${shown.length ? Object.entries(groups).map(([group, items]) => `${group ? `<div class="pop-group">${esc(group)}</div>` : ""}${items.map(row).join("")}`).join("")
      : `<p class="pop-empty">No model connected yet.</p>`}</div>
    ${m?.efforts?.length ? `<div class="pop-group">Reasoning effort</div><div class="effort-seg">${m.efforts.map((e) => `<button type="button" class="${e === state.effort ? "on" : ""}" data-pick-effort="${e}">${EFFORT_LABEL[e]}</button>`).join("")}</div>` : ""}
    <button type="button" class="pop-add" data-settings>＋ Add a model…</button>`;
}

function toggleModelPop(force) {
  const pop = $("#modelPop");
  const open = force ?? pop.hidden;
  if (open) renderModelPop();
  pop.hidden = !open;
}

async function pickModel(id) {
  state.model = id;
  const m = currentModel();
  if (m && !m.efforts?.length) state.effort = "medium";
  renderModelPill();
  renderModelPop();
  if (!$("#settingsView").hidden && state.settings?.tab === "models") renderSettings();
  try {
    await api("/api/config", { method: "PUT", body: { agent_model: id } });
    if (state.sessionId) await api(`/api/agent/sessions/${state.sessionId}`, { method: "PATCH", body: { model: id, effort: state.effort } });
  } catch (err) { toast(err.message, true); }
}

async function pickEffort(effort) {
  state.effort = effort;
  renderModelPill();
  renderModelPop();
  try {
    await api("/api/config", { method: "PUT", body: { agent_reasoning_effort: effort } });
    if (state.sessionId) await api(`/api/agent/sessions/${state.sessionId}`, { method: "PATCH", body: { effort } });
  } catch (err) { toast(err.message, true); }
}

function autoGrow() {
  const input = $("#input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

async function settingsDialog(tab) {
  toggleModelPop(false);
  state.settings = { tab: tab || state.settings?.tab || "accounts", adding: null };
  showScene($("#settingsView"));
  await renderSettings();
}

function closeSettings() {
  hideScene($("#settingsView"));
  // "Connect a provider…" in first-run setup comes back to the setup afterwards.
  if (state.setupReturn && state.setup) { state.setupReturn = false; showScene($("#setup")); renderSetup(); }
}

// Generation services the user signs in to (hosted MCP + OAuth), shown in setup and Settings → Generators.
const SERVICE_LOGO = { elevenlabs: "ui/logos/elevenlabs.svg", meshy: "ui/logos/meshy.png", fal: "ui/logos/fal.png", higgsfield: "ui/logos/higgsfield.png" };

async function loadServices() {
  try { state.services = (await api("/api/services")).services; } catch { state.services = state.services || []; }
  return state.services;
}

function serviceCardsHTML() {
  return `<div class="agent-cards" id="serviceCards">${(state.services || []).map((sv) => {
    const waiting = state.serviceWaiting === sv.id;
    const cls = sv.connected ? "ok" : waiting ? "login" : sv.error ? "error" : "idle";
    const note = sv.connected ? `Connected · ${sv.use === "generators" ? `powers the ${sv.label} models` : "Tess can use it"}` : waiting ? "Sign in in your browser…" : sv.error || sv.makes;
    return `<div class="agent-card ${cls}" role="button" tabindex="0" ${sv.connected ? "" : `data-service-connect="${sv.id}"`} title="${esc(sv.makes)}">
      <span class="agent-logo"><img src="${SERVICE_LOGO[sv.id]}" alt=""></span>
      <span class="agent-text"><strong>${esc(sv.label)}</strong><small>${esc(note)}</small></span>
      <span class="agent-mark">${sv.connected ? `<button type="button" class="link-btn" data-service-disconnect="${sv.id}" title="Sign out">✓</button>` : waiting ? `<i class="agent-spin"></i>` : "→"}</span></div>`;
  }).join("")}</div>`;
}

function renderServiceCards() {
  const box = $("#serviceCards");
  if (box) box.outerHTML = serviceCardsHTML();
  if ($("#acctList") && !$("#settingsView").hidden) renderSettings();
}

// Opens the service's sign-in page; the browser comes back to Tessera, which finishes the sign-in.
async function connectService(id) {
  // Open the tab during the click, so the browser doesn't block it while Tessera prepares the sign-in.
  // Tessera's native window sends new windows to the user's browser, where a blank one would stay blank.
  const tab = nativeWindow() ? null : window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  state.serviceWaiting = id;
  renderServiceCards();
  let url;
  try { url = (await api(`/api/services/${id}/connect`, { method: "POST" })).authorize_url; } catch (err) {
    // Say why in the tab too, in case the browser won't let Tess close it.
    try { tab.document.body.innerHTML = `<p style="font:16px system-ui;padding:40px">Sign-in could not start: ${esc(err.message)}</p>`; } catch { /* already gone */ }
    tab?.close();
    state.serviceWaiting = null;
    renderServiceCards();
    return toast(err.message, true);
  }
  if (tab) tab.location.href = url;
  else window.open(url, "_blank", "noopener");
  clearTimeout(state.serviceTimer);
  let tries = 0;
  const poll = async () => {
    await loadServices();
    const sv = state.services.find((x) => x.id === id);
    if (sv?.connected) return serviceConnected(id);
    if (++tries < 90 && state.serviceWaiting === id) state.serviceTimer = setTimeout(poll, 2000);
    else { state.serviceWaiting = null; renderServiceCards(); }
  };
  state.serviceTimer = setTimeout(poll, 2000);
}

function serviceConnected(id) {
  if (state.serviceWaiting !== id && !$("#serviceCards") && !$("#acctList")) return;
  clearTimeout(state.serviceTimer);
  state.serviceWaiting = null;
  renderServiceCards();
  const sv = (state.services || []).find((x) => x.id === id);
  playFistbump(SERVICE_LOGO[id], sv?.label || "The service", $("#serviceFistbump"));
}

const KEY_PROVIDERS = [
  { key: "gemini", name: "Google Gemini", use: "2D images (Nano Banana)", url: "https://aistudio.google.com/apikey", hint: "AIza…" },
  { key: "meshy", name: "Meshy", use: "3D models, rigs, animations", url: "https://www.meshy.ai/settings/api", hint: "msy_…" },
  { key: "tripo", name: "Tripo", use: "3D models (second 3D engine)", url: "https://platform.tripo3d.ai/api-keys", hint: "tsk_…" },
  { key: "elevenlabs", name: "ElevenLabs", use: "Sound effects, voices, more image models", url: "https://elevenlabs.io/app/settings/api-keys", hint: "sk_…" },
  { key: "stability", name: "Stability AI", use: "Music and ambient loops (Stable Audio)", url: "https://platform.stability.ai/account/keys", hint: "sk-…" },
];
const PRESET_ICON = { anthropic: "✳", openai: "◯", openrouter: "⇄", gemini: "✦", ollama: "◉", lmstudio: "▣", custom: "⚙" };

// What a coding agent's card says. Only "ok" (a real call worked) means Tess can use it.
const CLI_STATUS_TEXT = { ok: "✓ Logged in", login: "Not logged in · Log in", error: "Didn't answer · Try again", unknown: "Checking the login…", missing: "Not installed · Install", waiting: "Waiting for you to log in in the window that opened…" };
const cliStatus = (c) => (state.cliWait?.[c.id] ? "waiting" : c.status || (c.installed ? "unknown" : "missing"));

// Log in (or install) in a real terminal window, then check every few seconds until it works.
async function cliLogin(id) {
  const label = state.modelInfo?.clis?.find((c) => c.id === id)?.label || "The coding agent";
  try { await api(`/api/agent/cli/${id}/login`, { method: "POST" }); } catch (err) { return toast(err.message, true); }
  state.cliWait = { ...(state.cliWait || {}), [id]: true };
  refreshModelViews();
  for (let i = 0; i < 60 && state.cliWait?.[id]; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    let r;
    try { r = await api(`/api/agent/cli/${id}/check`, { method: "POST" }); } catch { continue; }
    if (!r.ok) continue;
    delete state.cliWait[id];
    await loadModels();
    if (!state.models.some((m) => m.id === state.model && m.ready)) {
      const pick = state.models.find((m) => m.id === `cli:${id}/`);
      if (pick) await pickModel(pick.id);
    }
    toast(`✓ ${label} is logged in. Tess is ready.`);
    return refreshModelViews();
  }
  if (state.cliWait?.[id]) toast(`${label} still isn't logged in. Finish in the window that opened, then press Log in again.`, true);
  delete state.cliWait?.[id];
  refreshModelViews();
}

function refreshModelViews() {
  renderModelPill();
  renderMessages();
  if (!$("#settingsView").hidden && state.settings?.tab === "models") renderSettings();
}

// Settings: five plain tabs. Each one draws at once from what Tessera already knows and fills in as answers arrive.
const SETTINGS_TABS = [["accounts", "Accounts"], ["local", "This PC"], ["images", "New art"], ["models", "Tess"], ["connect", "Your game"], ["about", "Files & app"]];
const SETTINGS_ALIAS = { agent: "models", storage: "about", pc: "local" };

// Every provider in one list: sign in where the provider allows it, otherwise (or as well) paste a key.
const PROVIDERS = [
  { id: "elevenlabs", name: "ElevenLabs", makes: "Images, sound effects, voices and music", key: "elevenlabs", service: true },
  { id: "meshy", name: "Meshy", makes: "3D models, rigs, animations and images", key: "meshy", service: true },
  { id: "gemini", name: "Google Gemini", makes: "Images (Nano Banana)", key: "gemini" },
  { id: "fal", name: "fal", makes: "Hundreds of image, video and 3D models", service: true },
  { id: "higgsfield", name: "Higgsfield", makes: "Images and cinematic video", service: true },
  { id: "tripo", name: "Tripo", makes: "3D models", key: "tripo" },
  { id: "stability", name: "Stability AI", makes: "Music and ambient loops", key: "stability" },
];
const PROVIDER_LOGO = { ...SERVICE_LOGO, gemini: "ui/logos/gemini.svg" };

// What Tessera can make right now, and with what: the four lights at the top of Accounts.
function capabilities(cfg) {
  const sv = Object.fromEntries((state.services || []).map((s) => [s.id, s.connected]));
  const sm = state.serviceModels || { image: [], "3d": [] };
  const keyImages = (state.studio?.models || []).some((m) => m.available);
  const chat = state.models.find((m) => m.id === state.model && m.ready) || state.models.find((m) => m.ready);
  return [
    { id: "images", label: "Images", icon: "character", ok: keyImages || sm.image.length > 0, via: imageVia() },
    { id: "3d", label: "3D models", icon: "cube", ok: !!(cfg.meshy_configured || cfg.tripo_configured || cfg.meshy_signed_in || sm["3d"].length), via: cfg.meshy_configured || cfg.meshy_signed_in ? "Meshy" : cfg.tripo_configured ? "Tripo" : sm["3d"][0]?.label.split(" · ")[0] },
    { id: "sounds", label: "Sounds", icon: "sound", ok: !!(cfg.elevenlabs_configured || sv.elevenlabs || cfg.stability_configured), via: cfg.elevenlabs_configured || sv.elevenlabs ? "ElevenLabs" : "Stability AI" },
    { id: "chat", label: "Tess", icon: "send", ok: !!chat, via: chat?.label, tab: "models" },
  ];
}

// The service the default image model is paid through, as the Images light says it.
function imageVia() {
  const id = String(state.studio?.selected || "");
  const svc = (state.serviceModels?.image || []).find((m) => m.id === id);
  if (svc || id.startsWith("svc:")) return `${svc?.label.split(" · ")[0] || humanize(id.slice(4).split("/")[0])} credits`;
  // The default may be a model whose key is missing; the sheet then uses the first one that works, so name that one.
  const models = state.studio?.models || [];
  const own = models.find((m) => m.id === id && m.available) || models.find((m) => m.available);
  if (own?.local) return "this PC, free";
  return own ? `your ${own.label.split(" · ")[0]} ${String(own.via || "").includes("sign") ? "account" : "key"}` : "ready";
}

// Tripo has no "sign in with Tripo" for apps, only API keys. So Tessera checks the key with Tripo before saving it,
// and shows the credits that are left.
function tripoAccountCard(cfg) {
  const t = state.tripo, keyed = !!cfg.tripo_configured;
  const credits = t?.balance ? `${Math.round(t.balance.balance).toLocaleString()} credits` : "";
  const status = !keyed ? "Not connected" : t?.error ? `Key saved, but Tripo says: ${t.error}` : credits ? `Connected · ${credits}${t.balance.frozen ? ` (${Math.round(t.balance.frozen)} in use)` : ""}` : "Connected · checking credits…";
  const isDefault = cfg.default_3d_provider === "tripo" && !cfg.default_3d_service_model;
  const sel = (key, entries) => `<select data-tripo-cfg="${key}" aria-label="${esc(key)}">${entries.map(([v, l]) => `<option value="${esc(v)}" ${v === cfg[key] ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const tog = (key, label, hint) => `<label class="mesh-toggle"><span class="switch"><input type="checkbox" data-tripo-cfg="${key}" ${cfg[key] ? "checked" : ""}><span></span></span><span>${label}<small>${hint}</small></span></label>`;
  const models = t?.models || { "v3.1-20260211": "Tripo 3.1 · best detail", "v3.0-20250812": "Tripo 3.0", "v2.5-20250123": "Tripo 2.5 · fastest", "P1-20260311": "Tripo P1 · low-poly", "P2-20260801": "Tripo P2 · low-poly with quads" };
  const form = `<details class="acct-key" ${keyed ? "" : "open"}><summary>${keyed ? "Replace the key" : "Connect with an API key"}</summary>
      <form class="acct-key-form tripo-connect-form"><input name="api_key" type="password" autocomplete="off" placeholder="tsk_…" aria-label="Tripo API key">
      <button class="mini">Connect</button><a href="https://platform.tripo3d.ai/api-keys" target="_blank" rel="noopener">Get a key ↗</a>
      <label class="inline"><input type="checkbox" name="make_default" ${isDefault ? "" : "checked"}> Use Tripo for new 3D models</label></form></details>`;
  const defaults = keyed ? `<details class="acct-key"><summary>Make 3D defaults</summary><div class="mesh-opts">
      <div class="mesh-grid"><label>Model ${sel("tripo_model", Object.entries(models))}</label>
        <label>Texture ${sel("tripo_texture_quality", [["fast", "Fast"], ["standard", "Standard"], ["detailed", "Detailed"], ["extreme", "Extreme 8K"]])}</label>
        <label>Shape detail ${sel("tripo_geometry_quality", [["standard", "Standard"], ["detailed", "Detailed"]])}</label></div>
      ${tog("tripo_auto_size", "Real-world size", "Scales models to metres")}
      ${tog("tripo_smart_low_poly", "Smart low poly", "Game-ready topology, 500 to 20k triangles")}
      ${tog("tripo_quad", "Quad meshes", "Also saves the FBX next to the GLB")}
      <p class="st-note">Each Make 3D window can still change these for one run.</p></div></details>` : "";
  return `<div class="acct${keyed && !t?.error ? " on" : ""}" data-acct="tripo">
    <span class="acct-logo"><b>T</b></span>
    <div class="acct-text"><strong>Tripo</strong><small>3D models, rigs, animations, retopo and re-texturing</small>
      <span class="acct-status">${keyed && !t?.error ? "✓ " : ""}${esc(status)}</span>${form}${defaults}</div>
    <div class="acct-act">${keyed ? `${isDefault ? `<span class="chip">3D engine</span>` : `<button class="primary" data-tripo-default>Use for 3D</button>`}
      <a class="ghost btn" href="https://platform.tripo3d.ai/billing" target="_blank" rel="noopener">Credits ↗</a>
      <button class="ghost" data-tripo-disconnect>Disconnect</button>` : ""}</div></div>`;
}

$("#settingsView").addEventListener("submit", async (event) => {
  const form = event.target.closest(".tripo-connect-form");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("input[name=api_key]"), button = form.querySelector("button");
  if (!input.value.trim()) return input.focus();
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    state.tripo = await api("/api/tripo/connect", { method: "POST", body: { api_key: input.value.trim(), make_default: form.make_default.checked } });
    state.studio = null;
    toast(`✓ Tripo connected · ${Math.round(state.tripo.balance.balance).toLocaleString()} credits`);
    await renderSettings();
  } catch (err) {
    toast(err.message, true);
    // Also on the card itself, where it stays until the next try (a toast is easy to miss).
    const status = form.closest(".acct")?.querySelector(".acct-status");
    if (status) { status.textContent = `Couldn't connect: ${err.message}`; status.classList.add("bad"); }
    button.disabled = false; button.textContent = "Connect";
  }
});

$("#settingsView").addEventListener("change", async (event) => {
  const el = event.target.closest("[data-tripo-cfg]");
  if (!el) return;
  event.stopImmediatePropagation();
  try { await api("/api/config", { method: "PUT", body: { [el.dataset.tripoCfg]: el.type === "checkbox" ? el.checked : el.value } }); state.studio = null; toast("Saved"); } catch (err) { toast(err.message, true); }
});

$("#settingsView").addEventListener("click", async (event) => {
  const t = event.target.closest("[data-tripo-default],[data-tripo-disconnect]");
  if (!t) return;
  try {
    if (t.dataset.tripoDefault !== undefined) { await api("/api/config", { method: "PUT", body: { default_3d_provider: "tripo", default_3d_service_model: "" } }); toast("New 3D models are made with Tripo"); }
    else { state.tripo = await api("/api/tripo", { method: "DELETE" }); toast("Tripo disconnected"); }
    state.studio = null;
    await renderSettings();
  } catch (err) { toast(err.message, true); }
});

function accountCard(p, cfg) {
  if (p.id === "tripo") return tripoAccountCard(cfg);
  const sv = (state.services || []).find((s) => s.id === p.id);
  const signedIn = !!sv?.connected, keyed = !!(p.key && cfg[`${p.key}_configured`]);
  const waiting = state.serviceWaiting === p.id;
  const keyInfo = KEY_PROVIDERS.find((k) => k.key === p.key);
  const status = signedIn ? "Signed in" : keyed ? "Key saved" : waiting ? "Finish signing in in your browser…" : "Not connected";
  const logo = PROVIDER_LOGO[p.id] ? `<img src="${PROVIDER_LOGO[p.id]}" alt="">` : `<b>${esc(p.name[0])}</b>`;
  const keyForm = p.key ? `<details class="acct-key"><summary>${keyed ? "Replace the key" : p.service ? "Or paste an API key" : "Paste an API key"}</summary>
      <form class="acct-key-form"><input name="${esc(p.key)}_api_key" type="password" autocomplete="off" placeholder="${esc(keyInfo?.hint || "Paste the key")}" aria-label="${esc(p.name)} API key">
      <button class="mini">Save</button><a href="${esc(keyInfo?.url || "#")}" target="_blank" rel="noopener">Get a key ↗</a></form></details>` : "";
  return `<div class="acct${signedIn || keyed ? " on" : ""}${waiting ? " wait" : ""}" data-acct="${p.id}">
    <span class="acct-logo">${logo}</span>
    <div class="acct-text"><strong>${esc(p.name)}</strong><small>${esc(p.makes)}</small>
      <span class="acct-status">${signedIn || keyed ? "✓ " : waiting ? `<i class="agent-spin"></i>` : ""}${esc(status)}</span>${keyForm}</div>
    <div class="acct-act">${signedIn ? `<button class="ghost" data-service-disconnect="${p.id}">Sign out</button>`
      : p.service ? `<button class="primary" data-service-connect="${p.id}">${waiting ? "Waiting…" : "Sign in"}</button>` : ""}</div></div>`;
}

// Models made by hand on a website (Tripo Studio's credits can't be used by Tessera): download them, and they arrive here.
function modelInboxCard() {
  const box = state.modelInbox;
  if (!box) return "";
  const other = box.enabled && state.project && box.project !== state.project;
  const status = box.error ? `<span class="acct-status bad">${esc(box.error)}</span>`
    : box.enabled ? `<span class="acct-status">✓ Watching · new models go to ${esc(humanize(box.project))}${box.recent.length ? ` · last: ${esc(humanize(box.recent[0].split("/").pop().replace(/\.md$/, "")))}` : ""}</span>` : `<span class="acct-status">Off</span>`;
  return `<div class="acct${box.enabled && !box.error ? " on" : ""}" data-acct="model-inbox">
    <span class="acct-logo">${icon("cube")}</span>
    <div class="acct-text"><strong>Watched folder for 3D models</strong>
      <small>Made a model in Tripo Studio or on another site? Download it as GLB, FBX or OBJ and it becomes an asset here. GLB keeps its textures in one file. Tessera only copies new files and spends no credits.</small>
      ${status}
      ${box.enabled ? `<div class="path-row"><code>${esc(box.folder)}</code></div>`
        : `<form class="model-inbox-form path-row"><input name="folder" value="${esc(box.default_folder)}" autocomplete="off" aria-label="Folder to watch" spellcheck="false"></form>`}
      <div class="row wrap model-inbox-tools">
        <button class="ghost" data-inbox-batches ${box.waiting ? "" : "disabled"}>Prepare Tripo batches${box.waiting ? ` (${plural(box.waiting, "image")})` : ""}</button>
        ${box.unpaired ? `<button class="primary" data-inbox-pair>Pair ${plural(box.unpaired, "model")}</button>` : ""}</div></div>
    <div class="acct-act">${box.enabled ? `${other ? `<button class="primary" data-inbox-here>Send to ${esc(humanize(state.project))}</button>` : ""}<button class="ghost" data-inbox-off>Turn off</button>`
      : `<button class="primary" data-inbox-on ${state.project ? "" : "disabled"}>Turn on</button>`}</div></div>`;
}

async function setModelInbox(body) {
  try {
    state.modelInbox = await api("/api/model-inbox", { method: "PUT", body });
    toast(body.enabled ? `Watching for new models · they go to ${humanize(body.project)}` : "Stopped watching");
    await renderSettings();
  } catch (err) { toast(err.message, true); }
}

$("#settingsView").addEventListener("submit", (event) => {
  if (!event.target.closest(".model-inbox-form")) return;
  event.preventDefault();
  setModelInbox({ enabled: true, folder: event.target.folder.value.trim(), project: state.project });
});

$("#settingsView").addEventListener("click", (event) => {
  if (event.target.closest("[data-inbox-on]")) setModelInbox({ enabled: true, folder: $("#settingsView .model-inbox-form input").value.trim(), project: state.project });
  if (event.target.closest("[data-inbox-off]")) setModelInbox({ enabled: false, project: state.project });
  if (event.target.closest("[data-inbox-batches]")) prepareTripoBatches();
  if (event.target.closest("[data-inbox-pair]")) openModelPairing();
  if (event.target.closest("[data-inbox-here]")) setModelInbox({ enabled: true, folder: state.modelInbox.folder, project: state.project });
});

function prepareTripoBatches() { return exportForTripo(null); }

// Batch downloads have no useful name, so a person pairs them by eye: pick a model, pick its image, compare, attach.
async function openModelPairing() {
  try { state.modelPairing = await api("/api/model-inbox/pairing"); } catch (err) { return toast(err.message, true); }
  state.pairPick = { model: "", asset: "" };
  drawModelPairing();
  const project = state.project;
  if (state.modelPairing.models.some((m) => !m.thumb)) {
    renderMissingThumbs(project, (model) => {
      const found = state.modelPairing?.models.find((m) => m.model === model);
      if (!found || !$("#dialog").open || !$("#dialog .model-pairing")) return;
      found.thumb = model.replace(/\.[^.]+$/, "_thumb.png");
      drawModelPairing();
    }).catch(() => {});
  }
}

function pairPicture(rel, alt = "") {
  return rel ? `<img src="${esc(projectFileUrl(state.project, rel))}" alt="${esc(alt)}" loading="lazy">` : `<span class="pair-none">${icon("cube")}</span>`;
}

function drawModelPairing() {
  const { models, waiting } = state.modelPairing;
  if (!models.length) { if ($("#dialog").open) closeDialog(); toast("All paired"); return; }
  const pick = state.pairPick;
  const model = models.find((m) => m.path === pick.model) || models[0];
  if (pick.model !== model.path) { pick.model = model.path; pick.asset = model.suggested; }
  const asset = waiting.find((a) => a.path === pick.asset);
  pick.asset = asset?.path || "";
  const sections = new Map();
  for (const item of waiting) {
    const label = dirOf(item.path).split("/").filter(Boolean).map(humanize).join(" · ") || "Project";
    if (!sections.has(label)) sections.set(label, []);
    sections.get(label).push(item);
  }
  const scroll = ["pair-models", "pair-assets"].map((name) => $(`#dialog .${name}`)?.scrollTop || 0);
  const body = `<div class="dlg model-pairing"><h2>${icon("cube")} Pair ${plural(models.length, "model")}</h2>
    <div class="pair-compare">
      <figure>${pairPicture(model.thumb, "Selected model")}<figcaption>${esc(model.title || "Downloaded model")}</figcaption></figure>
      <figure>${asset ? pairPicture(asset.winner, asset.title) : `<span class="pair-none pair-prompt">Choose its image below</span>`}<figcaption>${esc(asset?.title || "")}</figcaption></figure>
      <div class="pair-act"><button class="primary" data-pair-attach ${asset ? "" : "disabled"}>Attach</button><button class="ghost" data-pair-keep>Keep separate</button></div>
    </div>
    <div class="pair-columns">
      <div class="pair-models" aria-label="Downloaded models">${models.map((m) => `<button type="button" class="pair-tile${m.path === model.path ? " on" : ""}" data-pair-model="${esc(m.path)}" aria-pressed="${m.path === model.path}" aria-label="${esc(m.title || "Downloaded model")}">${pairPicture(m.thumb)}</button>`).join("")}</div>
      <div class="pair-assets">${waiting.length ? [...sections].map(([label, items]) => `<section><h3>${esc(label)} <small>${items.length}</small></h3><div class="pair-grid">${items.map((item) => `<button type="button" class="pair-tile${item.path === pick.asset ? " on" : ""}" data-pair-asset="${esc(item.path)}" aria-pressed="${item.path === pick.asset}">${pairPicture(item.winner)}<span>${esc(item.title)}</span></button>`).join("")}</div></section>`).join("") : `<p class="st-note">No assets are waiting for a model.</p>`}</div>
    </div>
    <div class="row"><button type="button" class="ghost" data-close>Done</button></div></div>`;
  if ($("#dialog").open) $("#dialog").innerHTML = body; else openDialog(body);
  ["pair-models", "pair-assets"].forEach((name, i) => { const el = $(`#dialog .${name}`); if (el) el.scrollTop = scroll[i]; });
}

$("#dialog").addEventListener("click", async (event) => {
  const tile = event.target.closest("[data-pair-model],[data-pair-asset]");
  if (tile && state.pairPick) {
    if (tile.dataset.pairModel) state.pairPick.model = tile.dataset.pairModel;
    else state.pairPick.asset = tile.dataset.pairAsset;
    drawModelPairing();
    if (tile.dataset.pairAsset) $("#dialog [data-pair-attach]")?.focus(); // Enter attaches
    return;
  }
  const button = event.target.closest("[data-pair-attach],[data-pair-keep]");
  if (!button) return;
  // The next model comes up at once; the moves run one by one behind it.
  const model = state.pairPick.model, target = button.matches("[data-pair-attach]") ? state.pairPick.asset : "";
  const pairing = state.modelPairing;
  pairing.models = pairing.models.filter((m) => m.path !== model);
  pairing.waiting = pairing.waiting.filter((a) => a.path !== target);
  state.pairPick = { model: "", asset: "" };
  state.pairQueue = (state.pairQueue || Promise.resolve()).then(() => api("/api/model-inbox/pair", { method: "POST", body: { model, target } })).catch(async (err) => {
    toast(err.message, true);
    state.modelPairing = await api("/api/model-inbox/pairing").catch(() => state.modelPairing);
    if ($("#dialog").open && state.pairPick) drawModelPairing();
  });
  drawModelPairing();
});

$("#dialog").addEventListener("close", () => {
  if (!state.pairPick) return;
  state.pairPick = null;
  Promise.resolve(state.pairQueue).then(() => { if (!$("#settingsView").hidden) renderSettings(); }); // the card's counts changed
});

// Previews for 3D models that have none yet, rendered here in the browser and saved beside the model.
async function renderMissingThumbs(project, onThumb) {
  const { models } = await api(`/api/import/models?project=${encodeURIComponent(project)}`);
  if (!models.length) return;
  const viewer = await viewerModule();
  for (const model of models) {
    try {
      const png = await viewer.renderThumb(projectFileUrl(project, model), 384);
      await api(`/api/studio/thumb?project=${encodeURIComponent(project)}`, { method: "POST", body: { model, png } });
      onThumb?.(model);
    } catch { /* keep the placeholder */ }
  }
}

function accountsBody(cfg, budget) {
  const caps = capabilities(cfg);
  const missing = caps.filter((c) => !c.ok);
  return `<h1>Accounts</h1>
    <p class="st-lede">Tessera makes art with services you sign in to. Tessera is free; you pay each service directly for what you make, and everything stays on this computer.</p>
    <div class="caps">${caps.map((c) => `<button class="cap ${c.ok ? "ok" : "no"}" ${c.tab ? `data-settings-tab="${c.tab}"` : `data-cap-jump="${c.id}"`}>
      <span class="cap-icon">${icon(c.icon)}</span><span><strong>${c.label}</strong><small>${c.ok ? `✓ ${esc(c.via || "ready")}` : "Not set up yet"}</small></span></button>`).join("")}</div>
    ${missing.length ? `<p class="st-hint">${missing.length === caps.length ? "Start with <b>ElevenLabs</b>: one sign-in gives you images and sounds." : `To make ${missing.map((c) => c.label.toLowerCase()).join(" and ")}, connect a service below that says so.`}</p>` : ""}
    ${missing.some((c) => c.id === "images") ? `<button type="button" class="pc-promo" data-settings-tab="local"><span class="pc-chip">${icon("gpu")}</span><span><strong>No account? Make images free on your own graphics card</strong><small>Tessera checks your PC and installs the right model in one click.</small></span><b>This PC →</b></button>` : ""}
    <div class="acct-list" id="acctList">${PROVIDERS.map((p) => accountCard(p, cfg)).join("")}${modelInboxCard()}</div>
    <div class="fistbump" id="serviceFistbump" hidden></div>
    ${budgetCard(budget)}`;
}

// Who bills an image model: a signed-in service's credits, or one of your API keys.
const m0Via = (m, who) => (String(m.id).startsWith("svc:") ? `${who} credits` : String(m.id).startsWith("local:") ? "nothing: it runs on this PC" : `your ${who} key`);

// ---------- Makers: who does each step of making art. One list per step, whether it runs on this PC, on a key or a
// signed-in service; New art picks the default and every Generate window can switch for one run. ----------

const WHERE = { pc: "On this PC · free", key: "Your key", svc: "Signed in" };
const MAKER_STEPS = [
  ["image", "Image", "Makes the picture"],
  ["cut", "Cut out", "Removes the background"],
  ["mesh", "3D model", "Turns the pick into a mesh"],
  ["sound", "Sounds & voices", "Effects, music and lines"],
];
// Makers that hand back a transparent picture themselves (forge/local_ai/cutout.py has_own_cutout).
const ownCut = (id) => /^(meshy:|svc:|elevenlabs:gpt-image)/.test(String(id || ""));
const localSpeed = (m) => String(m?.speed || "").split(" an image")[0].replace(/^about /, "≈ ");

function whereTag(m) {
  const text = m.where === "pc" ? WHERE.pc : m.where === "key" ? `Your ${m.who || ""} key`.replace("  ", " ") : `${m.who || "Service"} credits`;
  return `<span class="mk-where ${m.where}"><i></i>${esc(text)}</span>`;
}

function makerChoices(step, cfg) {
  const info = state.localInfo || { models: [], deps: [] };
  const sm = state.serviceModels || { image: [], "3d": [] };
  const studio = state.studio || { models: [] };
  const lm = (kind) => (info.models || []).filter((m) => m.kind === kind);
  if (step === "image") {
    const pc = lm("image").filter((m) => m.installed || !LOCAL_WONT.has(m.fit)).map((m) => ({
      id: `local:${m.id}`, name: m.label, where: "pc", ready: m.installed && !(m.missing_deps || []).length,
      act: m.installed ? "Install its dependencies" : "Install on This PC", setup: "local", speed: localSpeed(m), price: "free", refs: false, own: false,
      note: m.personal_only ? "Personal use only" : "" }));
    const keys = (studio.models || []).filter((m) => !m.local).map((m) => {
      const [who, ...rest] = m.label.split(" · ");
      return { id: m.id, name: rest.join(" · ") || m.label, who, where: m.via === "signed in" ? "svc" : "key", ready: !!m.available, act: `Connect ${who}`, setup: "accounts",
        speed: "", price: m.price ? `$${m.price.toFixed(3)}` : "", refs: true, own: ownCut(m.id) };
    });
    const svc = (sm.image || []).map((m) => {
      const [who, ...rest] = m.label.split(" · ");
      return { id: m.id, name: rest.join(" · ") || m.label, who, where: "svc", ready: true, speed: "", price: "credits", refs: true, own: true };
    });
    return [...pc, ...keys, ...svc];
  }
  if (step === "cut") {
    const bi = lm("cutout").find((m) => m.id === "birefnet");
    const biReady = !!(bi?.installed && !(bi.missing_deps || []).length);
    return [
      ...(bi ? [{ id: "birefnet", name: "BiRefNet", where: "pc", ready: biReady, act: bi.installed ? "Install its dependencies" : `Install · ${bi.needed_gb} GB`, setup: "local", speed: "≈ 1 s", price: "free",
        note: "AI cut-out: hair, holes and soft edges. The same model ElevenLabs runs." }] : []),
      { id: "simple", name: "Plain-background cut", where: "pc", ready: true, speed: "instant", price: "free", note: "Built in. Removes flat backgrounds only; shadows and gradients stay." },
    ];
  }
  if (step === "mesh") {
    const keys = [["meshy", "Meshy", "Textures, rigs and animations too"], ["tripo", "Tripo", ""]].map(([id, who, note]) => ({
      id: `keys:${id}`, name: who, who, where: !cfg[`${id}_configured`] && cfg[`${id}_signed_in`] ? "svc" : "key", ready: !!(cfg[`${id}_configured`] || cfg[`${id}_signed_in`]), act: `Connect ${who}`, setup: "accounts", speed: "", price: "credits", note }));
    const svc = (sm["3d"] || []).map((m) => {
      const [who, ...rest] = m.label.split(" · ");
      return { id: m.id, name: rest.join(" · ") || m.label, who, where: "svc", ready: true, speed: "", price: "credits" };
    });
    return [...keys, ...svc];
  }
  const sv = Object.fromEntries((state.services || []).map((x) => [x.id, x.connected]));
  return [
    { id: "elevenlabs", name: "ElevenLabs", who: "ElevenLabs", where: cfg.elevenlabs_configured ? "key" : "svc", ready: !!(cfg.elevenlabs_configured || sv.elevenlabs), act: "Connect ElevenLabs", setup: "accounts", price: "credits", note: "Sound effects, music and voices" },
    { id: "stability", name: "Stable Audio", who: "Stability AI", where: "key", ready: !!cfg.stability_configured, act: "Add a Stability key", setup: "accounts", price: "credits", note: "Sound effects and music" },
  ];
}

// The maker each step uses now. Cut out: "auto" is BiRefNet once it's installed, else the plain cut.
function currentMaker(step, cfg, list = makerChoices(step, cfg)) {
  if (step === "image") return list.find((m) => m.id === (state.studio?.selected || cfg.default_image_model)) || { id: state.studio?.selected || "", name: humanize(String(state.studio?.selected || "Not set").split(/[/:]/).pop()), where: "key", ready: false };
  if (step === "cut") {
    const choice = cfg.cutout_with || "auto";
    const bi = list.find((m) => m.id === "birefnet");
    return choice === "simple" || !bi?.ready ? list.find((m) => m.id === "simple") : bi;
  }
  if (step === "mesh") return list.find((m) => m.id === (cfg.default_3d_service_model || `keys:${cfg.default_3d_provider || "meshy"}`)) || list[0];
  return list.find((m) => m.ready) || list[0];
}

function makerCaps(step, m) {
  if (step !== "image") return m.note ? `<small class="mk-note">${esc(m.note)}</small>` : "";
  return `<div class="mk-caps"><span class="${m.refs ? "good" : "no"}">style refs</span><span>${m.own ? "transparent built in" : "needs a cut-out"}</span>${m.note ? `<span class="warn">${esc(m.note)}</span>` : ""}</div>`;
}

function makerPicker(step, cfg, { title, pickAttr = "data-maker-pick", current = "" } = {}) {
  const list = makerChoices(step, cfg);
  const cur = current ? list.find((m) => m.id === current) || { id: current } : currentMaker(step, cfg, list);
  const groups = [["pc", "On this PC · free, nothing leaves your computer"], ["key", "Your API keys · billed to that account"], ["svc", "Signed-in services · paid in their credits"]];
  const empty = { pc: step === "mesh" ? "Nothing for this step runs on this PC yet." : step === "sound" ? "Nothing for this step runs on this PC yet." : "" };
  return `<div class="mk-picker" role="group" aria-label="${esc(title)}">
    <div class="mk-picker-head"><strong>${esc(title)}</strong><small>${step === "sound" ? "Sounds use whichever of these is connected." : pickAttr === "data-cmp-maker" ? "Just for this run. The default is in Settings → New art." : "Pick once here. Any Generate window can switch for one run."}</small></div>
    ${step === "cut" ? `<label class="mk-own"><input type="checkbox" data-maker-own ${cfg.cutout_prefer_own !== false ? "checked" : ""}><span><b>Let the image maker cut out when it can</b><small>Meshy, GPT Image and signed-in services return transparent pictures themselves. Off: this PC's cutter does every image.</small></span></label>` : ""}
    ${groups.map(([w, label]) => {
      const items = list.filter((m) => m.where === w);
      if (!items.length) return empty[w] ? `<div class="mk-group"><div class="mk-eyebrow">${label}</div><p class="mk-empty">${empty[w]} <button type="button" class="link-btn" data-settings-tab="local">This PC</button></p></div>` : "";
      return `<div class="mk-group"><div class="mk-eyebrow">${label}</div><div class="mk-tiles">${items.map((m) => `
        <button type="button" class="mk-tile${m.id === cur?.id ? " on" : ""}${m.ready ? "" : " dim"}" ${m.ready ? `${pickAttr}="${esc(step)}|${esc(m.id)}"` : `data-maker-setup="${esc(m.setup || "accounts")}"`}>
          <span class="mk-tile-top"><strong>${esc(m.name)}</strong>${m.id === cur?.id ? `<em>✓</em>` : ""}</span>
          ${makerCaps(step, m)}
          <span class="mk-meta"><span>${esc(m.speed || "")}</span><span>${esc(m.price || "")}</span></span>
          ${m.ready ? "" : `<span class="mk-act">${esc(m.act || "Set up")} →</span>`}
        </button>`).join("")}</div></div>`;
    }).join("")}</div>`;
}

function makerStations(cfg) {
  const open = state.makerOpen || "";
  const cards = MAKER_STEPS.map(([step, label, sub]) => {
    const m = currentMaker(step, cfg);
    const off = !m || !m.ready;
    const extra = step === "cut" && cfg.cutout_prefer_own !== false ? "or the image maker's own" : step === "image" && m?.where === "pc" ? m.speed : step === "image" && m?.price ? `${m.price} an image` : sub;
    return `<button type="button" class="mk-station${open === step ? " open" : ""}${off ? " off" : ""}" data-maker-station="${step}" aria-expanded="${open === step}">
      <span class="mk-eyebrow">${label}</span>
      <span class="mk-name">${esc(m?.name || "Not set up")}</span>
      ${m ? whereTag(m) : ""}
      <small>${esc(extra || "")}</small></button>`;
  }).join("");
  const step = MAKER_STEPS.find(([id]) => id === open);
  return `<div class="mk-chain">${cards}</div>
    ${step ? makerPicker(step[0], cfg, { title: `Who ${step[2].charAt(0).toLowerCase()}${step[2].slice(1)}` }) : ""}`;
}

async function pickMaker(step, id) {
  const body = step === "image" ? { default_image_model: id, user_locked_image_model: true }
    : step === "cut" ? { cutout_with: id }
    : step === "mesh" ? (id.startsWith("keys:") ? { default_3d_provider: id.slice(5), default_3d_service_model: "" } : { default_3d_service_model: id })
    : null;
  if (!body) return;
  const cfg = await api("/api/config", { method: "PUT", body });
  if (state.settings) state.settings.cfg = cfg;
  state.agentCfg = { ...(state.agentCfg || {}), ...cfg };
  state.studio = null;
  await studioOptions().catch(() => {});
  return cfg;
}

// New art: who makes each step, then the shape and background of each kind.
function defaultsHTML(cfg, studio) {
  const dim = state.overview?.dimension || "3d";
  return `
    ${makerStations(cfg)}
    ${state.project ? `<div class="set-row"><div><strong>${esc(humanize(state.project))} is a</strong><small>2D hides 3D models, rigs and animations from this project. You can switch any time.</small></div>
      <div class="seg" role="radiogroup">${[["2d", "2D game"], ["3d", "3D game"]].map(([v, l]) => `<label><input type="radio" name="project_dimension" value="${v}" ${(dim === "hybrid" ? "3d" : dim) === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</div></div>` : ""}
    <div class="set-row"><div><strong>Images per Generate</strong><small>How many pictures Generate images and Generate missing make by default.</small></div>
      <select name="image_count" aria-label="Images per Generate">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(cfg.image_count || 1) === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>
    <div class="set-row"><div><strong>Background</strong><small>Applies to every new image unless an asset sets its own.</small></div>
      <select name="image_background_mode" aria-label="Background for new images">${[["auto", "Per kind (table below)"], ["cutout", "Always cut out"], ["scene", "Always kept"]].map(([v, l]) => `<option value="${v}" ${(cfg.image_background_mode || "auto") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="st-label">Each kind of asset</div>
    <div class="kind-table">${Object.entries(studio.kind_defaults || {}).map(([kind, k]) => `<div class="kind-row">
      <span class="kind-name">${kindArt(kind, "")}<strong>${esc(KIND_PLURAL[kind] || humanize(kind))}</strong></span>
      <select data-kind-aspect="${esc(kind)}" aria-label="Shape for ${esc(kind)}">${aspectOptions(k.aspect)}</select>
      <select data-kind-bg="${esc(kind)}" aria-label="Background for ${esc(kind)}"><option value="cutout" ${k.background === "cutout" ? "selected" : ""}>Cut out</option><option value="scene" ${k.background === "scene" ? "selected" : ""}>Full scene</option></select></div>`).join("")}</div>
    <p class="st-note"><b>Cut out</b> suits characters, props and anything that becomes 3D or a sprite; the Cut out step above does it. <b>Full scene</b> keeps the background, for places and key art. Changes save at once.</p>`;
}

function readDefaults(form) {
  const mesh = form.default_3d?.value || "";
  const out = { kind_defaults: Object.fromEntries([...form.querySelectorAll("[data-kind-aspect]")].map((el) => [el.dataset.kindAspect, { aspect: el.value, background: form.querySelector(`[data-kind-bg="${el.dataset.kindAspect}"]`)?.value || "cutout" }])) };
  if (form.image_count) out.image_count = Number(form.image_count.value) || 1;
  if (form.image_background_mode) out.image_background_mode = form.image_background_mode.value;
  if (form.default_image_model) Object.assign(out, { default_image_model: form.default_image_model.value, user_locked_image_model: true });
  if (mesh.startsWith("keys:")) Object.assign(out, { default_3d_provider: mesh.slice(5), default_3d_service_model: "" });
  else if (mesh) out.default_3d_service_model = mesh;
  return out;
}

async function saveDefaults(form, changed) {
  if (changed?.name === "project_dimension") {
    try {
      await api("/api/bible", { method: "PUT", body: { project_dimension: changed.value } });
      if (state.overview) state.overview.dimension = changed.value;
      return toast(changed.value === "2d" ? "2D game: 3D tools are hidden" : "3D game: 3D tools are back");
    } catch (err) { return toast(err.message, true); }
  }
  try {
    await api("/api/config", { method: "PUT", body: readDefaults(form) });
    state.studio = null;
    toast("Saved");
  } catch (err) { toast(err.message, true); }
}

function chatBody(info, cfg) {
  const ready = state.models.filter((m) => m.ready);
  const current = ready.find((m) => m.id === state.model);
  const groups = Object.groupBy(ready, (m) => m.group || m.provider);
  const opt = (values, cur, label = (v) => v) => values.map((v) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${label(v)}</option>`).join("");
  const k = (v) => `${v / 1000}k tokens`;
  return `<h1>Tess</h1>
    <p class="st-lede">Tess plans your game's art with you and makes it. It runs on an AI you already have: log in to a coding agent once, no API key needed.</p>
    <div class="chat-now ${current ? "ok" : "no"}">${current ? `<span class="dot live"></span><span>The chat uses <b>${esc(current.label)}</b></span>` : `<span class="dot"></span><span>The chat has no AI yet. Log in to one below.</span>`}</div>
    <div class="st-label">Your coding agents</div>
    <div class="preset-grid">${(info.clis || []).map((c) => `<button class="preset cli-${cliStatus(c)}" data-cli-login="${esc(c.id)}" title="${esc(c.installed ? c.login : c.install)}"><i><img class="preset-logo" src="${AGENT_LOGO[c.id]}" alt=""></i><strong>${esc(c.label)}</strong><small>${CLI_STATUS_TEXT[cliStatus(c)]}</small>${c.installed && cliStatus(c) !== "waiting" ? `<span class="cli-logout" role="button" tabindex="0" data-cli-logout="${esc(c.id)}" title="Sign ${esc(c.label)} out, then log in again">Log out</span>` : ""}</button>`).join("")}</div>
    ${ready.length ? `<div class="st-label">Ready to use · ${ready.length}</div>
    ${Object.entries(groups).map(([name, items]) => `<div class="conn-group"><div class="conn-head"><strong>${esc(name)}</strong>${items[0].endpoint ? `<button class="link-btn danger-text" data-remove-endpoint="${esc(items[0].endpoint)}">Remove</button>` : ""}</div>
      ${items.map((m) => `<div class="conn-row"><span class="dot live"></span><span>${esc(m.label)}</span><span class="grow"></span>${m.id === state.model ? `<em class="in-use">In use</em>` : `<button class="mini" data-pick-model="${esc(m.id)}" data-settings-refresh>Use</button>`}<span class="test-result" id="test-${esc(m.id).replace(/[^a-z0-9]/gi, "_")}"></span><button class="mini ghost" data-test-model="${esc(m.id)}">Test</button></div>`).join("")}</div>`).join("")}` : ""}
    <details class="st-more"${state.settings.adding ? " open" : ""}><summary>Use an API key or a local model instead</summary>
      ${state.settings.adding ? addModelCard(info) : `<div class="preset-grid">
        ${Object.entries(info.presets).map(([id, p]) => `<button class="preset" data-add-preset="${id}"><i>${PRESET_ICON[id] || "•"}</i><strong>${esc(p.label)}</strong><small>${p.needs_key ? "API key" : id === "custom" ? "Any OpenAI-compatible URL" : "No key needed"}</small></button>`).join("")}</div>`}
    </details>
    <details class="st-more"><summary>Advanced</summary>
      <form id="agentForm" class="agent-form">
        <div class="set-row"><div><strong>Show the chat</strong><small>Automatic hides it while your coding agent works on the project.</small></div>
          <select name="chat_mode">${opt(["auto", "on", "off"], cfg.chat_mode || "auto", (v) => ({ auto: "Automatic", on: "Always", off: "Never" })[v])}</select></div>
        <div class="set-row"><div><strong>How hard it thinks</strong><small>For new chats. Each chat can change it in the model menu.</small></div>
          <select name="agent_reasoning_effort">${opt(["low", "medium", "high", "max"], cfg.agent_reasoning_effort, (v) => EFFORT_LABEL[v])}</select></div>
        <div class="set-row"><div><strong>Shorten long chats</strong><small>Older messages fold into a summary, so long chats stay quick and cheap.</small></div>
          <label class="switch"><input type="checkbox" name="agent_auto_compact" ${cfg.agent_auto_compact ? "checked" : ""}><span></span></label></div>
        <div class="set-row"><div><strong>Shorten at</strong><small>The size of the chat sent with each message.</small></div>
          <select name="agent_compact_at_tokens">${opt([16000, 32000, 48000, 64000, 100000, 128000, 200000], cfg.agent_compact_at_tokens, k)}</select></div>
        <div class="set-row"><div><strong>Keep word for word</strong><small>The newest messages never fold.</small></div>
          <select name="agent_keep_recent_messages">${opt([2, 4, 6, 8, 12, 16], cfg.agent_keep_recent_messages)}</select></div>
        <div class="set-row"><div><strong>Steps per message</strong><small>How many rounds the chat may take for one message.</small></div>
          <select name="agent_max_tool_rounds">${opt([4, 8, 12, 16, 24], cfg.agent_max_tool_rounds)}</select></div>
        <div class="set-row"><div><strong>Claude Code works directly</strong><small>Claude Code models use their own file tools, with no step limit. Generations stay limited to 8 per message.</small></div>
          <label class="switch"><input type="checkbox" name="agent_native_cli" ${cfg.agent_native_cli ? "checked" : ""}><span></span></label></div>
      </form>
    </details>`;
}

// ---------- This PC: free images on the user's own graphics card (forge/local_ai) ----------

const LOCAL_FIT = {
  good: ["ok", () => "Runs well here"],
  slow: ["warn", () => "Runs, but slower here"],
  too_big: ["no", (m) => `Needs a ${m.min_gb} GB card`],
  low_ram: ["no", (m) => `Needs ${m.min_ram_gb} GB of RAM`],
  unsupported: ["no", () => "Needs an NVIDIA card"],
};
const LOCAL_WONT = new Set(["too_big", "low_ram", "unsupported"]);
const DEP_MARK = { pytorch: "PT", "image-libs": "IMG", "cutout-libs": "CUT" };
const gb = (n) => `${Math.round(Number(n || 0) * 10) / 10} GB`;

function localProgress(job) {
  return `<div class="pc-progress"><div class="pc-bar"><i style="width:${Math.max(2, job.percent)}%"></i></div><small>${esc(job.stage)} · ${Math.round(job.percent)}%</small></div>`;
}

function depNames(info, ids) {
  return ids.map((id) => info.deps.find((d) => d.id === id)?.label || id).join(" + ");
}

function localModelRow(m, info) {
  const job = info.install || {};
  const busy = job.status === "running" && job.kind !== "move" && job.model === m.id;
  const other = job.status === "running" && job.model !== m.id;
  const wont = LOCAL_WONT.has(m.fit);
  const [tone, text] = LOCAL_FIT[m.fit] || LOCAL_FIT.unsupported;
  const missing = m.missing_deps || [];
  const badges = (m.recommended && !m.installed ? `<span class="pc-badge best">Best for your PC</span>` : "")
    + (m.installed ? `<span class="pc-badge inst">✓ Installed</span>` : "")
    + (m.personal_only ? `<span class="pc-badge warn">Personal use only</span>` : "")
    + (!m.recommended && m.fit !== "good" ? `<span class="pc-badge ${tone}">${esc(text(m))}</span>` : "");
  const uses = (m.deps || []).length ? `<span>uses <b>${esc(depNames(info, m.deps))}</b></span>` : "";
  const needs = m.installed && missing.length ? `<span class="needs">needs ${esc(depNames(info, missing))} to run</span>` : "";
  const act = busy ? `<button class="ghost mini" data-local-cancel>Stop</button>`
    : wont ? ""
    : m.installed ? `${missing.length ? `<button class="primary mini" data-local-dep-install="${esc(missing[missing.length - 1])}" ${other ? "disabled" : ""}>Install ${esc(depNames(info, missing))}</button>` : ""}<button class="ghost mini" data-local-remove="${esc(m.id)}">Remove</button>`
    : `<button class="${m.recommended ? "primary" : "ghost"}" data-local-install="${esc(m.id)}"${m.personal_only ? " data-local-license" : ""} ${other ? "disabled" : ""}>${m.personal_only ? "Read license & install" : "Install"} · ${m.needed_gb ? `${m.needed_gb} GB` : "already downloaded"}</button>`;
  const failed = job.model === m.id && job.status === "error" ? `<p class="pc-err">${esc(job.error)}</p>` : "";
  return `<div class="pc-row${m.recommended && !m.installed ? " best" : ""}${m.installed ? " on" : ""}">
    <div><div class="pc-name"><strong>${esc(m.label)}</strong>${badges}</div>
      <p>${esc(m.blurb)}</p>
      <div class="pc-facts"><span>speed <b>${esc(m.speed)}</b></span><span>size <b>${gb(m.size_gb)}</b></span>${uses}
        <span>license <a href="${esc(m.license_url)}" target="_blank" rel="noopener">${esc(m.license)}</a></span>${needs}</div></div>
    <div class="pc-act">${act}</div>
    ${busy ? localProgress(job) : ""}${failed}</div>`;
}

function localDepRow(d, info) {
  const job = info.install || {};
  const busy = job.status === "running" && job.model === `dep:${d.id}`;
  const other = job.status === "running" && !busy;
  const used = d.used_by.length ? `used by ${d.used_by.join(", ")}` : d.installed ? "nothing uses it right now" : "";
  const act = busy ? `<button class="ghost mini" data-local-cancel>Stop</button>`
    : d.installed ? `<button class="ghost mini" data-local-dep-remove="${esc(d.id)}">Remove</button>`
    : `<button class="ghost mini" data-local-dep-install="${esc(d.id)}" ${other ? "disabled" : ""}>Install · ${gb(d.size_gb)}</button>`;
  const failed = job.model === `dep:${d.id}` && job.status === "error" ? `<p class="pc-err">${esc(job.error)}</p>` : "";
  return `<div class="pc-dep${d.installed ? " on" : ""}">
    <span class="pc-dep-mark">${DEP_MARK[d.id] || "LIB"}</span>
    <div><strong>${esc(d.label)}</strong><small>${esc(d.blurb)}</small>
      <small>${gb(d.size_gb)}${d.installed ? " · installed" : ""}${used ? ` · ${esc(used)}` : ""}</small></div>
    <div class="pc-act">${act}</div>
    ${busy ? localProgress(job) : ""}${failed}</div>`;
}

function localMemory(info) {
  const hw = info.hardware || {};
  const total = Number(hw.ram_gb || 0);
  if (!total) return "";
  const eng = info.engine || {};
  const held = eng.running ? Number(eng.ram_gb || 0) : 0;
  const others = Math.max(0, Number(info.ram_used_gb || 0) - held);
  const mins = Math.max(1, Math.ceil(Number(eng.frees_in || 0) / 60));
  const right = !eng.running ? "frees itself after use" : eng.busy ? `${esc(eng.model || "a model")} is working` : `${esc(eng.model || "a model")} loaded · frees in ${mins} min`;
  return `<div class="pc-mem">
    <div class="pc-mem-legend"><span>RAM</span><span>${held ? `Tessera holds <b>${gb(held)}</b>` : "Tessera holds nothing"}</span></div>
    <div class="pc-mem-bar"><i style="width:${(others / total) * 100}%;background:#4b4b5a"></i><i class="held" style="width:${(held / total) * 100}%"></i></div>
    <div class="pc-mem-legend"><span>other apps ${gb(others)} of ${gb(total)}</span><span>${right}</span></div>
    ${eng.running && !eng.busy ? `<button class="ghost mini" data-local-free>Free memory now</button>` : ""}</div>`;
}

function localBody(info) {
  if (info.error) return `<h1>This PC</h1><p class="st-note">${esc(info.error)}</p>`;
  const hw = info.hardware || {};
  const ok = hw.backend && hw.backend !== "none";
  const memory = hw.backend === "mps" ? "shared memory" : "video memory";
  const job = info.install || {};
  const moving = job.status === "running" && job.kind === "move";
  const kinds = info.kinds?.length ? info.kinds : [["image", "Images"]];
  const cat = kinds.some(([id]) => id === state.localCat) ? state.localCat : kinds[0][0];
  const list = info.models.filter((m) => (m.kind || "image") === cat);
  const runs = list.filter((m) => !LOCAL_WONT.has(m.fit)), wont = list.filter((m) => LOCAL_WONT.has(m.fit));
  const rec = info.models.find((m) => m.recommended && m.kind === "image");
  const lowDisk = rec && !rec.installed && job.status !== "running" && info.disk_free_gb < rec.needed_gb + 1;
  const anything = info.models.some((m) => m.installed) || info.deps.some((d) => d.installed);
  const drive = (info.folder || "").match(/^[A-Za-z]:/)?.[0];
  return `<h1>This PC</h1>
    <p class="st-lede">Free makers that run on your own graphics card. No account and no credits, and nothing leaves this computer. Each one you install shows up in New art and in every Generate window.</p>
    <div class="pc-hero${ok ? "" : " no"}">
      <span class="pc-chip">${icon("gpu")}</span>
      <div><strong>${esc(hw.gpu || "No graphics card found")}</strong>
        <div class="pc-specs">${ok ? `<span><b>${gb(hw.vram_gb)}</b> ${memory}</span>${hw.ram_gb ? `<span><b>${gb(hw.ram_gb)}</b> RAM</span>` : ""}${info.preset ? `<span><b>${esc(info.preset)}</b> preset</span>` : ""}<span>models on <b>${esc(drive || "this drive")}</b> · ${gb(info.disk_free_gb)} free</span>` : `<span>${esc(hw.reason || "")}</span>`}
          <button class="link-btn" data-local-refresh title="Look at the hardware again">Check again</button></div></div>
      ${ok ? localMemory(info) : ""}</div>
    ${hw.warning ? `<p class="st-hint">${esc(hw.warning)}</p>` : ""}
    ${ok && lowDisk ? `<div class="pc-space"><span><strong>Not enough room on this drive</strong><small>${esc(rec.label)} needs about ${rec.needed_gb} GB and ${info.disk_free_gb} GB is free. Keep the models on another drive.</small></span><button class="primary" data-local-folder>Choose a folder…</button></div>` : ""}
    ${ok ? `<nav class="pc-cats">${kinds.map(([id, label]) => {
      const rows = info.models.filter((m) => (m.kind || "image") === id);
      const have = rows.filter((m) => m.installed).length;
      return `<button class="${cat === id ? "on" : ""}" data-local-cat="${esc(id)}">${esc(label)}<em>${have ? `${have} installed` : rows.length}</em></button>`;
    }).join("")}</nav>
    <div class="pc-lib">${runs.map((m) => localModelRow(m, info)).join("")}
      ${wont.length ? `<details class="pc-wont"><summary>Won't run on this PC · ${wont.length}</summary>${wont.map((m) => localModelRow(m, info)).join("")}</details>` : ""}</div>
    <div class="pc-deps-head"><div class="st-label">Dependencies</div>
      <p>The engine the models above run on. Removing a model keeps these, so the next install is just the download. Remove one here to get its space back.</p></div>
    ${info.deps.map((d) => localDepRow(d, info)).join("")}` : ""}
    <p class="pc-foot">Files live in <code>${esc(info.folder)}</code>.
      ${moving ? "" : `<button class="link-btn" data-local-folder>${anything ? "Move to another folder" : "Change folder"}</button>`}
      ${anything && !moving ? ` · <button class="link-btn danger-text" data-local-remove-all>Remove everything</button>` : ""}</p>
    ${moving ? localProgress(job) : ""}
    ${job.kind === "move" && job.status === "error" ? `<p class="pc-err">${esc(job.error)}</p>` : ""}`;
}

function drawLocal(info) {
  state.localInfo = info;
  const body = $("#settingsView .st-body");
  if (body?.dataset.tab === "local" && !$("#settingsView").hidden) body.innerHTML = localBody(info);
}

// While an install runs, the page asks for its progress every second; while a model is loaded, every few seconds
// so the memory meter and its countdown stay true.
function pollLocal(info, st) {
  clearTimeout(state.localPoll);
  const installing = info?.install?.status === "running";
  if (!installing && !info?.engine?.running) return;
  state.localPoll = setTimeout(async () => {
    if (state.settings !== st || st.tab !== "local" || $("#settingsView").hidden) return;
    const next = await api("/api/local-ai").catch(() => null);
    if (!next) return pollLocal(info, st);
    if (installing && next.install.status !== "running") localInstallEnded(next);
    drawLocal(next);
    pollLocal(next, st);
  }, installing ? 1000 : 5000);
}

function localInstallEnded(info) {
  const job = info.install;
  if (job.kind === "move") {
    if (job.status === "done") toast(`Moved: local models now live in ${info.folder}`);
    else if (job.status === "error") toast(job.error, true);
    return;
  }
  const dep = String(job.model || "").startsWith("dep:") && info.deps.find((d) => `dep:${d.id}` === job.model);
  const m = info.models.find((x) => x.id === job.model);
  if (job.status === "done") {
    toast(dep ? `${dep.label} is installed` : m?.kind === "cutout" ? `${m.label} is ready: it cuts out backgrounds now` : `${m?.label || "The model"} is ready: new images are free`);
    state.studio = null;
    studioOptions().catch(() => {});
  } else if (job.status === "error") toast(job.error, true);
}

// "FLUX.1 schnell needs PyTorch and the image libraries first": one dialog listing what gets added, and its size.
function askLocal({ title, text, rows, total, yes, danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "pc-ask";
    el.innerHTML = `<div class="pc-ask-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><p>${text}</p>
      ${rows?.length ? `<div class="pc-ask-list">${rows.map((r) => `<div><span><strong>${esc(r.label)}</strong>${r.blurb ? `<small>${esc(r.blurb)}</small>` : ""}</span>${r.size_gb != null ? `<b>${gb(r.size_gb)}</b>` : ""}</div>`).join("")}</div>` : ""}
      ${total ? `<div class="pc-ask-total"><span>Total download</span><b>${esc(total)}</b></div>` : ""}
      <div class="pc-ask-btns"><button class="ghost" data-no>Cancel</button><button class="${danger ? "danger" : "primary"}" data-yes>${esc(yes)}</button></div></div>`;
    const done = (answer) => { el.remove(); document.removeEventListener("keydown", key, true); resolve(answer); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest("[data-no]")) done(false);
      else if (e.target.closest("[data-yes]")) done(true);
    });
    document.addEventListener("keydown", key, true);
    document.body.append(el);
    el.querySelector("[data-yes]").focus();
  });
}

async function installLocalModel(id, accept) {
  const body = { model: id, accept_license: accept };
  try {
    return await api("/api/local-ai/install", { method: "POST", body });
  } catch (err) {
    if (err.status !== 409 || !err.detail?.missing) throw err;
    const info = state.localInfo || await api("/api/local-ai");
    const m = info.models.find((x) => x.id === id);
    const missing = err.detail.missing;
    const deps = missing.reduce((n, d) => n + Number(d.size_gb || 0), 0);
    const ok = await askLocal({
      title: `Install ${missing.map((d) => d.label).join(" + ")} too?`,
      text: `${esc(m?.label || "This model")} runs on ${missing.length > 1 ? "these" : "this"}. ${missing.length > 1 ? "They install" : "It installs"} once and stay${missing.length > 1 ? "" : "s"} when you remove models, so other models use ${missing.length > 1 ? "them" : "it"} too.`,
      rows: [...missing, { label: m?.label || id, blurb: "The model itself", size_gb: Math.max(0, Number(m?.needed_gb || 0) - deps) }],
      total: gb(m?.needed_gb || deps),
      yes: "Install all",
    });
    if (!ok) return null;
    return api("/api/local-ai/install", { method: "POST", body: { ...body, install_deps: true } });
  }
}

$("#settingsView").addEventListener("click", async (event) => {
  const b = event.target.closest("[data-local-install],[data-local-cancel],[data-local-remove],[data-local-remove-all],[data-local-refresh],[data-local-folder],[data-local-cat],[data-local-free],[data-local-dep-install],[data-local-dep-remove]");
  if (!b) return;
  const st = state.settings;
  const show = (info) => { if (info) { drawLocal(info); pollLocal(info, st); } };
  try {
    if (b.dataset.localCat) {
      state.localCat = b.dataset.localCat;
      if (state.localInfo) drawLocal(state.localInfo);
    } else if (b.dataset.localInstall) {
      const m = (state.localInfo || await api("/api/local-ai")).models.find((x) => x.id === b.dataset.localInstall);
      const accept = b.matches("[data-local-license]");
      if (accept && !await askLocal({
        title: `${m?.label || "This model"}: personal use only`,
        text: `Its license is non-commercial: you may use the images it makes in a commercial game, but not the model itself for commercial work. <a href="${esc(m?.license_url || "#")}" target="_blank" rel="noopener">Read the license</a>.`,
        yes: "Accept and install",
      })) return;
      b.disabled = true;
      const info = await installLocalModel(b.dataset.localInstall, accept);
      if (!info) { b.disabled = false; return; }
      show(info);
    } else if (b.dataset.localDepInstall) {
      b.disabled = true;
      show(await api("/api/local-ai/install", { method: "POST", body: { dep: b.dataset.localDepInstall } }));
    } else if (b.dataset.localDepRemove) {
      const d = (state.localInfo?.deps || []).find((x) => x.id === b.dataset.localDepRemove);
      const label = d?.label || b.dataset.localDepRemove;
      const users = d?.used_by || [];
      const ok = await askLocal({
        title: `Remove ${label}?`,
        text: users.length
          ? `${esc(users.join(", "))} ${users.length > 1 ? "need" : "needs"} it, and won't run until you install it again. Their files stay on disk.`
          : `Gives back about ${gb(d?.size_gb)}. You can install it again any time.`,
        yes: "Remove", danger: true,
      });
      if (!ok) return;
      b.disabled = true;
      show(await api("/api/local-ai/remove", { method: "POST", body: { dep: b.dataset.localDepRemove, force: true } }));
      toast(`${label} removed`);
      state.studio = null;
    } else if (b.matches("[data-local-free]")) {
      b.disabled = true;
      const held = state.localInfo?.engine?.ram_gb;
      show(await api("/api/local-ai/free", { method: "POST", body: {} }));
      toast(`Freed ${held ? gb(held) : "the memory"}. The next image loads the model again.`);
    } else if (b.matches("[data-local-cancel]")) {
      show(await api("/api/local-ai/cancel", { method: "POST", body: {} }));
      toast("Stopped. Installing again picks up where it left off.");
    } else if (b.dataset.localRemove) {
      const m = (state.localInfo?.models || []).find((x) => x.id === b.dataset.localRemove);
      if (!await askLocal({
        title: `Remove ${m?.label || "this model"}?`,
        text: "Deletes its files. PyTorch and the other dependencies stay, so installing it again is only the download.",
        yes: "Remove", danger: true,
      })) return;
      show(await api("/api/local-ai/remove", { method: "POST", body: { model: b.dataset.localRemove } }));
      state.studio = null;
    } else if (b.matches("[data-local-remove-all]")) {
      if (!await askLocal({
        title: "Remove everything?",
        text: "Deletes every local model and every dependency, PyTorch included. You can install again later.",
        yes: "Remove everything", danger: true,
      })) return;
      show(await api("/api/local-ai/remove", { method: "POST", body: { everything: true } }));
      state.studio = null;
    } else if (b.matches("[data-local-folder]")) {
      let folder = "";
      try { folder = (await api("/api/system/choose-folder", { method: "POST", body: { title: "Where should Tessera keep local models?" } })).folder_path; }
      catch { folder = prompt("Paste a folder on a drive with room, like D:\\AI") || ""; }
      if (!folder) return;
      const info = await api("/api/local-ai/folder", { method: "POST", body: { folder } });
      show(info);
      if (info.install?.kind !== "move" || info.install.status !== "running") toast(`Local models go to ${info.folder}`);
    } else {
      b.disabled = true;
      show(await api("/api/local-ai?refresh=true"));
    }
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

async function renderSettings() {
  const st = state.settings;
  st.tab = SETTINGS_ALIAS[st.tab] || st.tab;
  if (!SETTINGS_TABS.some(([id]) => id === st.tab)) st.tab = "accounts";
  const tab = st.tab;
  const nav = SETTINGS_TABS.map(([id, label]) => `<button class="${tab === id ? "on" : ""}" data-settings-tab="${id}">${label}</button>`).join("");
  const draw = (body) => {
    if (state.settings !== st || st.tab !== tab || $("#settingsView").hidden) return;
    const same = $("#settingsView .st-body")?.dataset.tab === tab;
    const scroll = same ? $("#settingsView .st-body").scrollTop : 0;
    const open = same ? [...document.querySelectorAll("#settingsView details[open] > summary")].map((s) => s.textContent) : [];
    $("#settingsView").innerHTML = `
      <header class="pv-top"><div class="app-brand static"><img class="app-mark" src="ui/tessera-mark.svg" alt=""><span class="app-word">Tessera<small>Settings</small></span></div>
        <button class="icon-btn" type="button" data-close-settings title="Close" aria-label="Close">✕</button></header>
      <div class="st-main"><nav class="st-nav">${nav}</nav><div class="st-body" data-tab="${tab}">${body}</div></div>`;
    document.querySelectorAll("#settingsView details > summary").forEach((s) => { if (open.includes(s.textContent)) s.parentElement.open = true; });
    $("#settingsView .st-body").scrollTop = scroll;
  };
  if ($("#settingsView .st-nav")) $("#settingsView .st-nav").innerHTML = nav; // the tab lights up at once
  // Draw what is known now; answers that take a moment (signed-in services' models) redraw when they come.
  if (tab === "accounts" || tab === "images") {
    const [cfg, budget] = await Promise.all([api("/api/config"), tab === "accounts" ? api("/api/budget").catch(() => null) : null, studioOptions(), state.services ? null : loadServices(), state.models.length ? null : loadModels(),
      tab === "images" ? api("/api/local-ai").then((info) => { state.localInfo = info; }).catch(() => {}) : null]);
    st.cfg = cfg;
    const body = () => (tab === "accounts" ? accountsBody(cfg, budget)
      : `<h1>New art</h1><p class="st-lede">How your art gets made: one maker per step. Click a step to change who does it; this PC, your keys and your signed-in services are all in the same list. One asset can still switch in its Generate window.</p><form id="defaultsForm" class="gen-defaults">${defaultsHTML(cfg, state.studio)}</form>`);
    draw(body());
    if (state.serviceModels?.loading) state.serviceModelsReady.then(() => draw(body()));
    // Tripo's credits come from Tripo itself, so they fill in after the page is up.
    if (tab === "accounts" && cfg.tripo_configured) api("/api/tripo").then((t) => { state.tripo = t; draw(body()); }).catch(() => {});
    if (tab === "accounts") api("/api/model-inbox").then((box) => { state.modelInbox = box; draw(body()); }).catch(() => {});
  } else if (tab === "models") {
    const [cfg] = await Promise.all([api("/api/config"), state.modelInfo ? null : loadModels()]);
    draw(chatBody(state.modelInfo || { presets: {}, clis: [] }, cfg));
    loadModels().then(() => draw(chatBody(state.modelInfo || { presets: {}, clis: [] }, cfg)));
  } else if (tab === "local") {
    const info = await api("/api/local-ai").catch((err) => ({ error: err.message }));
    if (!info.error) state.localInfo = info;
    draw(localBody(info));
    pollLocal(info, st);
  } else if (tab === "connect") {
    draw(await connectSettings());
  } else {
    draw(await filesSettings());
  }
}

$("#settingsView").addEventListener("click", async (event) => {
  const b = event.target.closest("[data-maker-station],[data-maker-pick],[data-maker-setup]");
  if (!b || !$("#defaultsForm")?.contains(b)) return;
  const redraw = () => { const form = $("#defaultsForm"); if (form && state.settings?.cfg) form.innerHTML = defaultsHTML(state.settings.cfg, state.studio || {}); };
  if (b.dataset.makerStation) {
    state.makerOpen = state.makerOpen === b.dataset.makerStation ? "" : b.dataset.makerStation;
    return redraw();
  }
  if (b.dataset.makerSetup) {
    state.makerOpen = "";
    return settingsDialog(b.dataset.makerSetup === "local" ? "local" : "accounts");
  }
  const [step, id] = b.dataset.makerPick.split("|");
  try {
    await pickMaker(step, id);
    state.makerOpen = "";
    redraw();
    const m = makerChoices(step, state.settings.cfg).find((x) => x.id === id);
    toast(`${MAKER_STEPS.find(([x]) => x === step)[1]}: ${m?.name || "saved"}`);
  } catch (err) { toast(err.message, true); }
});

// Settings save as they change: no Save button to forget.
$("#settingsView").addEventListener("change", async (event) => {
  const form = event.target.form;
  if (event.target.matches?.("[data-maker-own]")) {
    try {
      state.settings.cfg = await api("/api/config", { method: "PUT", body: { cutout_prefer_own: event.target.checked } });
      state.agentCfg = { ...(state.agentCfg || {}), ...state.settings.cfg };
      $("#defaultsForm").innerHTML = defaultsHTML(state.settings.cfg, state.studio || {});
      toast(event.target.checked ? "Makers with their own cut-out use it" : "This PC cuts out every image");
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (form?.id === "defaultsForm") return saveDefaults(form, event.target);
  if (form?.id !== "agentForm") return;
  const updates = {
    agent_reasoning_effort: form.agent_reasoning_effort.value,
    agent_auto_compact: form.agent_auto_compact.checked,
    agent_compact_at_tokens: Number(form.agent_compact_at_tokens.value),
    agent_keep_recent_messages: Number(form.agent_keep_recent_messages.value),
    agent_max_tool_rounds: Number(form.agent_max_tool_rounds.value),
    agent_native_cli: form.agent_native_cli.checked,
    chat_mode: form.chat_mode.value,
  };
  try { await api("/api/config", { method: "PUT", body: updates }); state.agentCfg = { ...state.agentCfg, ...updates }; toast("Saved"); syncComposer(); applyChatMode(); } catch (err) { toast(err.message, true); }
});

$("#settingsView").addEventListener("submit", async (event) => {
  const form = event.target.closest(".acct-key-form");
  if (!form || form.classList.contains("tripo-connect-form")) return; // Tripo's own handler checks the key first
  event.preventDefault();
  const input = form.querySelector("input");
  if (!input.value.trim()) return input.focus();
  try {
    await api("/api/config", { method: "PUT", body: { [input.name]: input.value.trim() } });
    state.studio = null;
    loadServiceModels();
    toast("✓ Key saved");
    await renderSettings();
  } catch (err) { toast(err.message, true); }
});

// A capability that isn't set up points at the services that give it.
document.addEventListener("click", (event) => {
  const jump = event.target.closest("[data-cap-jump]");
  if (!jump) return;
  const want = { images: /image/i, "3d": /3d/i, sounds: /sound|music/i }[jump.dataset.capJump];
  const cards = [...document.querySelectorAll("#acctList .acct")].filter((el) => want?.test(el.querySelector("small")?.textContent || ""));
  cards[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
  for (const card of cards) { card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1600); }
});

async function filesSettings() {
  const [a, info, grants, health] = await Promise.all([api("/api/about"), api("/api/storage"), loadGrants(), api("/api/health").catch(() => ({})), state.update ? null : checkForUpdate()]);
  const shortcut = a.shortcuts.length
    ? `<p class="st-note">Open Tessera any time with the <strong>Tessera</strong> shortcut on your desktop or in the Start menu.${a.background ? " Closing the window leaves Tessera running; its icon in the taskbar tray opens or quits it." : ""}</p>`
    : `<p class="st-note">There's no Tessera shortcut yet. Add one to open Tessera without a terminal or an agent.</p>`;
  return `
    <h1>Files & app</h1><p class="st-lede">Tessera ${esc(a.version)} runs on this computer. Here is where your work is saved and how to open Tessera again.</p>
    <div class="st-label">Open Tessera</div>
    ${shortcut}
    <div class="row wrap"><button class="ghost" data-st-shortcut>${a.shortcuts.length ? "Make the shortcut again" : "Add a Tessera shortcut"}</button>${health.background ? `<button class="ghost danger-text" data-st-quit>Quit Tessera</button>` : ""}</div>
    <div class="st-label">Your projects</div>
    <div class="path-row"><code>${esc(info.projects_dir)}</code><button class="mini" data-st-open="projects">Open</button><button class="mini" data-st-move>Move…</button></div>
    ${state.project ? `<div class="st-label">This project · ${esc(humanize(state.project))}</div>
    <div class="path-row"><code>${esc(info.workspace_dir)}</code><button class="mini" data-st-open="workspace">Open</button></div>` : ""}
    <div class="row wrap">${state.project ? `<button class="ghost" data-st-export="${esc(state.project)}">Save as .zip…</button>` : ""}<button class="ghost" data-st-import-zip>Open a .zip…</button><button class="ghost" data-imp-open>Import a game…</button></div>
    ${updateSettings()}
    <details class="st-more"><summary>Advanced</summary>
      <div class="st-label">Folders Tess may use</div>
      <div class="grant-list">${grantRows(grants)}</div>
      <div class="row"><button class="ghost" data-grant-add>+ Add a folder</button></div>
      <p class="st-note">Tess can read these folders, and write in them when allowed. API keys and .env files are always off-limits. When Tess needs another folder, she asks in the chat.</p>
      <div class="st-label">Where Tessera is installed · ${esc(INSTALL_KIND[a.install_kind] || a.install_kind)}</div>
      <div class="path-row"><code>${esc(a.install_dir)}</code><button class="mini" data-st-open="install">Open</button></div>
      <div class="st-label">Settings and keys</div>
      <div class="path-row"><code>${esc(a.config_dir)}</code><button class="mini" data-st-open="config">Open</button></div>
      <p class="st-note">If something goes wrong, the log is <code>${esc(a.log)}</code>.</p>
      <div class="row"><button class="ghost" data-setup-open>Run the welcome setup again</button></div>
    </details>`;
}

// ---------- coding agent: connect the game folder ----------

const TRY_PROMPTS = [
  "Copy the Tessera art for the main character into the game and use it instead of the placeholder.",
  "Check tessera/ASSETS.md and tell me which art the game still needs.",
];

async function loadConnect() {
  try { state.connect = await api("/api/connect"); } catch { state.connect = null; }
  applyChatMode();
  return state.connect;
}

async function connectSettings() {
  const cn = await loadConnect();
  const draft = (state.cnDraft ||= { folder: "" });
  const how = `<div class="cn-how">
      <div><b>1</b><span>You make the art here in Tessera, with Tess or by hand.</span></div>
      <div><b>2</b><span>Tessera keeps <code>tessera/ASSETS.md</code> in your game: every asset and its finished files.</span></div>
      <div><b>3</b><span>Your coding agent reads it and copies the art it needs into the game. Nothing to install or restart.</span></div>
    </div>`;
  if (!cn?.connected) {
    return `<h1>Your game</h1>
      <p class="st-lede">Link ${esc(humanize(state.project))} to your game folder. Tessera writes a short note into <code>AGENTS.md</code> and <code>CLAUDE.md</code> so any coding agent (Claude Code, Codex, Cursor, Copilot…) knows where the finished art is.</p>
      ${how}
      <div class="st-label">Game folder</div>
      <div class="cn-pick"><input id="cnFolder" placeholder="/path/to/your/game" value="${esc(draft.folder)}" spellcheck="false"><button class="ghost" data-cn-browse>Browse…</button></div>
      <div class="row"><button class="primary" data-cn-connect>Link ${esc(humanize(state.project))}</button></div>
      <p class="st-note">Tessera only adds its own note (between <code>tessera:start</code> and <code>tessera:end</code>) and <code>tessera/ASSETS.md</code>. Your code is never changed, and Unlink removes the note again.</p>`;
  }
  return `<h1>Your game</h1>
    <p class="st-lede">${esc(humanize(state.project))} is linked to your game. Coding agents working there copy finished art from <code>tessera/ASSETS.md</code>.</p>
    <div class="cn-card">
      <div class="cn-top"><span class="dot ${cn.healthy ? "live" : "warn"}"></span><div><strong>${esc(cn.game_name)}</strong><small>${esc(cn.game_folder)}</small></div>
        <button class="mini" data-cn-open>Open folder</button></div>
      ${cn.healthy ? `<p class="st-note">Note in ${(cn.notes || ["AGENTS.md"]).map((n) => `<code>${esc(n)}</code>`).join(", ")}.</p>` : `<p class="cn-warn">Tessera's note in <code>AGENTS.md</code> is missing. <button class="link-btn" data-cn-connect>Write it again</button></p>`}
    </div>
    ${how}
    <div class="st-label">Try it: say this to your agent</div>
    <div class="cn-tries">${TRY_PROMPTS.map((p) => `<button type="button" class="cn-try" data-cn-copy="${esc(p)}"><span>${esc(p)}</span><i>Copy</i></button>`).join("")}</div>
    <p class="st-note"><button class="link-btn danger-text" data-cn-disconnect>Unlink</button></p>`;
}

async function connectGame() {
  const folder = $("#cnFolder") ? $("#cnFolder").value.trim() : state.connect?.game_folder;
  if (!folder) return toast("Choose your game folder first.", true);
  try {
    state.connect = await api("/api/connect", { method: "POST", body: { folder } });
    state.cnDraft = null;
    toast(`Linked to ${state.connect.game_name}. Your coding agent finds the art in tessera/ASSETS.md.`);
  } catch (err) { return toast(err.message, true); }
  applyChatMode();
  return inSetup() ? renderSetup() : renderSettings();
}

const inSetup = () => Boolean(state.setup) && !$("#setup").hidden;

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-cn-browse],[data-cn-connect],[data-cn-disconnect],[data-cn-open],[data-cn-copy]");
  if (!t) return;
  const d = t.dataset;
  const draft = (state.cnDraft ||= { folder: "" });
  if ($("#cnFolder")) draft.folder = $("#cnFolder").value.trim();
  const rerender = () => (inSetup() ? renderSetup() : renderSettings());
  if (d.cnBrowse !== undefined) {
    const folder = await chooseFolder("Choose your game folder");
    if (!folder) return;
    draft.folder = folder;
    return rerender();
  }
  if (d.cnConnect !== undefined) return connectGame();
  if (d.cnDisconnect !== undefined) {
    if (!(await ask({ title: "Unlink the game?", body: "Tessera removes its note from the game folder. The art in tessera/ stays.", ok: "Unlink", danger: true }))) return;
    try { state.connect = await api("/api/connect", { method: "DELETE" }); } catch (err) { return toast(err.message, true); }
    applyChatMode();
    return rerender();
  }
  if (d.cnOpen !== undefined) {
    try { await api("/api/storage/open", { method: "POST", body: { target: "grant", path: state.connect.game_folder } }); } catch (err) { toast(err.message, true); }
    return;
  }
  if (d.cnCopy) {
    try { await navigator.clipboard.writeText(d.cnCopy); toast("Copied"); } catch { toast("Copy failed", true); }
  }
});

function budgetCard(b) {
  if (!b) return "";
  const spent = Number(b.spent_usd ?? b.total_spent_usd ?? b.spent ?? 0);
  const cap = Number(b.spend_cap_usd ?? b.cap_usd ?? 0);
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return `<div class="budget-card${cap && spent >= cap ? " with-art" : ""}">${cap && spent >= cap ? tessArt("budget", "sm") : ""}<div><strong>$${spent.toFixed(2)}</strong><span> spent in ${esc(humanize(state.project))}${cap ? ` of a $${cap.toFixed(2)} limit` : ""}</span></div>
    ${cap ? `<span class="meter"><i style="width:${pct}%"></i></span>` : ""}<small>Counted from what the providers report for each image, model and sound.</small></div>`;
}

function addModelCard(info) {
  const a = state.settings.adding;
  const preset = info.presets[a.preset];
  const showUrl = a.preset === "custom" || !preset.needs_key;
  return `<div class="add-card">
    <div class="add-head"><i>${PRESET_ICON[a.preset] || "•"}</i><div><strong>Connect ${esc(preset.label)}</strong><small>${preset.key_url ? `<a href="${preset.key_url}" target="_blank" rel="noopener">Get a key ↗</a>` : "Runs on your machine or your own server."}</small></div>
      <button class="link-btn" data-cancel-add>Cancel</button></div>
    ${showUrl ? `<label>Endpoint URL<input id="addUrl" value="${esc(a.base_url ?? preset.base_url)}" placeholder="https://my-server/v1"></label>` : ""}
    ${preset.needs_key || a.preset === "custom" ? `<label>API key${preset.needs_key ? "" : " (if needed)"}<input id="addKey" type="password" autocomplete="off" value="${esc(a.api_key || "")}" placeholder="Paste your key"></label>` : ""}
    ${a.models ? `<label>Name<input id="addName" value="${esc(a.name ?? preset.label)}"></label>
      <div class="model-check-head"><span>${a.models.length} models found · pick the ones you want</span><input id="addFilter" placeholder="Filter…" value="${esc(a.filter || "")}"></div>
      <div class="model-checks">${a.models.filter((m) => !a.filter || m.toLowerCase().includes(a.filter.toLowerCase())).slice(0, 200).map((m) => `<label class="model-check"><input type="checkbox" data-pick-check="${esc(m)}" ${a.picked.includes(m) ? "checked" : ""}><span>${esc(m)}</span></label>`).join("")}</div>
      <div class="row"><button class="primary" data-save-endpoint ${a.picked.length ? "" : "disabled"}>Add ${a.picked.length || ""} model${a.picked.length === 1 ? "" : "s"}</button></div>`
      : `<div class="row"><button class="primary" data-probe>${a.busy ? "Connecting…" : "Connect"}</button></div>`}
  </div>`;
}

function syncAddCard() {
  const a = state.settings.adding;
  if (!a) return;
  if ($("#addUrl")) a.base_url = $("#addUrl").value.trim();
  if ($("#addKey")) a.api_key = $("#addKey").value.trim();
  if ($("#addName")) a.name = $("#addName").value.trim();
  if ($("#addFilter")) a.filter = $("#addFilter").value;
}

async function probeEndpoint() {
  syncAddCard();
  const a = state.settings.adding;
  a.busy = true;
  await renderSettings();
  try {
    const { models } = await api("/api/agent/endpoints/probe", { method: "POST", body: a });
    if (!models.length) throw new Error("Connected, but the endpoint lists no models.");
    a.models = models;
    a.picked = models.length <= 3 ? [...models] : [];
  } catch (err) { toast(err.message, true); }
  a.busy = false;
  await renderSettings();
}

async function saveEndpoint() {
  syncAddCard();
  const a = state.settings.adding;
  try {
    await api("/api/agent/endpoints", { method: "POST", body: { preset: a.preset, name: a.name, base_url: a.base_url, api_key: a.api_key, models: a.picked } });
    state.settings.adding = null;
    toast(`Added ${a.picked.length} model${a.picked.length === 1 ? "" : "s"}`);
    await renderSettings();
    renderMessages();
  } catch (err) { toast(err.message, true); }
}

const KIND_PLURAL = { character: "Characters", creature: "Creatures", item: "Items", weapon: "Weapons", prop: "Props", vehicle: "Vehicles", environment: "Places", level: "Levels", material: "Materials", kit: "Modular kits", ui: "UI", vfx: "Effects" };

async function testModel(id) {
  const out = $(`#test-${id.replace(/[^a-z0-9]/gi, "_")}`);
  if (out) { out.className = "test-result"; out.textContent = "Testing…"; }
  try {
    await api("/api/agent/test", { method: "POST", body: { model: id } });
    if (out) { out.className = "test-result ok"; out.textContent = "Works"; }
  } catch (err) {
    if (out) { out.className = "test-result bad"; out.textContent = "Failed"; out.title = err.message; }
    toast(err.message, true);
  }
}

// Image models grouped by provider, each group saying how Tessera reaches it: a pasted key, a sign-in, or nothing yet.
const MODEL_VIA = { "API key": "uses your API key", "signed in": "uses your Meshy sign-in", "this PC": "free, runs on your graphics card" };
function imageModelOptions(models, selected) {
  return Object.entries(Object.groupBy(models, (m) => m.label.split(" · ")[0])).map(([provider, items]) => {
    const via = items.find((m) => m.via)?.via;
    const how = via ? MODEL_VIA[via] || via : "not set up yet: Settings → Generators";
    return `<optgroup label="${esc(provider)} · ${esc(how)}">${items.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""} ${m.available ? "" : "disabled"}>${esc(m.label.split(" · ").slice(1).join(" · ") || m.label)} · ${m.local ? "free" : `$${m.price.toFixed(3)}`}</option>`).join("")}</optgroup>`;
  }).join("");
}

function openDialog(html) {
  const dlg = $("#dialog");
  dlg.innerHTML = html;
  dlg.showModal();
}
function closeDialog() { $("#dialog").close(); }

// ---------- overview ----------

async function loadOverview() {
  try {
    [state.overview, state.upgrade] = await Promise.all([
      api("/api/overview"),
      api(`/api/projects/${encodeURIComponent(state.project)}/upgrade`).catch(() => null),
    ]);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  $("#projectName").textContent = projectTitle();
  document.title = `${projectTitle()} · Tessera Studio`;
  await renderView();
  loadAssetIndex();
  loadRequests();
  if (state.view.type !== "pipeline") loadLink();
}

function projectTitle() {
  return state.overview?.title || humanize(state.project);
}

function renderSections() {
  const ov = state.overview;
  const active = PLAIN_VIEWS.includes(state.view.type) ? "" : (state.view.path || "").split("/")[0];
  const sections = ov.sections.filter((s) => s.path !== "levels");  // the Levels button above is that folder's way in
  $("#sections").innerHTML = `
    <button class="sec vault-sec${state.view.type === "home" ? " active" : ""}" data-home>${icon("layers")}<span class="sec-name">Overview</span></button>
    <button class="sec vault-sec${state.view.type === "pipeline" || state.view.type === "vault" ? " active" : ""}" data-pipeline title="Every asset, from request to the copy in your game (P)">${icon("flow")}<span class="sec-name">Pipeline</span>${pipelineBadge()}</button>
    <div class="sec-label">Studios</div>
    <button class="sec vault-sec${state.view.type === "nodes" ? " active" : ""}" data-flow-nav>${icon("nodes")}<span class="sec-name">Node Studio</span></button>
    <button class="sec vault-sec${state.view.type === "pixel" ? " active" : ""}" data-pixel-nav>${icon("grid")}<span class="sec-name">Pixel Studio</span></button>
    <button class="sec vault-sec${state.view.type === "motion" ? " active" : ""}" data-motion-nav>${icon("bones")}<span class="sec-name">Motion Studio</span></button>
    <button class="sec vault-sec${state.view.type === "levels" || (state.view.path || "").startsWith("levels/") ? " active" : ""}" data-levels>${icon("map")}<span class="sec-name">Levels</span></button>
    ${sections.length ? `<div class="sec-label">Sections</div>` : `<div class="tip">Tell Tess about your game and its sections appear here.</div>`}
    ${sections.map((s) => `<button class="sec${s.path === active ? " active" : ""}" data-folder="${esc(s.path)}"><span class="sec-name">${esc(s.title)}</span>${s.children?.length ? `<span class="caret${s.path === active ? " open" : ""}"></span>` : ""}</button>${s.path === active ? subTree(s.children) : ""}`).join("")}
    <div class="spacer"></div>`;
}

// A section's subsections: places on the section's page, so a click glides there. Deeper folders are labels
// inside their subsection, so the tree stops at one level.
function subTree(nodes) {
  if (!nodes?.length) return "";
  const cur = state.view.type === "home" ? "" : state.view.path || "";
  const here = state.view.type === "doc" ? dirOf(cur) : cur;
  return `<div class="sub">${nodes.map((n) => {
    const onPath = here === n.path || here.startsWith(`${n.path}/`);
    return `<button class="sub-item${onPath ? " active" : ""}" data-folder="${esc(n.path)}">${esc(n.title)}</button>`;
  }).join("")}</div>`;
}

function renderCrumbs() {
  refreshChatEmpty();
  const parts = [];
  const path = state.view.path || "";
  if (state.view.type === "home") parts.push(`<strong>Overview</strong>`);
  else if (state.view.type === "vault") parts.push(`<button data-pipeline>Pipeline</button>`, `<span class="sep">/</span>`, `<strong>Export</strong>`);
  else if (state.view.type === "pipeline") parts.push(`<strong>Pipeline</strong>`);
  else if (state.view.type === "levels") parts.push(`<strong>Levels</strong>`);
  else if (state.view.type === "pixel") parts.push(state.pixelSel ? `<button data-px-crumb>Pixel Studio</button><span class="sep">/</span><strong>${esc(humanize(state.pixelSel.path.split("/").pop().replace(/\.md$/, "")))}</strong>` : `<strong>Pixel Studio</strong>`);
  else if (state.view.type === "motion") parts.push(state.motionSel ? `<button data-motion-nav>Motion Studio</button><span class="sep">/</span><strong>${esc(state.motionSel.title || "")}</strong>` : `<strong>Motion Studio</strong>`);
  else if (state.view.type === "nodes") parts.push(state.flowSel && flowsLoaded?.title() ? `<button data-flow-nav>Node Studio</button><span class="sep">/</span><strong>${esc(flowsLoaded.title())}</strong>` : `<strong>Node Studio</strong>`);
  else if (state.view.type === "board") parts.push(`<strong>Board</strong>`);
  else {
    const segs = path.split("/");
    segs.forEach((seg, idx) => {
      const sub = segs.slice(0, idx + 1).join("/");
      if (idx) parts.push(`<span class="sep">/</span>`);
      const last = idx === segs.length - 1;
      parts.push(last ? `<strong>${esc(humanize(seg))}</strong>` : `<button data-folder="${esc(sub)}">${esc(humanize(seg))}</button>`);
    });
  }
  $("#crumbs").innerHTML = parts.join("");
  $("#backBtn").disabled = state.view.type === "home";
}


const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Multi-select on a folder page: tick assets, then run one action (Make 3D) on all of them with the same settings.
// The selection lives across folders: tick a few in Props, open Monsters, tick more, then run one action on all.
const selecting = (folderPath) => Boolean(state.select?.on && folderPath !== undefined);

// "12 selected" or "12 selected in 3 folders": the selection can reach past the page you're on.
function selectionLabel() {
  const paths = [...state.select.paths];
  const folders = new Set(paths.map((p) => dirOf(p))).size;
  return `${paths.length} selected${folders > 1 ? ` in ${folders} folders` : ""}`;
}

function selectBar(folderPath) {
  const n = state.select.paths.size;
  const off = n ? "" : "disabled";
  return `<div class="select-bar" id="selectBar"><strong>${selectionLabel()}</strong>
    <button type="button" class="link-btn" data-select-all title="Every asset on this page (Ctrl+A)">All here</button>
    <button type="button" class="link-btn" data-select-folder="${esc(folderPath)}" title="Every asset in this folder and all its subfolders">Include subfolders</button>
    <button type="button" class="link-btn" data-select-clear ${off}>Clear</button>
    <span class="grow"></span>
    <button type="button" class="ghost" data-select-gen ${off} title="Candidates for every selected asset">${icon("sparkle")} Generate images</button>
    <button type="button" class="ghost" data-select-tripo ${off} title="Their picked images, named and in folders of 30, for Tripo Studio's batch upload">${icon("download")} Export for Tripo</button>
    <button type="button" class="primary" data-select-run ${off}>${icon("cube")} Make 3D</button>
    <button type="button" class="icon-btn" data-select-toggle="${esc(folderPath)}" title="Done (Esc)" aria-label="Done selecting">✕</button></div>`;
}

// The menu behind a "More" button: [{label, attr, hint}], "-" for a divider, null to leave out.
function menuButton(items) {
  const list = items.filter(Boolean);
  if (!list.some((i) => i !== "-")) return "";
  return `<div class="menu-wrap"><button type="button" class="ghost menu-btn" data-menu aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More">⋯</button>
    <div class="menu" role="menu" hidden>${list.map((i) => (i === "-" ? `<hr>` : `<button type="button" role="menuitem" ${i.attr}>${esc(i.label)}${i.hint ? `<small>${esc(i.hint)}</small>` : ""}</button>`)).join("")}</div></div>`;
}

// Tripo Studio can't be driven by Tessera, so its batch upload gets a folder of named images, 30 per folder.
async function exportForTripo(assets) {
  try {
    const res = await api("/api/model-inbox/batches", { method: "POST", body: assets ? { assets } : {} });
    if (!res.total) return toast(assets ? "None of these need a model: each has one already, or no picked image yet" : "No assets are waiting for a model");
    await api("/api/storage/open", { method: "POST", body: { target: "workspace", path: res.folder } });
    toast(`${plural(res.total, "image")} in ${plural(Object.keys(res.batches).length, "folder")}. In Tripo's picker, open a folder and press Ctrl+A. Downloads come back through the watched folder (Settings → Accounts).`);
  } catch (err) { toast(err.message, true); }
}

async function assetsUnder(folder) {
  return (await api(`/api/studio/assets-under?folder=${encodeURIComponent(folder)}`)).assets.map((a) => a.path);
}

function syncSelection() {
  const bar = $("#selectBar");
  if (!bar || !state.select) return;
  document.querySelectorAll("[data-select-tile]").forEach((t) => t.classList.toggle("selected", state.select.paths.has(t.dataset.selectTile)));
  bar.querySelector("strong").textContent = selectionLabel();
  bar.querySelectorAll("[data-select-run],[data-select-gen],[data-select-tripo],[data-select-clear]").forEach((b) => { b.disabled = !state.select.paths.size; });
}

async function makeSelected3D() {
  const paths = [...state.select.paths];
  if (!paths.length) return;
  let model = "";
  try { model = (await api("/api/studio/preview", { method: "POST", body: { path: paths[0], action: "make_3d" } })).model || ""; } catch { /* the first asset may have no winner yet */ }
  openDialog(`<form class="dlg sheet tone-sky compact" id="mesh3dForm">
    ${sheetHead("cube", "Make 3D", plural(paths.length, "asset"), `Every winner image becomes a model with the settings of a single Make 3D, set in Settings → Generators. They run side by side.`)}
    <div class="sheet-body">${optBlock("Assets", `<div class="batch-list">${paths.map((p) => `<label><span>${esc(humanize(p.split("/").pop()))}</span><small>${esc(dirOf(p) || "root")}</small></label>`).join("")}</div>`, "Assets without a winner image are skipped.")}</div>
    ${sheetFoot(model ? `Model · <b>${esc(model)}</b>` : "", "cube", `Make ${plural(paths.length, "model")}`)}</form>`);
  $("#mesh3dForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.submitter && (event.submitter.disabled = true);
    try {
      const res = await api("/api/studio/batch", { method: "POST", body: { assets: paths, action: "make_3d" } });
      res.jobs.forEach((j) => { state.jobs[j.id] ||= j; });
      closeDialog();
      state.select = null;
      state.dockOpen = true;
      renderJobDock();
      renderView();
      toast(res.jobs.length ? `Making ${plural(res.jobs.length, "model")}${res.skipped.length ? ` · ${res.skipped.length} skipped: ${res.skipped[0].reason}` : ""}` : `Nothing started: ${res.skipped[0]?.reason || "no assets"}`, Boolean(res.skipped.length));
    } catch (err) { toast(err.message, true); event.submitter && (event.submitter.disabled = false); }
  });
}

// File-name titles (bone_shelf, long-table) read as "Bone shelf"; titles someone typed are kept as they are.
const displayTitle = (title) => (/^[a-z0-9]+([_-][a-z0-9]+)*$/.test(String(title || "")) ? String(title).replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()) : title);

// Under a tile's name: what made it and what that cost ("Nano Banana 2 + Tripo v3.0 · $0.24").
function tileMeta(f) {
  const cost = Number(f.cost_usd) || 0;
  const made = [f.made_with || "", cost ? `$${cost < 0.1 ? cost.toFixed(3).replace(/0$/, "") : cost.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  if (made) return made;
  if (f.picked === false) return f.thumb || f.audio ? "No winner picked yet" : "Not made yet";
  return KIND_LABEL[f.asset_kind] || humanize(f.asset_kind || "");
}

// `opts.grid` is the grid-prefs key (a section page shares one across its subsections); `opts.bar` and
// `opts.add` turn off the filter bar and the "New asset" tile; `opts.selectBar` false leaves the select bar to the page.
function assetTiles(assets, folderPath, opts = {}) {
  const pick = selecting(folderPath);
  const bar = opts.bar !== false && folderPath !== undefined && !pick && assets.length > 1;
  const gridKey = opts.grid ?? folderPath;
  return `${bar ? gridBar(assets, folderPath) : ""}<div class="asset-grid"${folderPath !== undefined && !pick ? ` data-grid="${esc(gridKey)}"` : ""}>${assets.map((f) => `
    <button class="asset-tile${pick && state.select.paths.has(f.path) ? " selected" : ""}${f.picked === false ? " nowin" : ""}" ${pick ? `data-select-tile="${esc(f.path)}"` : `data-open="${esc(f.path)}"`} data-tile="${esc(f.path)}"${pick ? "" : ' draggable="true"'} data-name="${esc(displayTitle(f.title))}" data-kind="${esc(f.asset_kind || "")}" data-flags="${tileFlags(f)}" data-changed="${Number(f.changed) || 0}"${f.thumb ? ` data-thumb="${esc(f.thumb)}"` : ""}${f.audio ? ` data-hover-audio="${esc(f.audio)}"` : ""}${f.model ? ` data-hover-model="${esc(f.model)}"` : ""}>
      <span class="asset-img">${f.thumb ? `<img src="${esc(thumbUrl(f.thumb, 320))}" alt="" loading="lazy" decoding="async">` : f.audio ? `<span class="asset-sound"><span class="wave" aria-hidden="true">${"<i></i>".repeat(14)}</span><small>Hover to listen</small></span>` : kindArt(f.asset_kind)}<span class="kind-tag">${esc(f.asset_kind)}</span>${f.model ? `<span class="tile-3d">${icon("cube")}3D</span>` : ""}${f.thumb ? `<span class="tile-pillar" role="button" tabindex="0" data-make-pillar="${esc(f.thumb)}" title="Make this image a pillar: a style reference for a whole folder">${icon("layers")}</span>` : ""}${pick || f.audio ? "" : `<span class="tile-copy"><span role="button" tabindex="0" data-copy-prompt="${esc(f.path)}" title="Copy the full prompt as sent, with the style bible">${icon("copy")}</span><span role="button" tabindex="0" data-copy-images="${esc(f.path)}" title="Copy the pillar images sent with every generation">${icon("images")}</span></span>`}</span>
      <strong>${f.picked === false ? `<i class="nowin-dot" title="No winner picked yet"></i>` : ""}${esc(displayTitle(f.title))}</strong>
      <small class="tile-meta">${esc(tileMeta(f))}</small>
    </button>`).join("")}
    ${folderPath !== undefined && !pick && opts.add !== false ? `<button class="asset-tile add" data-new-asset="${esc(folderPath)}"><span class="asset-img"><span class="plus">+</span></span><strong>New asset</strong></button>` : ""}</div>${pick && opts.selectBar !== false ? selectBar(folderPath) : ""}`;
}

// ---------- a section is one page: its sub-folders are subsections under headings, not pages of their own ----------

const sectionRoot = (path) => String(path || "").split("/")[0];
const subsectionId = (path) => `sub-${String(path).replace(/[^a-z0-9]+/gi, "-")}`;
const isSound = (f) => AUDIO_KINDS.includes(f.asset_kind) || Boolean(f.audio);
const assetsIn = (node) => node.files.filter((f) => f.kind === "asset");
const countAssets = (node) => assetsIn(node).length + (node.subsections || []).reduce((n, s) => n + countAssets(s), 0);
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// Sounds are a list you can play from, two columns, not big cards with a picture of a wave.
function soundRows(sounds, folderPath) {
  const pick = selecting(folderPath);
  return `<div class="sound-list">${sounds.map((f) => `
    <div class="sound-row${f.picked === false ? " nowin" : ""}${pick && state.select.paths.has(f.path) ? " selected" : ""}" data-tile="${esc(f.path)}"${pick ? ` data-select-tile="${esc(f.path)}"` : ""} data-name="${esc(displayTitle(f.title))}" data-flags="${tileFlags(f)}">
      <button type="button" class="sound-play" ${f.audio && !pick ? `data-play="${esc(f.audio)}" aria-label="Play ${esc(displayTitle(f.title))}"` : "disabled aria-label=\"Nothing to play yet\""}>${icon("play")}<i class="sound-bars" aria-hidden="true"><i></i><i></i><i></i></i></button>
      <button type="button" class="sound-main" ${pick ? "" : `data-open="${esc(f.path)}"`}>
        <strong>${f.picked === false ? `<i class="nowin-dot" title="No winner picked yet"></i>` : ""}${esc(displayTitle(f.title))}</strong>
        <small>${esc([KIND_LABEL[f.asset_kind] || "", tileMeta(f)].filter((x, i, a) => x && a.indexOf(x) === i).join(" · "))}</small>
      </button>
      <span class="sound-dur"${f.audio ? ` data-dur="${esc(f.audio)}"` : ""}></span>
    </div>`).join("")}</div>`;
}

// A folder's assets: pictures and models as tiles, sounds as rows.
function assetBlock(node, root) {
  const assets = assetsIn(node);
  const sounds = assets.filter(isSound), tiles = assets.filter((f) => !isSound(f));
  return `${tiles.length ? assetTiles(tiles, node.path, { grid: root, bar: false, add: false, selectBar: false }) : ""}${sounds.length ? soundRows(sounds, node.path) : ""}`;
}

function subsectionHtml(node, root) {
  const n = countAssets(node);
  const others = node.files.filter((f) => f.kind !== "asset");
  const pillars = (node.pillars || []).length + (node.text_pillars || []).length;
  const top = node.depth === 1;
  const head = `<header class="subsec-head">
      <${top ? "h2" : "h3"}>${esc(node.title)}</${top ? "h2" : "h3"}>${n ? `<span class="subsec-count">${n}</span>` : ""}<span class="subsec-rule"></span>
      ${pillars ? `<button type="button" class="subsec-chip" data-sub-pillars="${esc(node.path)}" title="Style references sent with every image made in here">${icon("layers")} ${pillars}</button>` : ""}
      ${menuButton([
        { label: "New asset here", attr: `data-new-asset="${esc(node.path)}"` },
        n ? { label: "Generate missing here", attr: `data-batch="${esc(node.path)}"` } : null,
        n ? { label: "Select these", attr: `data-sub-select="${esc(node.path)}"` } : null,
        { label: "Pillars (style references)", attr: `data-sub-pillars="${esc(node.path)}"` },
        node.page ? { label: "Edit description", attr: `data-sub-edit="${esc(node.path)}"` } : null,
        "-",
        { label: "Make it its own section", hint: "Moves the folder to the top, next to the other sections", attr: `data-promote="${esc(node.path)}"` },
        { label: "Export as .zip", attr: `data-export="${esc(node.path)}"` },
      ])}
    </header>`;
  const body = assetBlock(node, root);
  return `<section class="subsec depth-${node.depth}" id="${subsectionId(node.path)}" data-subsec="${esc(node.path)}">
    ${head}
    ${node.excerpt ? `<p class="subsec-lede">${esc(node.excerpt)}</p>` : ""}
    ${body || (node.subsections.length ? "" : `<p class="subsec-empty">Nothing here yet. <button type="button" class="link-btn" data-new-asset="${esc(node.path)}">+ New asset</button></p>`)}
    ${others.length ? `<details class="subsec-files"><summary>${plural(others.length, "document")}</summary>${fileBlocks(others)}</details>` : ""}
    ${(node.subsections || []).map((s) => subsectionHtml(s, root)).join("")}
  </section>`;
}

// Where the section page was drawn last, so a redraw (a file changed) keeps the scroll and a fresh visit jumps
// to the subsection it was opened on.
const sectionDrawn = { key: "" };

async function renderSectionPage(content) {
  const view = state.view;
  const root = sectionRoot(view.path);
  let sec;
  try { sec = await pageApi(`/api/overview/section?path=${encodeURIComponent(root)}`); } catch {
    state.view = { type: "home" };
    return renderViewBody();
  }
  state.view.page = sec.page || "";
  const body = await readPage(sec.page);
  const own = assetsIn(sec);
  const all = [];
  const walk = (node) => { all.push(...assetsIn(node)); (node.subsections || []).forEach(walk); };
  walk(sec);
  const others = sec.files.filter((f) => f.kind !== "asset");
  const pillars = (sec.pillars || []).length + (sec.text_pillars || []).length;
  const pick = selecting(root);
  const aboutKey = `tessera.about.${state.project}.${root}`;
  const about = body;
  const empty = !all.length && !sec.subsections.length && !body && !others.length;
  content.innerHTML = `
    <div class="doc-bar"><span class="path"></span><div>
      <button class="primary" data-new-asset="${esc(root)}">+ New asset</button>
      ${all.length ? `<button class="ghost${pick ? " on" : ""}" data-select-toggle="${esc(root)}" title="Tick assets and run one action on all of them (S)">${pick ? "Done selecting" : `${icon("check")} Select`}</button>
      <button class="ghost" data-batch="${esc(root)}" title="Generate candidates for every asset in this section that has none yet">${icon("sparkle")} Generate missing</button>` : ""}
      ${menuButton([
        { label: "+ New subsection", attr: `data-new-folder="${esc(root)}"` },
        sec.page ? { label: "Edit page", attr: `data-sub-edit="${esc(root)}"` } : null,
        "-",
        all.length ? { label: "Export images for Tripo Studio", hint: "Picked images of assets without a model, in folders of 30", attr: `data-tripo-folder="${esc(root)}"` } : null,
        { label: "Export section as .zip", attr: `data-export="${esc(root)}"` },
      ])}</div></div>
    <h1 class="title">${esc(sec.title)}</h1>
    ${sec.excerpt ? `<p class="lede">${esc(sec.excerpt)}</p>` : ""}
    ${sec.cover ? `<img class="hero" src="${esc(fileUrl(sec.cover))}" alt="">` : ""}
    <div class="sec-tools">
      ${about ? `<button type="button" class="sec-tool${storeGet(aboutKey) === "1" ? " on" : ""}" data-sec-about aria-expanded="${storeGet(aboutKey) === "1"}">${icon("eye")} About this section</button>` : ""}
      <button type="button" class="sec-tool" data-sub-pillars="${esc(root)}">${icon("layers")} Pillars${pillars ? ` <b>${pillars}</b>` : ""}</button>
      <span class="grow"></span>
      ${all.filter((f) => !isSound(f)).length > 1 && !pick ? gridBar(all.filter((f) => !isSound(f)), root) : ""}
    </div>
    ${about ? `<div class="sec-about"${storeGet(aboutKey) === "1" ? "" : " hidden"}>
      <div class="page-body">${withToc(renderMarkdown(stripLead(body), root))}</div></div>` : ""}
    ${own.length ? `<section class="subsec depth-1 sec-own">${assetBlock(sec, root)}</section>` : ""}
    ${others.length ? `<section class="subsec depth-1 sec-docs"><header class="subsec-head"><h2>Documents</h2><span class="subsec-count">${others.length}</span><span class="subsec-rule"></span></header>${fileBlocks(others)}</section>` : ""}
    ${sec.subsections.map((s) => subsectionHtml(s, root)).join("")}
    ${pick ? selectBar(root) : ""}
    ${empty ? `<p class="lede">Nothing here yet. Ask Tess to fill this section, or add an asset.</p>` : ""}`;
  fillDurations(content);
  const key = `${state.project}|${root}`;
  const fresh = sectionDrawn.key !== key;
  sectionDrawn.key = key;
  if (fresh) {
    content.scrollTop = 0;
    if (view.path !== root) requestAnimationFrame(() => scrollToSubsection(view.path, false));
  }
  spySections();
}

function scrollToSubsection(path, smooth = true) {
  const content = $("#content");
  if (path === sectionRoot(path)) return content.scrollTo({ top: 0, behavior: smooth ? "smooth" : "instant" });
  const el = document.getElementById(subsectionId(path));
  if (!el) return;
  const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 12;
  spyHold = performance.now() + (smooth ? 900 : 0);  // the glide must not light up every heading it passes
  content.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
}

// The sidebar and the crumbs follow the subsection you are reading.
let spyHold = 0, spyFrame = 0;
function spySections() {
  if (state.view.type !== "folder" || state.view.editing) return;
  const content = $("#content");
  const line = content.getBoundingClientRect().top + 120;
  let here = sectionRoot(state.view.path);
  for (const el of content.querySelectorAll(".subsec[data-subsec].depth-1")) {
    if (el.getBoundingClientRect().top <= line) here = el.dataset.subsec; else break;
  }
  if (content.scrollTop + content.clientHeight >= content.scrollHeight - 4) {
    // At the very bottom, a short last subsection can never reach the line: it is the one being read.
    const last = [...content.querySelectorAll(".subsec[data-subsec].depth-1")].pop();
    if (last && last.getBoundingClientRect().top < content.getBoundingClientRect().bottom - 80) here = last.dataset.subsec;
  }
  markSubsection(here);
}

function markSubsection(path) {
  if (state.view.path === path) return;
  state.view.path = path;
  saveView();
  renderCrumbs();
  document.querySelectorAll("#sections .sub-item[data-folder]").forEach((b) => b.classList.toggle("active", b.dataset.folder === path));
}

$("#content").addEventListener("scroll", () => {
  if (state.view.type !== "folder" || performance.now() < spyHold) return;
  cancelAnimationFrame(spyFrame);
  spyFrame = requestAnimationFrame(spySections);
}, { passive: true });

// A folder in the same section is a place on this page: glide to it instead of opening a page.
function openFolder(path) {
  if (state.view.type === "folder" && !state.view.editing && sectionRoot(path) === sectionRoot(state.view.path)
      && (path === sectionRoot(path) || document.getElementById(subsectionId(path)))) {
    const target = path.split("/").slice(0, 2).join("/");  // deeper folders are labels inside their subsection
    scrollToSubsection(path);
    markSubsection(target);
    return;
  }
  go({ type: "folder", path });
}

// One sound plays at a time; the row's button shows bars while it does.
const player = { audio: null, btn: null };
function playSound(btn) {
  const src = btn.dataset.play;
  const same = player.btn === btn;
  if (player.audio) { player.audio.pause(); player.btn?.classList.remove("playing"); }
  if (same) { player.audio = null; player.btn = null; return; }
  const audio = new Audio(fileUrl(src));
  Object.assign(player, { audio, btn });
  btn.classList.add("playing");
  audio.addEventListener("ended", () => { btn.classList.remove("playing"); if (player.audio === audio) Object.assign(player, { audio: null, btn: null }); });
  audio.play().catch(() => { btn.classList.remove("playing"); toast("Couldn't play this sound", true); });
}

const durations = new Map();
function fillDurations(root) {
  root.querySelectorAll("[data-dur]").forEach((el) => {
    const src = el.dataset.dur;
    if (durations.has(src)) { el.textContent = durations.get(src); return; }
    const probe = new Audio();
    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", () => {
      if (!Number.isFinite(probe.duration)) return;
      durations.set(src, fmtDur(probe.duration));
      document.querySelectorAll(`[data-dur="${CSS.escape(src)}"]`).forEach((x) => { x.textContent = durations.get(src); });
    }, { once: true });
    probe.src = fileUrl(src);
  });
}

// A subsection's pillars open in a sheet, so the page itself stays assets only.
async function pillarsSheet(path) {
  let folder;
  try { folder = await api(`/api/overview/folder?path=${encodeURIComponent(path)}`); } catch (err) { return toast(err.message, true); }
  openDialog(`<div class="dlg sheet compact pillars-sheet">${pillarStrip(folder.pillars || [], folder.path, `Pillars · ${folder.title}`, folder.text_pillars || [])}
    <div class="row"><button type="button" class="ghost" data-close>Done</button></div></div>`);
}

async function promoteFolder(path) {
  const name = humanize(path.split("/").pop());
  if (!(await ask({ title: `Make ${name} its own section?`, body: `The folder moves out of ${humanize(sectionRoot(path))} to the top, with everything in it. Your game's copies and ASSETS.md follow on the next sync.`, ok: "Make section" }))) return;
  try {
    const res = await api("/api/overview/promote", { method: "POST", body: { path } });
    await loadOverview();
    go({ type: "folder", path: res.path });
    toast(`${name} is a section now`);
  } catch (err) { toast(err.message, true); }
}

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-play],[data-sub-select],[data-sub-pillars],[data-sub-edit],[data-promote],[data-sec-about]");
  if (!t) return;
  const d = t.dataset;
  if (d.play) { event.stopPropagation(); return playSound(t); }
  closeMenus();
  if (d.subPillars !== undefined) return pillarsSheet(d.subPillars);
  if (d.subEdit !== undefined) return go({ type: "folder", path: d.subEdit, editing: true });
  if (d.promote !== undefined) return promoteFolder(d.promote);
  if (d.secAbout !== undefined) {
    const box = $("#content .sec-about");
    if (!box) return;
    box.hidden = !box.hidden;
    t.classList.toggle("on", !box.hidden);
    t.setAttribute("aria-expanded", String(!box.hidden));
    return storeSet(`tessera.about.${state.project}.${sectionRoot(state.view.path)}`, box.hidden ? "" : "1");
  }
  if (d.subSelect !== undefined) {
    const root = sectionRoot(d.subSelect);
    if (!state.select?.on) state.select = { on: true, folder: root, paths: new Set() };
    const found = await assetsUnder(d.subSelect).catch((err) => { toast(err.message, true); return []; });
    found.forEach((p) => state.select.paths.add(p));
    await renderView();
    return syncSelection();
  }
});

function fileBlocks(files) {
  const assets = files.filter((f) => f.kind === "asset");
  const docs = files.filter((f) => f.kind === "doc" || f.kind === "file");
  const images = files.filter((f) => f.kind === "image");
  const models = files.filter((f) => f.kind === "model");
  let html = "";
  if (assets.length) html += assetTiles(assets);
  if (docs.length) {
    html += `<div class="grid">${docs.map((f) => `
      <button class="card" data-open="${esc(f.path)}"><div class="body"><strong>${esc(f.title)}</strong>${f.excerpt ? `<p>${esc(f.excerpt)}</p>` : ""}<span class="meta">${esc(f.name)}</span></div></button>`).join("")}</div>`;
  }
  if (images.length) {
    html += `<div class="gallery">${images.map((f) => `<a href="${esc(fileUrl(f.path))}" target="_blank" rel="noopener"><img src="${esc(fileUrl(f.path))}" alt="${esc(f.title)}" loading="lazy"><span>${esc(f.name)}</span></a>`).join("")}</div>`;
  }
  if (models.length) {
    html += `<div class="grid">${models.map((f) => `<a class="card" href="${esc(fileUrl(f.path))}" download><div class="body"><strong>${esc(f.title)}</strong><span class="meta">3D model · ${esc(f.name)}</span></div></a>`).join("")}</div>`;
  }
  return html;
}

function pillarStrip(pillars, folderPath, label, texts = []) {
  const target = folderPath ? `${folderPath}/pillars` : "pillars";
  return `<section class="pillars">
    <div class="pillars-head"><div><strong>${esc(label)}</strong>
      <span>${folderPath ? "Sent with every image generated for assets in this folder and below it." : "The project bible: sent with every image generation."}</span></div>
      <div class="pillars-actions"><button class="ghost" data-style-text="${esc(target)}">+ Style text</button><button class="ghost" data-upload="${esc(target)}">+ Add image</button></div></div>
    ${texts.map((t) => `<div class="bible-text"><button class="bible-open" data-open="${esc(t.path)}"><span>Style bible · put in front of every prompt</span><p>${esc(t.excerpt.replace(/^#\s+.*\n?/, "").trim() || "Empty")}</p></button><div class="bible-actions"><button class="mini" data-open="${esc(t.path)}">Edit</button><button class="mini danger-mini" data-remove-style="${esc(t.path)}">Remove</button></div></div>`).join("")}
    ${pillars.length ? `<div class="pillar-row">${pillars.map((p) => `<div class="pillar-item"><a href="${esc(fileUrl(p))}" target="_blank" rel="noopener" title="${esc(p)}"><img src="${esc(fileUrl(p))}" alt="" loading="lazy"></a><button class="pillar-remove" data-remove-pillar="${esc(p)}" title="Remove pillar" aria-label="Remove pillar">×</button></div>`).join("")}</div>`
      : texts.length ? "" : `<p class="pillar-empty">No pillars yet. Add reference images whose art style, pose and lighting every new image should match, and style text such as pose, polygon budget or palette.</p>`}
  </section>`;
}

async function removeStyleText(path) {
  if (!(await ask({ title: "Remove this style text?", body: "It moves to .trash in the workspace, so it can be restored.", ok: "Remove", danger: true }))) return;
  try { await api(`/api/overview/style-text?path=${encodeURIComponent(path)}`, { method: "DELETE" }); toast("Style text removed"); await loadOverview(); } catch (err) { toast(err.message, true); }
}

async function removePillar(path) {
  if (!(await ask({ title: "Remove this pillar image?", body: "It moves to .trash in the workspace, so it can be restored.", ok: "Remove", danger: true }))) return;
  try { await api(`/api/overview/pillar?path=${encodeURIComponent(path)}`, { method: "DELETE" }); toast("Pillar removed"); await loadOverview(); } catch (err) { toast(err.message, true); }
}

async function addStyleText(target) {
  const path = `${target}/style-bible.md`;
  const exists = await api(`/api/overview/file?path=${encodeURIComponent(path)}`).then(() => true, () => false);
  if (!exists) {
    const content = `# Style bible\n\n- Pose: T-pose, front view, full body, neutral expression\n- Geometry: low-poly, clean silhouette, under 10k triangles\n- Rendering: soft studio light, plain background\n- Palette: \n`;
    try { await api("/api/overview/file", { method: "PUT", body: { path, content } }); } catch (err) { toast(err.message, true); return; }
  }
  await loadOverview();
  go({ type: "doc", path, editing: true });
}

async function makePillarDialog(image) {
  let targets;
  try { targets = (await api(`/api/studio/pillar-targets?path=${encodeURIComponent(state.view.path)}`)).targets; } catch (err) { toast(err.message, true); return; }
  openDialog(`
    <form class="dlg pillar-pick" id="pillarForm">
      <div class="pillar-pick-head"><img src="${esc(fileUrl(image))}" alt=""><div><h2>Make it a pillar</h2>
        <p>Pick the folder this image should style. It is sent with every generation in that folder and everything below it.</p></div></div>
      <div class="target-list">${targets.map((t, i) => `<label class="target"><input type="radio" name="folder" value="${esc(t.path)}" ${i === targets.length - 1 ? "checked" : ""}>
        <span><strong>${esc(t.path ? humanize(t.path.split("/").pop()) : "Project bible")}</strong><small>${esc(t.path ? t.path : "Every image in the whole project")}</small></span></label>`).join("")}</div>
      <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Make pillar</button></div>
    </form>`);
  $("#pillarForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const folder = new FormData(event.target).get("folder") || "";
    try {
      await api("/api/studio/make-pillar", { method: "POST", body: { image, folder } });
      closeDialog();
      toast(`Pillar added to ${folder ? humanize(folder.split("/").pop()) : "the project bible"}`);
      renderView();
    } catch (err) { toast(err.message, true); }
  });
}

function uploadTo(folder, onDone) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.multiple = true;
  input.onchange = () => uploadFiles(folder, input.files, onDone);
  input.click();
}

async function uploadFiles(folder, files, onDone) {
  const form = new FormData();
  for (const file of files) if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) form.append("files", file);
  if (!form.has("files")) { toast("Drop a PNG, JPG or WebP image.", true); return; }
  try {
    const res = await fetch(`/api/overview/upload?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(folder)}`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Upload failed");
    toast(`Added ${data.saved.length} image${data.saved.length === 1 ? "" : "s"}`);
    if (onDone) await onDone(data.saved); else await loadOverview();
  } catch (err) { toast(err.message, true); }
}

// A picture picked from the computer for an asset becomes a candidate and its winner (forge/ui/drops.js).
function addCandidateImages(files) {
  return dropFiles({ kind: "asset", path: state.view.path, hero: true }, files);
}

const KIND_ICON = new Proxy({}, { get: (_, k) => (ICON[k] ? icon(k) : AUDIO_KINDS.includes(k) ? icon("sound") : "") });

const KIND_LABEL = { environment: "Place", level: "Level", kit: "Modular kit", ui: "UI", vfx: "Effect", sfx: "Sound effect", voice: "Voice line", music: "Music" };

function kindTags(kinds, selected) {
  return `<div class="kind-tags" role="radiogroup" aria-label="Kind">${kinds.map((k) => `<label class="kind-chip"><input type="radio" name="kind" value="${esc(k)}" ${k === selected ? "checked" : ""}><span>${KIND_ICON[k] || "•"} ${esc(KIND_LABEL[k] || humanize(k))}</span></label>`).join("")}</div>`;
}

// Example name and description per kind, shown as placeholders in New asset.
const KIND_EXAMPLE = {
  character: ["Bronze Knight", "A stout knight in dented bronze armour with a red tabard"],
  creature: ["Cave Slime", "A wobbly green slime with a glowing core and two tiny eyes"],
  item: ["Health Potion", "A round glass bottle of bubbling red liquid with a cork"],
  weapon: ["Rusty Sword", "A short iron sword with a chipped blade and a leather grip"],
  prop: ["Wooden Barrel", "An old oak barrel with iron bands"],
  environment: ["Moonlit Forest", "A misty forest clearing at night with tall pines"],
  level: ["Crypt Room", "Top-down view of a small crypt room with coffins, torches and a broken pillar"],
  vehicle: ["Mine Cart", "A rusty mine cart on rails, filled with coal"],
  ui: ["Health Bar", "A red health bar in a carved stone frame"],
  vfx: ["Fire Burst", "A round burst of orange flames and sparks"],
  sfx: ["Coin Pickup", "A short bright metallic coin chime, under half a second"],
  voice: ["Shopkeeper Greeting", "Welcome, traveller! Take a look, everything's on sale."],
  music: ["Forest Theme", "Calm looping flute and harp melody, gentle and mysterious"],
  material: ["Wet Flagstone", "Worn dark flagstones with moss in the cracks"],
  kit: ["Crypt Kit", "Walls, floors and doorways for the sunken crypt"],
};
const askFor = (kind) => (kind === "voice" ? "What does the character say?" : AUDIO_KINDS.includes(kind) ? "What does it sound like?" : kind === "kit" ? "What is it for?" : "What does it look like?");

async function newAssetDialog(folder, preset = {}) {
  const kinds = (await studioOptions()).kinds.filter((k) => k !== "kit" || !is2d());  // kits are 3D pieces
  // Suggest the kind from the folder name (creatures → creature) when it matches one.
  const guess = kinds.find((k) => (folder || "").toLowerCase().split("/").some((part) => part.replace(/^\d+[-_ ]*/, "").replace(/s$/, "").includes(k))) || "";
  openDialog(`
    <form class="dlg" id="newAssetForm">
      <h2>New asset</h2>
      <p>Creates a document in <code>${esc(folder || "the project root")}</code> that you can generate images and 3D for.</p>
      <label>Name<input name="title" maxlength="80" value="${esc(preset.title || "")}" placeholder="${esc(KIND_EXAMPLE[guess]?.[0] || KIND_EXAMPLE.character[0])}" autofocus></label>
      <div class="dlg-field"><span>Kind</span>${kindTags(kinds, guess)}</div>
      <label><span id="naWhat">${askFor(guess)}</span><textarea name="prompt" rows="3" placeholder="${esc(KIND_EXAMPLE[guess]?.[1] || KIND_EXAMPLE.character[1])}">${esc(preset.prompt || "")}</textarea></label>
      <p class="form-why" id="naWhy" hidden>Give it a name first.</p>
      <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Create</button></div>
    </form>`);
  // The examples follow the kind: a sound gets a sound, a level a level.
  $("#newAssetForm").addEventListener("change", (event) => {
    if (event.target.name !== "kind") return;
    const [name, prompt] = KIND_EXAMPLE[event.target.value] || KIND_EXAMPLE.character;
    const form = event.target.form;
    form.title.placeholder = name;
    form.prompt.placeholder = prompt;
    $("#naWhat").textContent = askFor(event.target.value);
  });
  $("#newAssetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (!String(data.title || "").trim()) { $("#naWhy").hidden = false; return event.target.title.focus(); }
    if (!data.kind) { $("#naWhy").textContent = "Pick what kind of asset it is."; $("#naWhy").hidden = false; return; }
    const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
    const path = folder ? `${folder}/${slug}.md` : `${slug}.md`;
    const yaml = (v) => JSON.stringify(String(v).trim());
    const content = `---\nkind: ${yaml(data.kind)}\nprompt: ${yaml(data.prompt || data.title)}\n---\n\n# ${data.title.trim()}\n`;
    try {
      await api("/api/overview/file", { method: "PUT", body: { path, content } });
      closeDialog();
      await loadOverview();
      go({ type: "doc", path });
    } catch (err) { toast(err.message, true); }
  });
}

async function readPage(path) {
  if (!path) return "";
  try { return (await pageApi(`/api/overview/file?path=${encodeURIComponent(path)}`)).content; } catch { return ""; }
}

// One draw at a time: a slow view (Motion Studio, an asset page) that finishes after the user moved on must
// not paint over the view they moved to. A call that comes in mid-draw runs one more draw of the latest view.
let viewDraw = null, viewAgain = false;
async function renderView() {
  if (viewDraw) { viewAgain = true; return viewDraw; }
  viewDraw = (async () => {
    try { do { viewAgain = false; await drawView(); } while (viewAgain); } finally { viewDraw = null; }
  })();
  return viewDraw;
}

async function drawView() {
  await renderViewBody();
  renderSectionCounts();
  applyGrids();
  if (state.view.type === "doc") { mountAssetRail(); mountSpriteBlock(); }
  mountHero();
  mountWave();
  revealNewPictures();
  if (state.view.type === "board") mountBoard();
}

// On an asset page, a picture that was not there at the last draw resolves in squares, once.
const picsSeen = { key: "", paths: new Set() };
function revealNewPictures() {
  if (state.view.type !== "doc") { picsSeen.key = ""; return; }
  const key = `${state.project}|${state.view.path}`;
  const first = picsSeen.key !== key;
  if (first) { picsSeen.key = key; picsSeen.paths = new Set(); }
  for (const card of document.querySelectorAll("#content .out-img[data-lightbox]")) {
    const path = card.dataset.lightbox;
    if (!first && !picsSeen.paths.has(path)) card.insertAdjacentHTML("beforeend", revealSquares());
    picsSeen.paths.add(path);
  }
}

// The live 3D hero on an asset page. Its canvas survives re-renders of the same asset, so the
// model is loaded once and keeps turning instead of reloading on every workspace change.
let hero = null;

async function mountHero() {
  const slot = $("#content [data-hero-model]");
  const path = slot?.dataset.heroModel;
  if (hero && hero.path !== path) { hero.view?.dispose(); hero.host.remove(); hero = null; }
  if (!slot) return;
  if (hero) {
    slot.querySelector(".hero-stage").replaceWith(hero.host);
    if (hero.view) slot.classList.add("live");
    return;
  }
  const h = hero = { path, host: Object.assign(document.createElement("div"), { className: "hero-stage" }), view: null };
  slot.querySelector(".hero-stage").replaceWith(h.host);
  // A press on the turning model (not a drag to orbit it) opens it in the full-window viewer.
  let press = null;
  h.host.addEventListener("pointerdown", (e) => { press = e.button === 0 && !e.shiftKey ? [e.clientX, e.clientY, performance.now()] : null; });
  h.host.addEventListener("pointerup", (e) => {
    if (!press || Math.hypot(e.clientX - press[0], e.clientY - press[1]) > 5 || performance.now() - press[2] > 400) return;
    press = null;
    viewModel(h.path, false, h.host.closest(".hero-3d") || h.host);
  });
  try {
    const viewer = await viewerModule();
    const view = await viewer.createViewer(h.host, fileUrl(path), { autoRotate: true, grid: false });
    if (hero !== h) { view.dispose(); return; }
    h.view = view;
    if (view.clips.length) view.play(0);
    h.host.closest("[data-hero-model]")?.classList.add("live");
  } catch { /* the poster image stays */ }
}

async function renderViewBody() {
  const ov = state.overview;
  if (state.view.type !== "motion") motionLoaded?.leave();
  if (state.view.type !== "nodes") flowsLoaded?.leave();
  if (!ov) return;
  if (state.view.type === "doc" && /(^|\/)README\.md$/i.test(state.view.path) && dirOf(state.view.path)) state.view = { type: "folder", path: dirOf(state.view.path) };
  saveView();
  renderSections();
  renderCrumbs();
  const content = $("#content");
  delete content.dataset.dropAsset;
  const view = state.view;

  if (view.type === "home") {
    if (ov.empty && ov.game) {
      const g = ov.game;
      content.innerHTML = `<div class="empty game-start"><h1>Let's set up ${esc(g.title)}</h1>
        <p>Tessera is connected to your ${esc(g.engine)} game in <code>${esc(g.folder)}</code>. Describe the game once and Tess builds its workspace:
        a front page, a section per part of the game, a style bible, and a page for every character, creature, item, place and sound to make.
        Nothing is generated until you say so.</p>
        <button class="keyart-cta" data-game-build>${icon("sparkle")}<span><strong>Build it in Tess</strong><small>Paste your pitch or design notes, or let Tess read the docs in your game folder</small></span></button>
        <button class="keyart-cta sample-cta" data-install-sample>${icon("eye")}<span><strong>Or explore a finished project first</strong><small>Pocket Kaiju: characters, 3D models and sounds. Opens as its own project; no credits used.</small></span></button></div>`;
      return;
    }
    if (ov.empty) {
      content.innerHTML = `<div class="empty">${tessArt("empty")}<h1>This project is empty</h1>
        <p>Tell Tess about your game (press / to open the chat), for example:</p>
        <p><em>“Create a project structure for a cozy farming game set on a floating island.”</em></p>
        <p>Sections, documents and pages will appear here as the agent creates them.</p>
        <button class="keyart-cta sample-cta" data-install-sample>${icon("eye")}<span><strong>Or explore a finished project first</strong><small>Pocket Kaiju: characters, 3D models and sounds. Opens as its own project; no credits used.</small></span></button></div>`;
      return;
    }
    const body = await readPage(ov.page);
    const jobsHere = Object.values(state.jobs).some((j) => j.asset?.endsWith?.("key-art.md") && ["running", "queued"].includes(j.status));
    content.innerHTML = `
      <header class="proj-hero${ov.cover ? " has-cover" : ""}">
        ${ov.cover ? `<div class="proj-hero-blur" style="background-image:url('${esc(fileUrl(ov.cover))}')"></div><img class="proj-hero-img" src="${esc(fileUrl(ov.cover))}" alt="">` : ""}
        <div class="proj-hero-text">
          <h1 class="title">${esc(projectTitle())}</h1>
          ${ov.excerpt ? `<p class="lede">${esc(ov.excerpt)}</p>` : ""}
        </div>
        ${ov.cover ? "" : `<button class="keyart-cta" data-key-art="${esc(state.project)}"${jobsHere ? " disabled" : ""}>${icon("sparkle")}<span><strong>${jobsHere ? "Painting key art…" : "Make key art"}</strong><small>${jobsHere ? "It becomes the cover when it lands" : "A cover image from your pitch, for this page and the projects overview"}</small></span></button>`}
      </header>
      ${upgradeCard()}
      ${requestsCard(ov.requests)}
      ${wallHtml() || `<div class="actions-row"><button class="ghost" data-batch="">${icon("sparkle")} Generate all missing</button><span class="home-model-tools" id="homeModelTools"></span></div>`}
      ${body ? `<details class="brief"${storeGet(`tessera.brief.${state.project}`) === "1" ? " open" : ""}><summary><span>The brief</span><small>${esc(ov.page || "README.md")}</small>${ov.page ? `<button class="mini" type="button" data-open="${esc(ov.page)}">Edit</button>` : ""}</summary><div class="md">${renderMarkdown(stripLead(body), "")}</div></details>` : ""}
      ${pillarStrip(ov.pillars || [], "", "Bible pillars", ov.text_pillars || [])}
      ${ov.files.length ? `<h2 class="block-title">Files</h2>${fileBlocks(ov.files)}` : ""}`;
    fillHomeModelTools();
    content.querySelector("details.brief")?.addEventListener("toggle", (e) => storeSet(`tessera.brief.${state.project}`, e.target.open ? "1" : ""));
    return;
  }

  if (view.type === "pipeline") return renderPipeline();
  if (view.type === "vault") return renderVault();
  if (view.type === "levels") return renderLevels();
  if (view.type === "pixel") return renderPixelPage();
  if (view.type === "motion") return renderMotionPage();
  if (view.type === "nodes") return renderFlowsPage();
  if (view.type === "board") return renderBoard();

  if (view.type === "folder") {
    if (view.editing) {
      let folder;
      try { folder = await pageApi(`/api/overview/folder?path=${encodeURIComponent(view.path)}`); } catch { state.view = { type: "home" }; return renderViewBody(); }
      state.view.page = folder.page || "";
      if (folder.page) {
        const file = await pageApi(`/api/overview/file?path=${encodeURIComponent(folder.page)}`);
        content.innerHTML = `<div class="doc-bar"><span class="path"><bdi>${esc(folder.page)}</bdi></span><div><button class="ghost" data-cancel-edit>Cancel</button> <button class="primary" data-save>Save</button></div></div>
          <textarea class="editor" id="editor" spellcheck="false">${esc(file.content)}</textarea>`;
        return;
      }
      state.view.editing = false;
    }
    return renderSectionPage(content);
  }

  if (view.type === "doc") {
    let file;
    try { file = await pageApi(`/api/overview/file?path=${encodeURIComponent(view.path)}`); } catch (err) {
      // A view restored from last time can point at a file that's gone since: just start at the overview.
      if (!view.restored) toast(err.message, true);
      state.view = { type: "home" };
      return renderViewBody();
    }
    const isMd = view.path.toLowerCase().endsWith(".md");
    if (isMd && !view.editing) {
      const asset = await pageApi(`/api/studio/asset?path=${encodeURIComponent(view.path)}`).catch(() => null);
      if (asset?.kind === "level") state.pack = await api(`/api/studio/level-pack?path=${encodeURIComponent(asset.path)}`).catch(() => null);
      if (asset?.kind === "kit") state.materials = (await api("/api/studio/materials").catch(() => ({ materials: [] }))).materials;
      if (asset?.is_asset) { content.innerHTML = renderAssetPage(asset); content.dataset.dropAsset = ""; queueThumbs(asset); return; }
    }
    content.innerHTML = `
      <div class="doc-bar"><span class="path"><bdi>${esc(file.path)}</bdi></span>
        <div>${view.editing ? `<button class="ghost" data-cancel-edit>Cancel</button> <button class="primary" data-save>Save</button>` : `${isMd && !/(^|\/)(README|index|GAME)\.md$/i.test(view.path) && !/(^|\/)pillars\//.test(view.path) ? `<button class="ghost" data-to-folder title="Make this document a folder (it becomes the folder's page) so you can put assets and sub-folders in it">Turn into folder</button> <button class="ghost" data-make-asset>Turn into asset</button> ` : ""}${/(^|\/)README\.md$/i.test(view.path) && dirOf(view.path) ? `<button class="ghost" data-new-folder="${esc(dirOf(view.path))}">+ New folder</button> <button class="ghost" data-new-asset="${esc(dirOf(view.path))}">+ New asset</button> ` : ""}<button class="ghost" data-edit>Edit</button>`}</div></div>
      ${view.editing ? `<textarea class="editor" id="editor" spellcheck="false">${esc(file.content)}</textarea>`
        : isMd ? withToc(renderMarkdown(file.content, dirOf(file.path))) : `<div class="md"><pre><code>${esc(file.content)}</code></pre></div>`}`;
  }
}

// ---------- final vault ----------

const VAULT_FILTERS = { all: "All", ready: "Export-ready", no3d: "Missing 3D", noimage: "Missing image" };

function meshSummary(s) {
  if (!s || !Object.keys(s).length) return "";
  const smart = s.model_type === "smart-topology";
  const poly = smart || s.should_remesh ? `${fmtCount(s.target_polycount)} ${s.topology === "quad" ? "quads" : "tris"}` : "raw mesh";
  return [MESH_MODEL_LABEL[s.ai_model]?.split(" · ")[0] || s.ai_model, poly, s.should_texture ? `${s.enable_pbr ? "PBR " : ""}${s.texture_resolution}` : "untextured", s.pose_mode].filter(Boolean).join(" · ");
}

function vaultRow(e) {
  const formats = Object.keys(e.model?.formats || {});
  const files = [e.winner ? e.winner.split(".").pop().toUpperCase() : "", ...formats.map((f) => f.toUpperCase())].filter(Boolean);
  const exportPath = [e.folder, e.name].filter(Boolean).join("/");
  const meshBtn = AUDIO_KINDS.includes(e.kind) || e.kind === "material" || (is2d() && !e.model) ? "" : e.model
    ? `<button class="vault-thumb mesh" data-view-model="${esc(e.model.path)}" title="Open in the 3D viewer">${e.model.thumb ? `<img src="${esc(fileUrl(e.model.thumb))}" alt="" loading="lazy">` : icon("cube")}</button>`
    : `<button class="vault-thumb mesh missing" data-open="${esc(e.path)}" title="Make 3D"><span>No 3D</span></button>`;
  return `<div class="vault-row${e.ready ? " ready" : ""}">
    <button class="vault-thumb" data-open="${esc(e.path)}" title="${AUDIO_KINDS.includes(e.kind) ? "Final take" : "Final image"}">${e.winner && !AUDIO_KINDS.includes(e.kind) ? `<img src="${esc(fileUrl(e.winner))}" alt="" loading="lazy">` : kindArt(AUDIO_KINDS.includes(e.kind) ? "sound" : e.kind, "")}</button>
    ${meshBtn}
    <div class="vault-info">
      <div class="vault-name"><strong>${esc(displayTitle(e.title))}</strong><span class="kind-tag">${esc(e.kind)}</span>${e.ready ? `<span class="kind-tag win">Ready</span>` : ""}</div>
      <code title="Folder in the export">${esc(exportPath)}/</code>
      <div class="vault-files">${files.map((f) => `<span class="chip">${esc(f)}</span>`).join("")}${e.model_settings && Object.keys(e.model_settings).length ? `<small>${esc(meshSummary(e.model_settings))}</small>` : ""}</div>
    </div>
    <div class="vault-actions">
      ${e.model ? `<button class="act" data-view-model="${esc(e.model.path)}">${icon("eye")}View</button>` : ""}
      <button class="act" data-open="${esc(e.path)}">${e.model ? "Open" : `${icon("cube")}Make 3D`}</button>
      <button class="act" data-vault-zip="${esc(e.path)}" title="Download this asset as a ZIP">${icon("download")}ZIP</button>
    </div>
  </div>`;
}

// ---------- asset studio ----------

const ACTION_LABEL = { candidates: "Generate images", variant: "Variant", edit: "Edit image", views: "Turnaround", prop_sheet: "Prop sheet", trim_sheet: "Trim sheet", make_3d: "Make 3D", rig: "Rig", animate: "Animate" };
// A job's name in toasts and lists: a sound job is a "candidates" run too, but it makes sounds, not 2D.
const jobLabel = (j) => (j?.audio ? "Sounds" : ACTION_LABEL[j?.action]);

// Failed or interrupted runs stay on the asset page until dismissed, so a lost result is never silent.
function dismissedJobs() { try { return new Set(JSON.parse(storeGet("forge.dismissedJobs") || "[]")); } catch { return new Set(); } }

function problemJobs(path) {
  const gone = dismissedJobs();
  const day = Date.now() / 1000 - 86400;
  return Object.values(state.jobs).filter((j) => j.asset === path && (j.status === "failed" || j.status === "interrupted") && !gone.has(j.id) && (j.finished_at || 0) > day);
}

function runningJobs(path) {
  return Object.values(state.jobs).filter((j) => j.asset === path && j.status === "running");
}

const ICON = {
  nodes: `<rect x="3" y="8" width="7" height="8" rx="1.6"/><rect x="14" y="4" width="7" height="6" rx="1.6"/><rect x="14" y="14" width="7" height="6" rx="1.6"/><path d="M10 12h2M14 7h-2v10h2"/>`,
  flow: `<circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/><path d="M7.2 12h2.6M14.2 12h2.6"/>`,
  link: `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  sort: `<path d="M7 4v16M4 7l3-3 3 3M17 20V4m-3 13 3 3 3-3"/>`,
  "chev-left": `<path d="M15 5l-7 7 7 7"/>`,
  "chev-right": `<path d="m9 5 7 7-7 7"/>`,
  material: `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M4 15h16M9 4v5.5M15 9.5V15M9 15v5"/>`,
  kit: `<path d="M4 20V9l4-2v13M8 20h12V11h-5v-3h-3v3H8"/><path d="M4 20h16"/>`,
  folder: `<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`,
  sparkle: `<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16v4M17 18h4"/>`,
  variant: `<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>`,
  edit: `<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>`,
  cube: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>`,
  star: `<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>`,
  layers: `<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/>`,
  download: `<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>`,
  check: `<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>`,
  back: `<path d="M15 5l-7 7 7 7"/>`,
  turn: `<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/><circle cx="12" cy="12" r="2.5"/>`,
  bones: `<circle cx="12" cy="4.5" r="2"/><path d="M12 6.5v7M12 13.5l-4 6.5M12 13.5l4 6.5M6 9.5h12"/>`,
  play: `<path d="M7 4.5v15l12-7.5z"/>`,
  scissors: `<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18M8 16.5 20 6"/>`,
  grid: `<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>`,
  upload: `<path d="M12 20V9M7 13l5-5 5 5M5 4h14"/>`,
  box: `<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>`,
  images: `<rect x="7" y="7" width="13" height="13" rx="2.2"/><path d="M4 16V6.2A2.2 2.2 0 0 1 6.2 4H16"/><circle cx="11.5" cy="11.5" r="1.4"/><path d="M20 17l-3.5-3.5L10 20"/>`,
  copy: `<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2"/><path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3"/>`,
  inbox: `<path d="M4 13.5 6.5 5h11l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>`,
  send: `<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="M11.5 13.5 20 4"/>`,
  film: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M8 4.5v15M16 4.5v15M3.5 9h4.5M3.5 15h4.5M16 9h4.5M16 15h4.5"/>`,
  // One per kind of asset: the picture an asset shows until it has art of its own.
  character: `<circle cx="12" cy="7.5" r="3.6"/><path d="M4.8 20.5c0-4.1 3.2-7.2 7.2-7.2s7.2 3.1 7.2 7.2"/>`,
  creature: `<path d="M4.5 19.5c0-6.2 3.3-11 7.5-11s7.5 4.8 7.5 11z"/><path d="M8.2 9.6 6 4.5M15.8 9.6 18 4.5"/><circle cx="9.6" cy="14" r=".9"/><circle cx="14.4" cy="14" r=".9"/>`,
  item: `<path d="M9.5 3.5h5M10.3 3.5v5.2L5.8 16.6A2.6 2.6 0 0 0 8.1 20.5h7.8a2.6 2.6 0 0 0 2.3-3.9l-4.5-7.9V3.5"/><path d="M7.4 14h9.2"/>`,
  weapon: `<path d="M20 4 10.5 13.5M20 4h-4.2l-8.3 8.3M20 4v4.2l-8.3 8.3"/><path d="M5.8 13.6l4.6 4.6M8.1 15.9 4 20"/>`,
  prop: `<rect x="4" y="4.5" width="16" height="16" rx="1.6"/><path d="M4 9h16M4 16h16M8 9l8 7M16 9l-8 7"/>`,
  vehicle: `<path d="M3.5 16v-3.4l2.2-5.1h12.6l2.2 5.1V16z"/><path d="M3.5 12.6h17"/><circle cx="7.6" cy="16.6" r="1.9"/><circle cx="16.4" cy="16.6" r="1.9"/>`,
  environment: `<path d="M2.5 19.5 9 9.2l4 5.9 2.6-3.6 6 8z"/><circle cx="17" cy="6" r="2"/>`,
  level: `<path d="M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>`,
  ui: `<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17M7 13h6M7 16h4"/>`,
  vfx: `<path d="M12 3v4.2M12 16.8V21M3 12h4.2M16.8 12H21M5.6 5.6l3 3M15.4 15.4l3 3M5.6 18.4l3-3M15.4 8.6l3-3"/>`,
  sound: `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>`,
  map: `<path d="M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>`,
  gpu: `<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>`,
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
// What an asset shows before it has a picture: its kind's icon on a soft tile, so an empty folder still reads.
const KIND_HUE = { character: 340, creature: 20, item: 160, weapon: 0, prop: 35, vehicle: 200, environment: 130, level: 100, ui: 260, vfx: 290, sound: 190 };
const kindArt = (kind, text = "No image yet") => {
  const k = ICON[kind] ? kind : "prop";
  return `<span class="kind-art" style="--hue:${KIND_HUE[k] ?? 330}">${icon(k)}${text ? `<small>${esc(text)}</small>` : ""}</span>`;
};

// Image outputs that can become the winner and be worked on further.
const WORK_KINDS = new Set(["candidates", "variants", "edits"]);

// A card's ⋯ menu closes when you pick something in it or click anywhere else.
document.addEventListener("click", (event) => {
  document.querySelectorAll(".out-more[open]").forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest(".out-menu button")) menu.open = false;
  });
});

// Drag a picture or model out of Tessera into Explorer / Finder (or any folder) to copy the file there.
const DRAG_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", glb: "model/gltf-binary", fbx: "application/octet-stream", obj: "model/obj", wav: "audio/wav", mp3: "audio/mpeg" };
document.addEventListener("dragstart", (event) => {
  const el = event.target.closest?.("[data-drag-file]");
  if (!el || !event.dataTransfer) return;
  const path = el.dataset.dragFile;
  const name = path.split("/").pop();
  const url = `${location.origin}${fileUrl(path)}`;
  event.dataTransfer.setData("DownloadURL", `${DRAG_TYPES[name.split(".").pop().toLowerCase()] || "application/octet-stream"}:${name}:${url}`);
  event.dataTransfer.setData("text/uri-list", url);
  event.dataTransfer.effectAllowed = "copy";
});

const removeBtn = (path) =>`<button type="button" class="out-del" data-remove-output="${esc(path)}" title="Move to trash (Undo right after)" aria-label="Delete">×</button>`;

function modelCard(o, kind) {
  const glb = /\.glb$/i.test(o.path);
  const badge = { "3d": ["cube", "3D"], rig: ["bones", "Rigged"], animations: ["film", "Animation"] }[kind] || ["cube", "3D"];
  const ext = o.path.split(".").pop().toUpperCase();
  const formats = Object.entries(o.formats || { [ext.toLowerCase()]: o.path });
  return `<div class="out model">${removeBtn(o.path)}<button type="button" class="out-img" data-view-model="${esc(o.path)}" draggable="true" data-drag-file="${esc(o.path)}" title="Open in the 3D viewer · drag into a folder to copy the model">${o.thumb ? `<img src="${esc(fileUrl(o.thumb))}" alt="">` : `<div class="no-thumb">${icon("cube")}<span>${esc(ext)} model</span></div>`}<span class="out-badge mesh">${icon(badge[0])}${badge[1]} · ${esc(ext)}</span></button>
    <div class="out-bar"><button class="act" data-view-model="${esc(o.path)}">${icon("eye")}View</button>
    ${kind === "3d" && glb ? `<button class="act" data-action="rig" data-source="${esc(o.path)}">${icon("bones")}Rig</button>` : kind === "rig" && glb ? `<button class="act" data-action="animate">${icon("play")}Animate</button>` : `<button class="act" data-sprites="${esc(o.path)}">${icon("grid")}Sprites</button>`}
    <div class="fmt-links">${icon("download")}${formats.map(([fmt, path]) => `<a href="${esc(fileUrl(path))}" download>${esc(fmt.toUpperCase())}</a>`).join("")}</div></div></div>`;
}

function outputGrid(all, winner, kind = "candidates") {
  if (!all.length) return "";
  // Engine files the browser can't show (Godot .res clips, .blend…) are listed as compact chips.
  const files = all.filter((o) => o.type === "file");
  const items = all.filter((o) => o.type !== "file");
  const chips = files.length ? `<div class="file-chips">${files.map((o) => {
    const name = o.path.split("/").pop();
    return `<span class="file-chip-wrap"><a class="file-chip" href="${esc(fileUrl(o.path))}" download title="Download ${esc(name)}">${icon(kind === "animations" ? "film" : "download")}<span>${esc(name)}</span></a><button type="button" class="chip-del" data-remove-output="${esc(o.path)}" title="Move to trash" aria-label="Delete ${esc(name)}">×</button></span>`;
  }).join("")}</div>` : "";
  return (items.length ? "" : chips) + (items.length ? `<div class="out-grid">${items.map((o) => {
    if (o.type === "model") return modelCard(o, kind);
    if (o.type === "audio") return audioCard(o, winner);
    const isWinner = o.path === winner;
    const img = `<a class="out-img" href="${esc(fileUrl(o.path))}" target="_blank" rel="noopener" data-lightbox="${esc(o.path)}" data-drag-file="${esc(o.path)}" title="Click to enlarge · drag into a folder to copy it"><img src="${esc(fileUrl(o.path))}" alt="" loading="lazy">${isWinner ? `<span class="out-badge win">${icon("star")}Winner</span>` : ""}</a>`;
    if (!WORK_KINDS.has(kind)) {
      return `<div class="out${kind === "icons" || kind === "sprites" ? " checker" : ""}">${removeBtn(o.path)}${img}<div class="out-bar">
        ${kind === "parts" || kind === "views" ? `<button class="act" data-icons="${esc(o.path)}">${icon("grid")}Icons</button><button class="act" data-winner="${esc(o.path)}">${icon("star")}Winner</button>` : ""}
        ${kind === "sheets" ? `<button class="act hero-act" data-sheet-cut="${esc(o.path)}">${icon("scissors")}Cut into props</button>` : ""}
        <a class="act wide" href="${esc(fileUrl(o.path))}" download>${icon("download")}Download</a></div></div>`;
    }
    // One clear next step per card; everything else waits in the ⋯ menu.
    return `<div class="out${isWinner ? " winner" : ""}">${removeBtn(o.path)}${img}
      <div class="out-bar compact">${isWinner ? `<span class="act win-tag">${icon("star")}Winner</span>` : `<button class="act hero-act" data-winner="${esc(o.path)}">${icon("star")}Pick winner</button>`}
      <details class="out-more"><summary class="act" title="More actions" aria-label="More actions">⋯</summary>
        <div class="out-menu">
          <button type="button" data-action="variant" data-source="${esc(o.path)}">${icon("variant")}Variant</button>
          <button type="button" data-action="edit" data-source="${esc(o.path)}">${icon("edit")}Edit</button>
          <button type="button" data-split="${esc(o.path)}">${icon("scissors")}Split into parts</button>
          <button type="button" data-icons="${esc(o.path)}">${icon("grid")}Make icons</button>
          <hr><button type="button" class="pillar-item-btn" data-make-pillar="${esc(o.path)}" title="Use this image as a style reference for a whole folder">${icon("layers")}Make pillar</button>
        </div></details></div></div>`;
  }).join("")}</div>${chips}` : "");
}

const AUDIO_KINDS = ["sfx", "voice", "music"];
const AUDIO_RE = /\.(mp3|wav|ogg|flac)$/i;
const AUDIO_COPY = {
  sfx: { prompt: "Prompt: what this sound is", run: "Generate sounds", empty: "No sound picked yet." },
  voice: { prompt: "Line: what the character says", run: "Generate line", empty: "No take picked yet." },
  music: { prompt: "Prompt: mood, instruments, tempo", run: "Generate music", empty: "No track picked yet." },
};

function audioCard(o, winner) {
  const isWinner = o.path === winner;
  const name = o.path.split("/").pop();
  return `<div class="out audio${isWinner ? " winner" : ""}">${removeBtn(o.path)}
    <div class="audio-face">${isWinner ? `<span class="out-badge win">${icon("star")}Winner</span>` : ""}<span class="wave" aria-hidden="true">${"<i></i>".repeat(18)}</span><small>${esc(name)}</small></div>
    <audio controls preload="none" src="${esc(fileUrl(o.path))}"></audio>
    <div class="out-bar">${isWinner ? "" : `<button class="act wide hero-act" data-winner="${esc(o.path)}">${icon("star")}Pick winner</button>`}
      <a class="act wide" href="${esc(fileUrl(o.path))}" download>${icon("download")}Download</a></div></div>`;
}

// Animation clips as one compact list: the same clip in several files (Walk.fbx and walk.res) is one row, and
// an FBX clip plays on the model in the hero viewer. Tessera's own animated GLBs (mesh included) keep their cards.
function animationBlock(list, canPlay) {
  const cards = list.filter((o) => o.type === "model" && /\.glb$/i.test(o.path));
  const clips = {};
  for (const o of list.filter((x) => !cards.includes(x))) {
    const file = o.path.split("/").pop();
    const stem = file.replace(/\.[^.]+$/, "");
    (clips[stem.toLowerCase().replace(/[^a-z0-9]+/g, "")] ||= { label: humanize(stem.replace(/[_-]+/g, " ")), files: [] }).files.push(o.path);
  }
  const rows = Object.values(clips).sort((x, y) => x.label.localeCompare(y.label)).map((c) => {
    const playable = canPlay && c.files.find((p) => /\.(fbx|glb|gltf)$/i.test(p));
    return `<div class="clip">${playable ? `<button type="button" class="clip-play" data-play-clip="${esc(playable)}" title="Play on the model above">${icon("play")}</button>` : `<span class="clip-play off">${icon("film")}</span>`}
      <span class="clip-name">${esc(c.label)}</span>
      <span class="clip-files">${c.files.map((p) => `<a href="${esc(fileUrl(p))}" download title="${esc(p.split("/").pop())}">${esc(p.split(".").pop().toUpperCase())}</a>`).join("")}</span></div>`;
  }).join("");
  const count = Object.keys(clips).length;
  return `<h2 class="block-title" id="out-animations">Animations <span class="block-count">${count + cards.length}</span></h2>
    ${cards.length ? outputGrid(cards, "", "animations") : ""}
    ${count ? `<div class="clip-list">${rows}</div>${canPlay ? "" : `<p class="hint-line">Add the character's 3D model to play these clips on it here.</p>`}` : ""}`;
}

// Textures are the model's material maps: a small strip, not a wall of cards.
function textureStrip(list) {
  const images = list.filter((o) => o.type === "image");
  const files = list.filter((o) => o.type !== "image");
  return `<details class="tex-block"${list.length <= 8 ? " open" : ""}><summary><h2 class="block-title" id="out-textures">Textures <span class="block-count">${list.length}</span></h2></summary>
    <div class="tex-strip">${images.map((o) => `<a href="${esc(fileUrl(o.path))}" data-lightbox="${esc(o.path)}" title="${esc(o.path.split("/").pop())}"><img src="${esc(fileUrl(o.path))}" alt="" loading="lazy"></a>`).join("")}
    ${files.map((o) => `<a class="tex-file" href="${esc(fileUrl(o.path))}" download>${esc(o.path.split("/").pop())}</a>`).join("")}</div></details>`;
}

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-play-clip]");
  if (!t) return;
  if (!hero?.view) return toast("The 3D model is still loading.", true);
  document.querySelectorAll(".clip.playing").forEach((c) => c.classList.remove("playing"));
  try {
    if (await hero.view.playFrom(fileUrl(t.dataset.playClip))) {
      t.closest(".clip").classList.add("playing");
      $("#content [data-hero-model]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else toast("This clip's bones don't match the model, so it can't play here.", true);
  } catch { toast("Couldn't load this clip.", true); }
});

const OUTPUT_SECTIONS = [
  ["audio", "Takes"], ["3d", "3D models"], ["rig", "Rigged"], ["animations", "Animations"], ["sprites", "Sprite sheets"], ["icons", "Icons"],
  ["sheets", "Prop sheets"], ["views", "Turnaround views"], ["candidates", "Candidates"], ["variants", "Variants"], ["edits", "Edits"], ["textures", "Textures"], ["parts", "Parts"],
];

// ---------- the stage: an asset page shows the asset large, the track of its stages, and the one next step ----------

// Which stages this asset has reached. Clicking a reached stage puts that stage's result on the stage.
function stageTrack(a, o, showing) {
  const threeD = !is2d() && a.kind !== "material" && a.kind !== "level";
  const model = (list) => (list || []).find((m) => m.type === "model" && /\.glb$/i.test(m.path)) || (list || []).find((m) => m.type === "model");
  const m3 = model(o["3d"]), mr = model(o.rig), ma = model(o.animations);
  const linked = state.link?.assets?.find((x) => x.path === a.path);
  const inGame = Boolean(linked?.files?.some((f) => (f.copies || []).length));
  const cands = (o.candidates || []).length;
  const steps = [
    { label: "Concept", done: cands > 0 || Boolean(a.winner), attrs: "data-scroll-candidates", on: false, tip: cands ? `${cands} take${cands === 1 ? "" : "s"}` : "No takes yet" },
    { label: "Picked", done: Boolean(a.winner), attrs: `data-stage-show=""`, on: Boolean(a.winner) && !showing, tip: "The winning picture" },
    ...(threeD ? [
      { label: "3D", done: Boolean(m3), attrs: m3 ? `data-stage-show="${esc(m3.path)}"` : "", on: Boolean(m3) && showing?.path === m3.path, tip: "The 3D model" },
      { label: "Rig", done: Boolean(mr), attrs: mr ? `data-stage-show="${esc(mr.path)}"` : "", on: Boolean(mr) && showing?.path === mr.path, tip: "The rigged model" },
      { label: "Motion", done: Boolean(ma), attrs: ma ? `data-stage-show="${esc(ma.path)}"` : "", on: Boolean(ma) && showing?.path === ma.path, tip: "The animated model" },
    ] : []),
    { label: "In game", done: inGame, attrs: "data-pipeline", on: false, tip: inGame ? "Copied into your game" : "Not in your game yet" },
  ];
  return `<nav class="stage-track" aria-label="Stages of ${esc(a.path)}">${steps.map((s, i) => {
    const through = s.done && steps[i + 1]?.done;
    return `<button type="button" class="st-step${s.done ? " done" : ""}${s.on ? " on" : ""}${through ? " thru" : ""}" ${s.done ? s.attrs : "disabled"} title="${esc(s.tip)}"${s.on ? ' aria-current="step"' : ""}><span>${s.label}</span></button>`;
  }).join("")}</nav>`;
}

// The single most useful thing to do with this asset now.
function nextStep(a, o, jobs) {
  if (jobs.length) return `<div class="next-step busy"><span class="ns-ico"><span class="spinner"></span></span><span class="ns-text"><small>Working</small><b>${jobs.map((j) => esc(jobLabel(j) || j.action)).join(", ")}</b><em>The result lands on this page by itself.</em></span></div>`;
  const cands = (o.candidates || []).length;
  const glb = (o["3d"] || []).some((m) => /\.glb$/i.test(m.path));
  const rigged = Boolean(a.meta?.rig_task) || (o.rig || []).length > 0;
  const moving = (o.animations || []).length > 0;
  const threeD = !is2d() && a.kind !== "material" && a.kind !== "level";
  const riggable = ["character", "creature"].includes(a.kind);
  let s;
  if (!a.winner && !cands) s = ["sparkle", "Generate images", "Takes from the prompt, in your project's style.", `data-action="candidates"`];
  else if (!a.winner) s = ["star", "Pick a winner", `${cands} take${cands === 1 ? " is" : "s are"} waiting below. Press 1 to 9, then Enter.`, "data-scroll-candidates"];
  else if (threeD && !glb) s = ["cube", "Make the 3D model", "A textured mesh from the winner, at game scale.", `data-action="make_3d"`];
  else if (threeD && riggable && !rigged) s = ["bones", "Rig it", "Add a skeleton, so it can be animated.", `data-action="rig"`];
  else if (threeD && riggable && !moving) s = ["play", "Animate it", "Walk, run and attack clips for the rig.", `data-action="animate"`];
  else if (a.kind === "level" && levelPackLeft()) s = ["box", is2d() ? "Cut out its props" : "Turn into asset pack", "Walls, floors and props made from this picture. See the cost first.", `data-level-pack="${esc(a.path)}"`];
  else s = ["check", "Ready for your game", "Listed in tessera/ASSETS.md. Export a ZIP for Godot, Unity or Unreal.", `data-export="${esc(a.path)}"`];
  return `<button type="button" class="next-step${s[0] === "check" ? " ready" : ""}" ${s[3]}><span class="ns-ico">${icon(s[0])}</span><span class="ns-text"><small>${s[0] === "check" ? "Done" : "Next step"}</small><b>${s[1]}</b><em>${s[2]}</em></span><span class="ns-go">${icon("chev-right")}</span></button>`;
}

// "Copy prompt" takes the full prompt a new image is sent with (style rules, style bible and reference rule
// included); "Copy images" takes the pillar images that go with it. Two buttons, because a paste picks one kind.
function copyPair(a, compact = false) {
  const strength = a.meta.pillars || "normal";
  const n = strength === "off" ? 0 : strength === "light" ? Math.min(2, a.pillars.length) : a.pillars.length;
  return `<span class="copy-pair${compact ? " compact" : ""}">
    <button type="button" class="mini" data-copy-prompt="${esc(a.path)}" title="Copy the full prompt as sent, with the style bible">${icon("copy")}${compact ? "Copy" : "Copy prompt"}</button>
    <button type="button" class="mini" data-copy-images="${esc(a.path)}"${n ? "" : " disabled"} title="${n ? `Copy the ${n} pillar image${n === 1 ? "" : "s"} sent with every generation` : "No pillar images apply to this asset"}">${icon("images")}${compact ? "" : "Copy images "}<b>${n}</b></button>
  </span>`;
}

async function copyAssetPrompt(path) {
  // The clipboard write starts during the click with a promise for the text: browsers drop the permission
  // once the click is over, and the prompt is still being built on the server at that point.
  const prompt = api(`/api/studio/copy-pack?path=${encodeURIComponent(path)}`).then(({ prompt }) => {
    if (!prompt.trim()) throw new Error("this asset has no prompt yet");
    return prompt;
  });
  try {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": prompt.then((t) => new Blob([t], { type: "text/plain" })) })]);
    } catch (err) {
      if (/no prompt/.test(err.message)) throw err;
      // The browser refused: on Windows the server writes the clipboard instead.
      try { await api("/api/studio/copy-prompt", { method: "POST", body: { path } }); }
      catch { await navigator.clipboard.writeText(await prompt); }
    }
    toast("Copied the full prompt");
  } catch (err) { toast(`Could not copy: ${err.message}`, true); }
}

async function copyAssetImages(path, btn) {
  btn.disabled = true;
  try {
    // On Windows the server puts the files themselves on the clipboard: one paste drops every image.
    const { copied } = await api("/api/studio/copy-images", { method: "POST", body: { path } });
    toast(`Copied ${copied} pillar image${copied === 1 ? "" : "s"}. Paste them anywhere`);
  } catch (err) {
    // Elsewhere a browser can hold one image, so the pillars go as one sheet.
    try {
      const { images } = await api(`/api/studio/copy-pack?path=${encodeURIComponent(path)}`);
      if (!images.length) throw err;
      const sheet = Promise.all(images.map((p) => loadImage(fileUrl(p)))).then((list) => imageSheet(list));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": sheet })]);
      toast(`Copied ${images.length} pillar image${images.length === 1 ? "" : "s"} as one sheet`);
    } catch (e) { toast(`Could not copy: ${e.message}`, true); }
  }
  btn.disabled = false;
}

// Capture phase: on an asset tile these sit inside the tile's own button, which would open the asset.
document.addEventListener("click", (event) => {
  const t = event.target.closest("[data-copy-prompt],[data-copy-images]");
  if (!t) return;
  event.stopPropagation();
  event.preventDefault();
  if (t.dataset.copyPrompt) copyAssetPrompt(t.dataset.copyPrompt);
  else copyAssetImages(t.dataset.copyImages, t);
}, true);

// What the style block says while it is folded.
function styleSummary(a) {
  const strength = { off: "pillars off", light: "light", normal: "normal", strong: "strong" }[a.meta.pillars || "normal"] || "normal";
  const refs = a.pillars.length ? `${a.pillars.length} reference image${a.pillars.length === 1 ? "" : "s"}` : "no reference images";
  return `${refs}${(a.text_pillars || []).length ? " · style bible" : ""} · ${strength}`;
}

document.addEventListener("click", (event) => {
  const step = event.target.closest("[data-stage-show]");
  if (!step || state.view.type !== "doc") return;
  // "Picked" (an empty value) asks for the 2D picture; otherwise the stage shows the asset's newest 3D model.
  state.stageView = { path: state.view.path, model: step.dataset.stageShow || "" };
  // The page is redrawn in place: stay where the reader was.
  const box = $("#content"), top = box.scrollTop;
  renderView().then(() => { box.scrollTop = top; });
});
// The style block stays open or folded across the page's own redraws.
document.addEventListener("toggle", (event) => { if (event.target.matches?.("details.applied")) state.styleOpen = event.target.open; }, true);

function renderAssetPage(a) {
  const title = displayTitle((a.body.match(/^#\s+(.+)$/m) || [])[1] || humanize(a.path.split("/").pop()));
  const jobs = runningJobs(a.path);
  const groups = {};
  for (const p of a.pillars) (groups[p.source] ||= []).push(p);
  const o = a.outputs;
  // With no winner image, the newest model fills the hero slot: animated first, then rigged, then plain 3D. An
  // animation counts only as a GLB (Tessera's own, with the mesh): an imported FBX clip is usually bones alone.
  const heroModel = [...(o.animations || []).filter((m) => /\.glb$/i.test(m.path)), ...(o.rig || []), ...(o["3d"] || [])].find((m) => m.type === "model");
  const asked = state.stageView?.path === a.path ? [...(o.animations || []), ...(o.rig || []), ...(o["3d"] || [])].find((m) => m.path === state.stageView.model) : null;
  const wants2d = state.stageView?.path === a.path && !state.stageView.model && a.winner;
  const stage3d = asked || (wants2d ? null : heroModel || null);
  if (AUDIO_KINDS.includes(a.kind)) return renderAudioAsset(a, title, jobs);
  if (a.kind === "kit") return renderKitAsset(a, title);
  return `
    <div class="asset-head"><h1 class="title" title="${esc(a.path)}">${esc(title)}</h1><span class="kind-tag">${esc(a.kind)}</span>${copyPair(a)}</div>
    ${problemJobs(a.path).map((j) => `<div class="job-banner bad"><span class="bad-dot">!</span><span class="grow">${esc(jobLabel(j) || j.action)} ${j.status === "interrupted" ? "was interrupted" : "failed"}: ${esc(j.error || "no details")}</span><button type="button" class="mini" data-action="${esc(j.action)}">Try again</button><button type="button" class="mini" data-dismiss-job="${esc(j.id)}">Dismiss</button></div>`).join("")}
    <div class="asset-top">
      <div class="stage-col"><div class="winner-box drop-zone${stage3d ? " hero-3d" : ""}" data-drop-winner${stage3d ? ` data-hero-model="${esc(stage3d.path)}"` : ""} title="${is2d() ? "Drop an image here to use it as the winner" : "Drop an image to use it as the winner, or a 3D model to add it"}">${a.winner && !stage3d ? `<img src="${esc(fileUrl(a.winner))}" alt="Winner"><span class="drop-hint">${is2d() ? "Drop an image to replace" : "Drop an image to replace, or a 3D model to add"}</span>` : stage3d ? `
        ${a.winner ? `<img src="${esc(fileUrl(a.winner))}" alt="" hidden>` : ""}${stage3d.thumb ? `<img class="hero-poster" src="${esc(fileUrl(stage3d.thumb))}" alt="">` : ""}<div class="hero-stage"></div>
        <span class="out-badge mesh hero-badge">${icon("cube")}3D · drag to turn</span>
        <button type="button" class="mini hero-open" data-view-model="${esc(stage3d.path)}">${icon("eye")}Open viewer</button>
        ${a.winner ? "" : `<span class="drop-hint">Drop an image to make it the winner</span>`}` : `<div class="no-thumb big"><p class="drop-copy">${kindArt(a.kind, "")}No picture yet.<br>${(o.candidates || []).length ? `<button type="button" class="link-btn" data-scroll-candidates>Pick ${(o.candidates || []).length === 1 ? "the candidate" : `one of the ${(o.candidates || []).length} candidates`} below</button>, <b>drop or paste an image${is2d() ? "" : " or 3D model"} here</b>` : `Generate images, <b>drop or paste an image${is2d() ? "" : " or 3D model"} here</b>`}<br>or <button type="button" class="link-btn" data-pick-winner-file>choose a file</button>.</p></div>`}</div>
      ${stageTrack(a, o, stage3d)}</div>
      <div class="asset-side">
        ${nextStep(a, o, jobs)}
        <div class="prompt-label-row"><label class="field-label" for="assetPrompt">Prompt: what this ${esc(a.kind)} looks like</label>${copyPair(a, true)}</div>
        <textarea id="assetPrompt" class="prompt-box" rows="5" data-asset="${esc(a.path)}">${esc(a.prompt)}</textarea>
        <div class="make-dock">
          <button type="button" class="dock-tile tone-brand" data-action="candidates">${icon("sparkle")}<b>Images</b><small>New 2D art from the prompt</small></button>
          <button type="button" class="dock-tile tone-amber" data-action="variant"${a.winner ? "" : " disabled"}>${icon("variant")}<b>Variant</b><small>A new take on the winner</small></button>
          <button type="button" class="dock-tile tone-violet" data-action="edit"${a.winner ? "" : " disabled"}>${icon("edit")}<b>Edit</b><small>Change one thing</small></button>
          ${is2d() || a.kind === "material" || a.kind === "level" ? "" : `<button type="button" class="dock-tile tone-sky sem-mesh" data-action="make_3d"${a.winner ? "" : " disabled"}>${icon("cube")}<b>3D model</b><small>Image to textured mesh</small></button>`}
          ${a.kind === "material" || a.kind === "level" ? "" : `<button type="button" class="dock-tile tone-pixel" data-pixel-new="${esc(a.path)}">${icon("grid")}<b>Pixel sprite</b><small>A pixel-art version, animated</small></button>`}
        </div>
        ${a.kind === "level" ? levelPanel(a) : ""}
        ${a.kind === "material" ? materialPanel(a) : ""}
        ${gameTools(a)}
        <details class="applied"${state.styleOpen ? " open" : ""}><summary><span>Style</span><small>${esc(styleSummary(a))}</small></summary><div class="applied-in">
          <div class="field-label pillar-head">Pillars sent with every generation
            <select class="pillar-strength" data-pillar-strength title="How strongly the pillars steer this asset">${[["off", "Off"], ["light", "Light · palette only"], ["normal", "Normal"], ["strong", "Strong · match closely"]].map(([v, l]) => `<option value="${v}" ${(a.meta.pillars || "normal") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          ${a.pillars.length ? Object.entries(groups).map(([src, items]) => `<div class="applied-group"><span>${esc(src)}</span><div class="pillar-row small">${items.map((p) => `<img src="${esc(fileUrl(p.path))}" title="${esc(p.path)}" alt="">`).join("")}</div></div>`).join("")
            : `<p class="pillar-empty">${(a.text_pillars || []).length ? "No reference images yet: add some" : "No pillars apply yet. Add reference images"} on the project front page (bible) or on this asset's folder.</p>`}
          ${(a.text_pillars || []).length ? `<details class="bible-mini"><summary><span>Style bible</span>${a.text_pillars.map((t) => esc(t.source)).join(" · ")}<em>View</em></summary>
            ${a.text_pillars.map((t) => `<div class="md">${renderMarkdown(t.text)}</div>`).join("")}</details>` : ""}
          ${a.style_rules.map((r) => `<div class="applied-group"><span>Style · ${esc(r.source)}</span><p>${esc(r.text)}</p></div>`).join("")}
        </div></details>
      </div>
    </div>
    ${a.kind === "level" ? packPicks() : ""}
    ${(a.winner ? OUTPUT_SECTIONS : [...OUTPUT_SECTIONS].sort((x, y) => (y[0] === "candidates") - (x[0] === "candidates"))).map(([kind, label]) => (o[kind] || []).length ? (kind === "animations" ? animationBlock(o[kind], Boolean(stage3d))
      : kind === "textures" ? textureStrip(o[kind]) : `<h2 class="block-title" id="out-${kind}">${label}</h2>${outputGrid(o[kind], a.winner, kind)}`) : "").join("")}
    <h2 class="block-title">Notes</h2>
    <div class="doc-bar"><span class="path"><bdi>${esc(a.path)}</bdi></span><button class="ghost" data-edit>Edit document</button></div>
    <div class="md">${renderMarkdown(a.body.replace(/^#\s+.+$/m, ""), dirOf(a.path))}</div>`;
}

// Sound assets: a player for the winner take, the prompt (or the line to speak), and the takes below.
function renderAudioAsset(a, title, jobs) {
  const copy = AUDIO_COPY[a.kind];
  const takes = a.outputs.audio || [];
  return `
    <div class="asset-head"><h1 class="title" title="${esc(a.path)}">${esc(title)}</h1><span class="kind-tag">${esc(a.kind)}</span></div>
    ${problemJobs(a.path).map((j) => `<div class="job-banner bad"><span class="bad-dot">!</span><span class="grow">${esc(copy.run)} failed: ${esc(j.error || "no details")}</span><button type="button" class="mini" data-action="candidates">Try again</button><button type="button" class="mini" data-dismiss-job="${esc(j.id)}">Dismiss</button></div>`).join("")}
    ${jobs.length ? `<div class="job-banner"><span class="spinner"></span>${esc(copy.run)} running… takes appear here automatically.</div>` : ""}
    <div class="asset-top">
      <div class="winner-box audio-hero drop-zone" data-drop-winner title="Drop an audio file here">${a.winner && AUDIO_RE.test(a.winner)
        ? `<div class="audio-big" data-wave-src="${esc(a.winner)}"><canvas class="wave-canvas" height="120"></canvas><audio controls src="${esc(fileUrl(a.winner))}"></audio>
            <div class="wave-tools"><small>${esc(a.winner.split("/").pop())}</small><span class="grow"></span><span class="wave-sel" hidden></span>
              <button type="button" class="mini" data-wave-loop title="Play the last 2 seconds straight into the first 2, to hear the loop seam">${icon("turn")}Loop check</button>
              <button type="button" class="mini" data-wave-trim disabled title="Drag across the waveform to choose a part, then save it as a new take">${icon("scissors")}Save selection</button></div></div><span class="drop-hint">Drop an audio file to add a take</span>`
        : `<div class="no-thumb big"><p class="drop-copy"><span class="drop-icon">♪</span>${copy.empty}<br>Generate takes or <b>drop an MP3 / WAV here</b>.</p></div>`}</div>
      <div class="asset-side">
        <label class="field-label" for="assetPrompt">${copy.prompt}</label>
        <textarea id="assetPrompt" class="prompt-box" rows="6" data-asset="${esc(a.path)}">${esc(a.prompt)}</textarea>
        <div class="action-row"><button class="primary" data-action="candidates">${icon("sparkle")}${copy.run}</button></div>
        ${a.kind === "voice" ? `<p class="hint-line">Voice: <b>${esc(a.meta.voice_name || a.meta.voice || "pick one when you generate")}</b></p>` : ""}
      </div>
    </div>
    ${takes.length ? `<h2 class="block-title">Takes</h2>${outputGrid(takes, a.winner, "audio")}` : ""}
    <h2 class="block-title">Notes</h2>
    <div class="doc-bar"><span class="path"><bdi>${esc(a.path)}</bdi></span><button class="ghost" data-edit>Edit document</button></div>
    <div class="md">${renderMarkdown(a.body.replace(/^#\s+.+$/m, ""), dirOf(a.path))}</div>`;
}

async function uploadAudio(files) {
  const sounds = [...files].filter((f) => AUDIO_RE.test(f.name));
  if (!sounds.length) return;
  const form = new FormData();
  sounds.forEach((f) => form.append("files", f));
  try {
    const res = await fetch(`/api/studio/audio-upload?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(state.view.path)}`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Upload failed");
    toast(`Added ${plural(data.saved.length, "take")}`);
    renderView();
  } catch (err) { toast(err.message, true); }
}

async function renderAudioSheet() {
  const p = state.preview;
  const copy = AUDIO_COPY[p.kind];
  const s = p.settings;
  if (p.kind === "voice" && !state.voices) {
    state.voices = (await api("/api/studio/voices").catch(() => ({ voices: [] }))).voices || [];
  }
  const voices = state.voices || [];
  if (p.kind === "voice" && !s.voice_id && voices[0]) s.voice_id = voices[0].id;
  const model = p.models.find((m) => m.id === p.model);
  openDialog(`
    <div class="dlg sheet tone-brand">
      <header class="sheet-head"><span class="sheet-icon">${icon("sparkle")}</span>
        <div><h2>${esc(copy.run)} <span>· ${esc(humanize(p.asset.split("/").pop()))}</span></h2><p>${p.kind === "voice" ? "The line is spoken by the voice you pick." : "Takes land under the asset; pick the winner by ear."}</p></div></header>
      <div class="sheet-model">
        <label class="model-pick">Generator<select id="auModel">${p.models.map((m) => `<option value="${esc(m.id)}" ${m.id === p.model ? "selected" : ""} ${m.available ? "" : "disabled"}>${esc(m.label)}${m.available ? "" : m.service ? " · not signed in" : " · no key"}</option>`).join("")}</select></label>
      </div>
      <div class="sheet-body"><section>
        <label class="field-label" for="pvPrompt">${p.kind === "voice" ? "Line to speak" : "Prompt"} <em>exactly what is sent</em></label>
        <textarea id="pvPrompt" class="final-prompt" rows="4">${esc(p.prompt)}</textarea>
      </section><section class="audio-opts">
        ${p.kind === "voice" ? `<label>Voice<select id="auVoice">${voices.map((v) => `<option value="${esc(v.id)}" ${v.id === s.voice_id ? "selected" : ""}>${esc(v.name)}${v.category ? ` · ${esc(v.category)}` : ""}</option>`).join("") || `<option value="">${model?.available ? "Loading voices failed" : "Sign in to ElevenLabs or add a key first"}</option>`}</select></label>` : ""}
        ${p.kind !== "voice" ? `<label>Length<select id="auDuration">${[...new Set([...(p.kind === "music" ? [8, 15, 30, 60, 90, 120, 180] : [0, 1, 2, 3, 4, 5, 8, 10, 12, 15, 20, 30]), Number(s.duration) || 0])].sort((x, y) => x - y).map((d) => `<option value="${d}" ${Number(s.duration) === d ? "selected" : ""}>${d ? `${d} s` : "Automatic"}</option>`).join("")}</select></label>
          <label class="mesh-toggle"><span class="switch"><input type="checkbox" id="auLoop" ${s.loop ? "checked" : ""}><span></span></span><span>Seamless loop<small>For ambience, engines, music beds</small></span></label>` : ""}
      </section></div>
      <footer class="sheet-foot">
        <label class="inline">${p.kind === "sfx" ? "Variations" : "Takes"} <select id="pvCount">${(p.kind === "sfx" ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4]).map((n) => `<option ${n === p.count ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        ${p.kind === "sfx" ? `<span class="cost">A pool of variations keeps repeated sounds (footsteps, hits) from sounding robotic</span>` : ""}
        <span class="grow"></span>
        <button type="button" class="ghost" data-close>Cancel</button><button type="button" class="run-btn" data-run>${icon("sparkle")}${esc(copy.run)}</button>
      </footer>
    </div>`);
}

function syncAudioFields() {
  const p = state.preview;
  if (!p?.audio) return;
  if ($("#auModel")) p.model = $("#auModel").value;
  if ($("#auVoice")) p.settings.voice_id = $("#auVoice").value;
  if ($("#auDuration")) p.settings.duration = Number($("#auDuration").value);
  if ($("#auLoop")) p.settings.loop = $("#auLoop").checked;
}

async function saveAssetPrompt() {
  const box = $("#assetPrompt");
  if (!box) return;
  await api("/api/studio/asset", { method: "PATCH", body: { path: box.dataset.asset, fields: { prompt: box.value.trim() } } });
}

async function openPreview(action, source = "", instruction = "") {
  try {
    await saveAssetPrompt();
    await Promise.all([studioOptions(), loadCredits()]);
    const req = await api("/api/studio/preview", { method: "POST", body: { path: state.view.path, action, source, instruction } });
    // A variant or edit starts from an existing image, so the style bible stays off unless switched on.
    if (action === "rig") { state.preview = req; return renderRigSheet(); }
    if (action === "animate") { state.preview = { ...req, picked: [], search: "" }; return renderAnimateSheet(); }
    if (req.audio) { state.preview = req; return renderAudioSheet(); }
    const bible = action === "variant" || action === "edit" || action === "views" ? false : req.use_bible !== false;
    state.preview = applyBible({ ...req, model3d: String(req.model || "").startsWith("svc:") ? req.model : "", use_bible: bible, instruction, references: req.references.map((r) => ({ ...r, on: true })) });
    renderPreview();
  } catch (err) { toast(err.message, true); }
}

function refLabel(r) {
  if (r.role === "source") return "Source image";
  if (r.role === "extra") return "Added for this run";
  if (r.role === "view") return "Turnaround view";
  return `Pillar · ${r.source}`;
}

const ACTION_THEME = {
  candidates: { tone: "brand", icon: "sparkle", blurb: "New images from the asset prompt, styled by the pillars." },
  variant: { tone: "amber", icon: "variant", blurb: "A new take on the source image. Same subject, pose and style." },
  edit: { tone: "violet", icon: "edit", blurb: "Change one thing in the source image and keep the rest." },
  make_3d: { tone: "sky", icon: "cube", blurb: "Turn the winner image into a textured 3D model." },
  views: { tone: "amber", icon: "turn", blurb: "Side and back views of the winner. Make 3D then uses them for a better model." },
  trim_sheet: { tone: "amber", icon: "grid", blurb: "Pillars, arches and door frames from the level picture, on one sheet. They also hide the joins between walls." },
  prop_sheet: { tone: "amber", icon: "grid", blurb: "Every prop in the level picture, drawn once on one sheet. One image instead of one per prop; Tessera cuts it up for free." },
  rig: { tone: "sky", icon: "bones", blurb: "Add a skeleton to a humanoid model so it can be animated. Includes walk and run clips." },
  animate: { tone: "violet", icon: "play", blurb: "Put preset animations on the rigged model: idle, attack, death and more." },
};
// The composer's mode tabs: [action, label, icon, needs a picture]. "pixel" leaves for Pixel Studio.
const CMP_MODES = [["candidates", "Image", "sparkle", false], ["variant", "Variant", "variant", true], ["edit", "Edit", "edit", true], ["make_3d", "3D model", "cube", true], ["pixel", "Pixel sprite", "grid", false]];
document.addEventListener("click", (event) => {
  const b = event.target.closest("#dialog [data-cmp-mode], #dialog [data-cmp-aspect], #dialog [data-cmp-count]");
  if (!b || !state.preview) return;
  syncPreviewFields();
  const p = state.preview;
  if (b.dataset.cmpAspect) { p.settings.aspect_ratio = b.dataset.cmpAspect; return renderPreview(); }
  if (b.dataset.cmpCount) { p.count = Number(b.dataset.cmpCount); return renderPreview(); }
  const mode = b.dataset.cmpMode;
  if (mode === p.action) return;
  if (mode === "pixel") { const asset = p.asset; closeDialog(); return openPixelNew(asset); }
  if (mode === "make_3d" && !document.querySelector("#content .winner-box > img")) return;
  openPreview(mode, "", p.instruction || "");
});
document.addEventListener("click", (event) => {
  const b = event.target.closest("#dialog [data-cmp-maker-open], #dialog [data-cmp-maker], #dialog [data-maker-setup], #dialog [data-cmp-cutter], #dialog [data-cmp-view]");
  if (!b || !state.preview) return;
  event.preventDefault();
  syncPreviewFields();
  const p = state.preview;
  if (b.matches("[data-cmp-maker-open]")) { p.makerOpen = !p.makerOpen; return renderPreview(); }
  if (b.dataset.cmpMaker) {
    p.model = b.dataset.cmpMaker.split("|")[1];
    p.makerOpen = false;
    return renderPreview();
  }
  if (b.dataset.cmpView) { p.promptView = b.dataset.cmpView; return renderPreview(); }
  closeDialog();
  if (b.matches("[data-cmp-cutter]")) { state.makerOpen = "cut"; return settingsDialog("images"); }
  settingsDialog(b.dataset.makerSetup === "local" ? "local" : "accounts");
});
const PART_ROLE = { bible: "Style bible", subject: "Subject", style: "Style rule", rule: "Reference rule" };

async function studioOptions() {
  if (!state.studio) state.studio = await api("/api/studio/options").catch(() => ({ models: [], kinds: [], selected: "" }));
  if (!state.serviceModels) loadServiceModels();
  return state.studio;
}

// Models of the services the user signed in to. Asking each service takes a moment, so the sheet redraws when they arrive.
function loadServiceModels() {
  state.serviceModels = { image: [], "3d": [], loading: true };
  state.serviceModelsReady = api("/api/studio/service-models").catch(() => ({ image: [], "3d": [] })).then((models) => {
    state.serviceModels = models;
    if (state.preview && $("#dialog")?.open && $("#pvSource")) { syncPreviewFields(); renderPreview(); }
    return models;
  });
  return state.serviceModelsReady;
}

const ASPECTS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"];
const ASPECT_NAME = { "1:1": "Square", "4:3": "Wide", "3:4": "Tall", "3:2": "Wide", "2:3": "Tall", "16:9": "Very wide", "9:16": "Very tall" };
const aspectOptions = (value) => [...new Set([value || "1:1", ...ASPECTS])].map((a) => `<option value="${esc(a)}" ${a === (value || "1:1") ? "selected" : ""}>${ASPECT_NAME[a] ? `${ASPECT_NAME[a]} · ` : ""}${esc(a)}</option>`).join("");

// Where a studio model runs: "keys" (Tessera's providers, with your API keys) or a signed-in service's id.
const modelSource = (model) => (String(model || "").startsWith("svc:") ? model.slice(4).split("/")[0] : "keys");

function sourcePicker(p, kind) {
  const list = state.serviceModels?.[kind] || [];
  const services = [...new Map(list.map((m) => [m.service, m.label.split(" · ")[0]])).entries()];
  const current = modelSource(kind === "3d" ? p.model3d : p.model);
  // The default can be a signed-in service whose models haven't arrived yet: show it chosen, not "keys".
  if (current !== "keys" && !services.some(([id]) => id === current)) services.push([current, humanize(current)]);
  const keysLabel = kind === "3d" ? "Tessera · Meshy / Tripo settings" : "Tessera · your API keys";
  return `<label class="model-pick">Source <select id="pvSource">
    <option value="keys" ${current === "keys" ? "selected" : ""}>${keysLabel}</option>
    ${services.map(([id, label]) => `<option value="${esc(id)}" ${current === id ? "selected" : ""}>${esc(label)} · signed in (MCP)</option>`).join("")}
    ${state.serviceModels?.loading ? `<option disabled>Checking signed-in services…</option>` : ""}</select></label>`;
}

function serviceModelOptions(kind, service, selected) {
  const list = (state.serviceModels?.[kind] || []).filter((m) => m.service === service);
  const pending = selected && selected.startsWith(`svc:${service}/`) && !list.some((m) => m.id === selected)
    ? `<option value="${esc(selected)}" selected>${esc(humanize(selected.split("/").pop()))}${state.serviceModels?.loading ? " · loading…" : ""}</option>` : "";
  return pending + list.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(m.label.split(" · ").slice(1).join(" · "))}</option>`).join("");
}

// Each service's own recommended model, picked when the user switches to it.
const SERVICE_DEFAULT_MODEL = { "elevenlabs/image": "svc:elevenlabs/gpt-image-2.5-sunburst", "higgsfield/image": "svc:higgsfield/gpt_image_2_5", "higgsfield/3d": "svc:higgsfield/meshy_v7_image_to_3d" };

function onSourceChange(kind) {
  const p = state.preview;
  const source = $("#pvSource").value;
  const pick = source === "keys"
    ? (kind === "3d" ? "" : (state.studio.models.find((m) => m.id === state.studio.selected && m.available) || state.studio.models.find((m) => m.available) || {}).id || "")
    : (state.serviceModels[kind].find((m) => m.id === SERVICE_DEFAULT_MODEL[`${source}/${kind}`]) || state.serviceModels[kind].find((m) => m.service === source) || {}).id || "";
  if (kind === "3d") p.model3d = pick; else p.model = pick;
  renderPreview();
}

function renderPreview() {
  const p = state.preview;
  const theme = ACTION_THEME[p.action];
  const needsInstruction = p.action === "variant" || p.action === "edit" || p.action === "prop_sheet";
  const is3d = p.action === "make_3d";
  const models = state.studio?.models || [];
  const model = models.find((m) => m.id === p.model);
  const on = p.references.filter((r) => r.on).length;
  const source = modelSource(is3d ? p.model3d : p.model);
  const serviceLabel = (state.serviceModels?.[is3d ? "3d" : "image"] || []).find((m) => m.service === source)?.label.split(" · ")[0] || source;
  const tripo = is3d && source === "keys" && p.engine === "tripo";
  const unit = tripo ? "Tripo" : "Meshy";
  const need = tripo ? tripoCredits(p.settings) : p.settings?.should_texture ? 30 : 20;
  const credits3d = state.credits?.[tripo ? "tripo_balance" : "meshy_balance"];
  // Demo mode makes placeholders and spends nothing: no prices, no balance, never blocked on credits.
  const demo = Boolean(state.agentCfg?.demo_mode);
  const cost = demo ? " · demo mode: placeholders, no cost" : source !== "keys" ? ` · paid in your ${serviceLabel} credits`
    : is3d ? ` · ≈ $${(need / 100).toFixed(2)} (${need} ${unit} credits)` : model ? ` · ≈ $${(model.price * (p.count || 1)).toFixed(2)}` : "";
  const alert = creditAlert(source !== "keys" ? source : is3d ? unit.toLowerCase() : (p.model || "").split(":")[0]);
  const balance = !demo && is3d && source === "keys" && credits3d != null ? ` · ${credits3d} ${unit} credits left` : "";
  // Not enough credits for this model: say so and don't let it start a run that will fail.
  const short = !demo && is3d && source === "keys" && credits3d != null && credits3d < need;
  const cfgNow = state.agentCfg || {};
  const makers = is3d ? [] : makerChoices("image", cfgNow);
  const maker = makers.find((m) => m.id === p.model) || { id: p.model, name: model?.label?.split(" · ").slice(1).join(" · ") || humanize(String(p.model || "Not set").split(/[/:]/).pop()),
    who: model?.label?.split(" · ")[0], where: String(p.model).startsWith("svc:") ? "svc" : "key", refs: true, own: ownCut(p.model), price: model?.price ? `$${model.price.toFixed(3)}` : "" };
  const isLocal = String(p.model || "").startsWith("local:");
  const firstWord = String(maker.name || "It").split(" ")[0];
  const extras = p.references.filter((r) => r.on && r.role !== "source").length;
  const startsFrom = p.references.some((r) => r.on && r.role === "source");
  const skipRefs = !is3d && isLocal && extras > 0;
  const better = makers.filter((m) => m.ready && m.refs).slice(0, 3);
  const refWarn = skipRefs ? `<div class="mk-refwarn"><span><b>${esc(maker.name)} reads text only.</b> ${startsFrom ? `It starts from the source picture; the other ${extras} reference${extras === 1 ? "" : "s"} won't be sent.` : `These ${extras} reference${extras === 1 ? "" : "s"} won't be sent, so the style comes from the words alone.`}</span>
      ${better.length ? `<div class="mk-switch">${better.map((m) => `<button type="button" data-cmp-maker="image|${esc(m.id)}">Use ${esc(m.name)}${m.price ? ` · ${esc(m.price)}` : ""}</button>`).join("")}</div>` : ""}</div>` : "";
  const cutter = currentMaker("cut", cfgNow);
  const cutBy = maker.where === "svc" ? `${maker.who || "the service"}, after (a few extra credits)`
    : maker.own && !isLocal && cfgNow.cutout_prefer_own !== false ? `${maker.name} itself` : `${cutter?.name || "Plain-background cut"} on this PC`;
  const makerBlock = is3d ? "" : `<div class="mk-pop"><input type="hidden" id="pvModel" value="${esc(p.model || "")}">
      <button type="button" class="mk-btn" data-cmp-maker-open aria-expanded="${!!p.makerOpen}">
        <span class="mk-eyebrow">Made by</span><span class="mk-chev">${p.makerOpen ? "Close ▴" : "Change ▾"}</span>
        <span class="mk-name">${esc(maker.name)}</span>${whereTag(maker)}
        <span class="mk-btn-caps">${makerCaps("image", maker)}</span></button>
      ${p.makerOpen ? makerPicker("image", cfgNow, { title: "Who makes this picture", pickAttr: "data-cmp-maker", current: p.model }) : ""}</div>`;
  const reads = isLocal && p.promptView !== "full" && p.action !== "views";
  const localCost = isLocal ? ` · free on your GPU${maker.speed ? `, ${maker.speed} each` : ""}` : "";
  const refs = p.references.map((r, i) => `
    <label class="ref role-${esc(r.role)}${r.on ? "" : " off"}"><input type="checkbox" data-ref="${i}" ${r.on ? "checked" : ""}>
      <img src="${esc(fileUrl(r.path))}" alt=""><span title="${esc(refLabel(r))}">${esc(refLabel(r).split(" · ")[0])}</span></label>`).join("");
  const assetName = humanize(p.asset.split("/").pop());
  const modes = CMP_MODES.some(([m]) => m === p.action);
  const hasPicture = Boolean(document.querySelector("#content .winner-box > img"));
  const srcRef = p.references.find((r) => r.role === "source") || (is3d ? p.references.find((r) => r.on) : null);
  const [aw, ah] = String(p.settings.aspect_ratio || "1:1").split(":").map(Number);
  const slots = is3d ? 1 : p.action === "views" ? 1 : p.count || 1;
  const outBox = (i) => `<div class="cmp-out" style="aspect-ratio:${is3d ? "1" : `${aw || 1}/${ah || 1}`}">${icon(theme.icon)}<span>${is3d ? "GLB" : slots > 1 ? i + 1 : "New"}</span></div>`;
  const stage = `<div class="cmp-stage-art${srcRef ? " has-src" : ""}">
      ${srcRef ? `<div class="cmp-src"><img src="${esc(fileUrl(srcRef.path))}" alt=""><span>${is3d ? "From" : "Source"}</span></div><span class="cmp-arrow">${icon("chev-right")}</span>` : ""}
      <div class="cmp-outs n${Math.min(slots, 4)}">${Array.from({ length: slots }, (_, i) => outBox(i)).join("")}</div>
    </div>
    <p class="cmp-stage-note">${esc(theme.blurb)}</p>`;
  const chip = (attr, value, label, on) => `<button type="button" class="cmp-chip${on ? " on" : ""}" ${attr}="${esc(String(value))}">${label}</button>`;
  const imageControls = `
      ${"aspect_ratio" in p.settings ? `<div class="cmp-field"><div class="field-label">Shape</div><input type="hidden" id="pvAspect" value="${esc(p.settings.aspect_ratio || "1:1")}">
        <div class="cmp-chips">${[...new Set([p.settings.aspect_ratio || "1:1", ...ASPECTS])].map((a) => { const [w, h] = a.split(":").map(Number); const k = 14 / Math.max(w, h); return chip("data-cmp-aspect", a, `<i style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px"></i>${esc(a)}`, a === (p.settings.aspect_ratio || "1:1")); }).join("")}</div></div>` : ""}
      ${p.action === "views" ? "" : `<div class="cmp-field"><div class="field-label">How many</div><input type="hidden" id="pvCount" value="${p.count || 1}">
        <div class="cmp-chips">${[1, 2, 3, 4].map((n) => chip("data-cmp-count", n, String(n), n === (p.count || 1))).join("")}</div></div>`}
      ${"transparent_background" in p.settings ? `<label class="mesh-toggle sheet-bg"><span class="switch"><input type="checkbox" id="pvTransparent" ${p.settings.transparent_background ? "checked" : ""}><span></span></span><span>Transparent background<small>${p.settings.transparent_background ? `Cut out by <b>${esc(cutBy)}</b> · <button type="button" class="link-btn" data-cmp-cutter>change</button>` : "Keeps the scene, for places and key art"}</small></span></label>` : ""}
      ${Object.entries(p.settings).filter(([k]) => k !== "aspect_ratio" && k !== "transparent_background").map(([k, v]) => `<span class="chip">${esc(k.replace(/_/g, " "))} <b>${esc(Array.isArray(v) ? v.join(", ") : String(v))}</b></span>`).join("")}`;
  const refsBlock = p.picking && !is3d ? `<div class="field-label">Pick from this project</div>
          <div class="refs">${(p.pool || []).map((e) => `<button type="button" class="ref pick" data-pick-ref="${esc(e.path)}" title="${esc(e.title)}">
              <img src="${esc(fileUrl(e.path))}" alt="" loading="lazy"><span>${esc(e.title)}</span></button>`).join("") || `<p class="pillar-empty">No finished images in this project yet.</p>`}</div>
          <div class="row"><button type="button" class="ghost" data-upload-ref>Upload from computer</button><button type="button" class="ghost" data-close-picker>Cancel</button></div>` : `<div class="field-label">Reference images · ${on}${is3d ? (p.references.length > 1 ? " · several views make a better model" : "") : " of 8"}</div>
          <div class="refs">${refs || `<p class="pillar-empty">No reference images. Add pillars to keep the style consistent.</p>`}
            ${is3d ? "" : `<button type="button" class="ref add" data-add-ref>+ Add</button>`}</div>`;
  const runCost = demo ? "demo" : source !== "keys" ? "" : is3d ? `${need} credits` : model ? (model.local ? "free" : `≈ $${(model.price * (p.count || 1)).toFixed(2)}`) : "";
  if (!is3d && isLocal && !state.localInfo && !state.localInfoLoading) {
    state.localInfoLoading = true;  // speeds and install state for the maker list; redraw once they're here
    api("/api/local-ai").then((info) => { state.localInfo = info; if (state.preview === p) { syncPreviewFields(); renderPreview(); } }).catch(() => {}).finally(() => { state.localInfoLoading = false; });
  }
  openDialog(`
    <div class="dlg sheet composer tone-${theme.tone}">
      <header class="cmp-head">
        ${modes ? `<nav class="cmp-tabs" role="tablist">${CMP_MODES.map(([m, label, ic, needsPic]) => `<button type="button" role="tab" class="cmp-tab${m === p.action ? " on" : ""} tone-${m === "pixel" ? "pixel" : ACTION_THEME[m]?.tone || "brand"}" data-cmp-mode="${m}" aria-selected="${m === p.action}"${needsPic && !hasPicture ? ` disabled title="Pick or drop a picture first"` : ""}>${icon(ic)}<span>${label}</span></button>`).join("")}</nav>`
          : `<div class="cmp-title"><span class="sheet-icon">${icon(theme.icon)}</span><h2>${esc(ACTION_LABEL[p.action])}</h2></div>`}
        <span class="cmp-asset" title="${esc(p.asset)}">${esc(displayTitle(assetName))}</span>
        <button type="button" class="cmp-x" data-close title="Close (Esc)">×</button>
      </header>
      <div class="cmp-grid${is3d ? " is-3d" : ""}">
        <aside class="cmp-stage">
          ${stage}
          <section class="cmp-refs${skipRefs ? " skipped" : ""}">${refsBlock}${refWarn}</section>
        </aside>
        <div class="cmp-controls">
          <div class="cmp-model">${is3d ? `${sourcePicker(p, "3d")}${source === "keys" ? "" : `<label class="model-pick">Model <select id="pvModel3d">${serviceModelOptions("3d", source, p.model3d)}</select></label>`}`
            : makerBlock}</div>
          ${alert ? `<div class="credit-warn"><span class="bad-dot">!</span><span><b>${esc(humanize(alert.provider))} ran out of credits ${esc(timeAgo(alert.at).toLowerCase())}.</b> Top up first, or pick another Source above.</span></div>` : ""}
          ${is3d ? "" : `<div class="cmp-row">${imageControls}</div>`}
          ${needsInstruction ? `<div class="sheet-instruction cmp-instruction"><label>${p.action === "prop_sheet" ? "Which props? (optional: leave empty for everything in the picture)" : "What should change?"}<textarea id="pvInstruction" rows="2" placeholder="${p.action === "variant" ? "Frost-themed armour, icy blue trim" : p.action === "prop_sheet" ? "barrel, torch, broken pillar, chest, bones" : "Remove the shield"}"></textarea></label>
            <button class="ghost" data-rebuild>Update prompt</button></div>` : ""}
          ${is3d ? (source === "keys" ? (p.engine === "tripo" ? tripoOptions(p) : meshOptions(p)) : `<section class="mesh-opts"><p class="hint-line">${esc(serviceLabel)} makes the model from the ticked image${p.references.length > 1 ? "s" : ""}, with its own settings. The GLB lands here like any other output.</p></section>`) : `<section class="cmp-prompt">
            ${p.action === "views" ? `<p class="hint-line">One image per view: ${esc(p.settings.views || "")}. <code>{view}</code> is replaced for each image.</p>` : bibleSwitch(p)}
            <div class="mk-prompt-head"><label class="field-label" for="pvPrompt">Prompt <em>${reads ? `what ${esc(firstWord)} actually reads` : "exactly what is sent"}</em></label>
              ${isLocal && p.action !== "views" ? `<span class="mk-seg"><button type="button" class="${reads ? "on" : ""}" data-cmp-view="reads">What ${esc(firstWord)} reads</button><button type="button" class="${reads ? "" : "on"}" data-cmp-view="full">Your full prompt</button></span>` : ""}</div>
            <textarea id="pvPrompt" class="final-prompt" rows="5"${reads ? " hidden" : ""}>${esc(p.prompt)}</textarea>
            ${reads ? `<div class="mk-reads" id="pvReads" tabindex="0">…</div><p class="mk-reads-note">Tessera reshapes the prompt for a local model: lines about reference images and "no …" lines are dropped, because a local model reads "no text" as "text". Edit it under <b>Your full prompt</b>.</p>` : ""}
            <details class="recipe-details"><summary>How the prompt is built</summary>
              <div class="recipe">${p.parts.map((part) => `<div class="recipe-part role-${esc(part.role || "subject")}"><span>${esc(PART_ROLE[part.role] || part.source)}<em>${esc(part.source.replace(/^[^·]*·\s*/, ""))}</em></span><p>${esc(part.text || "—")}</p></div>`).join("")}</div></details>
          </section>`}
        </div>
      </div>
      <footer class="sheet-foot cmp-foot">
        <span class="cost">${is3d || !isLocal ? `${on} image${on === 1 ? "" : "s"} attached${cost}` : `${startsFrom ? "From the source picture" : "Text only"}${demo ? cost : localCost}`}${balance}${short ? `<b class="short">You need ${Math.ceil(need - credits3d)} more ${unit} credits. <a href="${tripo ? "https://platform.tripo3d.ai/billing" : "https://www.meshy.ai/settings/subscription"}" target="_blank" rel="noopener">Top up ↗</a></b>` : ""}</span>
        <span class="grow"></span>
        ${is3d ? "" : `<button type="button" class="ghost copy-req" data-copy-request title="Copy this prompt and the ticked images, to paste into ChatGPT, Gemini or another tool yourself (no API cost)">${icon("copy")}Copy prompt + images</button>`}
        <button type="button" class="run-btn cmp-run" data-run ${short ? "disabled" : ""}>${icon(theme.icon)}<span>${esc(is3d ? "Make 3D model" : p.action === "candidates" ? `Generate ${p.count > 1 ? `${p.count} images` : "image"}` : ACTION_LABEL[p.action])}</span>${runCost ? `<em>${esc(runCost)}</em>` : ""}<kbd>Ctrl ↵</kbd></button>
      </footer>
    </div>`);
  const instruction = $("#pvInstruction");
  if (instruction) instruction.value = p.instruction || "";
  if (reads) {
    const prompt = p.prompt, transparent = !!p.settings.transparent_background;
    api("/api/local-ai/prompt-preview", { method: "POST", body: { prompt, transparent } }).then((r) => {
      const box = $("#pvReads");
      if (box && state.preview === p && p.prompt === prompt) box.textContent = r.prompt;
    }).catch(() => { const box = $("#pvReads"); if (box) box.textContent = prompt; });
  }
  $("#pvModel")?.addEventListener("change", () => { syncPreviewFields(); renderPreview(); });
  $("#pvModel3d")?.addEventListener("change", () => { syncPreviewFields(); renderPreview(); });
  $("#pvSource")?.addEventListener("change", () => { syncPreviewFields(); onSourceChange(is3d ? "3d" : "image"); });
  $("#pvCount")?.addEventListener("change", () => { syncPreviewFields(); renderPreview(); });
  document.querySelectorAll("#dialog [data-mesh], #dialog [data-fmt], #dialog [data-tripo]").forEach((el) => el.addEventListener("change", () => { syncMesh(); renderPreview(); }));
}

// Make 3D settings for Tripo: model, texture, polygons and mesh style. Each field is a Tripo API field of the same name.
const tripoCredits = (s) => (s.texture ? 40 : 30) + ({ detailed: 10, extreme: 30 }[s.texture_quality] || 0) + (s.geometry_quality === "detailed" ? 20 : 0);
const isPSeries = (m) => /^p/i.test(m || "");
const versionAtLeast3 = (m) => isPSeries(m) || !/^v2\./i.test(m || "");

function tripoOptions(p) {
  const s = p.settings, c = p.choices || {};
  const pSeries = isPSeries(s.model), modern = versionAtLeast3(s.model);
  const select = (key, entries, disabled = false) => `<select data-tripo="${key}"${disabled ? " disabled" : ""}>${entries.map(([v, label]) => `<option value="${esc(v)}" ${v === s[key] ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  const toggle = (key, label, hint, disabled = false) => `<label class="mesh-toggle${disabled ? " off" : ""}"><span class="switch"><input type="checkbox" data-tripo="${key}" ${s[key] && !disabled ? "checked" : ""}${disabled ? " disabled" : ""}><span></span></span><span>${label}<small>${hint}</small></span></label>`;
  const quality = { fast: "Fast", standard: "Standard", detailed: "Detailed · +10 credits", extreme: "Extreme 8K · +30 credits" };
  const quadOk = !pSeries ? modern : /^p2/i.test(s.model);
  return `<section class="mesh-opts">
    <div class="field-label">Generator</div>
    <div class="mesh-grid">
      <label>Model ${select("model", Object.entries(c.model || {}))}</label>
      <label>Shape detail ${select("geometry_quality", (c.geometry_quality || []).map((v) => [v, v === "detailed" ? "Detailed · +20 credits" : "Standard"]), pSeries || !modern)}</label>
    </div>
    ${pSeries ? `<p class="hint-line">The P series is tuned for clean low-poly models.</p>` : ""}
    <div class="field-label">Polygons</div>
    <div class="poly-row">
      <input type="number" data-tripo="face_limit" min="0" max="2000000" step="500" value="${s.face_limit || ""}" placeholder="Automatic">
      <span class="poly-presets">${(c.face_presets || []).map((n) => `<button type="button" class="${n === s.face_limit ? "on" : ""}" data-tripo-faces="${n}">${fmtCount(n)}</button>`).join("")}<button type="button" class="${s.face_limit ? "" : "on"}" data-tripo-faces="0">Auto</button></span>
    </div>
    ${toggle("smart_low_poly", "Smart low poly", "Clean game-ready topology, 500 to 20k triangles. Can fail on complex pictures", pSeries || !modern)}
    ${toggle("quad", "Quad mesh", "Quads suit sculpting and animation. Tessera also converts the result to GLB", !quadOk)}
    <div class="field-label">Texture</div>
    ${toggle("texture", "Texture the model", "Off gives a bare grey mesh and costs less")}
    ${toggle("pbr", "PBR maps", "Metallic, roughness and normal maps", !s.texture)}
    <div class="mesh-grid"><label>Quality ${select("texture_quality", (c.texture_quality || []).map((v) => [v, quality[v] || v]), !s.texture || !modern)}</label></div>
    ${toggle("auto_size", "Real-world size", "Scales the model to metres, so a door is door-sized")}
  </section>`;
}

function syncTripo() {
  const s = state.preview.settings;
  document.querySelectorAll("#dialog [data-tripo]").forEach((el) => {
    if (el.disabled) return;
    s[el.dataset.tripo] = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, Math.round(Number(el.value) || 0)) : el.value;
  });
  if (!s.texture) { s.pbr = false; s.texture_quality = "standard"; }
  if (s.smart_low_poly && s.face_limit > 20000) s.face_limit = 20000;
  // A model change can switch off what it doesn't have: send only what Tripo accepts for it.
  if (isPSeries(s.model)) Object.assign(s, { smart_low_poly: false, geometry_quality: "standard", quad: /^p2/i.test(s.model) ? s.quad : false });
  if (!versionAtLeast3(s.model)) Object.assign(s, { smart_low_poly: false, quad: false, geometry_quality: "standard", texture_quality: "standard" });
}

document.addEventListener("click", (event) => {
  const faces = event.target.closest("[data-tripo-faces]");
  if (!faces || state.preview?.engine !== "tripo") return;
  state.preview.settings.face_limit = Number(faces.dataset.tripoFaces);
  renderPreview();
});

const MESH_MODEL_LABEL = { "meshy-7.1": "Meshy 7.1 · best detail", "meshy-6": "Meshy 6", "meshy-6-lite": "Meshy 6 Lite · fast", "meshy-t2.5": "Meshy T2.5 · game topology", "meshy-t2": "Meshy T2 · game topology" };
const fmtCount = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

// Make 3D settings: generator, polycount, texture, pose and export formats.
function meshOptions(p) {
  const s = p.settings;
  const c = p.choices || {};
  const t2 = s.ai_model === "meshy-t2" || s.ai_model === "meshy-t2.5";
  const smart = t2 || s.model_type === "smart-topology";
  const cap = smart ? (s.ai_model === "meshy-t2" ? 15000 : 30000) : 300000;
  const usesCount = smart || s.should_remesh;
  const select = (key, labels = {}, disabled = false) => `<select data-mesh="${key}"${disabled ? " disabled" : ""}>${(c[key] || []).map((v) => `<option value="${esc(v)}" ${v === s[key] ? "selected" : ""}>${esc(labels[v] ?? v)}</option>`).join("")}</select>`;
  const toggle = (key, label, hint, disabled = false) => `<label class="mesh-toggle${disabled ? " off" : ""}"><span class="switch"><input type="checkbox" data-mesh="${key}" ${s[key] && !disabled ? "checked" : ""}${disabled ? " disabled" : ""}><span></span></span><span>${label}<small>${hint}</small></span></label>`;
  return `<section class="mesh-opts">
    <div class="field-label">Generator</div>
    <div class="mesh-grid">
      <label>Model ${select("ai_model", MESH_MODEL_LABEL)}</label>
      <label>Mesh ${t2 ? `<select disabled><option>Smart topology · game-ready</option></select>` : select("model_type", { standard: "Standard · high detail", "smart-topology": "Smart topology · game-ready" })}</label>
    </div>
    <div class="field-label">Polycount</div>
    ${smart ? "" : toggle("should_remesh", "Remesh to a target polycount", "Off keeps Meshy's raw high-detail mesh")}
    <div class="poly-row${usesCount ? "" : " off"}">
      <input type="number" data-mesh="target_polycount" min="100" max="${cap}" step="100" value="${Math.min(s.target_polycount, cap)}"${usesCount ? "" : " disabled"}>
      <span class="poly-presets">${(c.polycount_presets || []).filter((n) => n <= cap).map((n) => `<button type="button" class="${n === s.target_polycount ? "on" : ""}" data-poly="${n}"${usesCount ? "" : " disabled"}>${fmtCount(n)}</button>`).join("")}</span>
    </div>
    ${smart ? `<p class="hint-line">Smart topology always hits the target, up to ${fmtCount(cap)} triangles.</p>` : usesCount ? `<div class="mesh-grid"><label>Faces ${select("topology", { triangle: "Triangles", quad: "Quads" })}</label></div>` : ""}
    <div class="field-label">Texture</div>
    ${toggle("should_texture", "Texture the model", "Off gives a grey clay mesh and costs less")}
    ${toggle("enable_pbr", "PBR maps", "Metallic, roughness and normal maps", !s.should_texture)}
    <div class="mesh-grid"><label>Resolution ${select("texture_resolution", {}, !s.should_texture || s.ai_model === "meshy-6-lite")}</label></div>
    <div class="field-label">Pose &amp; export</div>
    <div class="mesh-grid">
      <label>Pose ${select("pose_mode", { "": "As in the image", "a-pose": "A-pose", "t-pose": "T-pose" })}</label>
      <label>Origin ${select("origin_at", { bottom: "Bottom (feet)", center: "Center" })}</label>
    </div>
    <div class="fmt-row">${(c.target_formats || []).map((f) => `<label class="fmt${s.target_formats.includes(f) ? " on" : ""}"><input type="checkbox" data-fmt="${f}" ${s.target_formats.includes(f) ? "checked" : ""}${f === "glb" ? " disabled" : ""}>${f.toUpperCase()}</label>`).join("")}</div>
  </section>`;
}

function syncMesh() {
  const p = state.preview;
  if (p?.action !== "make_3d") return;
  if (p.engine === "tripo") return syncTripo();
  const s = p.settings;
  document.querySelectorAll("#dialog [data-mesh]").forEach((el) => {
    if (el.disabled) return;
    const key = el.dataset.mesh;
    s[key] = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(100, Number(el.value) || s[key]) : el.value;
  });
  s.target_formats = ["glb", ...[...document.querySelectorAll("#dialog [data-fmt]:checked")].map((el) => el.dataset.fmt).filter((f) => f !== "glb")];
  if (s.ai_model === "meshy-t2" || s.ai_model === "meshy-t2.5") s.model_type = "smart-topology";
  if (!s.should_texture) s.enable_pbr = false;
}

function bibleSwitch(p) {
  if (!p.bible?.length) return `<p class="hint-line">No style bible yet. Add one under <b>Bible pillars</b> on the project overview (pose, polygon budget, palette…).</p>`;
  return `<div class="bible-switch${p.use_bible ? " on" : ""}">
    <label class="switch"><input type="checkbox" data-bible-toggle ${p.use_bible ? "checked" : ""}><span></span></label>
    <div><strong>Style bible</strong><small>${p.use_bible ? "In the final prompt below" : "Off for this run"} · ${p.bible.map((b) => esc(b.source)).join(", ")}</small></div>
    <button type="button" class="link-btn" data-bible-view>${p.showBible ? "Hide" : "View"}</button>
  </div>
  ${p.showBible ? `<div class="bible-view">${p.bible.map((b) => `<div><span>${esc(b.source)}</span><div class="md">${renderMarkdown(b.text)}</div></div>`).join("")}</div>` : ""}`;
}

// The style bible sits at the top of the final prompt, so the prompt can be copied as a whole.
function bibleBlock(p) {
  return p.bible?.length ? `Style bible:\n${p.bible.map((b) => b.text.trim()).join("\n\n")}` : "";
}

// Subject first, then the style bible, then the reference rule, so the subject is never buried under the style text.
function applyBible(p) {
  const block = bibleBlock(p);
  if (!block) return p;
  const prompt = String(p.prompt || "").replace(block, "").replace(/\n{3,}/g, "\n\n").trim();
  if (p.use_bible === false) { p.prompt = prompt; return p; }
  const rule = (p.parts || []).find((part) => part.role === "rule")?.text?.trim();
  const at = rule ? prompt.indexOf(rule) : -1;
  p.prompt = at >= 0
    ? [prompt.slice(0, at).trim(), block, prompt.slice(at).trim()].filter(Boolean).join("\n\n")
    : [prompt, block].filter(Boolean).join("\n\n");
  return p;
}

function syncPreviewFields() {
  const p = state.preview;
  if (!p) return;
  if ($("#pvPrompt")) p.prompt = $("#pvPrompt").value;
  if ($("#pvCount")) p.count = Number($("#pvCount").value);
  if ($("#pvInstruction")) p.instruction = $("#pvInstruction").value;
  // An empty select means its models are still loading: keep the model the sheet opened with.
  if ($("#pvModel")?.value) p.model = $("#pvModel").value;
  if ($("#pvModel3d")?.value) p.model3d = $("#pvModel3d").value;
  if ($("#pvAspect")) p.settings.aspect_ratio = $("#pvAspect").value;
  if ($("#pvTransparent")) p.settings.transparent_background = $("#pvTransparent").checked;
  syncMesh();
  syncAudioFields();
}

async function rebuildPreview() {
  syncPreviewFields();
  const p = state.preview;
  const source = (p.references.find((r) => r.role === "source") || {}).path || "";
  const extras = p.references.filter((r) => r.role === "extra");
  try {
    const req = await api("/api/studio/preview", { method: "POST", body: { path: p.asset, action: p.action, source, instruction: p.instruction, model: p.model } });
    state.preview = applyBible({ ...req, model3d: p.model3d, instruction: p.instruction, count: p.count, use_bible: p.use_bible, showBible: p.showBible, references: [...req.references.map((r) => ({ ...r, on: true })), ...extras] });
    renderPreview();
  } catch (err) { toast(err.message, true); }
}

async function runPreview() {
  syncPreviewFields();
  if (!prepareGameRun()) return;
  const p = state.preview;
  if ((p.action === "variant" || p.action === "edit") && !String(p.instruction || "").trim()) { toast("Describe what should change, then press Update prompt.", true); return; }
  const request = { action: p.action, asset: p.asset, prompt: p.prompt, count: p.count, settings: p.settings, action_ids: p.action_ids, names: p.names, model: p.action === "make_3d" ? (p.model3d || "") : p.model, use_bible: p.use_bible !== false, references: p.references.filter((r) => r.on).map(({ path, source, role }) => ({ path, source, role })) };
  if (p.audio) {
    Object.assign(request, { audio: true, kind: p.kind });
    if (p.kind === "voice") {
      if (!p.settings.voice_id) { toast("Pick a voice first.", true); return; }
      const voice = (state.voices || []).find((v) => v.id === p.settings.voice_id);
      await api("/api/studio/asset", { method: "PATCH", body: { path: p.asset, fields: { voice: p.settings.voice_id, voice_name: voice?.name || "" } } }).catch(() => {});
    }
  }
  try {
    const job = await api("/api/studio/run", { method: "POST", body: { request } });
    if (!state.jobs[job.id]) state.jobs[job.id] = job; // the socket may already have reported it finished
    closeDialog();
    toast(`${p.audio ? AUDIO_COPY[p.kind].run : ACTION_LABEL[p.action]} started`);
    renderView();
  } catch (err) { toast(err.message, true); }
}

async function loadJobs() {
  try {
    const data = await api("/api/studio/jobs");
    state.jobs = Object.fromEntries((data.jobs || []).map((j) => [j.id, j]));
  } catch { state.jobs = {}; }
}

async function pickWinner(file) {
  try {
    await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields: { winner: file } } });
    toast("Winner picked");
    await renderView();
    if (state.lb) renderLightbox();
  } catch (err) { toast(err.message, true); }
}

function newFolderDialog(parent) {
  openDialog(`
    <form class="dlg" id="newFolderForm">
      <h2>New folder</h2>
      <p>Creates a folder in <code>${esc(parent || "the project root")}</code> for a group of assets, e.g. creatures, factions or weapons.</p>
      <label>Name<input name="title" required maxlength="80" placeholder="Creatures" autofocus></label>
      <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Create</button></div>
    </form>`);
  $("#newFolderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { title } = Object.fromEntries(new FormData(event.target));
    try {
      const { path } = await api("/api/overview/folder", { method: "POST", body: { parent, title } });
      closeDialog();
      await loadOverview();
      go({ type: "folder", path });
    } catch (err) { toast(err.message, true); }
  });
}

async function docToFolder() {
  try {
    const { path } = await api("/api/overview/to-folder", { method: "POST", body: { path: state.view.path } });
    toast("Now a folder: add assets and sub-folders to it");
    await loadOverview();
    go({ type: "folder", path });
  } catch (err) { toast(err.message, true); }
}

async function makeAsset() {
  const { kinds } = await studioOptions();
  openDialog(`
    <form class="dlg" id="makeAssetForm">
      <h2>Turn into asset</h2>
      <p>Pick what this is. You can then generate images and 3D for it.</p>
      <div class="dlg-field"><span>Kind</span>${kindTags(kinds, "")}</div>
      <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Turn into asset</button></div>
    </form>`);
  $("#makeAssetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const kind = new FormData(event.target).get("kind");
    try {
      await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields: { kind } } });
      closeDialog();
      renderView();
    } catch (err) { toast(err.message, true); }
  });
}

// The current page and the pages before it survive a refresh, per project.
const viewKey = () => `forge.view.${state.project}`;
const PLAIN_VIEWS = ["home", "pipeline", "vault", "levels", "pixel", "motion", "nodes", "board"];
const plainView = (v) => (PLAIN_VIEWS.includes(v.type) ? { type: v.type } : { type: v.type, path: v.path });

function saveView() {
  const hash = state.view.type === "home" ? "" : PLAIN_VIEWS.includes(state.view.type) ? `#${state.view.type}` : `#${state.view.type}=${encodeURIComponent(state.view.path)}`;
  try { history.replaceState(null, "", hash || location.pathname); } catch { /* ignore */ }
  storeSet(viewKey(), JSON.stringify({ view: plainView(state.view), trail: state.trail.slice(-30).map(plainView) }));
}

function restoreView() {
  if (["#pipeline", "#vault", "#levels", "#pixel", "#motion", "#nodes", "#board"].includes(location.hash)) { state.view = { type: location.hash.slice(1) }; return; }
  const hash = location.hash.match(/^#(folder|doc)=(.+)$/);
  if (hash) {
    state.view = { type: hash[1], path: decodeURIComponent(hash[2]), restored: true };
    try { state.trail = (JSON.parse(storeGet(viewKey()) || "null")?.trail || []).filter((v) => v.type === "home" || typeof v.path === "string"); } catch { /* no trail */ }
    return;
  }
  try {
    const saved = JSON.parse(storeGet(viewKey()) || "null");
    const ok = (v) => v && (PLAIN_VIEWS.includes(v.type) || ((v.type === "folder" || v.type === "doc") && typeof v.path === "string"));
    if (!ok(saved?.view)) return;
    state.view = { ...plainView(saved.view), restored: true };
    state.trail = (saved.trail || []).filter(ok);
  } catch { /* start at the overview */ }
}

function goBack() {
  const cur = state.view;
  if (cur.type === "home") return;
  let prev = state.trail.pop();
  if (!prev) {
    const parent = (cur.path || "").split("/").slice(0, -1).join("/");
    prev = parent ? { type: "folder", path: parent } : { type: "home" };
  }
  const from = state.view;
  (state.forward ||= []).push(plainView(from));
  state.view = prev;
  showPanel("workspace", true);
  transitionTo(from, prev, async () => { $("#content").scrollTop = 0; await renderView(); });
}

function goForward() {
  const next = state.forward?.pop();
  if (next) go(next, { keepForward: true });
}

function go(view, { keepForward = false } = {}) {
  if (!keepForward) state.forward = [];
  // A folder's README is that folder's page, so it opens in the folder view with its sub-folders and assets.
  if (view.type === "doc" && /(^|\/)README\.md$/i.test(view.path) && dirOf(view.path)) view = { type: "folder", path: dirOf(view.path) };
  const same = state.view.type === view.type && state.view.path === view.path;
  if (!same) state.trail.push(plainView(state.view));
  // A dialog or the lightbox belongs to the page being left (also on browser Back or a pasted link).
  if (!same && $("#dialog").open) closeDialog();
  if (!same && state.lb) closeLightbox();
  if (!$("#projectsView").hidden && state.project) closeProjects();
  const from = state.view;
  state.view = view;
  if (view.type === "folder") sectionDrawn.key = "";  // a section opened anew starts at the subsection asked for
  showPanel("workspace", true);
  transitionTo(from, view, async () => {
    const content = $("#content");
    content.scrollTop = 0;
    await renderView();
    // The new page rises into place (the animation restarts on every page change).
    if (!same) { content.classList.remove("page-in"); void content.offsetWidth; content.classList.add("page-in"); }
  });
}

// A link pasted or edited in the address bar (#doc=…, #folder=…, #vault) opens that view.
window.addEventListener("hashchange", () => {
  const hash = location.hash.match(/^#(folder|doc)=(.+)$/);
  if (hash) go({ type: hash[1], path: decodeURIComponent(hash[2]) });
  else if (["#pipeline", "#vault", "#levels", "#pixel", "#motion", "#nodes", "#board"].includes(location.hash)) go({ type: location.hash.slice(1) });
});

function openPath(path) {
  if (!path) return;
  const isFile = /\.[a-z0-9]+$/i.test(path.split("/").pop());
  if (nativeWindow() && /\.(png|jpe?g|webp|gif|svg)$/i.test(path)) return openLightbox(path); // stays in Tessera's window
  if (nativeWindow() && /\.(glb|gltf|obj|fbx)$/i.test(path)) return viewModel(path);
  if (/\.(png|jpe?g|webp|gif|svg|glb|gltf|obj|fbx)$/i.test(path)) { window.open(fileUrl(path), "_blank", "noopener"); return; }
  go(isFile ? { type: "doc", path } : { type: "folder", path });
}

async function saveDoc() {
  try {
    await api("/api/overview/file", { method: "PUT", body: { path: state.view.type === "folder" ? state.view.page : state.view.path, content: $("#editor").value } });
    state.view = { ...state.view, editing: false };
    toast("Saved");
    await loadOverview();
  } catch (err) { toast(err.message, true); }
}

// ---------- game tools: turnaround, rig, animate, split, icons, sprites, 3D viewer, export ----------

const MODEL_RE = /\.(glb|gltf|obj|fbx)$/i;

// Level kit: a picture of a level section, then one sheet with all its props, cut up on this computer into props.
// A 2D project (Settings → New art, or chosen when the project was made) hides the 3D tools; models already made still show.
const is2d = () => state.overview?.dimension === "2d";

// A level is done only once its pack is: before the pack's status loads, it isn't "ready" either.
function levelPackLeft() {
  const items = state.pack?.items || [];
  return !state.pack || !items.length || items.some((i) => !i.done);
}

function levelPanel(a) {
  const pack = state.pack;
  const items = pack?.items || [];
  const left = items.filter((i) => !i.done).length;
  const started = items.some((i) => i.done);
  const step = (n, done, title, text, button) => `<li class="${done ? "done" : ""}"><b>${done ? "✓" : n}</b><div><strong>${title}</strong><small>${text}</small></div>${button}</li>`;
  const label = started ? "Finish pack" : "Turn into asset pack";
  const kit = pack?.kit ? `<button class="mini" data-open="${esc(pack.kit)}">Open kit</button>` : "";
  const packText = pack?.running ? "Tessera is making it now. You can leave this page."
    : !a.winner ? "Pick a level picture first."
    : is2d() ? "Every prop in the picture, cut out and named."
    : !started ? "Matching walls, floors, ceiling, pillars and props, all made from this picture, ready for modular or procedural levels."
    : left ? `${plural(items.length - left, "part")} of ${items.length} done. Finishing only makes what's missing.`
    : "Walls, floors, trim and props are made, and your coding agent can find them in ASSETS.md.";
  return `<div class="level-kit"><div class="field-label">${icon("map")} Level</div><ol>
    ${step(1, a.winner, "Picture the level", "Describe the place above, generate, and pick the one you like.", `<button class="mini" data-action="candidates">Generate</button>`)}
    ${step(2, started && !left, is2d() ? "Cut out its props" : "Make its asset pack", packText, pack?.running ? `<span class="spinner"></span>` : `<span class="pack-btns">${kit}${started && !left ? "" : `<button class="mini${started ? "" : " pack-go"}" data-level-pack="${esc(a.path)}" ${a.winner ? "" : "disabled"}>${label}</button>`}</span>`)}
  </ol>${pack?.note ? `<p class="pack-note">${esc(pack.note)}</p>` : ""}</div>`;
}

// Below the level: what the pack made, and the props and trim to tick for 3D, with the total before anything is spent.
function packPicks() {
  const pack = state.pack;
  if (!pack) return "";
  const ready = (pack.surfaces || []).filter((s) => s.image);
  const picks = pack.pickable || [];
  if (!ready.length && !picks.length) return "";
  const groups = {};
  for (const p of picks) (groups[p.group] ||= []).push(p);
  const wants3d = picks.some((p) => !p.model) && !is2d();
  return `${ready.length ? `<h2 class="block-title">Walls and floors <span class="block-count">${ready.length}</span></h2>
    <div class="pack-tiles">${ready.map((s) => `<button type="button" class="pack-tile" data-open="${esc(s.asset)}" title="Open ${esc(s.title)}"><img src="${esc(fileUrl(s.image))}" alt="" loading="lazy"><span>${esc(s.title)}</span></button>`).join("")}</div>` : ""}
  ${Object.entries(groups).map(([group, list]) => `<h2 class="block-title">${esc(group)} <span class="block-count">${list.length}</span></h2>
    <div class="pack-tiles">${list.map((p) => `<label class="pack-tile${p.model ? " has-3d" : ""}">
      <img src="${esc(fileUrl(p.image))}" alt="" loading="lazy"><span>${esc(p.title)}</span>
      ${p.model ? `<em>${icon("cube")}3D</em>` : is2d() ? "" : `<input type="checkbox" data-pack-pick="${esc(p.asset)}" aria-label="Make ${esc(p.title)} 3D">`}</label>`).join("")}</div>`).join("")}
  ${wants3d ? `<div class="pack-3d"><span id="packTotal">Tick the ones you want in 3D. Everything else stays a free cut-out.</span><button type="button" class="primary" id="packMake3d" disabled>Make 3D</button></div>` : ""}`;
}

function packDialog(path) {
  const items = state.pack?.items || [];
  const model = state.studio?.models?.find((m) => m.id === state.studio.selected);
  const row = (i) => `<label><input type="checkbox" name="item" value="${esc(i.id)}" ${i.done ? "disabled" : "checked"}><span>${esc(i.label)}</span><small>${i.done ? "Done" : esc(i.hint || "")}</small></label>`;
  const total = () => {
    const n = [...document.querySelectorAll("#packForm input[name=item]:checked")].length;
    const price = model?.price && !state.agentCfg?.demo_mode ? ` · ≈ $${(model.price * n).toFixed(2)}` : "";
    $("#packCost").textContent = `${plural(n, "image")}${price}. The cutting, tiling and kit building after that are free.`;
  };
  openDialog(`<form class="dlg sheet tone-amber compact" id="packForm">
    ${sheetHead("box", items.some((i) => i.done) ? "Finish the asset pack" : "Asset pack", "", "Tessera redraws each surface from your level picture, flat-on and evenly lit, then builds pieces that always line up. They match the picture's look, not its exact pixels.")}
    <div class="sheet-body">${optBlock("Make", `<div class="batch-list">${items.map(row).join("")}</div>`)}</div>
    ${sheetFoot("", "sparkle", "Make pack", `id="packCost"`)}</form>`);
  total();
  $("#packForm").addEventListener("change", total);
  $("#packForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const wanted = [...event.target.querySelectorAll("input[name=item]:checked")].map((i) => i.value);
    if (!wanted.length) return toast("Tick at least one thing to make.", true);
    try {
      await api("/api/studio/level-pack", { method: "POST", body: { asset: path, items: wanted } });
      closeDialog();
      state.dockOpen = true;
      renderJobDock();
      await renderView();
    } catch (err) { toast(err.message, true); }
  });
}

async function renderLevels() {
  const content = $("#content");
  let data;
  try { data = await pageApi("/api/studio/levels"); } catch (err) { content.innerHTML = `<p class="hint-line">${esc(err.message)}</p>`; return; }
  state.levelFolder = data.folder;
  content.innerHTML = `
    <div class="asset-head"><h1 class="title">Levels</h1></div>
    <p class="levels-lead">${is2d() ? "Describe a place, pick the picture you like, and Tessera cuts out every prop in it." : "Describe a place, pick the picture you like, and Tessera turns it into a matching asset pack: walls, floors, pillars and props that fit together, for hand-built or procedural levels."}</p>
    <div class="action-row"><button class="primary" data-new-level>${icon("sparkle")} New level</button></div>
    ${data.levels.length ? `<div class="level-cards">${data.levels.map((l) => `<button type="button" class="level-card" data-open="${esc(l.path)}">
      ${l.image ? `<img src="${esc(fileUrl(l.image))}" alt="" loading="lazy">` : `<span class="level-blank">${icon("map")}</span>`}
      <strong>${esc(l.title)}</strong><small>${!l.image ? "No picture yet" : l.kit ? `Asset pack${l.props ? ` · ${plural(l.props, "prop")}` : ""}` : l.props ? plural(l.props, "prop") : "Picture picked"}</small></button>`).join("")}</div>` : `<div class="empty">${tessArt("model")}<h1>No levels yet</h1><p>Your levels will show up here. Make your first one to see how it works.</p>
      <button class="keyart-cta" data-new-level>${icon("map")}<span><strong>New level</strong><small>Describe a place, pick the picture you like, and Tessera cuts out its props</small></span></button></div>`}`;
}

function newLevelDialog() {
  openDialog(`<form class="dlg sheet tone-amber compact" id="newLevelForm">
    ${sheetHead("map", "New level", "", "Describe one place in your game. You'll get a picture to approve before anything else is made.")}
    <div class="sheet-body">
      <label>Name<input name="title" maxlength="80" placeholder="Cold storage plant" autofocus></label>
      <label>What's it like?<textarea name="prompt" rows="3" placeholder="An abandoned cold-storage plant: rusted pipes, frosted concrete walls, flickering strip lights, seen from eye level"></textarea></label>
      <p class="form-why" id="nlWhy" hidden>Give it a name first.</p>
    </div>
    ${sheetFoot("Nothing is generated yet", "map", "Create")}</form>`);
  $("#newLevelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const name = String(data.title || "").trim();
    if (!name) { $("#nlWhy").hidden = false; return event.target.title.focus(); }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "level";
    const path = `${state.levelFolder || "levels"}/${slug}.md`;
    const content = `---\nkind: "level"\nprompt: ${JSON.stringify(String(data.prompt || name).trim())}\n---\n\n# ${name}\n`;
    try {
      await api("/api/overview/file", { method: "PUT", body: { path, content } });
      closeDialog();
      await loadOverview();
      go({ type: "doc", path });
    } catch (err) { toast(err.message, true); }
  });
}

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-level-pack],[data-new-level],#packMake3d");
  if (!t || t.disabled) return;
  if (t.dataset.levelPack) {
    await studioOptions().catch(() => null);
    return packDialog(t.dataset.levelPack);
  }
  if (t.dataset.newLevel !== undefined) return newLevelDialog();
  const assets = [...document.querySelectorAll("[data-pack-pick]:checked")].map((i) => i.dataset.packPick);
  if (!assets.length) return;
  t.disabled = true;
  try {
    const res = await api("/api/studio/level-pack/make-3d", { method: "POST", body: { assets } });
    res.jobs.forEach((j) => { state.jobs[j.id] ||= j; });
    state.dockOpen = true;
    renderJobDock();
    toast(`Making ${plural(res.jobs.length, "3D model")}${res.skipped.length ? ` · ${res.skipped.length} skipped: ${res.skipped[0].reason}` : ""}`, Boolean(res.skipped.length));
    await renderView();
  } catch (err) { toast(err.message, true); t.disabled = false; }
});

document.addEventListener("change", (event) => {
  if (!event.target.matches?.("[data-pack-pick]")) return;
  const n = document.querySelectorAll("[data-pack-pick]:checked").length;
  const usd = (state.pack?.mesh_usd || 0.3) * n;
  $("#packTotal").textContent = n ? `${plural(n, "3D model")} · ≈ $${usd.toFixed(2)} at Tessera's Meshy estimate` : "Tick the ones you want in 3D. Everything else stays a free cut-out.";
  $("#packMake3d").disabled = !n;
});

// A material: the picked image made seamless, with its maps, shown repeating so a visible seam or grid is easy to spot.
function materialPanel(a) {
  const albedo = (a.outputs.textures || []).find((o) => /-albedo\.png$/.test(o.path));
  const label = !albedo ? "Make tileable" : a.meta.material_source === a.winner ? "Make tileable again" : "Update from the new picture";
  const url = albedo ? `${fileUrl(albedo.path)}?v=${encodeURIComponent(a.meta.material_built || "")}` : "";
  return `<div class="level-kit mat-panel"><div class="field-label">${icon("material")} Tiling material</div>
    ${albedo ? `<div class="mat-tiles" role="img" aria-label="The texture repeated three times each way" style="background-image:url(&quot;${esc(url)}&quot;)"></div>` : `<p class="hint-line">${a.winner ? "Free, on this computer: makes the picture seamless and adds normal, roughness and height maps." : "Generate an image and pick it, then make it tile. That step is free."}</p>`}
    <div class="mat-actions"><button type="button" class="mini" data-material-build="${esc(a.path)}" ${a.winner ? "" : "disabled"}>${label}</button>
      <label>One tile covers <input type="number" data-kit-field="tile_m" data-kit-asset="${esc(a.path)}" min="0.1" max="50" step="0.1" value="${esc(a.meta.tile_m || 2)}"> metres</label></div></div>`;
}

// A modular kit: exact-size pieces Tessera builds itself, painted with the project's materials.
function renderKitAsset(a, title) {
  const models = a.outputs["3d"] || [];
  const room = models.find((m) => /-sample-room\.glb$/.test(m.path));
  const m = a.meta;
  const field = (name, label, value, min, max, step) => `<label>${label}<span><input type="number" data-kit-field="${name}" data-kit-asset="${esc(a.path)}" min="${min}" max="${max}" step="${step}" value="${esc(m[name] ?? value)}"> m</span></label>`;
  const known = state.materials || [];
  const slot = (name, label) => `<label>${label}<select data-kit-field="kit_${name}" data-kit-asset="${esc(a.path)}"><option value="">Plain grey</option>
    ${known.map((x) => `<option value="${esc(x.path)}" ${x.path === m[`kit_${name}`] ? "selected" : ""} ${x.built ? "" : "disabled"}>${esc(x.title)}${x.built ? "" : " (press Make tileable on it first)"}</option>`).join("")}</select></label>`;
  return `
    <div class="asset-head"><h1 class="title" title="${esc(a.path)}">${esc(title)}</h1><span class="kind-tag">modular kit</span></div>
    <div class="asset-top">
      <div class="winner-box${room ? " hero-3d" : ""}"${room ? ` data-hero-model="${esc(room.path)}"` : ""}>${room ? `
        ${room.thumb ? `<img class="hero-poster" src="${esc(fileUrl(room.thumb))}" alt="">` : ""}<div class="hero-stage"></div>
        <span class="out-badge mesh hero-badge">${icon("cube")}Sample room · drag to turn</span>
        <button type="button" class="mini hero-open" data-view-model="${esc(room.path)}">${icon("eye")}Open viewer</button>` : `<div class="no-thumb big"><p class="drop-copy">${kindArt(a.kind, "")}Nothing built yet.<br>Press <b>Build kit</b>: it's free and takes seconds.</p></div>`}</div>
      <div class="asset-side">
        <p class="hint-line">Floors, walls, doorways, corners and stairs at exact sizes, so they always line up. Tessera builds them on this computer, and your coding agent gets a map of how they fit for procedural levels.</p>
        <div class="field-label">Grid</div>
        <div class="kit-form">${field("kit_cell", "Cell size", 2, 0.5, 20, 0.5)}${field("kit_height", "Wall height", 3, 0.5, 30, 0.5)}${field("kit_thickness", "Wall thickness", 0.2, 0.02, 2, 0.05)}${field("kit_relief", "Surface depth", 0.05, 0, 0.5, 0.01)}</div>
        <div class="field-label">Materials</div>
        <div class="kit-form">${slot("wall", "Walls")}${slot("wall_2", "Walls, variant")}${slot("wall_3", "Walls, variant 2")}${slot("floor", "Floors")}${slot("floor_2", "Floors, variant")}${slot("ceiling", "Ceilings")}</div>
        ${known.length ? "" : `<p class="hint-line">No materials yet. Make an asset of kind Material for each surface, or build in plain grey to try the layout first.</p>`}
        <div class="action-row"><button class="primary" data-kit-build="${esc(a.path)}">${room ? "Rebuild kit" : "Build kit"}</button>
          ${room ? `<a class="ghost btn-link" href="${esc(fileUrl(`${dirOf(room.path)}/kit.json`))}" download>${icon("download")}kit.json</a>` : ""}
          <button type="button" class="ghost" data-export="${esc(a.path)}">${icon("box")}Export</button></div>
      </div>
    </div>
    ${models.length ? `<h2 class="block-title" id="out-3d">3D models</h2>${outputGrid(models, "", "kit")}` : ""}
    <h2 class="block-title">Notes</h2>
    <div class="doc-bar"><span class="path"><bdi>${esc(a.path)}</bdi></span><button class="ghost" data-edit>Edit document</button></div>
    <div class="md">${renderMarkdown(a.body.replace(/^#\s+.+$/m, ""), dirOf(a.path))}</div>`;
}

// The hero viewer keeps its model for the same path, so a rebuilt file needs a new one.
function resetHero() {
  if (hero) { hero.view?.dispose(); hero.host.remove(); hero = null; }
}

async function buildKit(path, quiet = false) {
  await api("/api/studio/kit/build", { method: "POST", body: { asset: path } });
  resetHero();
  if (!quiet) toast("Kit built");
  await renderView();
}

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-material-build],[data-kit-build]");
  if (!t || t.disabled) return;
  t.disabled = true;
  try {
    if (t.dataset.kitBuild) return await buildKit(t.dataset.kitBuild);
    await api("/api/studio/material/build", { method: "POST", body: { asset: t.dataset.materialBuild } });
    toast("Material ready: seamless, with its maps");
    await renderView();
  } catch (err) { toast(err.message, true); t.disabled = false; }
});

// Settings save as they change; a kit already built follows them, so swapping a material reskins it.
document.addEventListener("change", async (event) => {
  const t = event.target.closest("[data-kit-field]");
  if (!t) return;
  const path = t.dataset.kitAsset;
  try {
    await api("/api/studio/asset", { method: "PATCH", body: { path, fields: { [t.dataset.kitField]: t.type === "number" ? Number(t.value) : t.value } } });
    if (t.dataset.kitField.startsWith("kit_") && $("#content [data-hero-model]")) await buildKit(path, true);
  } catch (err) { toast(err.message, true); }
});

function gameTools(a) {
  const glb = a.outputs["3d"].some((o) => /\.glb$/i.test(o.path));
  const rigged = Boolean(a.meta?.rig_task);
  const winner = esc(a.winner || "");
  const TONE = { bones: "sky", play: "violet", cube: "sky", grid: "amber", box: "brand" };
  const tool = (attrs, name, label, enabled, tip) => `<button type="button" class="tool tone-${TONE[name] || "brand"}" ${attrs}${enabled ? "" : " disabled"} title="${esc(tip)}"><span class="tool-ic">${icon(name)}</span>${label}</button>`;
  const three = !is2d() || glb;
  if (a.kind === "material" || a.kind === "level") return `<div class="tool-row"><div class="field-label">Game tools</div><div class="tool-btns">${tool(`data-export="${esc(a.path)}"`, "box", "Export", true, "ZIP for Godot, Unity or Unreal")}</div></div>`;
  return `<div class="tool-row"><div class="field-label">Game tools</div><div class="tool-btns">
    ${three ? `${tool(`data-action="rig"`, "bones", "Rig", glb, glb ? "Add a skeleton to the GLB model. Works on textured humanoid characters facing forward" : "Make a GLB model, or drop one on this page, first")}
    ${tool(`data-action="animate"`, "play", "Animate", rigged, rigged ? "Preset animations for the rigged model" : "Rig the model first")}` : ""}
    ${three && state.studio?.tripo_connected ? tool(`data-tripo-tools="${esc(JSON.stringify(a.outputs["3d"].filter((o) => /\.glb$/i.test(o.path)).map((o) => o.path)))}" data-asset="${esc(a.path)}"`, "cube", "Tripo", glb, glb ? "Retopo, re-texture or convert the model with Tripo" : "Make a GLB model first") : ""}
    ${tool(`data-icons="${winner}"`, "grid", "Icons", a.winner, a.winner ? "Square inventory icons from the winner" : "Pick a winner first")}
    ${tool(`data-export="${esc(a.path)}"`, "box", "Export", true, "ZIP for Godot, Unity or Unreal")}
  </div></div>`;
}

// Tripo's model tools: retopo (fewer, cleaner polygons), re-texture and convert. The result is saved beside the original.
const TRIPO_TOOLS = {
  retopo: { label: "Retopo", credits: (o) => (o.quad ? 40 : 35), blurb: "Rebuilds the model with fewer, cleaner polygons and bakes the texture across." },
  retexture: { label: "Re-texture", credits: (o) => 20 + ({ detailed: 10, extreme: 30 }[o.quality] || 0), blurb: "New textures on the same shape. Describe the look, or leave it empty to redo them." },
  convert: { label: "Convert", credits: () => 10, blurb: "The same model as FBX, OBJ, USDZ or STL, for engines and tools that don't take GLB." },
};

function tripoToolsDialog(models, asset) {
  const name = humanize(asset.split("/").pop());
  const st = { op: "retopo", options: { face_limit: 10000, quad: false, quality: "standard", prompt: "", format: "FBX" }, model: models[0], busy: false };
  const draw = () => {
    const o = st.options, tool = TRIPO_TOOLS[st.op];
    const fields = st.op === "retopo" ? `<div class="poly-row"><input type="number" id="ttFaces" min="100" max="500000" step="500" value="${o.face_limit}"> <span class="poly-presets">${[3000, 10000, 30000, 100000].map((n) => `<button type="button" class="${n === o.face_limit ? "on" : ""}" data-tt-faces="${n}">${fmtCount(n)}</button>`).join("")}</span></div>
        <label class="mesh-toggle"><span class="switch"><input type="checkbox" id="ttQuad" ${o.quad ? "checked" : ""}><span></span></span><span>Quad mesh<small>Saved as FBX</small></span></label>`
      : st.op === "retexture" ? `<label class="sheet-instruction">Look <textarea id="ttPrompt" rows="2" placeholder="mossy stone, hand-painted, rusty metal…">${esc(o.prompt)}</textarea></label>
        <div class="mesh-grid"><label>Quality <select id="ttQuality">${[["standard", "Standard"], ["detailed", "Detailed · +10"], ["extreme", "Extreme 8K · +30"]].map(([v, l]) => `<option value="${v}" ${v === o.quality ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>`
      : `<div class="mesh-grid"><label>Format <select id="ttFormat">${["FBX", "OBJ", "USDZ", "STL"].map((f) => `<option ${f === o.format ? "selected" : ""}>${f}</option>`).join("")}</select></label></div>`;
    openDialog(`<div class="dlg sheet tone-sky">
      <header class="sheet-head"><span class="sheet-icon">${icon("cube")}</span><div><h2>Tripo <span>· ${esc(name)}</span></h2><p>${esc(tool.blurb)} The original stays.</p></div></header>
      <div class="sheet-model"><label class="model-pick">Model <select id="ttModel">${models.map((m) => `<option value="${esc(m)}" ${m === st.model ? "selected" : ""}>${esc(m.split("/").pop())}</option>`).join("")}</select></label>
        <div class="seg" role="radiogroup">${Object.entries(TRIPO_TOOLS).map(([id, t]) => `<label><input type="radio" name="ttOp" value="${id}" ${id === st.op ? "checked" : ""}><span>${t.label}</span></label>`).join("")}</div></div>
      <div class="sheet-body only-refs"><section class="mesh-opts">${fields}</section></div>
      <footer class="sheet-foot"><span class="cost">≈ ${tool.credits(o)} Tripo credits · ≈ $${(tool.credits(o) / 100).toFixed(2)}</span><span class="grow"></span>
        <button type="button" class="ghost" data-close>Cancel</button><button type="button" class="run-btn" id="ttRun">${icon("cube")}${st.busy ? "Working…" : tool.label}</button></footer></div>`);
    const read = () => {
      st.model = $("#ttModel").value;
      if ($("#ttFaces")) st.options.face_limit = Math.max(100, Number($("#ttFaces").value) || 10000);
      if ($("#ttQuad")) st.options.quad = $("#ttQuad").checked;
      if ($("#ttPrompt")) st.options.prompt = $("#ttPrompt").value;
      if ($("#ttQuality")) st.options.quality = $("#ttQuality").value;
      if ($("#ttFormat")) st.options.format = $("#ttFormat").value;
    };
    $("#ttModel").addEventListener("change", read);
    document.querySelectorAll("#dialog [name=ttOp]").forEach((r) => r.addEventListener("change", () => { read(); st.op = r.value; draw(); }));
    document.querySelectorAll("#dialog [data-tt-faces]").forEach((b) => b.addEventListener("click", () => { read(); st.options.face_limit = Number(b.dataset.ttFaces); draw(); }));
    document.querySelectorAll("#ttQuad, #ttQuality").forEach((el) => el.addEventListener("change", () => { read(); draw(); }));
    $("#ttRun").addEventListener("click", async () => {
      if (st.busy) return;
      read();
      st.busy = true;
      $("#ttRun").disabled = true;
      $("#ttRun").lastChild.textContent = "Working…";
      toast("Tripo is working. This takes a minute or two.");
      try {
        await api("/api/tripo/process", { method: "POST", body: { asset, model: st.model, op: st.op, options: st.options } });
        closeDialog();
        toast(`✓ ${TRIPO_TOOLS[st.op].label} done. It's in the 3D models.`);
        renderView();
      } catch (err) { st.busy = false; toast(err.message, true); draw(); }
    });
  };
  draw();
}

document.addEventListener("click", (event) => {
  const t = event.target.closest("[data-tripo-tools]");
  if (!t || t.disabled) return;
  try { tripoToolsDialog(JSON.parse(t.dataset.tripoTools), t.dataset.asset); } catch (err) { toast(err.message, true); }
});

function sheetFrame(action, assetName, body, foot, extraClass = "") {
  const theme = ACTION_THEME[action];
  return `<div class="dlg sheet tone-${theme.tone} ${extraClass}">
    ${sheetHead(theme.icon, ACTION_LABEL[action], assetName, theme.blurb)}
    ${body}
    <footer class="sheet-foot">${foot}<span class="grow"></span><button type="button" class="ghost" data-close>Cancel</button>
      <button type="button" class="run-btn" data-run>${icon(theme.icon)}${esc(ACTION_LABEL[action])}</button></footer></div>`;
}

// The coloured header every action dialog shares: icon tile, title, what it's for.
const sheetHead = (iconName, title, sub, blurb) => `<header class="sheet-head"><span class="sheet-icon">${icon(iconName)}</span>
  <div><h2>${esc(title)}${sub ? ` <span>· ${esc(sub)}</span>` : ""}</h2>${blurb ? `<p>${blurb}</p>` : ""}</div></header>`;
// Footer for form dialogs: a note on the left, Cancel and the submit button on the right.
const sheetFoot = (note, iconName, label, attrs = "") => `<footer class="sheet-foot"><span class="cost" ${attrs}>${note}</span><span class="grow"></span>
  <button type="button" class="ghost" data-close>Cancel</button><button class="run-btn">${icon(iconName)}${esc(label)}</button></footer>`;
// A labelled block of options inside a sheet.
const optBlock = (label, body, hint = "") => `<div class="opt-block"><div class="opt-label">${label}</div>${body}${hint ? `<p class="opt-hint">${hint}</p>` : ""}</div>`;

const RIG_BODY = {
  biped: ["Humanoid", "Two legs, two arms", `<circle cx="12" cy="4.5" r="2"/><path d="M12 6.5v7M12 13.5l-4 6.5M12 13.5l4 6.5M6 9.5h12"/>`],
  quadruped: ["Four legs", "Dogs, horses, beasts", `<path d="M4 10.5h13l3-3M6 10.5v8M9 10.5v8M14 10.5v8M17 10.5v8M17 7.5l1.5-2"/>`],
  hexapod: ["Six legs", "Insects, ants", `<ellipse cx="12" cy="12" rx="3" ry="6"/><path d="M9 9 4 7M9 12H3.5M9 15l-5 2M15 9l5-2M15 12h5.5M15 15l5 2"/>`],
  octopod: ["Eight legs", "Spiders, crabs", `<circle cx="12" cy="12" r="3"/><path d="M9.5 10 4 6M9 12H3M9.5 14 4 18M10.5 15 8 20.5M14.5 10l5.5-4M15 12h6M14.5 14l5.5 4M13.5 15l2.5 5.5"/>`],
  avian: ["Bird", "Wings, two legs", `<path d="M3 9c3-1 6 0 9 3 3-3 6-4 9-3-3 1-5 3-6 6H9C8 12 6 10 3 9zM10 15v4M14 15v4"/>`],
  serpentine: ["Snake", "Snakes, worms, tails", `<path d="M3 16c3 0 3-6 6-6s3 6 6 6 3-6 6-6"/><circle cx="20.5" cy="10" r=".8"/>`],
  aquatic: ["Swimmer", "Fish, sharks, eels", `<path d="M3 12c3-4 9-5 13-2l4-3v10l-4-3c-4 3-10 2-13-2z"/><circle cx="7" cy="11.5" r=".8"/>`],
  others: ["Other", "Tripo guesses the bones", `<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>`],
};
const RIG_SPEC = { tripo: ["Tripo", "Its own bone names"], mixamo: ["Mixamo", "Mixamo clips, Blender"], unity: ["Unity", "Humanoid avatar"], unreal: ["Unreal", "UE5 Mannequin"], actorcore: ["ActorCore", "Reallusion / iClone"], vrm: ["VRM", "VTuber avatars"] };
const RIG_HEIGHTS = [[0.6, "Critter"], [1.2, "Child"], [1.7, "Human"], [2.1, "Brute"], [3, "Ogre"], [5, "Giant"]];
const RIG_ENGINE = {
  meshy: ["Meshy", "Humanoids only · free walk and run clips", ["Rigged GLB + FBX", "Walk clip", "Run clip"]],
  tripo: ["Tripo", "Eight body types · engine-ready skeletons", ["Rigged model", "Pick a skeleton for your engine"]],
};

function renderRigSheet() {
  const p = state.preview;
  p.references = p.references.map((r) => ({ ...r, on: true }));
  const s = p.settings;
  const engines = p.engines || [{ id: p.engine, credits: p.credits, cost_usd: p.cost_usd }];
  const models = p.models?.length ? p.models : [{ path: p.references[0]?.path || "", thumb: p.thumb }];
  const modelPath = p.references[0]?.path || models[0].path;
  const model = models.find((m) => m.path === modelPath) || models[0];
  const tripoRig = s.engine === "tripo" || (!s.engine && p.engine === "tripo");
  const engine = engines.find((e) => e.id === (tripoRig ? "tripo" : "meshy")) || engines[0];
  const h = Number(s.height_meters) || 1.7;
  const maxTri = p.max_triangles || 380000;
  const triOk = model.triangles == null || tripoRig || model.triangles <= maxTri;
  const biped = s.rig_type === "biped";

  // Left: the model on a floor with a 1.8 m person beside it, so the height reads at a glance.
  const span = Math.max(h, 1.8) * 1.15;
  const stage = `<div class="rig-stage${tripoRig ? " no-scale" : ""}">
      <div class="rig-floor">
        ${tripoRig ? "" : `<div class="rig-ref" style="height:${(1.8 / span) * 100}%" title="A 1.8 m person"><svg viewBox="0 0 12 30" preserveAspectRatio="xMidYMax meet"><circle cx="6" cy="3" r="2.4"/><path d="M6 5.6V17M6 8.5 2.2 15M6 8.5l3.8 6.5M6 17l-2.6 12.5M6 17l2.6 12.5"/></svg><span>1.8 m</span></div>`}
        <div class="rig-model" style="height:${tripoRig ? 100 : (h / span) * 100}%">${model.thumb ? `<img src="${esc(fileUrl(model.thumb))}" alt="">` : icon("cube")}${tripoRig ? "" : `<span class="rig-measure">${h.toFixed(2)} m</span>`}</div>
      </div>
      <div class="rig-stats">
        <span class="stat ${triOk ? "" : "bad"}">${model.triangles == null ? "Triangles unknown" : `${fmtCount(model.triangles)} tris${tripoRig ? "" : ` / ${fmtCount(maxTri)}`}`}</span>
        ${model.mb != null ? `<span class="stat">${model.mb} MB</span>` : ""}<span class="stat">GLB</span>
      </div>
      ${models.length > 1 ? `<div class="rig-models">${models.map((m) => `<button type="button" class="${m.path === model.path ? "on" : ""}" data-rig-model="${esc(m.path)}" title="${esc(m.path.split("/").pop())}">${m.thumb ? `<img src="${esc(fileUrl(m.thumb))}" alt="">` : icon("cube")}</button>`).join("")}</div>` : ""}
      <code class="rig-file">${esc(model.path.split("/").pop())}</code>
    </div>`;

  const engineCards = optBlock("Rig with", `<div class="opt-cards two">${["meshy", "tripo"].map((id) => {
    const e = engines.find((x) => x.id === id);
    return `<button type="button" class="opt-card${engine.id === id ? " on" : ""}" data-rig-engine="${id}" ${e ? "" : "disabled"}>
      <strong>${RIG_ENGINE[id][0]}</strong><small>${e ? RIG_ENGINE[id][1] : "Add a key in Settings to use it"}</small>
      ${e ? `<em>${e.credits} credits</em>` : ""}</button>`;
  }).join("")}</div>`);

  const config = tripoRig
    ? optBlock("Body type", `<div class="opt-cards four">${(p.choices?.rig_type || Object.keys(RIG_BODY)).map((t) => `<button type="button" class="opt-card icon-card${s.rig_type === t ? " on" : ""}" data-rig-type="${t}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${(RIG_BODY[t] || RIG_BODY.others)[2]}</svg><strong>${(RIG_BODY[t] || [humanize(t)])[0]}</strong><small>${(RIG_BODY[t] || ["", ""])[1]}</small></button>`).join("")}</div>`)
      + optBlock("Skeleton", `<div class="opt-chips">${(p.choices?.spec || Object.keys(RIG_SPEC)).map((v) => `<button type="button" class="opt-chip${s.spec === v ? " on" : ""}" data-rig-spec="${v}" ${biped ? "" : "disabled"} title="${esc((RIG_SPEC[v] || ["", ""])[1])}">${(RIG_SPEC[v] || [humanize(v)])[0]}</button>`).join("")}</div>`,
        biped ? esc((RIG_SPEC[s.spec] || ["", ""])[1]) + ". Match it to your engine so its own animations fit." : "Skeleton presets are for humanoids; other bodies get Tripo's own bones.")
    : optBlock("Height", `<div class="opt-chips">${RIG_HEIGHTS.map(([m, l]) => `<button type="button" class="opt-chip${Math.abs(h - m) < 0.001 ? " on" : ""}" data-rig-height="${m}">${l}<b>${m} m</b></button>`).join("")}</div>
        <div class="rig-slider"><input type="range" id="rigHeightRange" min="0.3" max="8" step="0.05" value="${h}"><label class="rig-num"><input id="rigHeight" type="number" min="0.2" max="20" step="0.05" value="${h}"><span>m</span></label></div>`,
        "Sets the skeleton's scale and the stride of the walk and run clips.");

  const checks = [
    [true, "GLB model"],
    [triOk, tripoRig ? "Any polycount" : `Under ${fmtCount(maxTri)} triangles${triOk ? "" : ": remesh it in Make 3D first"}`],
    [null, tripoRig ? (biped ? "Standing in a T or A pose" : "Facing forward, limbs apart") : "Humanoid, facing forward, arms away from the body"],
  ];
  const gets = optBlock("You get", `<ul class="opt-gets">${RIG_ENGINE[engine.id][2].map((g) => `<li>${icon("check")}${esc(g)}</li>`).join("")}<li class="next">${icon("play")}Then: Animate, with ${engine.id === "tripo" ? "Tripo" : "Meshy"}'s preset clips</li></ul>`)
    + `<ul class="opt-checks">${checks.map(([ok, t]) => `<li class="${ok === false ? "bad" : ok ? "ok" : ""}"><i>${ok === false ? "!" : ok ? "✓" : "i"}</i><span>${esc(t)}</span></li>`).join("")}</ul>`;

  openDialog(sheetFrame("rig", humanize(p.asset.split("/").pop()), `
    <div class="sheet-body rig-body">${stage}<section class="rig-opts">${engines.length > 1 || !engines.some((e) => e.id === "tripo") ? engineCards : ""}${config}${gets}</section></div>`,
  state.agentCfg?.demo_mode ? `<span class="cost">Demo mode: rigs a stand-in figure with one clip, so you can try Animate and Motion Studio. No cost.</span>`
    : `<span class="cost">${engine.credits} ${engine.id === "tripo" ? "Tripo" : "Meshy"} credits · ≈ $${engine.cost_usd.toFixed(2)}</span>`, "rig-sheet"));
  const run = $("#dialog [data-run]");
  if (run && !triOk && !state.agentCfg?.demo_mode) { run.disabled = true; run.title = "Too many triangles for Meshy"; }
  // Dragging the slider moves the model and the readout in place; the sheet redraws only when the range itself changes.
  const live = (v, from) => {
    s.height_meters = Math.round(Math.min(20, Math.max(0.2, Number(v) || 1.7)) * 100) / 100;
    const hh = s.height_meters, sp = Math.max(hh, 1.8) * 1.15;
    $("#dialog .rig-ref")?.style.setProperty("height", `${(1.8 / sp) * 100}%`);
    $("#dialog .rig-model")?.style.setProperty("height", `${(hh / sp) * 100}%`);
    const m = $("#dialog .rig-measure"); if (m) m.textContent = `${hh.toFixed(2)} m`;
    if (from !== "num") $("#rigHeight").value = hh;
    if (from !== "range") $("#rigHeightRange").value = hh;
    document.querySelectorAll("#dialog [data-rig-height]").forEach((c) => c.classList.toggle("on", Math.abs(Number(c.dataset.rigHeight) - hh) < 0.001));
  };
  $("#rigHeightRange")?.addEventListener("input", (e) => live(e.target.value, "range"));
  $("#rigHeight")?.addEventListener("input", (e) => live(e.target.value, "num"));
}

document.addEventListener("click", (event) => {
  const b = event.target.closest(".rig-sheet [data-rig-engine], .rig-sheet [data-rig-type], .rig-sheet [data-rig-spec], .rig-sheet [data-rig-height], .rig-sheet [data-rig-model]");
  const p = state.preview;
  if (!b || b.disabled || !p || p.action !== "rig") return;
  const s = p.settings, d = b.dataset;
  if (d.rigEngine) {
    const e = (p.engines || []).find((x) => x.id === d.rigEngine);
    if (!e) return;
    Object.assign(p, { engine: e.id, credits: e.credits, cost_usd: e.cost_usd, model: `${e.id}:rigging` });
    s.engine = e.id;
  }
  if (d.rigType) s.rig_type = d.rigType;
  if (d.rigSpec) s.spec = d.rigSpec;
  if (d.rigHeight) s.height_meters = Number(d.rigHeight);
  if (d.rigModel) {
    const m = p.models.find((x) => x.path === d.rigModel);
    p.references = [{ path: m.path, source: "3D model", role: "source", on: true }];
    p.thumb = m.thumb;
  }
  renderRigSheet();
});

async function renderAnimateSheet() {
  const p = state.preview;
  const tripoRig = p.engine === "tripo", who = tripoRig ? "Tripo" : "Meshy";
  if (state.animLibEngine !== p.engine) { state.animLib = null; state.animLibEngine = p.engine; } // the two services list different animations
  if (!state.animLib) {
    openDialog(sheetFrame("animate", humanize(p.asset.split("/").pop()), `<div class="sheet-body only-refs"><p class="hint-line">Loading ${who}'s animation list…</p></div>`, ""));
    try { state.animLib = (await api(`/api/studio/animations?engine=${encodeURIComponent(p.engine || "")}`)).animations; } catch (err) { state.animLib = null; p.error = err.message; }
  }
  const lib = state.animLib || [];
  const q = (p.search || "").toLowerCase();
  const shown = lib.filter((a) => !q || `${a.name} ${a.category} ${a.sub_category}`.toLowerCase().includes(q)).slice(0, 120);
  const picked = new Set(p.picked);
  const credits = p.picked.length * p.credits_each;
  openDialog(sheetFrame("animate", humanize(p.asset.split("/").pop()), `
    <div class="sheet-model"><label class="model-pick">Search<input id="animSearch" type="search" value="${esc(p.search)}" placeholder="idle, attack, death…"></label>
      ${tripoRig ? `<label class="mesh-toggle"><span class="switch"><input type="checkbox" id="animInPlace" ${p.settings.in_place ? "checked" : ""}><span></span></span><span>Stay in place<small>No travel: for a game that moves the character itself</small></span></label>`
        : `<label class="model-pick">FPS<select id="animFps">${[24, 25, 30, 60].map((f) => `<option ${f === Number(p.settings.fps) ? "selected" : ""}>${f}</option>`).join("")}</select></label>`}
      <span class="chip">Picked <b>${p.picked.length} / 10</b></span></div>
    <div class="sheet-body only-refs"><section>
      ${p.error ? `<p class="hint-line">${esc(p.error)}</p>` : ""}
      <div class="anim-grid">${shown.map((a) => `<button type="button" class="anim${picked.has(a.id) ? " on" : ""}" data-anim="${a.id}">
        ${/\.(gif|png|jpe?g|webp)(\?|$)/i.test(a.preview) ? `<img src="${esc(a.preview)}" alt="" loading="lazy">` : `<span class="anim-icon">${icon("play")}</span>`}
        <strong>${esc(a.name)}</strong><small>${esc([a.category, a.sub_category].filter(Boolean).join(" · "))}</small></button>`).join("")}</div>
      ${!shown.length && !p.error ? `<p class="hint-line">No animations match.</p>` : ""}
    </section></div>`, `<span class="cost">${p.picked.length && state.agentCfg?.demo_mode ? "Demo mode: a stand-in clip, no cost" : p.picked.length ? `${credits} ${who} credits · ≈ $${(credits / 100).toFixed(2)} · ${tripoRig ? "a file with a clip per animation, five to a task" : "one file with a clip per animation"}` : "Pick up to 10 animations"}</span>`));
  $("#animInPlace")?.addEventListener("change", (e) => { p.settings.in_place = e.target.checked; });
  const search = $("#animSearch");
  search?.addEventListener("input", () => { p.search = search.value; clearTimeout(state.animTimer); state.animTimer = setTimeout(() => renderAnimateSheet().then(() => { const s = $("#animSearch"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }), 200); });
  $("#animFps")?.addEventListener("change", (e) => { p.settings.fps = Number(e.target.value); });
}

function prepareGameRun() {
  const p = state.preview;
  if (!p) return true;
  if (p.action === "rig") {
    p.settings = { ...p.settings, engine: p.settings.engine || p.engine, rig_type: p.settings.rig_type || "biped", spec: p.settings.spec || "tripo" };
    if (p.settings.engine !== "tripo" && !(Number(p.settings.height_meters) > 0)) { toast("Enter the character height in metres.", true); return false; }
  }
  if (p.action === "animate") {
    if (!p.picked.length) { toast("Pick at least one animation.", true); return false; }
    p.action_ids = [...p.picked];
    p.names = p.picked.map((id) => (state.animLib || []).find((a) => a.id === id)?.name || String(id));
  }
  return true;
}

// ---- split an image into parts ----

async function splitDialog(image, sheet = false) {
  state.split = { image, boxes: [], asAssets: sheet, sheet, note: "" };
  renderSplit();
  try {
    const { boxes } = await api(`/api/studio/detect-parts?path=${encodeURIComponent(image)}${sheet ? "&sheet=1" : ""}`);
    if (state.split?.image === image && !state.split.boxes.length) { state.split.boxes = boxes.map((b, i) => ({ ...b, name: "" })); renderSplit(); }
  } catch { /* draw by hand */ }
  if (sheet && state.split?.boxes.length) nameSheetParts();
}

async function nameSheetParts() {
  const sp = state.split;
  sp.busy = true;
  sp.note = `Found ${sp.boxes.length} props. Tess is naming them…`;
  renderSplit();
  try {
    const res = await api("/api/studio/name-parts", { method: "POST", body: { image: sp.image, boxes: sp.boxes } });
    if (state.split !== sp) return;
    syncSplitNames();
    sp.boxes.forEach((b, i) => { if (!b.name) b.name = res.names[i] || ""; });
    sp.note = res.source === "tess" ? `${sp.boxes.length} props, named by Tess. Fix a name or a box if one is off.` : `${res.note || "No names"}: name them yourself, or keep the numbers.`;
  } catch (err) { sp.note = err.message; }
  sp.busy = false;
  renderSplit();
}

// Tess looks at the picture and boxes the head, torso, arms, legs and held items.
async function guessBodyParts() {
  const sp = state.split;
  syncSplitNames();
  sp.busy = true;
  sp.note = "Tess is looking for the head, torso, arms and legs…";
  renderSplit();
  try {
    const res = await api("/api/studio/guess-body-parts", { method: "POST", body: { image: sp.image } });
    if (state.split !== sp) return;
    sp.boxes = res.boxes;
    sp.note = res.source === "tess" ? `Boxes by Tess${res.model ? ` (${res.model})` : ""}. Adjust or redraw any that are off.`
      : `${res.note || "Tess had no answer"}, so these boxes come from typical body proportions. Redraw any that are off.`;
  } catch (err) { sp.note = err.message; }
  sp.busy = false;
  renderSplit();
}

function renderSplit() {
  const sp = state.split;
  openDialog(`<div class="dlg wide sheet tone-violet split-dlg">
    ${sheetHead("scissors", sp.sheet ? "Cut into props" : "Split into parts", "", `${sp.sheet ? "Each box becomes its own prop asset with the background removed, in a folder next to the level. Drag on the picture to add a box, click × to drop one." : "Drag on the picture to draw a box around each part, click × to remove one. <b>Separate figures</b> boxes each character on a sheet; <b>Body parts</b> asks Tessera for the head, torso, arms and legs."}`)}
    <div class="sheet-body split-body"><div class="split-layout">
      <div class="split-stage" id="splitStage"><img src="${esc(fileUrl(sp.image))}" alt="" draggable="false">
        ${sp.boxes.map((b, i) => `<div class="split-box" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"><span>${i + 1}</span><button type="button" data-split-remove="${i}" aria-label="Remove box">×</button></div>`).join("")}</div>
      <div class="split-side">
        <div class="field-label">Parts · ${sp.boxes.length}</div>
        <div class="split-names">${sp.boxes.map((b, i) => `<label><span>${i + 1}</span><input data-split-name="${i}" value="${esc(b.name)}" placeholder="Part ${i + 1} name"></label>`).join("") || `<p class="hint-line">No boxes yet.</p>`}</div>
        <div class="split-guess"><button type="button" class="ghost" data-split-auto ${sp.busy ? "disabled" : ""}>Separate figures</button><button type="button" class="ghost" data-split-body ${sp.busy ? "disabled" : ""}>${icon("bones")} Body parts</button></div>
        ${sp.note ? `<p class="hint-line split-note">${sp.busy ? `<span class="spinner"></span>` : ""}${esc(sp.note)}</p>` : ""}
        <div class="field-label">Save as</div>
        <label class="target"><input type="radio" name="splitMode" value="parts" ${sp.asAssets ? "" : "checked"}><span>Parts of this asset<small>Cut-outs under Parts</small></span></label>
        <label class="target"><input type="radio" name="splitMode" value="assets" ${sp.asAssets ? "checked" : ""}><span>Separate assets<small>One asset each, the cut-out as its winner</small></span></label>
      </div>
    </div></div>
    <footer class="sheet-foot"><span class="cost">Free · cut on your computer</span><span class="grow"></span><button type="button" class="ghost" data-close>Cancel</button>
      <button type="button" class="run-btn" data-split-run ${sp.boxes.length ? "" : "disabled"}>${icon("scissors")}Cut ${sp.boxes.length || ""} ${sp.sheet ? "prop" : "part"}${sp.boxes.length === 1 ? "" : "s"}</button></footer>
  </div>`);
  const stage = $("#splitStage");
  stage.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const rect = stage.getBoundingClientRect();
    const start = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    const ghost = document.createElement("div");
    ghost.className = "split-box drawing";
    stage.appendChild(ghost);
    stage.setPointerCapture(event.pointerId);
    let box = null;
    const move = (e) => {
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      box = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y), name: "" };
      Object.assign(ghost.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
    };
    const up = () => {
      stage.removeEventListener("pointermove", move);
      syncSplitNames();
      if (box && box.w > 0.02 && box.h > 0.02) sp.boxes.push(box);
      renderSplit();
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up, { once: true });
  });
}

function syncSplitNames() {
  document.querySelectorAll("[data-split-name]").forEach((input) => { const b = state.split.boxes[Number(input.dataset.splitName)]; if (b) b.name = input.value; });
  const mode = document.querySelector("input[name=splitMode]:checked");
  if (mode) state.split.asAssets = mode.value === "assets";
}

async function runSplit() {
  syncSplitNames();
  const sp = state.split;
  try {
    const { created } = await api("/api/studio/split", { method: "POST", body: { asset: state.view.path, image: sp.image, boxes: sp.boxes, as_assets: sp.asAssets } });
    closeDialog();
    if (sp.sheet && sp.asAssets && created.length) {
      toast(`✓ ${created.length} props made from ${humanize(state.view.path.split("/").pop().replace(/\.md$/, ""))}`);
      await loadOverview();
      return go({ type: "folder", path: dirOf(created[0]) });
    }
    toast(sp.asAssets ? `Made ${created.length} new asset${created.length === 1 ? "" : "s"}` : `Cut ${created.length} part${created.length === 1 ? "" : "s"}`);
    await loadOverview();
  } catch (err) { toast(err.message, true); }
}

// ---- icons ----

function iconsDialog(image) {
  openDialog(`<form class="dlg sheet tone-amber compact" id="iconsForm">
    ${sheetHead("grid", "Inventory icons", humanize(state.view.path.split("/").pop()), "Square PNGs with a transparent background, trimmed to the subject. Free, made on your computer.")}
    <div class="sheet-body two-col">
      <div class="icons-stage checker"><img id="icPrev" src="${esc(fileUrl(image))}" alt="" style="padding:8%"></div>
      <section>
        ${optBlock("Sizes", `<div class="opt-chips">${[32, 64, 128, 256, 512].map((n) => `<label class="opt-chip"><input type="checkbox" name="size" value="${n}" ${[64, 128, 256].includes(n) ? "checked" : ""}><span class="ic-sq" style="--s:${6 + Math.log2(n / 32) * 3}px"></span>${n}<b>px</b></label>`).join("")}</div>`, "One PNG per size.")}
        ${optBlock(`Padding <b id="icPadV">8%</b>`, `<input type="range" name="padding" min="0" max="30" value="8">`, "Space between the subject and the icon's edge.")}
      </section>
    </div>
    ${sheetFoot(`<span id="icCount">3 icons</span>`, "grid", "Make icons")}
  </form>`);
  const icForm = $("#iconsForm");
  icForm.addEventListener("input", () => {
    const pad = Number(icForm.padding.value);
    $("#icPrev").style.padding = `${pad}%`;
    $("#icPadV").textContent = `${pad}%`;
    const n = icForm.querySelectorAll("input[name=size]:checked").length;
    $("#icCount").textContent = n ? plural(n, "icon") : "Pick a size";
  });
  $("#iconsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const sizes = [...form.querySelectorAll("input[name=size]:checked")].map((i) => Number(i.value));
    try {
      const { created } = await api("/api/studio/icons", { method: "POST", body: { asset: state.view.path, image, sizes, padding: Number(form.padding.value) / 100 } });
      closeDialog();
      toast(`Made ${created.length} icon${created.length === 1 ? "" : "s"}`);
      renderView();
    } catch (err) { toast(err.message, true); }
  });
}

// ---- engine export ----

function exportDialog(path) {
  const remembered = storeGet("forge.engine") || "godot";
  const ENGINES = [["godot", "Godot", "assets/…", "GLB"], ["unity", "Unity", "Assets/Art/…", "FBX + GLB"], ["unreal", "Unreal", "Content/Art/…", "FBX"]];
  openDialog(`<form class="dlg sheet compact" id="exportForm">
    ${sheetHead("box", "Export", path ? humanize(path.split("/").pop()) : "whole project", `A ZIP with the models, rigs, animations, icons and sprites, laid out for your engine's project folder.`)}
    <div class="sheet-body">
      ${optBlock("Engine", `<div class="opt-cards three">${ENGINES.map(([id, label, dir, fmt]) => `<label class="opt-card"><input type="radio" name="engine" value="${id}" ${id === remembered ? "checked" : ""}>
        <strong>${label}</strong><small><code>${dir}</code></small><em>${fmt}</em></label>`).join("")}</div>`)}
      ${optBlock("What's in it", `<div class="opt-chips static">${["Models", "Rigs", "Animations", "Textures", "Icons", "Sprites", "Parts", "Views"].map((k) => `<span class="opt-chip on">${k}</span>`).join("")}</div>`, `From <code>${esc(path || "every folder")}</code>, whatever each asset has.`)}
    </div>
    ${sheetFoot("Free · made on your computer", "download", "Download ZIP")}
  </form>`);
  $("#exportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const engine = event.target.engine.value;
    storeSet("forge.engine", engine);
    try {
      const res = await fetch(`/api/studio/export?project=${encodeURIComponent(state.project)}&engine=${engine}&path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Export failed");
      const name = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || `export-${engine}.zip`;
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()), download: name });
      link.click();
      URL.revokeObjectURL(link.href);
      closeDialog();
    } catch (err) { toast(err.message, true); }
  });
}

// ---- 3D models: drop, thumbnails, viewer, sprite sheets ----

// A model's own files (glTF buffers, OBJ materials, textures) travel with it, so they stay next to it.
const MODEL_SIDECAR_RE = /\.(bin|mtl|png|jpe?g|webp|tga|bmp)$/i;

// Models picked from the computer, with their textures, go onto the open asset (forge/ui/drops.js).
function uploadModels(files) {
  return dropFiles({ kind: "asset", path: state.view.path }, files);
}

function pickModelFile() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".glb,.gltf,.obj,.fbx,.bin,.mtl,.png,.jpg,.jpeg,.webp,.tga,.bmp", multiple: true });
  input.onchange = () => uploadModels(input.files);
  input.click();
}

const viewerModule = () => import("./viewer.js");
const thumbTried = new Set();

// Models without a preview get one rendered in the browser, once per session.
async function queueThumbs(asset) {
  const missing = [...(asset.outputs["3d"] || []), ...(asset.outputs.rig || []), ...(asset.outputs.animations || []).filter((o) => /\.glb$/i.test(o.path))]
    .filter((o) => o.type === "model" && !o.thumb && !/\.gltf$/i.test(o.path) && !thumbTried.has(o.path));
  if (!missing.length) return;
  missing.forEach((o) => thumbTried.add(o.path));
  let saved = 0;
  try {
    const viewer = await viewerModule();
    for (const o of missing) {
      try {
        const png = await viewer.renderThumb(fileUrl(o.path), 384);
        await api("/api/studio/thumb", { method: "POST", body: { model: o.path, png } });
        saved += 1;
      } catch { /* leave the placeholder */ }
    }
  } catch { return; }
  if (saved && state.view.path === asset.path && !state.view.editing) renderView();
}

// ---------- 3D theater: a model fills the window ----------
// Opens from the clicked card (the card's rectangle grows into the window), keeps all chrome floating over the
// model and lets it fade away while the pointer rests. Details (stats, placement, exports, sprite sheets) live in a
// drawer that only slides in on request. ← / → step through the other models on the page.

const TH_SVG = {
  turntable: `<path d="M4 12a8 3.5 0 1 0 16 0"/><path d="M20 12a8 3.5 0 0 0-13.5-2.5"/><path d="M6.5 7.2 6.4 9.6l2.4.3"/><path d="M12 3v6"/>`,
  frame: `<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.5"/>`,
  full: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`,
  shot: `<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2.5h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>`,
  info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  prev: `<path d="M15 5l-7 7 7 7"/>`,
  next: `<path d="M9 5l7 7-7 7"/>`,
  pause: `<path d="M8 5v14M16 5v14"/>`,
  light: `<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>`,
};
const thIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${TH_SVG[name] || ICON[name] || ""}</svg>`;
// Swatches for the light presets (two colours: key and rim) and the backdrop each one paints behind the model.
const TH_LOOKS = [
  ["studio", "Studio", "#e9eaf0", "#8f9bb8"],
  ["daylight", "Daylight", "#ffe2a8", "#8ec5ff"],
  ["sunset", "Sunset", "#ff9a52", "#ff4fa3"],
  ["neon", "Neon", "#ff3cac", "#2de2ff"],
  ["night", "Moonlight", "#9fb4ff", "#28305a"],
  ["spotlight", "Spotlight", "#fff6e8", "#141414"],
  ["unlit", "Unlit", "#ffffff", "#c9c9cf"],
];
const TH_DISPLAY = [["shaded", "Shaded"], ["clay", "Clay"], ["wire", "Wire"], ["normals", "Normals"]];
const TH_CAMS = [["front", "Front"], ["side", "Side"], ["top", "Top"], ["iso", "¾"]];
const TH_SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const TH_LOOPS = [["loop", "Loop"], ["once", "Once"], ["pingpong", "Ping-pong"]];

const viewerPrefs = () => { try { return JSON.parse(localStorage.getItem("tessera.viewer") || "{}"); } catch { return {}; } };
const saveViewerPrefs = (prefs) => { try { localStorage.setItem("tessera.viewer", JSON.stringify(prefs)); } catch { /* private window */ } };

let theater = null;

async function viewModel(path, focusSprites = false, from = null) {
  const list = [...new Set([...document.querySelectorAll("#content [data-view-model]")].map((el) => el.dataset.viewModel))];
  const models = list.includes(path) ? list : [path];
  const prefs = viewerPrefs();
  const look = TH_LOOKS.some(([k]) => k === prefs.look) ? prefs.look : "studio";
  openDialog(`<div class="theater" id="theater" data-look="${look}">
    <div class="th-stage" id="viewerStage"></div>
    <div class="th-vignette"></div>
    <div class="th-loading" id="thLoading"><span class="th-ring"></span><span>Loading model</span></div>
    <header class="th-top th-chrome">
      <div class="th-title"><h2 id="thName"></h2><div class="th-meta" id="thMeta"></div></div>
      <div class="th-actions">
        ${models.length > 1 ? `<div class="th-nav"><button type="button" class="th-btn" data-th="prev" title="Previous model (←)">${thIcon("prev")}</button><span id="thCount"></span><button type="button" class="th-btn" data-th="next" title="Next model (→)">${thIcon("next")}</button></div>` : ""}
        <button type="button" class="th-btn" data-th="shot" title="Screenshot, transparent PNG (P)">${thIcon("shot")}</button>
        <button type="button" class="th-btn" data-th="full" title="Full screen">${thIcon("full")}</button>
        <button type="button" class="th-btn" data-th="info" title="Details, placement and exports (I)">${thIcon("info")}</button>
        <button type="button" class="th-btn th-close" data-th="close" title="Close (Esc)">${thIcon("close")}</button>
      </div>
    </header>
    <div class="th-bottom th-chrome">
      <div class="th-anim" id="viewerTime" hidden></div>
      <div class="th-dock" id="thDock"></div>
    </div>
    <aside class="th-drawer" id="thDrawer"><div class="th-drawer-head"><b>Details</b><button type="button" class="th-btn" data-th="info" title="Close (I)">${thIcon("close")}</button></div><div class="viewer-side" id="viewerSide"></div></aside>
    <div class="th-toast" id="thToast"></div>
    <div class="th-flash" id="thFlash"></div>
  </div>`);
  const dlg = $("#dialog");
  const root = $("#theater");
  const th = theater = { root, dlg, models, index: models.indexOf(path), path, view: null, prefs, look, offs: [], closed: false, from, drawer: focusSprites, bare: false };
  morphOpen(dlg, from);
  root.classList.toggle("drawer-open", th.drawer);

  // Closing plays the open in reverse back into the card it came from, when that card is still on the page.
  const cancel = (event) => { event.preventDefault(); closeTheater(); };
  dlg.addEventListener("cancel", cancel);
  dlg.addEventListener("close", () => {
    th.closed = true;
    dlg.removeEventListener("cancel", cancel);
    th.offs.splice(0).forEach((off) => off());
    th.view?.dispose();
    document.removeEventListener("keydown", keys, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (theater === th) theater = null;
  }, { once: true });

  root.addEventListener("click", (event) => {
    const b = event.target.closest("[data-th]");
    if (!b) return;
    const act = b.dataset.th;
    if (act === "close") closeTheater();
    if (act === "prev" || act === "next") stepModel(act === "next" ? 1 : -1);
    if (act === "shot") shoot();
    if (act === "info") toggleDrawer();
    if (act === "full") {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else dlg.requestFullscreen?.().catch(() => toast("Full screen isn't available here", true));
    }
  });

  // The chrome steps aside while the pointer rests over the model, and comes back when it moves.
  let idleTimer = 0;
  const wake = () => {
    root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (th.drawer || root.querySelector(".th-chrome:hover") || root.matches(".scrubbing")) return wake();
      root.classList.add("idle");
    }, 2600);
  };
  root.addEventListener("pointermove", wake);
  root.addEventListener("pointerdown", wake);
  th.offs.push(() => clearTimeout(idleTimer));
  wake();

  const keys = (event) => {
    if (!theater || theater !== th || event.target.closest?.("input, textarea, select") || event.ctrlKey || event.metaKey || event.altKey) return;
    const k = event.key.toLowerCase();
    const view = th.view;
    const hit = () => { event.preventDefault(); event.stopPropagation(); wake(); };
    if (k === "arrowright" && models.length > 1) { hit(); stepModel(1); }
    else if (k === "arrowleft" && models.length > 1) { hit(); stepModel(-1); }
    else if (k === "i") { hit(); toggleDrawer(); }
    else if (k === "h") { hit(); th.bare = !th.bare; root.classList.toggle("bare", th.bare); thToast(th.bare ? "Interface hidden · H to bring it back" : ""); }
    else if (k === "p") { hit(); shoot(); }
    else if (!view) return;
    else if (k === "f") { hit(); view.frame(); }
    else if (k === "t") { hit(); setTurntable(!view.turntable); }
    else if (k === "l") { hit(); const i = TH_LOOKS.findIndex(([n]) => n === th.look); setLook(TH_LOOKS[(i + (event.shiftKey ? -1 : 1) + TH_LOOKS.length) % TH_LOOKS.length][0]); }
    else if (k === "g") { hit(); root.querySelector('[data-thv="grid"]')?.click(); }
    else if (k === "b") { hit(); root.querySelector('[data-thv="skel"]')?.click(); }
    else if (["1", "2", "3", "4"].includes(k)) { hit(); view.view(TH_CAMS[Number(k) - 1][0]); }
    else if (k === " " && view.duration) { hit(); view.pause(view.playing); paintPlay(); }
    else if ((k === "," || k === ".") && view.duration) { hit(); view.step(k === "," ? -1 : 1); paintPlay(); }
    else if ((k === "[" || k === "]") && view.clips.length > 1) { hit(); playClip((view.clipIndex + (k === "]" ? 1 : -1) + view.clips.length) % view.clips.length); }
  };
  document.addEventListener("keydown", keys, true);

  function toggleDrawer(on = !th.drawer) { th.drawer = on; root.classList.toggle("drawer-open", on); th.view?.placement.setShown(on); wake(); }
  function setTurntable(on) { th.view?.setTurntable(on); th.prefs.turntable = on; saveViewerPrefs(th.prefs); }
  function setLook(name) {
    th.look = name;
    root.dataset.look = name;
    th.view?.setLook(name);
    th.prefs.look = name; saveViewerPrefs(th.prefs);
    root.querySelectorAll("[data-look-pick]").forEach((b) => b.classList.toggle("on", b.dataset.lookPick === name));
    const label = root.querySelector(".th-look-name");
    if (label) label.textContent = TH_LOOKS.find(([n]) => n === name)[1];
  }
  function shoot() {
    if (!th.view) return;
    const flash = $("#thFlash");
    flash.classList.remove("go"); void flash.offsetWidth; flash.classList.add("go");
    const a = Object.assign(document.createElement("a"), { href: th.view.screenshot(true), download: `${th.path.split("/").pop().replace(/\.[^.]+$/, "")}.png` });
    a.click();
    thToast("Screenshot saved");
  }
  function stepModel(dir) {
    if (models.length < 2) return;
    th.index = (th.index + dir + models.length) % models.length;
    th.from = document.querySelector(`#content [data-view-model="${CSS.escape(models[th.index])}"]`)?.closest(".out, .vault-thumb, .hero-3d") || null;
    load(models[th.index], dir);
  }
  function playClip(i) {
    th.view.play(i);
    root.querySelectorAll("[data-clip]").forEach((c) => c.classList.toggle("on", Number(c.dataset.clip) === i));
    root.querySelector(`[data-clip="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    renderTheaterTimeline(th);
  }
  function paintPlay() { paintTheaterPlay(th); }
  th.playClip = playClip;
  th.setLook = setLook;
  th.setTurntable = setTurntable;

  async function load(p, dir = 0) {
    th.path = p;
    th.offs.splice(0).forEach((off) => off());
    const stage = $("#viewerStage");
    if (th.view) {
      stage.classList.add(dir < 0 ? "leave-right" : "leave-left");
      await new Promise((done) => setTimeout(done, 180));
      if (th.path !== p || th.closed) return;
      th.view.dispose();
      th.view = null;
    }
    stage.className = "th-stage";
    stage.innerHTML = "";
    root.classList.add("loading");
    root.classList.remove("ready");
    $("#thName").textContent = p.split("/").pop();
    $("#thMeta").textContent = "";
    if ($("#thCount")) $("#thCount").textContent = `${th.index + 1} / ${models.length}`;
    $("#viewerTime").hidden = true;
    $("#thDock").innerHTML = "";
    $("#viewerSide").innerHTML = "";
    let view, viewer;
    try {
      viewer = await viewerModule();
      view = await viewer.createViewer(stage, fileUrl(p), { distance: 1.35 });
    } catch (err) {
      if (th.path === p && !th.closed) { root.classList.remove("loading"); root.classList.add("failed"); $("#thLoading").innerHTML = `<span>Could not open this model: ${esc(err.message)}</span>`; }
      return;
    }
    if (th.path !== p || th.closed) { view.dispose(); return; }
    root.classList.remove("failed");
    $("#thLoading").innerHTML = `<span class="th-ring"></span><span>Loading model</span>`;
    th.view = view;
    if (dir) stage.classList.add(dir < 0 ? "enter-left" : "enter-right");
    state.viewerAsset = state.view.type === "doc" ? await api(`/api/studio/asset?path=${encodeURIComponent(state.view.path)}`).catch(() => null) : null;
    if (th.path !== p || th.closed) return;
    state.viewer = { path: p, view, viewer, sheet: null };
    view.setLook(th.look, true);
    view.placement.setShown(th.drawer);
    view.setTurntable(th.prefs.turntable === true);
    view.setGrid(th.prefs.grid === true);
    th.offs.push(view.onTurntable((on) => root.querySelector('[data-thv="turn"]')?.classList.toggle("on", on)));
    th.offs.push(view.onLight((deg, dragging) => thToast(`${thIcon("light")} Light ${Math.round(deg)}°`, dragging ? 0 : 700)));
    const { stats, clips } = view;
    $("#thMeta").innerHTML = [`${stats.triangles.toLocaleString()} tris`, stats.bones ? `${stats.bones} bones` : "", clips.length ? `${clips.length} clip${clips.length === 1 ? "" : "s"}` : "", `<span id="viewerBytes"></span>`].filter(Boolean).join("<i>·</i>");
    fetch(fileUrl(p), { method: "HEAD" }).then((r) => { const n = Number(r.headers.get("content-length")); const el = $("#viewerBytes"); if (el && n) el.textContent = fmtBytes(n); }).catch(() => {});
    renderTheaterDock(th);
    renderTheaterSide(th, p, focusSprites);
    focusSprites = false;
    if (clips.length) playClip(0); else renderTheaterTimeline(th);
    root.classList.remove("loading");
    root.classList.add("ready");
    const seen = Number(th.prefs.hints || 0);
    if (seen < 3) { th.prefs.hints = seen + 1; saveViewerPrefs(th.prefs); thToast("Drag to orbit · Scroll to zoom · <b>Shift</b>-drag to turn the light", 3600); }
  }
  th.load = load;
  await load(path);
}

function closeTheater() {
  const th = theater;
  if (!th || th.closing) return;
  th.closing = true;
  const dlg = th.dlg;
  const from = th.from && th.from.isConnected ? th.from : null;
  const r = from?.getBoundingClientRect();
  const visible = r && r.width > 8 && r.bottom > 0 && r.top < innerHeight;
  th.root.classList.add("closing");
  const anim = visible
    ? dlg.animate([{ clipPath: "inset(0px 0px 0px 0px round 0px)" }, { clipPath: insetOf(r) }], { duration: 380, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" })
    : dlg.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.985)" }], { duration: 200, easing: "ease-in", fill: "forwards" });
  anim.finished.catch(() => {}).then(() => { dlg.close(); anim.cancel(); });
}

const insetOf = (r) => `inset(${Math.max(0, r.top)}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${Math.max(0, r.left)}px round 16px)`;

function morphOpen(dlg, from) {
  const r = from?.getBoundingClientRect?.();
  if (r && r.width > 8) dlg.animate([{ clipPath: insetOf(r) }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
  else dlg.animate([{ opacity: 0, transform: "scale(1.015)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
}

let thToastTimer = 0;
function thToast(html, ms = 1800) {
  const el = $("#thToast");
  if (!el) return;
  clearTimeout(thToastTimer);
  if (!html) { el.classList.remove("on"); return; }
  el.innerHTML = html;
  el.classList.add("on");
  if (ms) thToastTimer = setTimeout(() => el.classList.remove("on"), ms);
}

function renderTheaterDock(th) {
  const view = th.view;
  const dock = $("#thDock");
  const lookName = TH_LOOKS.find(([n]) => n === th.look)?.[1] || "Studio";
  dock.innerHTML = `
    <div class="th-group th-looks" title="Lighting (L)">
      ${TH_LOOKS.map(([n, label, a, b]) => `<button type="button" class="th-swatch${n === th.look ? " on" : ""}" data-look-pick="${n}" title="${label}" style="--a:${a};--b:${b}"></button>`).join("")}
      <span class="th-look-name">${lookName}</span>
    </div>
    <span class="th-sep"></span>
    <div class="th-group th-seg" data-thseg="display">${TH_DISPLAY.map(([v, l], i) => `<button type="button" data-v="${v}" class="${i === 0 ? "on" : ""}">${l}</button>`).join("")}</div>
    <span class="th-sep"></span>
    <div class="th-group">
      <button type="button" class="th-tog${view.turntable ? " on" : ""}" data-thv="turn" title="Turntable (T)">${thIcon("turntable")}</button>
      ${view.bones.length ? `<button type="button" class="th-tog" data-thv="skel" title="Skeleton (B)">${icon("bones")}</button>` : ""}
      <button type="button" class="th-tog${th.prefs.grid === true ? " on" : ""}" data-thv="grid" title="Floor grid (G)">${icon("grid")}</button>
    </div>
    <span class="th-sep"></span>
    <div class="th-group th-seg" data-thseg="cam">${TH_CAMS.map(([v, l], i) => `<button type="button" data-v="${v}" title="${l === "¾" ? "Three-quarter" : l} view (${i + 1})">${l}</button>`).join("")}</div>
    <button type="button" class="th-tog" data-thv="frame" title="Frame the model (F)">${thIcon("frame")}</button>`;
  dock.onclick = (event) => {
    const b = event.target.closest("button");
    if (!b) return;
    if (b.dataset.lookPick) return th.setLook(b.dataset.lookPick);
    const seg = b.closest("[data-thseg]")?.dataset.thseg;
    if (seg === "display") { b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); view.setDisplay(b.dataset.v); return; }
    if (seg === "cam") { b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); setTimeout(() => b.classList.remove("on"), 900); view.view(b.dataset.v); return; }
    const v = b.dataset.thv;
    if (v === "turn") th.setTurntable(!view.turntable);
    if (v === "skel") { b.classList.toggle("on"); view.setSkeleton(b.classList.contains("on")); }
    if (v === "grid") { b.classList.toggle("on"); th.prefs.grid = b.classList.contains("on"); view.setGrid(th.prefs.grid); saveViewerPrefs(th.prefs); }
    if (v === "frame") view.frame();
  };
}

function renderTheaterSide(th, path, focusSprites) {
  const view = th.view;
  const { stats, clips } = view;
  const clipOptions = (sel) => `<option value="-1" ${sel === -1 ? "selected" : ""}>No animation</option>${clips.map((c, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(c)}</option>`).join("")}`;
  $("#viewerSide").innerHTML = `
    ${viewerWarnings(stats)}<div class="viewer-stats"><span><b>${stats.triangles.toLocaleString()}</b> triangles</span><span><b>${stats.meshes}</b> meshes</span><span><b>${stats.materials}</b> materials</span><span><b>${stats.textures}</b> textures</span><span><b>${stats.bones}</b> bones</span><span><b>${clips.length}</b> clips</span><span><b>${[stats.size.x, stats.size.y, stats.size.z].map((n) => n.toFixed(2)).join(" × ")}</b> units</span></div>
    ${state.view.type === "doc" ? `<label class="field-label" for="viewerHeight">Height in the game</label>
    <div class="height-row"><input id="viewerHeight" type="number" min="0.05" max="200" step="0.05" value="${esc(state.viewerAsset?.meta?.height_m || "")}" placeholder="${esc(String(defaultHeight(state.viewerAsset)))}"><span>m</span><button type="button" class="ghost" data-height-save>Save</button><button type="button" class="link-btn" data-lineup>Compare in lineup</button></div>
    <p class="hint-line">The grey figure beside it is a 1.8 m person.</p>
    <div id="viewerPlacement"></div>` : ""}
    <div class="field-label">Download as</div>
    <div class="fmt-links export-row"><a href="${esc(fileUrl(path))}" download>${esc(path.split(".").pop().toUpperCase())}</a>${["obj", "stl", "usdz"].filter((f) => !path.toLowerCase().endsWith(`.${f}`)).map((f) => `<button type="button" class="link-btn" data-viewer-export="${f}" title="Converted in your browser">${f.toUpperCase()}</button>`).join("")}</div>
    ${view.bones.length ? `<details class="bone-tree"><summary>${icon("bones")} Skeleton · ${view.bones.length} bones</summary><ul>${view.bones.map((b) => `<li style="padding-left:${6 + Math.min(b.depth, 12) * 10}px" data-bone="${esc(b.name)}">${esc(b.name)}</li>`).join("")}</ul></details>` : ""}
    <button type="button" class="ghost" data-viewer-thumb>${icon("eye")} Use this view as preview</button>
    <details class="sprite-box" ${focusSprites ? "open" : ""}><summary>${icon("grid")} Sprite sheet</summary>
      <div class="sprite-form">
        <label>Animation<select id="spClip">${clipOptions(clips.length ? 0 : -1)}</select></label>
        <label>Directions<select id="spDirs"><option>1</option><option>4</option><option selected>8</option></select></label>
        <label>Frames<select id="spFrames">${[4, 6, 8, 12, 16, 24].map((n) => `<option ${n === 8 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>Frame size<select id="spSize">${[64, 96, 128, 256].map((n) => `<option ${n === 128 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>Camera<select id="spAngle"><option value="iso">Isometric</option><option value="side">Side</option><option value="front">Front</option><option value="top">Top-down</option></select></label>
      </div>
      <button type="button" class="primary" data-sprite-render>Render sheet</button>
      <div id="spriteOut"></div>
    </details>`;
  const side = $("#viewerSide");
  side.onpointerover = (e) => { const li = e.target.closest("[data-bone]"); view.highlightBone(li ? li.dataset.bone : ""); };
  side.onpointerleave = () => view.highlightBone("");
  if (state.view.type === "doc" && state.viewerAsset) setupPlacement(path, view).catch(() => {});
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

function renderTheaterTimeline(th) {
  const view = th.view;
  const host = $("#viewerTime");
  if (!host || !view) return;
  th.timeOff?.();
  host.hidden = !view.clips.length;
  if (!view.clips.length) return;
  const current = view.clipIndex;
  const speed = th.speed || 1;
  const loop = th.loop || "loop";
  host.innerHTML = `
    ${view.clips.length > 1 ? `<div class="th-clips" title="Animations ([ and ])">${view.clips.map((c, i) => `<button type="button" class="th-clip${i === current ? " on" : ""}" data-clip="${i}">${esc(c.replace(/^.*\|/, ""))}</button>`).join("")}</div>` : `<div class="th-clips"><span class="th-clip on solo">${esc(view.clips[0].replace(/^.*\|/, ""))}</span></div>`}
    <div class="th-track">
      <button type="button" class="th-play" data-tl="play" title="Play / pause (Space)">${icon("play")}</button>
      <div class="th-scrub"><div class="th-fill"></div><input type="range" min="0" max="${view.duration || 1}" step="0.001" value="0" aria-label="Time"></div>
      <span class="th-time"><b>0:00.00</b> / ${fmtTime(view.duration)}</span>
      <button type="button" class="th-chip" data-tl="speed" title="Speed">${speed}×</button>
      <button type="button" class="th-chip" data-tl="loop" title="Loop mode">${TH_LOOPS.find(([v]) => v === loop)[1]}</button>
      <button type="button" class="th-chip${th.inPlace ? " on" : ""}" data-tl="inplace" title="Hold the root still (strip root motion)">In place</button>
    </div>`;
  const scrub = host.querySelector("input");
  const fill = host.querySelector(".th-fill");
  const timeEl = host.querySelector(".th-time b");
  let dragging = false;
  const paint = (time, duration) => {
    const f = duration ? time / duration : 0;
    fill.style.transform = `scaleX(${f})`;
    timeEl.textContent = fmtTime(time);
  };
  scrub.addEventListener("pointerdown", () => { dragging = true; th.root.classList.add("scrubbing"); view.pause(true); paintTheaterPlay(th); });
  const release = () => { dragging = false; th.root.classList.remove("scrubbing"); };
  scrub.addEventListener("pointerup", release);
  scrub.addEventListener("pointercancel", release);
  scrub.addEventListener("input", () => { view.seek(Number(scrub.value)); paint(Number(scrub.value), view.duration); });
  host.onclick = (event) => {
    const clip = event.target.closest("[data-clip]");
    if (clip) return th.playClip(Number(clip.dataset.clip));
    const b = event.target.closest("[data-tl]");
    if (!b) return;
    if (b.dataset.tl === "play") { view.pause(view.playing); paintTheaterPlay(th); }
    if (b.dataset.tl === "speed") { th.speed = TH_SPEEDS[(TH_SPEEDS.indexOf(th.speed || 1) + 1) % TH_SPEEDS.length]; view.setSpeed(th.speed); b.textContent = `${th.speed}×`; }
    if (b.dataset.tl === "loop") { const i = (TH_LOOPS.findIndex(([v]) => v === (th.loop || "loop")) + 1) % TH_LOOPS.length; th.loop = TH_LOOPS[i][0]; view.setLoop(th.loop); b.textContent = TH_LOOPS[i][1]; }
    if (b.dataset.tl === "inplace") { th.inPlace = !th.inPlace; view.setInPlace(th.inPlace); b.classList.toggle("on", th.inPlace); }
  };
  view.setSpeed(speed);
  view.setLoop(loop);
  view.setInPlace(Boolean(th.inPlace));
  // The fill bar moves every frame (a transform, cheap); the numbers repaint ~15 times a second.
  let last = 0;
  th.timeOff = view.onTime((time, duration) => {
    if (dragging) return;
    fill.style.transform = `scaleX(${duration ? time / duration : 0})`;
    const now = performance.now();
    if (now - last < 66) return;
    last = now;
    scrub.value = String(time);
    timeEl.textContent = fmtTime(time);
  });
  th.offs.push(() => th.timeOff?.());
  paintTheaterPlay(th);
}

function paintTheaterPlay(th) {
  const play = th.root.querySelector('[data-tl="play"]');
  if (play) play.innerHTML = th.view?.playing ? thIcon("pause") : icon("play");
}

// The height a model gets when the user hasn't set one: the page's `size: w x h x d` line (as ASSETS.md reads it), else its kind's.
function defaultHeight(asset) {
  const m = /^\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)/i.exec(String(asset?.meta?.size || ""));
  return (m && Number(m[2]) > 0 ? Number(m[2]) : 0) || KIND_HEIGHT[asset?.kind] || 1;
}


function viewerWarnings(stats) {
  const budget = Number(state.overview?.bible?.polycount_budget || state.overview?.polycount_budget || 0);
  const warn = [];
  if (budget && stats.triangles > budget) warn.push(`Over the poly budget: ${stats.triangles.toLocaleString()} of ${budget.toLocaleString()} triangles.`);
  if (stats.bones && !stats.skinned) warn.push("Has bones but no skinned mesh: it won't deform when animated.");
  return warn.length ? `<div class="viewer-warn">${warn.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : "";
}

// Placement in the viewer: what the game needs to put the model in its world, checked by the user who can see it.
// Height drives the 1.8 m figure; the front arrow is set with one click; points are clicked on the model and named.
// Points belong to the asset's current 3D model (`points_for`), a rig shows the bones Tessera found, a clip says loop or once.
async function setupPlacement(path, view) {
  const host = $("#viewerPlacement");
  if (!host || !/\.(glb|gltf)$/i.test(path)) return;
  const info = await api(`/api/studio/model-info?path=${encodeURIComponent(path)}`);
  const asset = () => state.viewerAsset;
  const meta = () => asset()?.meta || {};
  const mainModel = () => (asset()?.outputs?.["3d"] || []).find((o) => o.type === "model")?.path || "";
  const role = /\/animations\//.test(path) ? "clip" : /\/rig\//.test(path) ? "rig" : /\/3d\//.test(path) ? "model" : "other";
  const save = async (fields, message) => {
    state.viewerAsset = await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields } });
    state.board = null;
    if (message) toast(message);
    draw();
  };
  const heightNow = () => Number($("#viewerHeight")?.value) || Number(meta().height_m) || defaultHeight(asset());
  const userPoints = () => (role === "model" && path === (meta().points_for || mainModel()) && meta().points && typeof meta().points === "object" ? meta().points : {});
  const allPoints = () => [
    ...Object.entries(info.auto_points || {}).map(([name, xyz]) => ({ name, xyz, type: "auto" })),
    ...Object.entries(info.bone_points || {}).map(([name, xyz]) => ({ name, xyz, type: "bone" })),
    ...Object.entries(userPoints()).map(([name, xyz]) => ({ name, xyz, type: "user" })),
  ];
  const fmt = (xyz) => xyz.map((v) => Number(v).toFixed(2)).join(", ");
  let selected = "";
  let snapStep = 0;
  const savePoint = async (name, xyz) => {
    if (!(name in userPoints())) return;
    await save({ points: { ...userPoints(), [name]: xyz }, points_for: path }).catch((err) => toast(err.message, true));
  };
  view.placement.onSelect((name, xyz, dragging) => {
    if (dragging) { // live numbers while the gizmo moves, without redrawing the panel
      host.querySelectorAll("[data-point-axis]").forEach((input) => { input.value = xyz[Number(input.dataset.pointAxis)].toFixed(3); });
      return;
    }
    if (name === selected) return;
    selected = name;
    draw(false);
  });
  view.placement.onMove((name, xyz) => savePoint(name, xyz));

  function draw(rebuild = true) {
    const front = meta().front || "";
    const loops = meta().anim_loops || {};
    const stem = path.split("/").pop().replace(/\.[^.]+$/, "");
    const loop = stem in loops ? loops[stem] : null;
    const points = allPoints();
    if (rebuild) {
      view.placement.setHeight(heightNow());
      view.placement.setFront(front || "+Z");
      view.placement.setPoints(points);
    }
    host.innerHTML = `
      ${role === "model" || role === "other" ? `<div class="field-label">Front</div>
      <div class="seg-row">${info.fronts.map((f) => `<button type="button" class="seg${(front || "+Z") === f ? " on" : ""}" data-front-set="${f}">${f}</button>`).join("")}</div>
      <p class="hint-line">${front ? `Checked: the front faces ${esc(front)}.` : `Not checked yet, so the game assumes +Z. If the pink arrow points out of the model's front, press <button type="button" class="link-btn" data-front-set="+Z">Looks right</button>.`}</p>` : ""}
      ${role === "clip" ? `<div class="field-label">This clip plays</div>
      <div class="seg-row"><button type="button" class="seg${loop === true ? " on" : ""}" data-loop-set="1">Loop</button><button type="button" class="seg${loop === false ? " on" : ""}" data-loop-set="0">Once</button></div>
      <p class="hint-line">${loop !== null ? "Set in Tessera." : info.loop_guess === null ? "Not set: the game can't tell from its name." : `Guessed from its name: ${info.loop_guess ? "loop" : "once"}. Press one to confirm.`}${info.clips?.[0]?.seconds ? ` ${info.clips[0].seconds} s long.` : ""}</p>` : ""}
      <div class="field-label">Points</div>
      <ul class="point-list">${points.map((p) => p.type === "user" ? `<li class="pt-user${selected === p.name ? " sel" : ""}"><button type="button" class="pt-pick" data-point-select="${esc(p.name)}" title="Select to move it"><span class="pt-dot"></span><b>${esc(p.name)}</b><code>${fmt(p.xyz)}</code></button><button type="button" class="icon-btn" data-point-remove="${esc(p.name)}" aria-label="Remove ${esc(p.name)}" title="Remove">✕</button></li>${selected === p.name ? `<li class="pt-edit"><div class="xyz">${["X", "Y", "Z"].map((axis, i) => `<label>${axis}<input type="number" step="0.01" data-point-axis="${i}" value="${Number(p.xyz[i]).toFixed(3)}"></label>`).join("")}</div>
        <div class="pt-tools"><label>Snap <select data-point-snap>${[["0", "Off"], ["0.01", "0.01"], ["0.05", "0.05"], ["0.1", "0.1"]].map(([v, l]) => `<option value="${v}"${String(snapStep) === v ? " selected" : ""}>${l}</option>`).join("")}</select></label><button type="button" class="link-btn" data-point-resurface>Place again by clicking</button><button type="button" class="link-btn" data-point-done>Done</button></div>
        <p class="hint-line">Drag the arrows on the model, or type numbers. Saved when you let go.</p></li>` : ""}` : `<li class="pt-${p.type}"><span class="pt-dot"></span><b>${esc(p.name)}</b><code>${fmt(p.xyz)}</code><small>${p.type === "bone" ? "rig bone" : "measured"}</small></li>`).join("")}</ul>
      ${role === "model" ? (path === mainModel() || !mainModel() ? `<div class="point-add"><input id="pointName" list="pointNames" placeholder="name, e.g. light" maxlength="32"><datalist id="pointNames">${info.point_names.map((n) => `<option value="${n}">`).join("")}</datalist><button type="button" class="ghost" data-point-add>Place on model</button></div>
      <p class="hint-line" id="pointHint">Name a point, press Place, then click the spot on the model (Esc cancels). The game gets it in the model's own units.</p>`
        : `<p class="hint-line">Points go on the asset's current model, ${esc(mainModel().split("/").pop())}. Open that one to place them.</p>`)
        : role === "rig" ? `<p class="hint-line">Rig points come from its bones, so they follow the skeleton.</p>` : ""}`;
  }

  host.addEventListener("click", async (event) => {
    const t = event.target.closest("[data-front-set],[data-loop-set],[data-point-add],[data-point-remove],[data-point-select],[data-point-done],[data-point-resurface]");
    if (!t) return;
    try {
      if (t.dataset.pointSelect) view.placement.selectPoint(selected === t.dataset.pointSelect ? "" : t.dataset.pointSelect);
      if (t.dataset.pointDone !== undefined) view.placement.selectPoint("");
      if (t.dataset.pointResurface !== undefined && selected) {
        const name = selected;
        t.textContent = "Click the model… (Esc cancels)";
        const xyz = await view.placement.pickPoint();
        if (xyz) await save({ points: { ...userPoints(), [name]: xyz }, points_for: path }, `Moved “${name}”`);
        else draw(false);
      }
      if (t.dataset.frontSet) await save({ front: t.dataset.frontSet }, `Front set to ${t.dataset.frontSet}`);
      if (t.dataset.loopSet) {
        const stem = path.split("/").pop().replace(/\.[^.]+$/, "");
        await save({ anim_loops: { ...(meta().anim_loops || {}), [stem]: t.dataset.loopSet === "1" } }, t.dataset.loopSet === "1" ? "Marked as a loop" : "Marked as playing once");
      }
      if (t.dataset.pointRemove) {
        const points = { ...userPoints() };
        delete points[t.dataset.pointRemove];
        await save({ points: Object.keys(points).length ? points : "", points_for: Object.keys(points).length ? path : "" }, `Removed ${t.dataset.pointRemove}`);
      }
      if (t.dataset.pointAdd !== undefined) {
        const name = ($("#pointName").value || "").trim().toLowerCase().replace(/\s+/g, "_");
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || ["ground", "top"].includes(name)) { toast("Give the point a short name first, like light or grip", true); $("#pointName").focus(); return; }
        $("#pointHint").textContent = `Click where “${name}” goes on the model. Esc cancels.`;
        t.disabled = true;
        const xyz = await view.placement.pickPoint();
        t.disabled = false;
        if (!xyz) { draw(); return; }
        await save({ points: { ...userPoints(), [name]: xyz }, points_for: path }, `Point “${name}” placed`);
      }
    } catch (err) { toast(err.message, true); }
  });
  host.addEventListener("change", (event) => {
    if (event.target.matches("[data-point-snap]")) { snapStep = Number(event.target.value); view.placement.setSnap(snapStep); return; }
    if (!event.target.matches("[data-point-axis]") || !selected) return;
    const xyz = [...host.querySelectorAll("[data-point-axis]")].map((input) => Number(input.value) || 0);
    view.placement.movePoint(selected, xyz);
    savePoint(selected, xyz);
  });
  $("#viewerHeight")?.addEventListener("input", () => view.placement.setHeight(heightNow()));
  draw();
}

async function renderSprites() {
  const v = state.viewer;
  const out = $("#spriteOut");
  out.innerHTML = `<p class="hint-line">Rendering…</p>`;
  try {
    v.sheet = await v.viewer.renderSpriteSheet(fileUrl(v.path), {
      clip: Number($("#spClip").value), directions: Number($("#spDirs").value), frames: Number($("#spFrames").value),
      size: Number($("#spSize").value), angle: $("#spAngle").value,
    });
    const m = v.sheet.meta;
    out.innerHTML = `<div class="sprite-preview checker"><img src="${v.sheet.dataUrl}" alt=""></div>
      <p class="hint-line">${m.columns}×${m.rows} frames of ${m.frame_width}px${m.fps ? ` · ${m.fps} fps` : ""}</p>
      <button type="button" class="primary" data-sprite-save>Save to asset</button>`;
  } catch (err) { out.innerHTML = `<p class="hint-line">${esc(err.message)}</p>`; }
}

async function saveSprites() {
  const v = state.viewer;
  const m = v.sheet.meta;
  const base = v.path.split("/").pop().replace(/\.[^.]+$/, "");
  try {
    await api("/api/studio/sprite", { method: "POST", body: { asset: state.view.path, name: `${base}-${m.clip ? m.clip.replace(/\W+/g, "-") : "turn"}-${m.directions}dir`, png: v.sheet.dataUrl, meta: m } });
    toast("Sprite sheet saved");
    closeDialog();
    renderView();
  } catch (err) { toast(err.message, true); }
}

// Outputs go to the workspace's .trash/ (models with every format and their preview), with Undo in the toast.
async function removeOutput(path, card) {
  const asset = state.view.path;
  card?.classList.add("leaving");
  try {
    const res = await api(`/api/studio/output?path=${encodeURIComponent(asset)}&output=${encodeURIComponent(path)}`, { method: "DELETE" });
    toast(`Moved ${path.split("/").pop()} to trash`, false, {
      label: "Undo",
      async run() {
        try {
          await api("/api/studio/output/restore", { method: "POST", body: { moves: res.removed } });
          if (res.was_winner) await api("/api/studio/asset", { method: "PATCH", body: { path: asset, fields: { winner: path } } });
          toast("Restored");
          renderView();
        } catch (err) { toast(err.message, true); }
      },
    });
    renderView();
  } catch (err) { card?.classList.remove("leaving"); toast(err.message, true); }
}

// Copy the exact prompt and the ticked reference images, to paste into a chat app or image tool by hand
// instead of paying for an API run. Text, HTML (prompt + images) and one PNG sheet of the images go on the
// clipboard together, so the target app picks what it understands.
async function copyRequest(btn) {
  syncPreviewFields();
  const p = state.preview;
  const refs = p.references.filter((r) => r.on);
  const text = p.prompt.trim();
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Copying…";
  // The ClipboardItem is made right away with promises for its parts: browsers (Safari above all) only allow
  // the write during the click itself, and the images are still loading at that point.
  const loaded = Promise.all(refs.map((r) => loadImage(fileUrl(r.path)).catch(() => null))).then((list) => list.filter(Boolean));
  const html = loaded.then((images) => new Blob([`<p>${esc(text).replace(/\n/g, "<br>")}</p>${images.map((img) => `<img src="${imageDataUrl(img, 1024)}">`).join("")}`], { type: "text/html" }));
  const item = { "text/plain": new Blob([text], { type: "text/plain" }) };
  if (refs.length) {
    item["text/html"] = html;
    item["image/png"] = loaded.then((images) => (images.length ? imageSheet(images) : Promise.reject(new Error("The images could not be loaded."))));
  }
  try {
    let count = 0;
    try {
      await navigator.clipboard.write([new ClipboardItem(item)]);
      count = (await loaded).length;
    } catch {
      await navigator.clipboard.writeText(text); // some browsers take only plain text
    }
    toast(count ? `Copied the prompt and ${count} image${count === 1 ? "" : "s"}` : refs.length ? "Copied the prompt only: this browser would not take the images" : "Copied the prompt");
  } catch (err) { toast(`Could not copy: ${err.message}`, true); }
  btn.disabled = false;
  btn.innerHTML = label;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

function imageDataUrl(img, max) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

// Every reference side by side in one PNG, since the clipboard holds a single image.
function imageSheet(images) {
  const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (images.length === 1) {
    const img = images[0];
    const scale = Math.min(1, 1536 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return toBlob(canvas);
  }
  const cell = 768;
  const gap = 16;
  const cols = Math.min(images.length, 3);
  const rows = Math.ceil(images.length / cols);
  const canvas = Object.assign(document.createElement("canvas"), { width: cols * cell + (cols - 1) * gap, height: rows * cell + (rows - 1) * gap });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((img, i) => {
    const scale = Math.min(cell / img.naturalWidth, cell / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (i % cols) * (cell + gap) + (cell - w) / 2, Math.floor(i / cols) * (cell + gap) + (cell - h) / 2, w, h);
  });
  return toBlob(canvas);
}

async function saveViewerThumb() {
  const v = state.viewer;
  try {
    await api("/api/studio/thumb", { method: "POST", body: { model: v.path, png: v.view.still() } });
    toast("Preview updated");
    renderView();
  } catch (err) { toast(err.message, true); }
}

document.addEventListener("click", (event) => {
  const t = event.target.closest("[data-remove-output],[data-copy-request],[data-dismiss-job],[data-view-model],[data-sprites],[data-split],[data-sheet-cut],[data-split-body],[data-split-remove],[data-split-auto],[data-split-run],[data-icons],[data-export],[data-anim],[data-viewer-thumb],[data-sprite-render],[data-sprite-save]");
  if (!t || t.disabled) return;
  if (t.dataset.removeOutput) { event.preventDefault(); event.stopPropagation(); return removeOutput(t.dataset.removeOutput, t.closest(".out, .file-chip-wrap")); }
  if (t.dataset.copyRequest !== undefined) return copyRequest(t);
  if (t.dataset.dismissJob) { storeSet("forge.dismissedJobs", JSON.stringify([...dismissedJobs(), t.dataset.dismissJob].slice(-100))); return renderView(); }
  if (t.dataset.viewModel) return viewModel(t.dataset.viewModel, false, t.closest(".hero-3d, .out, .vault-thumb") || t);
  if (t.dataset.sprites) return viewModel(t.dataset.sprites, true, t.closest(".out") || t);
  if (t.dataset.split) return splitDialog(t.dataset.split);
  if (t.dataset.sheetCut) return splitDialog(t.dataset.sheetCut, true);
  if (t.dataset.splitRemove) { syncSplitNames(); state.split.boxes.splice(Number(t.dataset.splitRemove), 1); return renderSplit(); }
  if (t.dataset.splitAuto !== undefined) { state.split.boxes = []; return splitDialog(state.split.image); }
  if (t.dataset.splitRun !== undefined) return runSplit();
  if (t.dataset.splitBody !== undefined) return guessBodyParts();
  if (t.dataset.icons) return iconsDialog(t.dataset.icons);
  if (t.dataset.export !== undefined) return exportDialog(t.dataset.export);
  if (t.dataset.anim) {
    const p = state.preview;
    const id = p.engine === "tripo" ? t.dataset.anim : Number(t.dataset.anim); // Tripo's are named presets, Meshy's are numbered
    if (p.picked.includes(id)) p.picked = p.picked.filter((x) => x !== id);
    else if (p.picked.length < 10) p.picked.push(id);
    else toast("Up to 10 animations per run.", true);
    return renderAnimateSheet();
  }
  if (t.dataset.viewerThumb !== undefined) return saveViewerThumb();
  if (t.dataset.spriteRender !== undefined) return renderSprites();
  if (t.dataset.spriteSave !== undefined) return saveSprites();
});

// ---------- mobile ----------

// Older code asks for "chat" or "workspace": the chat opens, or on a phone its sheet makes way for the page.
function showPanel(which, onlyIfMobile = false) {
  if (onlyIfMobile && !shell.isMobile()) return;
  if (which === "chat") shell.openChat(false);
  else if (shell.isMobile() && shell.chatShown()) shell.closeChat();
}

// ---------- live updates ----------

function connectSocket() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  let pending;
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "agent_progress" && msg.project === state.project) chatProgress(msg);
    if (msg.type === "models_changed") loadModels().then(refreshModelViews);
    if (msg.type === "model_inbox") {
      toast(`✓ Added ${msg.assets.map((a) => humanize(a.split("/").pop().replace(/\.md$/, ""))).join(", ")} to ${humanize(msg.project)}`);
      if (msg.project === state.project) renderMissingThumbs(msg.project).catch(() => {});
      if (!$("#settingsView").hidden && state.settings?.tab === "accounts") renderSettings();
    }
    if (msg.type === "flow_run" && msg.project === state.project) flowsLoaded?.onRun(msg);
    if (msg.type === "service_connected") loadServices().then(() => serviceConnected(msg.service));
    // A cover being painted for another project shows on its card as soon as it lands.
    if (msg.type === "studio_job" && msg.job.status === "done" && !$("#projectsView").hidden) openProjects();
    if (msg.type === "studio_job" && msg.job.status === "failed") state.credits = null; // may have been "out of credits"
    if (msg.type === "studio_job" && msg.project === state.project) {
      const known = state.jobs[msg.job.id];
      state.jobs[msg.job.id] = msg.job;
      const name = humanize((msg.job.asset || "").split("/").pop() || "");
      if (msg.job.status === "failed") toast(`${jobLabel(msg.job) || "Job"} failed${msg.job.batch ? ` (${name})` : ""}: ${msg.job.error}`, true);
      else if (msg.job.status === "done" && known?.status !== "done") {
        if (msg.job.sprite) spriteJobDone(msg.job);
        if (msg.job.pixel || (msg.job.status !== "running" && state.view.type === "pixel" && $("#pxHome"))) pixelJobDone(msg.job);
        if (msg.job.sprite_error) toast(`The picture is saved, but it couldn't be turned into sprites: ${msg.job.sprite_error}`, true);
        toast(msg.job.batch ? `${name} is ready to pick` : `${jobLabel(msg.job) || "Job"} finished`);
      }
      renderJobDock();
      if (state.view.path === msg.job.asset && !state.view.editing) renderView();
      else if (msg.job.status === "done" && ["board", "home"].includes(state.view.type)) renderView();
      else if (state.view.type === "pipeline") paintPipeline();
    }
    if (msg.type === "workspace_changed" && (!msg.project || msg.project === state.project)) { state.palette = null; state.board = null; }
    if (msg.type === "workspace_changed" && (!msg.project || msg.project === state.project) && !state.view.editing) {
      clearTimeout(pending);
      pending = setTimeout(loadOverview, 250);
    }
  };
  ws.onclose = () => setTimeout(connectSocket, 3000);
}

// ---------- events ----------

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-ob-cancel],[data-compact-now],[data-pick-winner-file],[data-scroll-candidates],[data-bible-toggle],[data-bible-view],[data-fav-model],[data-model-tab],[data-service-connect],[data-service-disconnect],[data-pick-model],[data-pick-effort],[data-close-settings],[data-settings-tab],[data-add-preset],[data-cancel-add],[data-probe],[data-save-endpoint],[data-pick-check],[data-test-model],[data-remove-endpoint],[data-cli-logout],[data-cli-login],[data-new-project],[data-delete-project],[data-open-project],[data-ob-skip],[data-ob-game],[data-ob-path],[data-ob-nogame],[data-ob-hasgame],[data-ob-home],[data-ob-home-reset],[data-ob-blank],[data-ob-restart],[data-ob-next],[data-ob-back],[data-ob-forge],[data-ob-enter],[data-ob-dim],[data-ob-chip],[data-make-pillar],[data-style-text],[data-remove-style],[data-remove-pillar],[data-toc],[data-upload],[data-new-asset],[data-new-folder],[data-to-folder],[data-make-asset],[data-action],[data-winner],[data-ref],[data-add-ref],[data-pick-ref],[data-upload-ref],[data-close-picker],[data-rebuild],[data-run],[data-open],[data-folder],[data-home],[data-vault],[data-levels],[data-vault-filter],[data-vault-zip],[data-vault-folder],[data-poly],[data-session],[data-delete],[data-suggest],[data-unattach],[data-settings],[data-close],[data-edit],[data-cancel-edit],[data-save],#newChatBtn,[data-show]");
  if (!t || event.target.closest("[data-st-export],[data-imp-use],[data-key-art]")) return;
  if (t.dataset.delete) { event.stopPropagation(); return deleteChat(t.dataset.delete); }
  if (t.dataset.chatStop !== undefined) return api(`/api/agent/sessions/${state.sessionId}/stop`, { method: "POST" }).catch((err) => toast(err.message, true));
  if (t.dataset.upload) return uploadTo(t.dataset.upload);
  if (t.dataset.newAsset !== undefined) return newAssetDialog(t.dataset.newAsset);
  if (t.dataset.toc) { event.preventDefault(); return document.getElementById(t.dataset.toc)?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  if (t.dataset.obCancel !== undefined) return cancelOnboarding();
  if (t.dataset.scrollCandidates !== undefined) return $("#out-candidates")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (t.dataset.pickWinnerFile !== undefined) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => addCandidateImages(input.files);
    return input.click();
  }
  if (t.dataset.compactNow !== undefined) {
    try { state.session = await api(`/api/agent/sessions/${state.sessionId}/compact`, { method: "POST" }); toast("Chat compacted"); renderMessages(); } catch (err) { toast(err.message, true); }
    return;
  }
  if (t.dataset.bibleToggle !== undefined) { if (event.target.tagName !== "INPUT") return; syncPreviewFields(); state.preview.use_bible = event.target.checked; applyBible(state.preview); return renderPreview(); }
  if (t.dataset.bibleView !== undefined) { syncPreviewFields(); state.preview.showBible = !state.preview.showBible; return renderPreview(); }
  if (t.dataset.serviceDisconnect) {
    event.stopImmediatePropagation();
    try { state.services = (await api(`/api/services/${t.dataset.serviceDisconnect}`, { method: "DELETE" })).services; toast("Signed out"); } catch (err) { toast(err.message, true); }
    return renderServiceCards();
  }
  if (t.dataset.serviceConnect) return connectService(t.dataset.serviceConnect);
  if (t.dataset.favModel) { event.stopImmediatePropagation(); return toggleFavorite(t.dataset.favModel); }
  if (t.dataset.modelTab) { event.stopImmediatePropagation(); state.modelTab = t.dataset.modelTab; return renderModelPop(); }
  if (t.dataset.pickModel) return pickModel(t.dataset.pickModel);
  if (t.dataset.pickEffort) return pickEffort(t.dataset.pickEffort);
  if (t.dataset.closeSettings !== undefined) return closeSettings();
  if (t.dataset.settingsTab) { state.settings.tab = t.dataset.settingsTab; state.settings.adding = null; return renderSettings(); }
  if (t.dataset.addPreset) { state.settings.adding = { preset: t.dataset.addPreset, picked: [] }; return renderSettings(); }
  if (t.dataset.cancelAdd !== undefined) { state.settings.adding = null; return renderSettings(); }
  if (t.dataset.probe !== undefined) return probeEndpoint();
  if (t.dataset.saveEndpoint !== undefined) return saveEndpoint();
  if (t.dataset.pickCheck) {
    syncAddCard();
    const a = state.settings.adding;
    a.picked = event.target.checked ? [...new Set([...a.picked, t.dataset.pickCheck])] : a.picked.filter((m) => m !== t.dataset.pickCheck);
    const btn = $("[data-save-endpoint]");
    if (btn) { btn.disabled = !a.picked.length; btn.textContent = `Add ${a.picked.length || ""} model${a.picked.length === 1 ? "" : "s"}`; }
    return;
  }
  if (t.dataset.testModel) return testModel(t.dataset.testModel);
  if (t.dataset.removeEndpoint) {
    try { await api(`/api/agent/endpoints/${t.dataset.removeEndpoint}`, { method: "DELETE" }); toast("Removed"); } catch (err) { toast(err.message, true); }
    return renderSettings();
  }
  if (t.dataset.cliLogout) {
    const id = t.dataset.cliLogout;
    const cli = state.modelInfo?.clis?.find((c) => c.id === id);
    delete (state.cliWait || {})[id];
    try { await api(`/api/agent/cli/${id}/logout`, { method: "POST" }); } catch (err) { return toast(err.message, true); }
    toast(`Logged out of ${cli?.label || "the coding agent"}. Click its card to log in again.`);
    await loadModels();
    return renderSettings();
  }
  if (t.dataset.cliLogin) {
    if (state.cliWait?.[t.dataset.cliLogin]) return;
    const cli = state.modelInfo?.clis?.find((c) => c.id === t.dataset.cliLogin);
    if (cli?.status === "ok") return toast(`${cli.label} is logged in and ready.`);
    cliLogin(t.dataset.cliLogin);
    return;
  }
  if (t.dataset.newProject !== undefined) return startOnboarding();
  if (t.dataset.obGame !== undefined) return chooseGameFolder();
  if (t.dataset.obHome !== undefined) return chooseHomeFolder();
  if (t.dataset.obHomeReset !== undefined) { syncOnboarding(); state.ob.home = ""; return renderOnboarding(); }
  if (t.dataset.obBlank !== undefined) return createBlank();
  if (t.dataset.obRestart !== undefined) { syncOnboarding(); state.ob.step = 0; return renderOnboarding(); }
  if (t.dataset.deleteProject) { event.stopPropagation(); return deleteProjectDialog(t.dataset.deleteProject); }
  if (t.dataset.openProject) { closeProjects(); return switchProject(t.dataset.openProject); }
  if (t.dataset.obSkip !== undefined) return skipOnboarding();
  if (t.dataset.obNext !== undefined) { syncOnboarding(); state.ob.step += 1; return renderOnboarding(); }
  if (t.dataset.obBack !== undefined) { syncOnboarding(); state.ob.step -= 1; return renderOnboarding(); }
  if (t.dataset.obForge !== undefined) return forgeWorld();
  if (t.dataset.obEnter !== undefined) return finishOnboarding();
  if (t.dataset.obPath !== undefined) {
    syncOnboarding();
    const ob = state.ob;
    if (!/^([a-z]:[\\/]|[\\/]|~)/i.test(ob.typed || "")) { toast("Paste the whole path, starting with the drive, like D:\\Games\\MyGame.", true); return $("#obGamePath")?.focus(); }
    ob.game = ob.typed;
    ob.noGame = false;
    applyAutoName(ob, ob.game);
    renderOnboarding();
    return peekGame();
  }
  if (t.dataset.obNogame !== undefined) { syncOnboarding(); Object.assign(state.ob, { noGame: true, game: "", home: "" }); return renderOnboarding(); }
  if (t.dataset.obHasgame !== undefined) { state.ob.noGame = false; return renderOnboarding(); }
  if (t.dataset.obDim) { syncOnboarding(); state.ob.dimension = t.dataset.obDim; return renderOnboarding(); }
  if (t.dataset.obChip) {
    syncOnboarding();
    const list = state.ob[t.dataset.obChip];
    const i = list.indexOf(t.dataset.value);
    if (i >= 0) list.splice(i, 1); else list.push(t.dataset.value);
    return renderOnboarding();
  }
  if (t.dataset.makePillar) return makePillarDialog(t.dataset.makePillar);
  if (t.dataset.styleText) return addStyleText(t.dataset.styleText);
  if (t.dataset.removeStyle) return removeStyleText(t.dataset.removeStyle);
  if (t.dataset.removePillar) return removePillar(t.dataset.removePillar);
  if (t.dataset.newFolder !== undefined) return newFolderDialog(t.dataset.newFolder);
  if (t.dataset.toFolder !== undefined) return docToFolder();
  if (t.dataset.makeAsset !== undefined) return makeAsset();
  if (t.dataset.action) return openPreview(t.dataset.action, t.dataset.source || "");
  if (t.dataset.winner) return pickWinner(t.dataset.winner);
  if (t.dataset.ref !== undefined) {
    if (event.target.tagName !== "INPUT") return;
    syncPreviewFields();
    state.preview.references[Number(t.dataset.ref)].on = event.target.checked;
    return renderPreview();
  }
  if (t.dataset.addRef !== undefined) {
    syncPreviewFields();
    const p = state.preview;
    try {
      const vault = await api("/api/vault");
      const seen = new Set();
      p.pool = vault.groups.flatMap((g) => g.assets)
        .filter((e) => e.winner && !AUDIO_KINDS.includes(e.kind) && /\.(png|jpe?g|webp|gif)$/i.test(e.winner) && !seen.has(e.winner) && seen.add(e.winner))
        .map((e) => ({ path: e.winner, title: e.title || e.name }));
    } catch (err) { p.pool = []; }
    p.picking = true;
    return renderPreview();
  }
  if (t.dataset.closePicker !== undefined) { syncPreviewFields(); state.preview.picking = false; return renderPreview(); }
  if (t.dataset.pickRef) {
    syncPreviewFields();
    const p = state.preview;
    const existing = p.references.find((r) => r.path === t.dataset.pickRef);
    if (existing) existing.on = true;
    else p.references.push({ path: t.dataset.pickRef, source: "Project image", role: "extra", on: true });
    p.picking = false;
    return renderPreview();
  }
  if (t.dataset.uploadRef !== undefined) {
    syncPreviewFields();
    const p = state.preview;
    return uploadTo(`${p.asset.replace(/\.md$/i, "")}/refs`, (saved) => {
      p.references.push(...saved.map((path) => ({ path, source: "Added", role: "extra", on: true })));
      p.picking = false;
      renderPreview();
    });
  }
  if (t.dataset.rebuild !== undefined) return rebuildPreview();
  if (t.dataset.run !== undefined) return runPreview();
  if (t.dataset.open !== undefined) { event.preventDefault(); return openPath(t.dataset.open); }
  if (t.dataset.folder !== undefined) return openFolder(t.dataset.folder);
  if (t.dataset.home !== undefined) return go({ type: "home" });
  if (t.dataset.vault !== undefined) return go({ type: "vault" });
  if (t.dataset.levels !== undefined) return go({ type: "levels" });
  if (t.dataset.vaultFilter) { state.vaultHistory = !!$("#vaultHistory")?.checked; state.vaultFilter = t.dataset.vaultFilter; return renderVault(); }
  if (t.dataset.vaultZip !== undefined) return vaultZip(t.dataset.vaultZip);
  if (t.dataset.vaultFolder !== undefined) return vaultToFolder();
  if (t.dataset.poly) {
    syncPreviewFields();
    state.preview.settings.target_polycount = Number(t.dataset.poly);
    return renderPreview();
  }
  if (t.dataset.session) return openSession(t.dataset.session);
  if (t.id === "newChatBtn") return newChat();
  if (t.dataset.suggest) { const input = $("#input"); input.value = t.dataset.suggest; input.focus(); input.setSelectionRange(input.value.length, input.value.length); return; }
  if (t.dataset.unattach !== undefined) { state.attachments.splice(Number(t.dataset.unattach), 1); return renderAttachments(); }
  if (t.dataset.settings !== undefined) return settingsDialog("models");
  if (t.dataset.close !== undefined) return closeDialog();
  if (t.dataset.edit !== undefined) { state.view = { ...state.view, editing: true }; return renderView(); }
  if (t.dataset.cancelEdit !== undefined) { state.view = { ...state.view, editing: false }; return renderView(); }
  if (t.dataset.save !== undefined) return saveDoc();
  if (t.dataset.show) return showPanel(t.dataset.show);
});

$("#composer").addEventListener("submit", (event) => { event.preventDefault(); send(); });
$("#input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
});
$("#input").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); addFiles(files); }
});
$("#fileInput").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
$("#projectsBtn").addEventListener("click", openProjects);
$("#closeProjectsBtn").addEventListener("click", closeProjects);
$("#newProjectBtn").addEventListener("click", () => startOnboarding());
$("#projectSearch").addEventListener("input", renderProjectGrid);
$("#projectSort").addEventListener("change", renderProjectGrid);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || $("#onboarding").hidden || event.target.tagName === "TEXTAREA") return;
  if (event.target.id === "obGamePath") { event.preventDefault(); return $("[data-ob-path]")?.click(); }
  if (state.ob?.step === OB_BLANK) { event.preventDefault(); return createBlank(); }
  if ($("#obName")) { event.preventDefault(); syncOnboarding(); state.ob.step = 3; renderOnboarding(); }
});
$("#settingsBtn").addEventListener("click", () => settingsDialog());
$("#refreshBtn")?.addEventListener("click", loadOverview);
$("#modelPill").addEventListener("click", (event) => { event.stopPropagation(); toggleModelPop(); });
$("#brandBtn").addEventListener("click", openProjects);
$("#input").addEventListener("input", autoGrow);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".model-pill-wrap")) toggleModelPop(false);
});
$("#backBtn").addEventListener("click", goBack);
// Tess is optional (Settings → Tess): "on", "off", or "auto", which hides it once a coding agent is
// connected to the project, unless the project already has Tessera chats. The hide/show buttons override that per project.
function applyChatMode() {
  const mode = state.agentCfg?.chat_mode || "auto";
  shell.setChatOff(mode === "off");
  // The window keeps the mode it was left in. The first time, Tess is the bar at the bottom.
  shell.defaultChat("bar");
}
function setChatHidden(hidden) {
  if (hidden) shell.closeChat();
  else shell.openChat(false);
}
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-toggle-chat]")) shell.toggleChat();
});
// Drag and drop and paste (files, folders, zips, pictures from a web page): forge/ui/drops.js.
initDrops({
  state, api, toast, esc, icon, humanize, openDialog, closeDialog, sheetHead, projectTitle, addFiles, importArchive, pushUndo,
  kindLabel: (k) => KIND_LABEL[k] || humanize(k),
  agentReady: () => (state.models || []).some((m) => m.ready),
  assetTitle: (path) => document.querySelector(`[data-tile="${CSS.escape(path)}"]`)?.dataset.name || humanize(String(path).split("/").pop().replace(/\.md$/i, "")).replace(/[a-z]/g, (c) => c.toUpperCase()),
  refresh: () => loadOverview(),
  reload: () => loadOverview(),
  // What a drop made glows for a moment, so the eye finds it.
  flash: (paths) => requestAnimationFrame(() => paths.forEach((p) => document.querySelectorAll(`[data-tile="${CSS.escape(p)}"]`).forEach((el) => {
    el.classList.remove("just-dropped"); void el.offsetWidth; el.classList.add("just-dropped");
  }))),
});
$("#settingsView").addEventListener("input", (event) => {
  if (event.target.id === "addFilter") { syncAddCard(); renderSettings().then(() => { const f = $("#addFilter"); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }); }
});

// Windows and Linux press Ctrl, not ⌘.
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  const btn = $("#paletteBtn");
  if (btn) { btn.title = "Jump anywhere (Ctrl+K)"; const kbd = btn.querySelector("kbd"); if (kbd) kbd.textContent = "Ctrl K"; }
}

(async function init() {
  shell.initShell();
  api("/api/health").then((h) => { state.version = h.version; renderStatusBar(); }).catch(() => {});
  try {
    state.agentCfg = await api("/api/config").catch(() => null);
    // First run: the setup covers the app at once, before anything behind it has a chance to show.
    if (state.agentCfg && !state.agentCfg.onboarded) openSetup();
    await loadProjects();
    restoreView();
    // Independent of each other: fetched together, so the first page waits for the slowest, not their sum.
    await Promise.all([loadModels(), loadGrants(), loadConnect(), loadJobs()]);
    renderJobDock();
    await Promise.all([loadSessions(), loadOverview()]);
    connectSocket();
    if (state.agentCfg?.auto_update_check !== false) checkForUpdate().then(renderUpdateBanner);
  } catch (err) {
    toast(`Could not start: ${err.message}`, true);
  }
})();

// ---------- folders: access grants, game import, storage, first-run setup ----------

const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const SHAPE_LABEL = { asset: "", kit: "kit", gallery: "images", audio: "audio", docs: "docs", data: "needs art" };

async function loadGrants() {
  try { state.grants = (await api("/api/access")).grants; } catch { state.grants = []; }
  return state.grants;
}

const isGranted = (path, write = false) => (state.grants || []).some((g) => {
  const root = g.path.toLowerCase().replace(/[\\/]+$/, "");
  const p = String(path).toLowerCase().replace(/[\\/]+$/, "");
  return (p === root || p.startsWith(`${root}\\`) || p.startsWith(`${root}/`)) && (g.write || !write);
});

async function chooseFolder(title) {
  try { return (await api("/api/system/choose-folder", { method: "POST", body: { title } })).folder_path || ""; }
  catch (err) { toast(err.message, true); return ""; }
}

async function grantFolder(path, write = false) {
  state.grants = (await api("/api/access", { method: "POST", body: { path, write } })).grants;
}

// The agent asked for a folder in the chat: Allow / Don't allow.
function accessCard(request, last) {
  const allowed = isGranted(request.path, request.write);
  const what = request.write ? "read and write" : "read";
  return `<div class="access-card${allowed ? " ok" : ""}">
    <div class="ac-head">${icon("folder")}<span>${allowed ? "Allowed" : `Tess asks to ${what} a folder`}</span></div>
    <code>${esc(request.path)}</code>
    ${request.reason ? `<p>${esc(request.reason)}</p>` : ""}
    ${!request.exists ? `<p class="ac-warn">This folder doesn't exist on this computer. Check the path.</p>` : ""}
    ${!allowed && last && request.exists ? `<div class="ac-actions"><button class="primary" data-access-allow="${esc(request.path)}" data-write="${request.write ? 1 : 0}">Allow</button>
      <button class="ghost" data-access-deny="${esc(request.path)}">Don't allow</button>
      <small>You can remove access any time in Settings → Storage & access.</small></div>` : ""}
  </div>`;
}

async function answerAccess(path, allow, write) {
  try {
    if (allow) await grantFolder(path, write);
    $("#input").value = allow
      ? `I allowed access to ${path}${write ? " (read and write)" : ""}. Go ahead.`
      : `Don't access ${path}.`;
    renderMessages();
    await send();
  } catch (err) { toast(err.message, true); }
}

// ----- importing a game project -----

function openImport(folder = "") {
  closeProjects();
  hideScene($("#onboarding"));
  state.imp = { step: "pick", folder, preview: null, target: "new", name: "", describe: state.models.some((m) => m.ready), log: [], phase: "", result: null };
  showScene($("#importView"));
  renderImport();
  if (folder) scanImport();
}

function closeImport() { hideScene($("#importView")); state.imp = null; }

function unitStats(u) {
  return [
    u.models && plural(u.models, "model"), u.animations && plural(u.animations, "animation"), u.textures && plural(u.textures, "texture"),
    u.variants && plural(u.variants, "variant"), u.images && plural(u.images, "image"), u.audio && plural(u.audio, "sound"),
  ].filter(Boolean).join(" · ");
}

function renderImport() {
  const imp = state.imp;
  if (!imp) return;
  let body = "";
  if (imp.step === "pick") {
    const recent = (state.grants || []).filter((g) => g.exists).slice(-6).reverse();
    body = `<div class="ob-step enter"><p class="ob-kicker">Import a game</p><h1>Bring your <em>game</em> in.</h1>
      <p class="ob-sub">Godot, Unity, Unreal or any folder of game art. Tessera finds the characters, models, animations, textures, variants, kits and design docs, copies them into a project and lays them out in the overview. Your game folder is never changed.</p>
      <div class="imp-pick"><input id="impPath" class="ob-input small" placeholder="D:\\Games\\MyGame" value="${esc(imp.folder)}" spellcheck="false">
        <button class="ob-back" data-imp-browse>Browse…</button><button class="ob-next" data-imp-scan>Scan</button></div>
      ${recent.length ? `<div class="imp-recent"><span>Folders Tess may use:</span>${recent.map((g) => `<button class="ob-chip" data-imp-use="${esc(g.path)}">${esc(g.path.split(/[\\/]/).pop() || g.path)}</button>`).join("")}</div>` : ""}
    </div>`;
  } else if (imp.step === "scanning") {
    body = `<div class="ob-step enter"><div class="ob-orb"><span></span><span></span><span></span></div><p class="ob-kicker">Scanning</p><h1>Looking through<br>your game…</h1><p class="ob-sub">${esc(imp.folder)}</p></div>`;
  } else if (imp.step === "preview") {
    const p = imp.preview;
    const c = p.counts;
    const tiles = [["Characters", c.characters], ["3D models", c.models], ["Animations", c.animations], ["Textures", c.textures], ["Images", c.images], ["Sounds", c.audio], ["Needs art", c.needs_art], ["Docs", c.docs]].filter(([, n]) => n);
    const current = humanize(state.project || "");
    body = `<div class="imp-preview${imp.shown === "preview" ? "" : " enter"}">
      <div class="imp-top"><div><p class="ob-kicker">${esc(p.engine_label)} project</p><h2>${esc(p.title)}</h2><code>${esc(p.folder)}</code></div>
        <button class="ob-back" data-imp-back>Choose another folder</button></div>
      <div class="imp-tiles">${tiles.map(([label, n]) => `<div><strong>${n}</strong><span>${label}</span></div>`).join("")}</div>
      <p class="imp-review">Review before anything is added: untick sections or click assets to leave them out, rename sections, or merge one into another.</p>
      <div class="imp-sections">${p.sections.map((s) => {
        const sp = imp.plan.sections[s.key] || {};
        const off = sp.include === false;
        const kept = s.units.filter((u) => !imp.plan.exclude.has(u.id)).length;
        return `<section class="${off ? "off" : ""}${sp.into ? " merged" : ""}"><h3>
          <label class="imp-sec-check"><input type="checkbox" data-imp-sec="${esc(s.key)}" ${off ? "" : "checked"}></label>
          <input class="imp-sec-title" data-imp-title="${esc(s.key)}" value="${esc(sp.title || s.title)}" ${off || sp.into ? "disabled" : ""} maxlength="60" aria-label="Section name">
          <small>${kept}/${s.units.length}</small>
          <select class="imp-merge" data-imp-into="${esc(s.key)}" ${off ? "disabled" : ""} title="Merge into another section"><option value="">Own section</option>${p.sections.filter((o) => o.key !== s.key).map((o) => `<option value="${esc(o.key)}" ${sp.into === o.key ? "selected" : ""}>→ ${esc((imp.plan.sections[o.key] || {}).title || o.title)}</option>`).join("")}</select></h3>
          <div class="imp-units">${s.units.map((u) => `
          <button type="button" class="imp-unit${u.shape === "data" ? " needs" : ""}${imp.plan.exclude.has(u.id) ? " out" : ""}" data-imp-unit="${esc(u.id)}" title="${esc(u.source || u.description || "")}${imp.plan.exclude.has(u.id) ? " · left out" : " · click to leave out"}"><strong>${esc(u.title)}</strong>
            <small>${esc(unitStats(u) || (u.description ? u.description.slice(0, 70) : ""))}</small>${SHAPE_LABEL[u.shape] ? `<em>${SHAPE_LABEL[u.shape]}</em>` : ""}</button>`).join("")}</div></section>`;
      }).join("")}</div>
      <div class="imp-options">
        <label class="imp-radio"><input type="radio" name="impTarget" value="new" ${imp.target === "new" ? "checked" : ""}><span>New project</span>
          <input id="impName" class="imp-name" value="${esc(imp.name || p.title)}" maxlength="60"></label>
        ${state.project ? `<label class="imp-radio"><input type="radio" name="impTarget" value="current" ${imp.target === "current" ? "checked" : ""}><span>Into <b>${esc(current)}</b> (merges with its sections and assets)</span></label>` : ""}
        <label class="imp-check"><input type="checkbox" id="impDescribe" ${imp.describe ? "checked" : ""}><span>Let Tess look at the art and write a prompt for each asset (uses your chat model)</span></label>
        <p class="imp-note">Adds ${c.files} files (${fmtBytes(c.bytes)}) to the project. On the same drive they're linked, not copied, so they take no extra space. ${p.skipped.archives ? `${p.skipped.archives} archives (.zip) are skipped. ` : ""}Tessera's agent may read this folder afterwards; change that in Settings → Storage & access.</p>
      </div>
      <div class="ob-nav"><button class="ob-back" data-imp-close>Cancel</button><button class="ob-next forge" data-imp-run>✦ Import ${esc(p.title)}</button></div>
    </div>`;
  } else {
    const done = imp.step === "done";
    body = `<div class="ob-step enter">${done ? `<img class="ob-mark" src="ui/tessera-mark.svg" alt="">` : `<div class="ob-orb"><span></span><span></span><span></span></div>`}
      <p class="ob-kicker">${done ? "Imported" : esc(imp.phase || "Importing")}</p><h1>${esc((imp.target === "new" ? imp.name : humanize(imp.result?.project || state.project)) || imp.preview?.title || "Your game")}</h1>
      <ul class="ob-log">${imp.log.slice(-14).map((l) => `<li class="${l.cls || ""}">${esc(l.text)}</li>`).join("")}</ul>
      ${done ? `<div class="ob-nav"><button class="ob-next forge" data-imp-enter>Open the project →</button></div>` : ""}</div>`;
  }
  const scroll = $("#importStage .imp-sections")?.scrollTop || 0;
  $("#importStage").innerHTML = body;
  if (imp.shown === "preview" && imp.step === "preview") $("#importStage .imp-sections").scrollTop = scroll;
  imp.shown = imp.step;
}

function syncImport() {
  const imp = state.imp;
  if ($("#impPath")) imp.folder = $("#impPath").value.trim().replace(/^"|"$/g, "");
  if ($("#impName")) imp.name = $("#impName").value.trim();
  const target = document.querySelector("input[name=impTarget]:checked");
  if (target) imp.target = target.value;
  if ($("#impDescribe")) imp.describe = $("#impDescribe").checked;
  document.querySelectorAll("[data-imp-title]").forEach((el) => {
    const sp = (imp.plan.sections[el.dataset.impTitle] ||= {});
    const original = imp.preview?.sections.find((s) => s.key === el.dataset.impTitle)?.title;
    sp.title = el.value.trim() && el.value.trim() !== original ? el.value.trim() : "";
  });
}

// What the user approved in the preview, in the shape game_import.import_game expects.
function importPlan() {
  const imp = state.imp;
  const move = {};
  const sections = {};
  for (const s of imp.preview.sections) {
    const sp = imp.plan.sections[s.key] || {};
    sections[s.key] = { include: sp.include !== false, ...(sp.title ? { title: sp.title } : {}) };
    if (sp.into && sp.include !== false) for (const u of s.units) move[u.id] = sp.into;
  }
  return { exclude: [...imp.plan.exclude], move, sections };
}

async function scanImport() {
  const imp = state.imp;
  if (!imp.folder) { toast("Choose or paste a game folder first.", true); return; }
  imp.step = "scanning";
  renderImport();
  try {
    imp.preview = await api("/api/import/analyze", { method: "POST", body: { folder: imp.folder } });
    imp.name = imp.preview.title;
    imp.plan = { exclude: new Set(), sections: {} };
    imp.step = "preview";
  } catch (err) {
    imp.step = "pick";
    toast(err.message, true);
  }
  renderImport();
}

async function runImport() {
  syncImport();
  const imp = state.imp;
  const log = (text, cls = "") => { imp.log.push({ text, cls }); renderImport(); };
  imp.step = "running";
  imp.phase = "Copying files";
  renderImport();
  try {
    const body = { folder: imp.folder, title: imp.target === "new" ? imp.name : "", plan: importPlan() };
    if (imp.target === "current") body.project = state.project;
    else body.name = imp.name;
    let job = await api("/api/import/start", { method: "POST", body });
    const project = job.project;
    let seen = 0;
    while (job.status === "running") {
      await new Promise((r) => setTimeout(r, 600));
      job = await api(`/api/import/jobs/${job.id}`);
      for (const line of job.log.slice(seen)) log(line);
      seen = job.log.length;
    }
    if (job.status !== "done") throw new Error(job.error || "The import stopped.");
    const r = job.result;
    log(`${r.assets} assets in ${Object.keys(r.sections).length} sections · ${r.copied} files${r.linked ? ` (${r.linked} linked, no extra space)` : ""}`, "ok");
    imp.result = { project };
    await loadGrants();
    state.project = project;
    storeSet("forge.project", project);
    // Previews for the 3D models, rendered here in the browser (with progress in the import log).
    const { models } = await api(`/api/import/models?project=${encodeURIComponent(project)}`);
    if (models.length) {
      imp.phase = "Rendering previews";
      log(`Rendering previews for ${plural(models.length, "model")}…`);
      const viewer = await viewerModule().catch(() => null);
      let made = 0;
      for (const [i, model] of models.entries()) {
        try {
          const png = await viewer.renderThumb(projectFileUrl(project, model), 384);
          await api(`/api/studio/thumb?project=${encodeURIComponent(project)}`, { method: "POST", body: { model, png } });
          made += 1;
        } catch { /* keep the placeholder */ }
        if (i % 8 === 7 || i === models.length - 1) { imp.log.at(-1).text = `Rendering previews ${i + 1} / ${models.length}…`; renderImport(); }
      }
      log(`${made} previews rendered`, "ok");
    }
    if (imp.describe) {
      imp.phase = "Looking at the art";
      log("Tess is looking at your characters and items…");
      try {
        const { described } = await api(`/api/import/describe?project=${encodeURIComponent(project)}`, { method: "POST" });
        log(described ? `Wrote prompts for ${plural(described, "asset")}` : "The chat model couldn't look at images; prompts stay empty for now.", described ? "ok" : "");
      } catch (err) { log(`Couldn't describe the art: ${err.message}`, "bad"); }
    }
    imp.step = "done";
  } catch (err) {
    log(err.message, "bad");
    imp.step = "done";
  }
  renderImport();
}

async function finishImport() {
  const project = state.imp?.result?.project || state.project;
  closeImport();
  await switchProject(project);
  showPanel("workspace", true);
}

// ----- storage: where projects live, export and import -----

async function exportProject(project) {
  try {
    const result = await api(`/api/projects/${encodeURIComponent(project)}/export`, { method: "POST", body: {} });
    if (result.cancelled) return;
    toast(`Exported ${humanize(project)} to ${result.path} (${fmtBytes(result.size)})`);
  } catch (err) {
    if (/dialog/i.test(err.message)) { window.location.href = `/api/projects/${encodeURIComponent(project)}/export.zip`; return; }
    toast(err.message, true);
  }
}

async function importArchive(file) {
  const form = new FormData();
  if (file) form.append("file", file);
  toast(file ? `Importing ${file.name}…` : "Choose a Tessera project .zip…");
  try {
    const res = await fetch("/api/projects/import-archive", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Import failed (${res.status})`);
    if (data.cancelled) return;
    toast(`Imported ${humanize(data.project)}`);
    closeProjects();
    closeSettings();
    await switchProject(data.project);
  } catch (err) { toast(err.message, true); }
}

function pickArchive() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.onchange = () => input.files[0] && importArchive(input.files[0]);
  input.click();
}

async function moveProjectsFolder() {
  const folder = await chooseFolder("Choose where Tessera keeps your projects");
  if (!folder) return;
  try {
    await api("/api/storage/location", { method: "POST", body: { path: folder } });
    toast(`Projects now live in ${folder}`);
    await loadProjects();
    await switchProject(state.projects.includes(state.project) ? state.project : state.projects[0] || "default");
    if (!$("#settingsView").hidden) renderSettings();
    if (state.setup) renderSetup();
  } catch (err) { toast(err.message, true); }
}

function grantRows(grants) {
  if (!grants.length) return `<p class="st-empty">No folders yet. Tess asks in the chat when it needs one, or add your game folder here.</p>`;
  return grants.map((g) => `<div class="grant-row${g.exists ? "" : " missing"}"><span class="dot ${g.exists ? "live" : ""}"></span><code title="${esc(g.path)}">${esc(g.path)}</code>
    <select data-grant-mode="${esc(g.path)}" aria-label="Access"><option value="read" ${g.write ? "" : "selected"}>Read</option><option value="write" ${g.write ? "selected" : ""}>Read & write</option></select>
    ${g.exists ? `<button class="mini" data-imp-use="${esc(g.path)}" title="Import this folder as a game">Import</button><button class="mini" data-st-open="grant" data-path="${esc(g.path)}">Open</button>` : `<small>missing</small>`}
    <button class="link-btn danger-text" data-grant-remove="${esc(g.path)}">Remove</button></div>`).join("");
}

// ----- first-run setup -----

const SETUP_STEPS = 4;
const AGENT_BUSY = new Set(["checking", "installing", "login"]);
const AGENT_STATUS = { missing: "Not installed · Install", idle: "Installed · Connect", checking: "Checking…", installing: "Finish installing in Terminal…", login: "Sign in in the Terminal window…", ok: "Connected", error: "Couldn't connect · Retry" };

async function openSetup() {
  state.setup = { step: 0, agents: {} };
  showScene($("#setup"));
  // What the next steps show, fetched while the welcome is read, so Continue never waits on a blank screen.
  state.setupPrefetch = { models: loadModels(), config: api("/api/config").catch(() => ({})), services: loadServices() };
  // Setup counts as done when it is finished or skipped, not when it is seen: `tessera connect` opens it in a
  // browser tab the user may close unread, and the next visit must still start with it.
  await renderSetup();
}

function stopAgentPolls() {
  for (const a of Object.values(state.setup?.agents || {})) clearTimeout(a.timer);
}

async function closeSetup(done = true) {
  stopAgentPolls();
  hideScene($("#setup"));
  state.setup = null;
  if (done && state.agentCfg) state.agentCfg.onboarded = true;
  if (done) await api("/api/config", { method: "PUT", body: { onboarded: true } }).catch(() => {});
}

// ----- setup: coding agents, plug and play -----

function agentCardsHTML() {
  const st = state.setup;
  return (state.modelInfo?.clis || []).map((c) => {
    const a = (st.agents[c.id] ||= { status: c.installed ? "idle" : "missing" });
    const mark = a.status === "ok" ? "✓" : AGENT_BUSY.has(a.status) ? `<i class="agent-spin"></i>` : "→";
    return `<button type="button" class="agent-card ${a.status}" data-setup-agent="${c.id}" title="${esc(a.error || (c.installed ? c.login : c.install))}">
      <span class="agent-logo"><img src="${AGENT_LOGO[c.id]}" alt=""></span>
      <span class="agent-text"><strong>${esc(c.label)}</strong><small>${AGENT_STATUS[a.status]}</small></span>
      <span class="agent-mark">${mark}</span></button>`;
  }).join("");
}

function renderAgentCards() {
  const box = $("#agentCards");
  if (!box) return;
  box.innerHTML = agentCardsHTML();
  const next = $("#setupStage [data-setup-next]");
  if (next) next.textContent = Object.values(state.setup.agents).some((a) => a.status === "ok") ? "Continue" : "Skip for now";
}

async function openAgentTerminal(id) {
  try { await api(`/api/agent/cli/${id}/login`, { method: "POST" }); } catch (err) { toast(err.message, true); }
}

// Checks whether an agent answers. `interactive` (a click) opens the Terminal to install it or sign in,
// then keeps checking until it's connected.
async function checkAgent(id, interactive = false) {
  const st = state.setup;
  const a = st?.agents[id];
  if (!a) return;
  clearTimeout(a.timer);
  const waiting = a.status === "installing" || a.status === "login";
  if (!waiting) a.status = "checking";
  renderAgentCards();
  let r;
  try { r = await api(`/api/agent/cli/${id}/check`, { method: "POST" }); } catch (err) { r = { installed: true, ok: false, error: err.message }; }
  if (state.setup !== st || st.step !== 1) return;
  a.error = r.error || "";
  if (r.ok) {
    a.status = "ok";
    renderAgentCards();
    return agentConnected(id);
  }
  if (!r.installed) {
    if (interactive && !waiting) await openAgentTerminal(id); // the install command
    a.status = interactive || a.status === "installing" ? "installing" : "missing";
  } else if (interactive || waiting) {
    if (a.status !== "login") await openAgentTerminal(id); // just installed, or a click: sign in
    a.status = "login";
  } else {
    a.status = "idle";
  }
  if (AGENT_BUSY.has(a.status)) {
    a.tries = (a.tries || 0) + 1;
    if (a.tries <= 45) a.timer = setTimeout(() => checkAgent(id), 4000);
    else { a.tries = 0; a.status = r.installed ? "error" : "missing"; }
  }
  renderAgentCards();
}

async function agentConnected(id) {
  playFistbump(AGENT_LOGO[id], state.modelInfo?.clis?.find((c) => c.id === id)?.label || "Your agent");
  await loadModels();
  const st = state.setup;
  // The first agent that connects runs Tess, unless a model was already picked here.
  const pick = state.models.find((m) => m.id === `cli:${id}/`);
  if (st && pick && !st.pickedModel) { st.pickedModel = true; await pickModel(pick.id); }
}

function playFistbump(logo, label, box = $("#fistbump")) {
  if (!box) return toast(`${label} is connected`);
  box.innerHTML = `<div class="fb-row"><div class="fb-side left"><img class="fb-mark tess" src="ui/tess-avatar.png" alt="Tess"><span class="fb-fist">🤜</span></div>
    <div class="fb-burst">${Array.from({ length: 10 }, (_, i) => `<i style="--a:${i * 36}deg"></i>`).join("")}</div>
    <div class="fb-side right"><span class="fb-fist">🤛</span><span class="fb-logo"><img src="${logo}" alt="${esc(label)}"></span></div></div>
    <p class="fb-text"><b>${esc(label)}</b> and Tess are connected</p>`;
  box.hidden = false;
  box.classList.remove("play");
  void box.offsetWidth; // restart the animation
  box.classList.add("play");
}

async function renderSetup() {
  const st = state.setup;
  if (!st) return;
  const nav = (next = "Continue") => `<div class="ob-nav"><button class="ob-back" data-setup-back>Back</button><button class="ob-next" data-setup-next>${next}</button></div>`;
  // The two real steps (agent, generators) get the dots; the welcome and the way out don't count as steps.
  const dots = st.step === 1 || st.step === 2 ? `<div class="setup-dots">${[1, 2].map((i) => `<i class="${i === st.step ? "on" : i < st.step ? "done" : ""}"></i>`).join("")}</div>` : "";
  let body = "";
  if (st.step === 0) {
    body = `<div class="ob-step intro enter"><p class="ob-kicker">Welcome to Tessera</p><h1>Your game's<br><em>asset studio</em>.</h1>
      <p class="ob-sub">Tessera makes the art, 3D models and sounds your game needs. Code with any agent you like: you shape the art here, and your agent copies it into the game. Two quick steps.</p>
      <button class="ob-next" data-setup-next>Start setup</button></div>`;
  } else if (st.step === 1) {
    if (state.setupPrefetch?.models) { await state.setupPrefetch.models; state.setupPrefetch.models = null; } else await loadModels();
    const connected = Object.values(st.agents).some((a) => a.status === "ok");
    body = `<div class="ob-step enter"><p class="ob-kicker">1 / 2 · Your AI</p><h1>Plug in your<br><em>coding agent</em>.</h1>
      <p class="ob-sub">Tessera runs on the AI you already pay for. Pick yours and sign in once: no API key needed.</p>
      <div class="agent-cards" id="agentCards">${agentCardsHTML()}</div>
      <div class="fistbump" id="fistbump" hidden></div>
      <p class="setup-alt">No coding agent? <button type="button" class="link-btn" data-setup-settings="models">Use an API key instead</button></p>
      ${nav(connected ? "Continue" : "Skip for now")}</div>`;
  } else if (st.step === 2) {
    const pre = state.setupPrefetch || {};
    const [cfg] = await Promise.all([pre.config || api("/api/config"), pre.services || loadServices()]);
    state.setupPrefetch = null;
    body = `<div class="ob-step enter"><p class="ob-kicker">2 / 2 · Generators</p><h1>Keys for art,<br><em>3D</em> and sound.</h1>
      <p class="ob-sub">Tessera is free; generation runs on your own provider accounts, so you only pay them for what you make. Sign in to one, or paste a key. Everything stays on this computer.</p>
      ${serviceCardsHTML()}
      <div class="fistbump" id="serviceFistbump" hidden></div>
      <details class="setup-more"><summary>Or paste API keys</summary>
      <form id="setupKeys" class="setup-keys">${KEY_PROVIDERS.map((k) => `<label><span><b>${k.name}</b> ${k.use} · <a href="${k.url}" target="_blank" rel="noopener">Get a key ↗</a></span>
        <input name="${k.key}_api_key" type="password" autocomplete="off" placeholder="${cfg[`${k.key}_configured`] ? "Connected. Paste to replace" : k.hint}"></label>`).join("")}</form></details>
      ${nav((state.services || []).some((sv) => sv.connected) || KEY_PROVIDERS.some((k) => cfg[`${k.key}_configured`]) ? "Continue" : "Skip for now")}</div>`;
  } else {
    body = `<div class="ob-step enter"><img class="ob-mark" src="ui/tessera-mark.svg" alt=""><p class="ob-kicker">All set</p><h1>What are we<br><em>making</em>?</h1>
      <div class="setup-actions big"><button class="ob-next forge" data-setup-finish="new">Start a new project</button><button class="ob-next" data-setup-finish="import">Import a game project</button>
      ${state.project ? `<button class="ob-back" data-setup-finish="open">Open ${esc(humanize(state.project))}</button>` : ""}</div>
      <p class="ob-sub small">Each project lives in its game's folder, in <code>tessera/</code>.</p></div>`;
  }
  setTess($("#setup"), SETUP_POSES[st.step]);
  $("#setupStage").innerHTML = dots + body;
  $("#setup .ob-skip").hidden = st.step === SETUP_STEPS - 1; // the last step is the way out
  if (st.step === 1 && !st.checked) {
    st.checked = true; // installed agents that are already signed in connect on their own
    for (const c of state.modelInfo?.clis || []) if (c.installed) checkAgent(c.id);
  }
}

async function setupNext() {
  const st = state.setup;
  if (st.step === 2) {
    const form = $("#setupKeys");
    const updates = {};
    for (const input of form.querySelectorAll("input")) if (input.value.trim()) updates[input.name] = input.value.trim();
    if (Object.keys(updates).length) {
      try { await api("/api/config", { method: "PUT", body: updates }); toast("Keys saved"); } catch (err) { return toast(err.message, true); }
    }
  }
  stopAgentPolls();
  st.step = Math.min(SETUP_STEPS - 1, st.step + 1);
  await renderSetup();
}

// ----- events -----

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-access-allow],[data-access-deny],[data-imp-open],[data-imp-close],[data-imp-browse],[data-imp-scan],[data-imp-use],[data-imp-back],[data-imp-run],[data-imp-unit],[data-imp-enter],[data-st-open],[data-st-move],[data-st-export],[data-st-import-zip],[data-st-quit],[data-st-shortcut],[data-grant-add],[data-grant-remove],[data-setup-open],[data-setup-next],[data-setup-back],[data-setup-skip],[data-setup-finish],[data-setup-settings],[data-setup-refresh],[data-setup-agent]");
  if (!t) return;
  const d = t.dataset;
  if (d.accessAllow) return answerAccess(d.accessAllow, true, d.write === "1");
  if (d.accessDeny) return answerAccess(d.accessDeny, false, false);
  if (d.impOpen !== undefined) { closeSettings(); return openImport(); }
  if (d.impClose !== undefined) return closeImport();
  if (d.impBrowse !== undefined) {
    syncImport();
    const folder = await chooseFolder("Choose your game folder");
    if (folder) { state.imp.folder = folder; await scanImport(); }
    return;
  }
  if (d.impScan !== undefined) { syncImport(); return scanImport(); }
  if (d.impUse) {
    event.stopPropagation();
    if (!state.imp) { closeSettings(); if (state.setup) await closeSetup(); return openImport(d.impUse); }
    state.imp.folder = d.impUse;
    return scanImport();
  }
  if (d.impBack !== undefined) { state.imp.step = "pick"; return renderImport(); }
  if (d.impRun !== undefined) return runImport();
  if (d.impUnit) {
    syncImport();
    const ex = state.imp.plan.exclude;
    if (ex.has(d.impUnit)) ex.delete(d.impUnit); else ex.add(d.impUnit);
    return renderImport();
  }
  if (d.impEnter !== undefined) return finishImport();
  if (d.stOpen) {
    try { await api("/api/storage/open", { method: "POST", body: { target: d.stOpen, path: d.path || "" } }); } catch (err) { toast(err.message, true); }
    return;
  }
  if (d.stMove !== undefined) return moveProjectsFolder();
  if (d.stExport) { event.stopPropagation(); return exportProject(d.stExport); }
  if (d.stImportZip !== undefined) return pickArchive();
  if (d.stShortcut !== undefined) {
    try { const { shortcuts } = await api("/api/shortcut", { method: "POST" }); toast(`Tessera shortcut added: ${shortcuts.join(", ")}`); if (state.settings?.tab === "about") renderSettings(); } catch (err) { toast(err.message, true); }
    return;
  }
  if (d.stQuit !== undefined) {
    if (!(await ask({ title: "Stop Tessera?", body: "Open it again any time with the Tessera shortcut.", ok: "Stop Tessera", danger: true }))) return;
    try { await api("/api/quit", { method: "POST" }); } catch (err) { return toast(err.message, true); }
    document.body.innerHTML = `<div class="empty" style="padding:15vh 24px;text-align:center">${tessArt("offline")}<h1>Tessera stopped</h1><p>Double-click the Tessera shortcut on your desktop, ask your coding agent to open Tessera, or run <code>tessera</code> in a terminal, to start it again.</p></div>`;
    return;
  }
  if (d.grantAdd !== undefined) {
    const folder = await chooseFolder("Choose a folder Tess may use");
    if (!folder) return;
    try { await grantFolder(folder); toast(`Tess may now read ${folder}`); } catch (err) { return toast(err.message, true); }
    if (state.setup) return renderSetup();
    return renderSettings();
  }
  if (d.grantRemove) {
    try { state.grants = (await api("/api/access", { method: "DELETE", body: { path: d.grantRemove } })).grants; } catch (err) { return toast(err.message, true); }
    if (state.setup) return renderSetup();
    return renderSettings();
  }
  if (d.setupOpen !== undefined) { closeSettings(); return openSetup(); }
  if (d.setupNext !== undefined) return setupNext();
  if (d.setupBack !== undefined) { stopAgentPolls(); state.setup.step = Math.max(0, state.setup.step - 1); return renderSetup(); }
  if (d.setupAgent) {
    const a = state.setup?.agents[d.setupAgent];
    if (!a || AGENT_BUSY.has(a.status)) return;
    if (a.status === "ok") return agentConnected(d.setupAgent);
    return checkAgent(d.setupAgent, true);
  }
  if (d.setupSkip !== undefined) return closeSetup();
  if (d.setupRefresh !== undefined) return renderSetup();
  if (d.setupSettings) {
    state.setupPrefetch = null; // keys added there must show when setup comes back
    hideScene($("#setup"));
    state.setupReturn = true;
    return settingsDialog(d.setupSettings);
  }
  if (d.setupFinish) {
    if (d.setupFinish === "new") {
      // Same backdrop: fade out setup's text, then the new-project questions take over in place.
      $("#setupStage").classList.add("stage-out");
      await new Promise((r) => setTimeout(r, 260));
      startOnboarding(true);
      await closeSetup();
      setTimeout(() => $("#setupStage").classList.remove("stage-out"), 900);
      return;
    }
    // Open the next scene first so it fades in over setup.
    if (d.setupFinish === "import") openImport();
    await closeSetup();
  }
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (!state.imp?.plan || !el.matches?.("[data-imp-sec], [data-imp-into]")) return;
  syncImport();
  if (el.dataset.impSec) (state.imp.plan.sections[el.dataset.impSec] ||= {}).include = el.checked;
  if (el.dataset.impInto) (state.imp.plan.sections[el.dataset.impInto] ||= {}).into = el.value;
  renderImport();
});

document.addEventListener("change", async (event) => {
  const select = event.target.closest?.("[data-grant-mode]");
  if (!select) return;
  try { await grantFolder(select.dataset.grantMode, select.value === "write"); toast(select.value === "write" ? "Tess may now read and write there" : "Read only"); } catch (err) { toast(err.message, true); }
});

// Asset page shortcuts: Ctrl/⌘+Enter in the prompt opens Generate images, and on a generation sheet it runs it.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  if (event.target.id === "assetPrompt") { event.preventDefault(); openPreview("candidates"); }
  else if ($("#dialog").open && state.preview && $("#dialog [data-run]")) { event.preventDefault(); runPreview(); }
});

// The prompt saves itself while typing, so leaving the page never loses an edit.
let promptTimer;
document.addEventListener("input", (event) => {
  if (event.target.id !== "assetPrompt") return;
  clearTimeout(promptTimer);
  promptTimer = setTimeout(async () => {
    try {
      await saveAssetPrompt();
      const label = $("label[for=assetPrompt]");
      label?.classList.add("saved");
      setTimeout(() => label?.classList.remove("saved"), 1400);
    } catch (err) { toast(err.message, true); }
  }, 700);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.id === "impPath") { event.preventDefault(); syncImport(); scanImport(); }
  if (event.key === "Escape" && state.imp && ["pick", "preview"].includes(state.imp.step)) closeImport();
  if (event.key === "Escape" && !$("#onboarding").hidden && !$("#onboarding").classList.contains("forging")) cancelOnboarding();
  // Settings closes like every other sheet, unless a dialog over it is what the Escape is for.
  if (event.key === "Escape" && !$("#settingsView").hidden && !$("#settingsView").dataset.leaving && !document.querySelector("dialog[open]")) closeSettings();
});


// ---------- updates ----------

const INSTALL_KIND = { "windows-app": "Windows app", "mac-app": "macOS app", "uv-tool": "installed with the terminal one-liner", source: "running from source" };

async function checkForUpdate(force = false) {
  try { state.update = await api(`/api/update${force ? "?force=true" : ""}`); } catch (err) { state.update = { error: err.message }; }
  return state.update;
}

function renderUpdateBanner() {
  const u = state.update;
  const box = $("#updateBanner");
  const busy = ["downloading", "installing", "restart", "failed"].includes(u?.state?.status);
  if (!u || (!u.available && !busy) || (!busy && storeGet("forge.skipUpdate") === u.latest)) { box.hidden = true; return; }
  const s = u.state || {};
  let body;
  if (s.status === "downloading" || s.status === "installing") {
    body = `<span class="spinner"></span><span class="grow">${esc(s.message || "Updating…")}</span>${s.status === "downloading" && s.progress ? `<span class="ub-pct">${Math.round(s.progress * 100)}%</span>` : ""}`;
  } else if (s.status === "restart") {
    body = `<span class="ub-dot"></span><span class="grow">${esc(s.message)}</span>`;
  } else if (s.status === "failed") {
    body = `<span class="ub-dot bad"></span><span class="grow">${esc(s.error || "The update failed.")}</span><a class="mini" href="${esc(u.url || "#")}" target="_blank" rel="noopener">Download</a><button class="mini" data-update-dismiss>×</button>`;
  } else {
    const action = u.can_install
      ? `<button class="mini on" data-update-install>Update now</button>`
      : u.command ? `<code title="Run this in the Tessera folder">${esc(u.command)}</code>` : `<a class="mini on" href="${esc(u.url)}" target="_blank" rel="noopener">Download</a>`;
    body = `${tessArt("update", "ub")}<span class="grow"><b>Tessera ${esc(u.latest)}</b> is out <small>(you have ${esc(u.current)})</small> · <a href="${esc(u.url)}" target="_blank" rel="noopener">What's new</a></span>${action}<button class="mini" data-update-dismiss title="Not now">Later</button>`;
  }
  box.innerHTML = body;
  box.hidden = false;
}

async function installUpdate() {
  try {
    state.update.state = await api("/api/update/install", { method: "POST" });
    renderUpdateBanner();
    if (!$("#settingsView").hidden && state.settings?.tab === "about") renderSettings();
    while (["downloading", "installing"].includes(state.update.state.status)) {
      await new Promise((r) => setTimeout(r, 800));
      try { state.update.state = await api("/api/update/state"); } catch { break; } // the app quit to install
      renderUpdateBanner();
    }
  } catch (err) { toast(err.message, true); }
}

function updateSettings() {
  const u = state.update || {};
  const s = u.state || {};
  const status = u.error ? esc(u.error)
    : ["downloading", "installing", "restart", "failed"].includes(s.status) ? esc(s.error || s.message)
    : u.available ? `Tessera ${esc(u.latest)} is available.`
    : u.latest ? "You have the latest version." : "Not checked yet.";
  return `<div class="st-label">Updates</div>
    <div class="set-row"><div><strong>Tessera ${esc(u.current || "")}</strong><small>${esc(INSTALL_KIND[u.kind] || "")} · ${status}</small></div>
      <div class="update-actions">${u.available && u.can_install ? `<button class="primary" data-update-install>Update to ${esc(u.latest)}</button>` : ""}<button class="ghost" data-update-check>Check now</button></div></div>
    ${u.available && u.command ? `<p class="st-note">To update this copy, run <code>${esc(u.command)}</code> in the Tessera folder.</p>` : ""}
    <div class="set-row"><div><strong>Check for updates when Tessera starts</strong><small>Asks GitHub for the latest release; nothing is installed without your click.</small></div>
      <label class="switch"><input type="checkbox" data-update-auto ${state.agentCfg?.auto_update_check === false ? "" : "checked"}><span></span></label></div>`;
}

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-update-install],[data-update-dismiss],[data-update-check]");
  if (!t) return;
  if (t.dataset.updateInstall !== undefined) return installUpdate();
  if (t.dataset.updateDismiss !== undefined) {
    if (state.update?.latest) storeSet("forge.skipUpdate", state.update.latest);
    if (state.update?.state?.status === "failed") state.update.state = {};
    $("#updateBanner").hidden = true;
    return;
  }
  if (t.dataset.updateCheck !== undefined) {
    t.disabled = true;
    await checkForUpdate(true);
    storeSet("forge.skipUpdate", "");
    renderUpdateBanner();
    return renderSettings();
  }
});

document.addEventListener("change", async (event) => {
  if (!event.target.matches?.("[data-update-auto]")) return;
  try {
    await api("/api/config", { method: "PUT", body: { auto_update_check: event.target.checked } });
    state.agentCfg = { ...(state.agentCfg || {}), auto_update_check: event.target.checked };
  } catch (err) { toast(err.message, true); }
});

// ---------- whole-project tools: board, batch runs, key art, sample, press kit ----------

const KIND_HEIGHT = { character: 1.7, creature: 2.5, vehicle: 2, prop: 1, item: 0.4, weapon: 1 };

// api() for another project than the open one: the URL is built before api() awaits anything.
function apiIn(project, path, options) {
  const open = state.project;
  state.project = project;
  try { return api(path, options); } finally { state.project = open; }
}

async function loadCredits() {
  if (state.credits && Date.now() - state.credits.loaded < 60000) return state.credits;
  state.credits = { alerts: {}, ...(await api("/api/studio/credits").catch(() => ({}))), loaded: Date.now() };
  return state.credits;
}

function creditAlert(provider) {
  const hit = provider && state.credits?.alerts?.[provider];
  return hit ? { ...hit, provider } : null;
}

async function renderBoard() {
  const content = $("#content");
  let data;
  try { data = await loadBoard(); } catch (err) { content.innerHTML = `<div class="empty">${tessArt("error")}<h1>Board unavailable</h1><p>${esc(err.message)}</p></div>`; return; }
  state.board = data;
  const all = data.groups.flatMap((g) => g.assets);
  const models = all.filter((a) => /\.(glb|gltf)$/i.test(a.model));
  const unpicked = all.filter((a) => !a.picked).length;
  content.innerHTML = `
    <h1 class="title">Board</h1>
    <p class="lede">Every asset on one canvas, to spot the ones that don't match. Drag to move; zoom with + and −, or ⌘ / Ctrl + scroll.</p>
    <div class="vault-bar">
      <div class="zoom-btns"><button class="icon-btn" data-board-zoom="-1" aria-label="Zoom out">−</button><span id="boardZoom">100%</span><button class="icon-btn" data-board-zoom="1" aria-label="Zoom in">+</button><button class="ghost" data-board-zoom="0">Fit</button></div>
      <span class="hint-line">${plural(all.length, "asset")}${unpicked ? ` · ${unpicked} without a winner` : ""}</span>
      <span class="grow"></span>
      ${models.length ? `<button class="ghost" data-lineup>${icon("cube")} 3D lineup · ${models.length}</button>` : ""}
      <button class="ghost" data-press-kit>${icon("download")} Press kit</button>
    </div>
    ${all.length ? `<div class="board" id="board"><div class="board-canvas" id="boardCanvas">${data.groups.map((g) => `
      <section class="board-col"><h2><small>${esc(g.number)}</small>${esc(g.title)}<span>${g.assets.length}</span></h2>
        ${g.assets.map((a) => `<button class="board-card${a.picked ? "" : " unpicked"}" data-open="${esc(a.path)}"${a.audio ? ` data-hover-audio="${esc(a.audio)}"` : ""} title="${esc(a.prompt)}">
          ${a.image ? `<img src="${esc(thumbUrl(a.image, 320))}" alt="" loading="lazy" decoding="async" draggable="false">` : a.audio ? `<span class="asset-sound"><span class="wave" aria-hidden="true">${"<i></i>".repeat(14)}</span><small>Hover to listen</small></span>` : kindArt(a.kind)}
          <span class="board-label"><strong>${esc(displayTitle(a.title))}</strong><em>${esc(a.kind)}${a.model ? " · 3D" : ""}${a.picked ? "" : " · no winner"}</em></span></button>`).join("")}
      </section>`).join("")}</div></div>` : `<div class="empty">${tessArt("empty-b")}<h1>Nothing on the board yet</h1><p>Assets appear here as soon as they exist. Add some on a section page, or ask the agent.</p></div>`}`;
}

// Pan and zoom the board with a CSS transform; the position is kept while the project stays open.
function mountBoard() {
  const board = $("#board");
  const canvas = $("#boardCanvas");
  if (!board || !canvas) return;
  const first = !state.boardView;
  const v = state.boardView ||= { x: 0, y: 0, z: 1 };
  const apply = () => {
    canvas.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    if ($("#boardZoom")) $("#boardZoom").textContent = `${Math.round(v.z * 100)}%`;
  };
  const zoomAt = (factor, cx, cy) => {
    const z = Math.min(2.5, Math.max(0.2, v.z * factor));
    v.x = cx - ((cx - v.x) * z) / v.z;
    v.y = cy - ((cy - v.y) * z) / v.z;
    v.z = z;
    apply();
  };
  board.fit = (tries = 30) => {
    // Right after a render the canvas may not be laid out yet: wait a frame or two for real sizes.
    if (!canvas.scrollWidth || !board.clientWidth) { if (tries) requestAnimationFrame(() => board.fit(tries - 1)); return; }
    const scale = Math.min(1, board.clientWidth / canvas.scrollWidth, board.clientHeight / canvas.scrollHeight);
    Object.assign(v, { x: 0, y: 0, z: Math.max(0.2, scale) });
    apply();
  };
  board.zoomBy = (dir) => zoomAt(dir > 0 ? 1.25 : 0.8, board.clientWidth / 2, board.clientHeight / 2);
  board.addEventListener("wheel", (event) => {
    event.preventDefault();
    const box = board.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top);
    else { v.x -= event.deltaX; v.y -= event.deltaY; apply(); }
  }, { passive: false });
  board.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const drag = { x: event.clientX, y: event.clientY, ox: v.x, oy: v.y, moved: false };
    const move = (e) => {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      board.classList.add("dragging");
      v.x = drag.ox + dx;
      v.y = drag.oy + dy;
      apply();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      board.classList.remove("dragging");
      // A drag that ends on a card must not open it.
      if (drag.moved) board.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  });
  if (first) board.fit(); // the first look shows every section at once
  else apply();
}

async function openLineup() {
  let data = state.board;
  if (!data) try { data = await loadBoard(); } catch (err) { return toast(err.message, true); }
  const items = data.groups.flatMap((g) => g.assets).filter((a) => /\.(glb|gltf)$/i.test(a.model));
  if (!items.length) return toast("No 3D models in this project yet.", true);
  openDialog(`<div class="dlg wide viewer-dlg">
    <div class="viewer-head"><h2>${icon("cube")} Lineup · ${plural(items.length, "model")}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="viewer-stage lineup-stage" id="lineupStage"><p class="hint-line">Loading models…</p></div>
    <p class="hint-line">Each model stands at its height in the game, next to a 1.7 m person (the grey figure). Set an asset's height in its 3D viewer.</p>
    <div class="lineup-legend">${items.map((a) => `<span class="chip">${esc(displayTitle(a.title))} <b>${esc(String(a.height_m))} m</b></span>`).join("")}</div></div>`);
  let view;
  $("#dialog").addEventListener("close", () => view?.dispose(), { once: true });
  try {
    const viewer = await viewerModule();
    const stage = $("#lineupStage");
    stage.innerHTML = "";
    view = await viewer.createLineup(stage, items.map((a) => ({ url: fileUrl(a.model), height: a.height_m, label: a.title })));
  } catch (err) { $("#lineupStage").innerHTML = `<p class="hint-line">Could not load the models: ${esc(err.message)}</p>`; }
}

async function batchDialog(folder, selection = null) {
  let plan;
  const query = selection ? selection.map((a) => `assets=${encodeURIComponent(a)}`).join("&") : `folder=${encodeURIComponent(folder)}`;
  try { [plan] = await Promise.all([api(`/api/studio/batch?${query}`), studioOptions()]); } catch (err) { return toast(err.message, true); }
  const where = selection ? "your selection" : folder ? humanize(folder.split("/").pop()) : "the project";
  if (!plan.assets.length) return toast(selection ? "None of the selected assets can be generated." : `Every asset in ${where} already has something to pick from.`);
  const images = plan.assets.filter((a) => !a.audio);
  const sounds = plan.assets.filter((a) => a.audio);
  const price = images.reduce((sum, a) => sum + (state.studio.models.find((m) => m.id === a.model)?.price || 0) * a.count, 0);
  const viaService = images.some((a) => String(a.model).startsWith("svc:"));
  const count = (list) => list.reduce((n, a) => n + a.count, 0);
  openDialog(`<form class="dlg sheet compact" id="batchForm">
    ${sheetHead("sparkle", "Generate", plural(plan.assets.length, "asset"), `${selection ? "New candidates for every asset in <b>your selection</b>, next to any they already have." : `Candidates for every asset in <b>${esc(where)}</b> that has nothing to pick from yet.`} Each uses its own prompt and pillars; two run at a time.`)}
    <div class="sheet-body">
      ${optBlock("Assets", `<div class="batch-list">${plan.assets.map((a) => `<label><input type="checkbox" name="asset" value="${esc(a.asset)}" checked><span>${esc(humanize(a.asset.split("/").pop()))}</span><small>${esc(dirOf(a.asset) || "root")} · ${a.count} ${a.audio ? "take" : "image"}${a.count === 1 ? "" : "s"}</small></label>`).join("")}</div>`, "Nothing is picked for you.")}
      ${images.length ? `<div class="opt-row">${optBlock("Images each", `<div class="seg" role="radiogroup">${[1, 2, 3, 4].map((n) => `<label><input type="radio" name="count" value="${n}" ${n === (images[0].count || 1) ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>`)}
        ${optBlock("Background", `<div class="seg" role="radiogroup">${[["", "Default"], ["cutout", "Removed"], ["scene", "Kept"]].map(([v, l]) => `<label><input type="radio" name="bg" value="${v}" ${v ? "" : "checked"}><span>${l}</span></label>`).join("")}</div>`)}</div>` : ""}
    </div>
    ${sheetFoot(`${[images.length ? `${plural(count(images), "image")}${state.agentCfg?.demo_mode ? "" : price ? ` · ≈ $${price.toFixed(2)}` : viaService ? " · paid in your signed-in service's credits" : ""}` : "", sounds.length ? plural(count(sounds), "sound") : ""].filter(Boolean).join(" · ")}${state.agentCfg?.demo_mode ? " · demo mode: placeholders, no cost" : ""}`, "sparkle", "Generate")}</form>`);
  $("#batchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const assets = [...event.target.querySelectorAll("input[name=asset]:checked")].map((i) => i.value);
    if (!assets.length) return toast("Tick at least one asset.", true);
    event.submitter && (event.submitter.disabled = true);
    try {
      const f = event.target;
      const res = await api("/api/studio/batch", { method: "POST", body: { assets, count: f.count ? Number(f.count.value) : undefined, background: f.bg?.value || undefined } });
      res.jobs.forEach((j) => { state.jobs[j.id] ||= j; });
      closeDialog();
      state.dockOpen = true;
      renderJobDock();
      toast(`Generating ${plural(res.jobs.length, "asset")}${res.skipped.length ? ` · ${res.skipped.length} skipped: ${res.skipped[0].reason}` : ""}`, Boolean(res.skipped.length));
    } catch (err) { toast(err.message, true); event.submitter && (event.submitter.disabled = false); }
  });
}

// The key art is an ordinary asset: make it, open its page and its Generate sheet, so the prompt, model and
// framing are on screen before anything is spent. Its first winner becomes the cover.
// The front page's lineup: the project's assets with a picture, a few from each section, big enough to see.
// ---------- the overview's sections: one row each, with how far along it is and a few of its pictures ----------

function wallHtml() {
  // The list of assets arrives a moment after the page; until it is this project's, there are no rows to draw.
  const assets = state.assetIndexProject === state.project ? Object.values(state.assetIndex || {}) : [];
  if (!assets.length) return "";
  const made = assets.filter((a) => a.picked).length, missing = assets.length - made;
  const sections = (state.overview?.sections || []).map((s) => {
    const inside = assets.filter((a) => a.path.startsWith(`${s.path}/`));
    return { ...s, inside, made: inside.filter((a) => a.picked).length };
  });
  const loose = assets.filter((a) => !a.path.includes("/"));
  const thumbs = (list) => {
    const pics = list.filter((a) => a.image).slice(0, 6);
    const sounds = pics.length < 6 ? list.filter((a) => a.audio && !a.image).slice(0, 6 - pics.length) : [];
    return [...pics.map((a) => `<img src="${esc(thumbUrl(a.image, 160))}" alt="" loading="lazy" decoding="async">`),
      ...sounds.map(() => `<span class="sum-snd">${icon("sound")}</span>`)].join("");
  };
  const row = (s) => {
    const n = s.inside.length, pct = n ? Math.round(s.made / n * 100) : 0;
    return `<button type="button" class="sec-sum${n && s.made === n ? " done" : ""}" data-folder="${esc(s.path)}">
      <span class="sec-sum-num">${esc(s.number || "")}</span>
      <span class="sec-sum-text"><strong>${esc(s.title)}</strong>${s.excerpt ? `<small>${esc(s.excerpt)}</small>` : ""}</span>
      <span class="sec-sum-thumbs">${thumbs(s.inside)}</span>
      <span class="sec-sum-prog">${n ? `<span><b>${s.made}</b> of ${n} made</span><i class="wall-meter"><i style="width:${pct}%"></i></i>${n - s.made ? `<em>${n - s.made} to go</em>` : `<em class="ok">Done</em>`}` : `<span class="none">No assets yet</span>`}</span>
      <span class="chev">›</span>
    </button>`;
  };
  return `<section class="wall-wrap" aria-label="Sections of ${esc(projectTitle())}">
    <div class="wall-head">
      <div class="wall-made" title="${made} of ${assets.length} assets have a picked winner"><b>${made}</b><span>of ${assets.length} made</span><i class="wall-meter"><i style="width:${Math.round(made / assets.length * 100)}%"></i></i></div>
      <span class="grow"></span>
      <span class="home-model-tools" id="homeModelTools"></span>
      <button class="ghost" type="button" data-press-kit title="A page and a ZIP of everything made so far">${icon("download")} Press kit</button>
      ${missing ? `<button class="primary" type="button" data-batch="">${icon("sparkle")} Generate ${missing} missing</button>` : ""}
    </div>
    <div class="sec-sum-list">${sections.map(row).join("")}</div>
    ${loose.length ? `<div class="sec-sum-loose">${loose.map((a) => `<button type="button" class="loose-chip" data-open="${esc(a.path)}">${a.image ? `<img src="${esc(thumbUrl(a.image, 80))}" alt="">` : ""}${esc(displayTitle(a.title))}</button>`).join("")}</div>` : ""}
  </section>`;
}

// The asset list has arrived or changed: redraw the wall where it stands, without redrawing the page around it.
function refreshWall() {
  if (state.view.type !== "home") return;
  const html = wallHtml();
  const old = document.querySelector("#content .wall-wrap") || document.querySelector("#content > .actions-row");
  if (!html || !old) return;
  old.outerHTML = html;
  fillHomeModelTools();
}

// 36 squares over a new picture that let go one after another: the picture resolves tile by tile, once.
function revealSquares() {
  let html = "";
  for (let i = 0; i < 36; i++) html += `<i style="--d:${(i % 6 + Math.floor(i / 6)) * 38 + Math.round(Math.random() * 110)}ms"></i>`;
  return `<span class="sq-reveal" aria-hidden="true">${html}</span>`;
}

function showcaseStrip(items) {
  if (items.length < 3) return "";
  return `<div class="showcase">${items.map((s) => `<button type="button" class="show-card" data-open="${esc(s.path)}" title="${esc(s.title)}">
    <span class="show-img"><img src="${esc(thumbUrl(s.thumb, 320))}" alt="" loading="lazy" decoding="async"></span>
    <span class="show-meta"><strong>${esc(displayTitle(s.title))}</strong><small>${esc(s.kind)}</small></span></button>`).join("")}</div>`;
}

// The first message that turns an empty game project into a workspace, for Tess or a coding agent.
function gameBuildPrompt(game, agent = false) {
  return agent
    ? `Build the Tessera workspace for this game (${game.title}) from its design docs, using Tessera's tools. Don't generate any images yet.`
    : `Build the workspace for my game ${game.title}. Read its design docs in ${game.folder} (README, design notes), then make the front page with the pitch, one section per part of the game, pillars/style-bible.md from the art direction, and an asset page for every character, creature, item, place and sound it names. Don't generate anything yet.\n\nMy pitch, if you want it on top: `;
}

// The by-hand 3D route on the overview, where it's found: Tripo export for everything waiting, and pairing downloads.
async function fillHomeModelTools() {
  if (!$("#homeModelTools")) return;  // the wall replaces these buttons: nothing to fill, nothing to fetch
  try { state.modelInbox = await api("/api/model-inbox"); } catch { return; }
  const box = state.modelInbox;
  const host = $("#homeModelTools");
  if (!host || !box) return;
  host.innerHTML = `${box.waiting ? `<button class="ghost" data-tripo-all title="Picked images of every asset without a model, named and in folders of 30, for Tripo Studio">${icon("cube")} Export ${plural(box.waiting, "image")} for Tripo</button>` : ""}${box.unpaired ? `<button class="primary" data-pair-open>${icon("cube")} Pair ${plural(box.unpaired, "downloaded model")}</button>` : ""}`;
}

// What the game's coding agent asked for in tessera/REQUESTS.md: open items, with a button that drafts a chat message.
// A project made before Tessera Studio 4 keeps its old folders until the user upgrades it (forge/migrate.py).
function upgradeCard() {
  const up = state.upgrade;
  if (!up?.needed) return "";
  return `<section class="upgrade-card"><span class="ub-dot"></span><div class="grow">
      <h2>Simpler folders for this project</h2>
      <p>Your art moves to <code>art/</code>, engine copies to <code>export/</code>, and Tessera's own files into one hidden <code>.studio/</code> folder${up.home !== up.new_home ? `; <code>glob/</code> becomes <code>tessera/</code>` : ""}. Nothing is deleted, and you can undo it.</p>
      ${up.blocked ? `<p class="bad-text">${esc(up.blocked)}</p>` : ""}
    </div><button class="mini on" data-upgrade-open${up.blocked ? " disabled" : ""}>Review the move</button></section>`;
}

async function runUpgrade(undo = false) {
  const project = state.project;
  try {
    await api(`/api/projects/${encodeURIComponent(project)}/upgrade`, { method: "POST", body: { undo } });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  closeDialog();
  await loadOverview();
  if (undo) toast("Put back the way it was.");
  else toast("Project upgraded to the new folders.", false, { label: "Undo", run: () => runUpgrade(true) });
}

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-upgrade-go]")) { event.target.closest("[data-upgrade-go]").disabled = true; runUpgrade(); return; }
  if (!event.target.closest("[data-upgrade-open]") || !state.upgrade?.needed) return;
  const up = state.upgrade;
  openDialog(`<form method="dialog" class="upgrade-dlg">
    <h2>Upgrade ${esc(projectTitle())}</h2>
    <p>These folders are renamed in place, in <code>${esc(up.home)}</code>. No file is copied or deleted; ASSETS.md and your game's agent note are rewritten for the new paths.</p>
    <pre class="upgrade-steps">${up.lines.map(esc).join("\n")}</pre>
    <p class="faint">Changed your mind later? Run <code>tessera migrate --undo</code> in the game folder.</p>
    <div class="actions-row"><button value="cancel" class="ghost">Not now</button><button type="button" class="primary" data-upgrade-go>Upgrade</button></div>
  </form>`);
});

function requestsCard(req) {
  if (!req?.open?.length) return "";
  const done = req.done || [];
  return `<section class="requests-card"><h2>${icon("sparkle")} Requests from the game · ${req.open.length}</h2>
    <p>The game's coding agent wrote these to <code>tessera/REQUESTS.md</code>. Nothing is made until you say so.</p>
    <ul>${req.open.map((t) => `<li>${esc(t)}</li>`).join("")}${done.slice(0, 5).map((t) => `<li class="done">${esc(t)}</li>`).join("")}</ul>
    <div class="actions-row"><button class="ghost" data-requests-chat>${icon("sparkle")} Go through them in chat</button></div></section>`;
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-requests-chat]") || !state.overview?.requests?.open?.length) return;
  setChatHidden(false);
  showPanel("chat");
  const input = $("#input");
  input.value = `The game asked for these in tessera/REQUESTS.md:\n${state.overview.requests.open.map((t) => `- ${t}`).join("\n")}\n\nGo through them with me: say which assets already exist, which need a new page or a change (with height_m), and what generating would cost. Don't generate anything yet.`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-game-build]") || !state.overview?.game) return;
  setChatHidden(false);
  showPanel("chat");
  const input = $("#input");
  input.value = gameBuildPrompt(state.overview.game);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});

async function makeKeyArt(project, btn) {
  if (btn) btn.disabled = true;
  try {
    if (project !== state.project) await switchProject(project);
    const res = await api("/api/overview/key-art?start=false", { method: "POST" });
    go({ type: "doc", path: res.asset });
    await openPreview("candidates");
  } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
}

async function installSample(btn) {
  if (btn) { btn.disabled = true; btn.classList.add("busy"); }
  try {
    const res = await api("/api/projects/sample", { method: "POST", body: {} });
    if (!$("#onboarding").hidden) hideScene($("#onboarding"));
    closeProjects();
    await switchProject(res.project);
    toast("Pocket Kaiju is yours to explore. Looking around costs nothing; generating spends credits as usual.");
  } catch (err) { toast(err.message, true); if (btn) { btn.disabled = false; btn.classList.remove("busy"); } }
}

function downloadPressKit() {
  const a = Object.assign(document.createElement("a"), { href: `/api/press-kit?project=${encodeURIComponent(state.project)}`, download: `${state.project}-press-kit.zip` });
  document.body.append(a);
  a.click();
  a.remove();
  toast("Press kit downloading: unzip and open index.html, or upload the folder to itch.io or any static host.");
}

// A running job's elapsed time ("1:05"), ticking once a second, so a long wait doesn't look like a hang.
function fmtElapsed(sec) { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }
function sinceTag(j) {
  if (!j?.started_at) return "";
  return ` <span class="since" data-since="${Number(j.started_at)}">${fmtElapsed(Date.now() / 1000 - j.started_at)}</span>`;
}
setInterval(() => {
  const now = Date.now() / 1000;
  document.querySelectorAll("[data-since]").forEach((el) => { el.textContent = fmtElapsed(now - Number(el.dataset.since)); });
}, 1000);

// Live and waiting generation jobs, bottom right, on every page.
// Jobs live in the status bar (a count) and the bottom panel's Jobs tab (the list). The name stays: many places call it.
function renderJobDock() {
  renderStatusBar();
  renderJobsPane();
}

const JOB_ORDER = { running: 0, queued: 1, failed: 2, done: 3 };
function jobsPopHtml() {
  const jobs = Object.values(state.jobs).sort((a, b) => (JOB_ORDER[a.status] ?? 4) - (JOB_ORDER[b.status] ?? 4));
  const live = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  if (!jobs.length) return `<div class="pop-head">Jobs</div><p class="pop-empty with-art">${tessArt("idle", "sm")}Nothing running. Images, 3D models, rigs and sounds you start show up here.</p>`;
  return `<div class="pop-head">Jobs<small>${live ? `${live} running or waiting` : "all done"}</small></div>
    <ul class="job-list">${jobs.slice(0, 60).map((j) => {
      const name = humanize(String(j.asset || "").split("/").pop() || "");
      const label = jobLabel(j) || j.action || "Job";
      const status = j.status === "queued" ? "waiting" : j.status === "running" ? `running${sinceTag(j)}` : j.status === "failed" ? "failed" : "done";
      return `<li><span class="state ${esc(j.status)}"></span>
        <span class="what"><button type="button" data-open="${esc(j.asset)}" title="Open ${esc(name)}">${esc(name || label)}</button><small>${esc(label)} · ${esc(status)}</small>${j.status === "failed" && j.error ? `<span class="err">${esc(j.error)}</span>` : ""}</span>
        ${j.status === "queued" ? `<button type="button" class="seg" data-job-cancel="${esc(j.id)}">Cancel</button>` : "<span></span>"}</li>`;
    }).join("")}</ul>`;
}
function renderJobsPane() {
  if (shell.popOpen("jobs")) shell.openPop("jobs", jobsPopHtml(), document.querySelector("[data-sb='jobs']"));
}

// ---------- editor frame: status bar, requests, tree counts ----------

// The board's payload, fetched once and kept until the workspace changes (the websocket clears state.board).
async function loadBoard() { return (state.board ||= await api("/api/board")); }

// Every asset in the project, for the status bar's counts and the inspector (refreshed when files change).
async function loadAssetIndex() {
  const project = state.project;
  try {
    state.board = null;  // the workspace may just have changed: fetch it fresh, once
    const board = await loadBoard();
    if (project !== state.project) return;
    state.assetIndex = Object.fromEntries(board.groups.flatMap((g) => g.assets.map((a) => [a.path, { ...a, section: g.title }])));
    state.assetIndexProject = project;
  } catch { state.assetIndex = state.assetIndex || {}; }
  renderStatusBar();
  renderSectionCounts();
  refreshWall();
  if (state.view.type === "doc") mountAssetRail();
}

// No model can answer Tess and no coding agent is still being checked: the chat, and Tess sorting drops, need one.
function agentMissing() {
  const info = state.modelInfo;
  if (!info || (state.models || []).some((m) => m.ready)) return false;
  return !(info.clis || []).some((c) => c.status === "checking" || c.status === "installing");
}

function renderStatusBar() {
  const bar = $("#statusBar");
  if (!bar) return;
  const assets = Object.values(state.assetIndex || {});
  const missing = assets.filter((a) => !a.picked).length;
  const live = Object.values(state.jobs).filter((j) => j.status === "running" || j.status === "queued");
  const failed = Object.values(state.jobs).filter((j) => j.status === "failed").length;
  const linked = Boolean(state.connect?.connected);
  // The engine's title when the game has one; the folder's name only as a fallback.
  const gameName = linked ? state.connect.game_name || String(state.connect.game_folder || state.connect.folder || state.connect.game || "Game").split(/[\\/]/).filter(Boolean).pop() : "";
  bar.innerHTML = `
    <button type="button" class="sb" data-sb="game" title="${linked ? `Linked to ${esc(state.connect.game_folder || gameName)} · open the pipeline` : "No game folder linked yet"}"><span class="dot${linked ? " ok" : ""}"></span>${linked ? esc(gameName) : "No game linked"}</button>
    ${state.link?.totals?.stale ? `<button type="button" class="sb" data-sb="stale" title="The game has older copies of art that changed since"><span class="dot warn"></span><span class="num">${state.link.totals.stale}</span> out of date in game</button>` : ""}
    ${missing ? `<button type="button" class="sb wide miss" data-sb="missing" title="Assets without a picked winner"><span class="num">${missing}</span> without a winner</button>` : ""}
    <span class="grow"></span>
    ${state.agentCfg?.demo_mode ? `<button type="button" class="sb" data-sb="demo" title="No generator is connected, so new art is a placeholder and nothing is spent. Connect an account to make real art."><span class="dot warn"></span>Demo mode · placeholders</button>` : ""}
    ${agentMissing() ? `<button type="button" class="sb tess-off" data-sb="connect-agent" title="Tess runs on your Claude Code, Codex, Gemini CLI or OpenCode login"><span class="dot warn"></span>Connect an agent to use Tess</button>` : ""}
    ${state.requests?.open?.length ? `<button type="button" class="sb" data-sb="requests" title="What your coding agent asked for"><span class="dot warn"></span><span class="num">${state.requests.open.length}</span> ${state.requests.open.length === 1 ? "request" : "requests"}</button>` : ""}
    ${live.length || failed ? `<button type="button" class="sb" data-sb="jobs" title="Jobs">${live.length ? `<span class="dot busy"></span><span class="num">${live.length}</span> running` : `<span class="dot warn"></span>${plural(failed, "failed job")}`}</button>` : ""}
    <span class="sb wide ver" title="Tessera Studio">${esc(state.version || "")}</span>`;
}

document.addEventListener("click", (event) => {
  const sb = event.target.closest("[data-sb]");
  if (!sb) return;
  const what = sb.dataset.sb;
  if (what === "jobs") return shell.popOpen("jobs") ? shell.closePop() : shell.openPop("jobs", jobsPopHtml(), sb);
  if (what === "requests") return shell.popOpen("requests") ? shell.closePop() : shell.openPop("requests", requestsPopHtml(), sb);
  else if (what === "tess") shell.openChat();
  else if (what === "connect-agent") settingsDialog("models");
  else if (what === "demo") settingsDialog("accounts");
  else if (what === "assets" || what === "missing") go({ type: "board" });
  else if (what === "game") go({ type: "pipeline" });
  else if (what === "stale") { state.plFilter = "stale"; go({ type: "pipeline" }); }
});

async function loadRequests() {
  try { state.requests = await api("/api/requests"); } catch { state.requests = { open: [], done: [] }; }
  renderStatusBar();
}

function requestsPopHtml() {
  const data = state.requests || { open: [], done: [] };
  if (!data.open.length && !data.done.length) return `<div class="pop-head">Requests</div><p class="pop-empty with-art">${tessArt("step-1", "sm")}When your coding agent needs art it doesn't have, it writes it to tessera/REQUESTS.md and it shows up here.</p>`;
  return `<div class="pop-head">Requests<small>from your coding agent</small></div>
    <ul class="req-list">${data.open.map((r) => `<li><span class="box"></span><span class="txt">${esc(r)}</span><button type="button" class="seg" data-request-make="${esc(r)}" title="Ask Tess to make it">Ask Tess</button></li>`).join("")}
    ${data.done.slice(0, 20).map((r) => `<li class="done"><span class="box"></span><span class="txt">${esc(r)}</span><span></span></li>`).join("")}</ul>`;
}

document.addEventListener("click", (event) => {
  const make = event.target.closest("[data-request-make]");
  if (!make) return;
  shell.closePop();
  shell.openChat();
  const input = $("#input");
  input.value = `My game's coding agent asked for this: ${make.dataset.requestMake}\nPlan it and make it.`;
  autoGrow();
  input.focus();
});

// The status bar follows Tess (working or ready) and the chat window.
shell.onLayoutChange(() => renderStatusBar());

// Asset counts and "no winner" marks on the section buttons in the tree.
function renderSectionCounts() {
  const all = Object.values(state.assetIndex || {});
  document.querySelectorAll("#sections .sec[data-folder]").forEach((btn) => {
    const path = btn.dataset.folder;
    const inside = all.filter((a) => a.path.startsWith(`${path}/`));
    btn.querySelector(".sec-count")?.remove();
    btn.querySelector(".sec-miss")?.remove();
    if (!inside.length) return;
    const miss = inside.filter((a) => !a.picked).length;
    btn.insertAdjacentHTML("beforeend", `${miss ? `<span class="sec-miss" title="${plural(miss, "asset")} without a winner">${miss}</span>` : ""}<span class="sec-count">${inside.length}</span>`);
  });
}

// ---------- opening an asset: the tile's picture grows into the page, and a filmstrip of its folder ----------

// The other assets in the same folder, in the folder's order.
function siblingsOf(path) {
  const folder = dirOf(path);
  return Object.values(state.assetIndex || {}).filter((a) => dirOf(a.path) === folder);
}

// A strip across the top of an asset page: every asset in its folder, the current one lit, arrows and J/K to step.
function mountAssetRail() {
  const content = $("#content");
  content.querySelector(".asset-rail")?.remove();
  if (state.view.type !== "doc") return;
  const list = siblingsOf(state.view.path);
  const index = list.findIndex((a) => a.path === state.view.path);
  if (index < 0 || list.length < 2) return;
  const prev = list[index - 1], next = list[index + 1];
  const rail = document.createElement("nav");
  rail.className = "asset-rail";
  rail.setAttribute("aria-label", "Assets in this folder");
  rail.innerHTML = `
    <button type="button" class="rail-step" data-rail-step="-1" ${prev ? `title="Previous: ${esc(displayTitle(prev.title))} (K)"` : "disabled"} aria-label="Previous asset">${icon("chev-left")}</button>
    <div class="rail-track">${list.map((a, i) => `<button type="button" class="rail-item${i === index ? " current" : ""}${a.picked ? "" : " missing"}" data-rail="${esc(a.path)}" title="${esc(displayTitle(a.title))}"${i === index ? ' aria-current="page"' : ""}>
      ${a.image ? `<img src="${esc(thumbUrl(a.image, 160))}" alt="" loading="lazy" decoding="async">` : `<span class="rail-none">${a.audio ? icon("play") : esc(displayTitle(a.title).slice(0, 2))}</span>`}</button>`).join("")}</div>
    <button type="button" class="rail-step" data-rail-step="1" ${next ? `title="Next: ${esc(displayTitle(next.title))} (J)"` : "disabled"} aria-label="Next asset">${icon("chev-right")}</button>
    <span class="rail-pos"><b>${index + 1}</b> / ${list.length}<span class="rail-folder">${esc(humanize(dirOf(state.view.path).split("/").pop() || projectTitle()))}</span></span>`;
  content.prepend(rail);
  const cur = rail.querySelector(".rail-item.current");
  const track = rail.querySelector(".rail-track");
  if (cur && track) track.scrollLeft = cur.offsetLeft - track.clientWidth / 2 + cur.clientWidth / 2;
}

function stepAsset(delta) {
  const list = siblingsOf(state.view.path);
  const index = list.findIndex((a) => a.path === state.view.path);
  const target = list[index + delta];
  if (target) go({ type: "doc", path: target.path });
}

document.addEventListener("click", (event) => {
  const item = event.target.closest("[data-rail]");
  if (item) { if (!item.classList.contains("current")) go({ type: "doc", path: item.dataset.rail }); return; }
  const step = event.target.closest("[data-rail-step]");
  if (step && !step.disabled) stepAsset(Number(step.dataset.railStep));
});

// Page changes animate with the View Transitions API (Chromium, so the desktop app too): the content cross-fades,
// and when an asset opens, the picture you clicked flies into the page's hero, and back again on the way out.
// Without the API, or with reduced motion, pages simply change.
const canMorph = () => typeof document.startViewTransition === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
const heroImage = () => document.querySelector("#content .winner-box > img:not([hidden]), #content .winner-box .hero-poster");
const pictureFor = (path) => (path ? document.querySelector(`#content [data-rail="${CSS.escape(path)}"] img, #content [data-open="${CSS.escape(path)}"] img`) : null);

function transitionTo(from, to, update) {
  if (!canMorph()) return update();
  let src = null;
  if (to.type === "doc") src = from.type === "doc" ? pictureFor(to.path) : pictureFor(to.path);
  else if (from.type === "doc") src = heroImage();
  // Only morph when there is a picture to fly; a plain page change is instant (a full-page transition costs a frame or two).
  if (!src) return update();
  src.style.viewTransitionName = "asset-hero";
  const vt = document.startViewTransition(async () => {
    if (src) src.style.viewTransitionName = "";
    await update();
    const dst = to.type === "doc" ? heroImage() : from.type === "doc" ? pictureFor(from.path) : null;
    if (src && dst) dst.style.viewTransitionName = "asset-hero";
  });
  // A transition that cannot run (the window is hidden) is not an error: the page has changed all the same.
  vt.ready.catch(() => {});
  vt.finished.catch(() => {}).finally(() => document.querySelectorAll("#content img[style*='view-transition-name']").forEach((img) => { img.style.viewTransitionName = ""; }));
}

// ---------- folder grids: filter chips, sort and thumbnail size, remembered; and quick look on Space ----------

const GRID_KEY = "tessera.grid";
const GRID_SIZE = [110, 300];
const GRID_FILTERS = [
  ["all", "All", () => true],
  ["nowin", "No winner", (f) => f.includes("nowin")],
  ["3d", "3D", (f) => f.includes("3d")],
  ["rig", "Rigged", (f) => f.includes("rig")],
  ["sound", "Sound", (f) => f.includes("sound")],
];
const GRID_SORTS = [["folder", "Folder order"], ["name", "Name"], ["recent", "Recently changed"], ["nowin", "No winner first"]];

function gridPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRID_KEY) || "null");
    if (saved && typeof saved === "object") return { size: 150, folders: {}, ...saved };
  } catch { /* storage blocked */ }
  return { size: 150, folders: {} };
}
function saveGridPrefs(prefs) {
  try { localStorage.setItem(GRID_KEY, JSON.stringify(prefs)); } catch { /* private window */ }
}
const folderPrefs = (prefs, path) => ({ filter: "all", sort: "folder", ...(prefs.folders[path] || {}) });

const tileFlags = (f) => [f.picked === false ? "nowin" : "", f.model ? "3d" : "", f.rigged ? "rig" : "", f.audio ? "sound" : ""].filter(Boolean).join(" ");

function gridBar(assets, folderPath) {
  const flags = assets.map(tileFlags);
  const chips = GRID_FILTERS.map(([id, label, test]) => [id, label, flags.filter(test).length]).filter(([id, , n]) => id === "all" || (n > 0 && n < assets.length));
  return `<div class="grid-bar" data-grid-bar="${esc(folderPath)}">
    <div class="grid-chips" role="group" aria-label="Filter">${chips.length > 1 ? chips.map(([id, label, n]) => `<button type="button" class="gchip" data-grid-filter="${id}">${esc(label)}<span>${n}</span></button>`).join("") : ""}</div>
    <span class="grow"></span>
    <label class="grid-sort" title="Sort">${icon("sort")}<select data-grid-sort aria-label="Sort">${GRID_SORTS.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join("")}</select></label>
    <label class="grid-size" title="Thumbnail size (Ctrl + and Ctrl −)">${icon("grid")}<input type="range" min="${GRID_SIZE[0]}" max="${GRID_SIZE[1]}" step="10" data-grid-size aria-label="Thumbnail size"></label>
  </div>`;
}

// Filtering and sorting happen in place (CSS order and a class), so changing them never refetches or jumps.
function applyGrid(grid) {
  const path = grid.dataset.grid;
  const prefs = gridPrefs();
  const { filter, sort } = folderPrefs(prefs, path);
  grid.style.setProperty("--tile", `${prefs.size}px`);
  const test = (GRID_FILTERS.find(([id]) => id === filter) || GRID_FILTERS[0])[2];
  const tiles = [...grid.querySelectorAll(".asset-tile[data-tile]")];
  const order = [...tiles];
  if (sort === "name") order.sort((a, b) => a.dataset.name.localeCompare(b.dataset.name, undefined, { numeric: true }));
  else if (sort === "recent") order.sort((a, b) => Number(b.dataset.changed || 0) - Number(a.dataset.changed || 0));
  else if (sort === "nowin") order.sort((a, b) => Number(b.dataset.flags.includes("nowin")) - Number(a.dataset.flags.includes("nowin")));
  let shown = 0;
  order.forEach((tile, i) => {
    tile.style.order = String(i);
    const keep = test(tile.dataset.flags || "");
    tile.classList.toggle("filtered-out", !keep);
    shown += keep;
  });
  grid.querySelector(".asset-tile.add")?.style.setProperty("order", "99999");
  grid.querySelector(".grid-none")?.remove();
  // On a section page one bar filters every subsection: a grid with nothing left just folds away.
  const inSection = Boolean(grid.closest(".subsec"));
  grid.classList.toggle("all-filtered", inSection && !shown && tiles.length > 0);
  if (!shown && tiles.length && !inSection) grid.insertAdjacentHTML("beforeend", `<p class="grid-none">Nothing here matches. <button type="button" class="link-btn" data-grid-filter="all">Show all</button></p>`);
  const bar = document.querySelector(`#content .grid-bar[data-grid-bar="${CSS.escape(path)}"]`);
  if (bar) {
    bar.querySelectorAll("[data-grid-filter]").forEach((b) => b.classList.toggle("on", b.dataset.gridFilter === filter));
    const select = bar.querySelector("[data-grid-sort]");
    if (select) select.value = sort;
    const range = bar.querySelector("[data-grid-size]");
    if (range) range.value = String(prefs.size);
  }
}
const applyGrids = () => document.querySelectorAll("#content .asset-grid[data-grid]").forEach(applyGrid);

function setGridPref(path, patch) {
  const prefs = gridPrefs();
  prefs.folders[path] = { ...folderPrefs(prefs, path), ...patch };
  saveGridPrefs(prefs);
  applyGrids();
}
function setGridSize(size) {
  const prefs = gridPrefs();
  prefs.size = Math.max(GRID_SIZE[0], Math.min(GRID_SIZE[1], Math.round(size / 10) * 10));
  saveGridPrefs(prefs);
  applyGrids();
}
const gridOf = (el) => el.closest(".grid-bar")?.dataset.gridBar ?? el.closest(".asset-grid[data-grid]")?.dataset.grid;

document.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-grid-filter]");
  if (chip) setGridPref(gridOf(chip) ?? "", { filter: chip.dataset.gridFilter });
});
document.addEventListener("change", (event) => {
  if (event.target.matches("[data-grid-sort]")) setGridPref(gridOf(event.target) ?? "", { sort: event.target.value });
});
document.addEventListener("input", (event) => {
  if (event.target.matches("[data-grid-size]")) setGridSize(Number(event.target.value));
});

// ---------- quick look: Space on the tile under the pointer (or focused) shows it big, without leaving the folder ----------

let hoverTile = null;
document.addEventListener("pointerover", (event) => { hoverTile = event.target.closest?.("#content .asset-tile[data-tile]") || hoverTile; });
document.addEventListener("pointerout", (event) => { if (hoverTile && !hoverTile.contains(event.relatedTarget)) hoverTile = null; });

const visibleTiles = () => [...document.querySelectorAll("#content .asset-tile[data-tile]:not(.filtered-out)")].sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0));

function quickLook(tile) {
  const tiles = visibleTiles();
  const index = Math.max(0, tiles.indexOf(tile));
  const t = tiles[index];
  if (!t) return;
  state.peek = { path: t.dataset.tile };
  let box = $("#quickLook");
  if (!box) {
    box = Object.assign(document.createElement("div"), { id: "quickLook", className: "quick-look" });
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Quick look");
    document.body.append(box);
  }
  const a = state.assetIndex?.[t.dataset.tile] || {};
  const image = a.image || t.dataset.thumb || "";
  const title = t.dataset.name;
  box.hidden = false;
  box.innerHTML = `<div class="ql-card">
      <div class="ql-stage">${image ? `<img src="${esc(fileUrl(image))}" alt="">` : `<div class="ql-none">${kindArt(t.dataset.kind || "")}</div>`}
        ${index > 0 ? `<button type="button" class="ql-nav prev" data-ql-step="-1" aria-label="Previous">${icon("chev-left")}</button>` : ""}
        ${index < tiles.length - 1 ? `<button type="button" class="ql-nav next" data-ql-step="1" aria-label="Next">${icon("chev-right")}</button>` : ""}</div>
      <div class="ql-foot">
        <div class="ql-name"><strong>${esc(title)}</strong><small>${esc(t.dataset.kind || "asset")}${a.picked === false ? " · no winner yet" : ""}${a.model ? " · 3D" : ""} · ${index + 1} / ${tiles.length}</small></div>
        ${t.dataset.audio ? `<audio src="${esc(fileUrl(t.dataset.audio))}" controls autoplay></audio>` : ""}
        <span class="grow"></span>
        <span class="ql-keys"><kbd>←</kbd><kbd>→</kbd> step · <kbd>Space</kbd> close</span>
        <button type="button" class="primary" data-ql-open>Open <kbd>↵</kbd></button>
      </div>
    </div>`;
  box.dataset.index = String(index);
}
function closeQuickLook() {
  const box = $("#quickLook");
  if (box) { box.hidden = true; box.innerHTML = ""; }
  state.peek = null;
}
function stepQuickLook(delta) {
  const tiles = visibleTiles();
  const next = tiles[Number($("#quickLook")?.dataset.index || 0) + delta];
  if (next) { quickLook(next); next.scrollIntoView({ block: "nearest" }); }
}
document.addEventListener("click", (event) => {
  if (!state.peek) return;
  const step = event.target.closest("[data-ql-step]");
  if (step) return stepQuickLook(Number(step.dataset.qlStep));
  if (event.target.closest("[data-ql-open]")) { const path = state.peek.path; closeQuickLook(); return go({ type: "doc", path }); }
  if (!event.target.closest(".ql-card")) closeQuickLook();
});
// Capture phase, so quick look owns these keys while it is open.
document.addEventListener("keydown", (event) => {
  if (state.peek) {
    if (event.key === " " || event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); return closeQuickLook(); }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); event.stopImmediatePropagation(); return stepQuickLook(event.key === "ArrowRight" ? 1 : -1); }
    if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); const path = state.peek.path; closeQuickLook(); return go({ type: "doc", path }); }
    return;
  }
  if (event.target.closest?.("input, textarea, select, [contenteditable]") || $("#dialog")?.open) return;
  if (event.key === " " && !event.ctrlKey && !event.metaKey) {
    const tile = document.activeElement?.closest?.("#content .asset-tile[data-tile]") || hoverTile;
    if (tile && document.contains(tile)) { event.preventDefault(); event.stopImmediatePropagation(); quickLook(tile); }
    return;
  }
  // Ctrl + / Ctrl − resize thumbnails on pages with a grid (instead of zooming the whole app).
  if ((event.ctrlKey || event.metaKey) && ["=", "+", "-"].includes(event.key) && document.querySelector("#content .asset-grid[data-grid]")) {
    event.preventDefault();
    setGridSize(gridPrefs().size + (event.key === "-" ? -20 : 20));
  }
}, true);

// ---------- asset tiles: right-click menu, drag onto a folder, and Undo for every change ----------

state.undo = [];
function pushUndo(label, run) {
  state.undo.push({ label, run });
  if (state.undo.length > 20) state.undo.shift();
  toast(label, false, { label: "Undo", run: () => runUndo() });
}
async function runUndo() {
  const last = state.undo.pop();
  if (!last) return toast("Nothing to undo");
  try { await last.run(); toast("Undone"); } catch (err) { toast(err.message, true); }
  await refreshAfterChange();
}
async function refreshAfterChange() {
  await renderView();
  loadAssetIndex();
}

function allFolders() {
  const out = [];
  const walk = (nodes, depth) => (nodes || []).forEach((n) => { out.push({ path: n.path, title: n.title, depth }); walk(n.children, depth + 1); });
  walk(state.overview?.sections, 0);
  return out;
}

async function moveAssets(paths, folder) {
  const res = await api("/api/overview/move", { method: "POST", body: { paths, folder } });
  const moved = res.moved.filter((m) => m.from !== m.to);
  if (!moved.length) return;
  if (state.view.type === "doc") { const m = moved.find((x) => x.from === state.view.path); if (m) state.view = { type: "doc", path: m.to }; }
  pushUndo(`Moved ${moved.length === 1 ? displayTitle(humanize(moved[0].to.split("/").pop().replace(/\.md$/, ""))) : plural(moved.length, "asset")} to ${humanize(folder.split("/").pop() || "the top")}`, async () => {
    for (const m of moved) await api("/api/overview/move", { method: "POST", body: { paths: [m.to], folder: dirOf(m.from) } });
  });
  await refreshAfterChange();
}

async function renameAsset(path, name) {
  const res = await api("/api/overview/move", { method: "POST", body: { paths: [path], name } });
  const m = res.moved[0];
  if (!m || m.from === m.to) return;
  if (state.view.type === "doc" && state.view.path === path) state.view = { type: "doc", path: m.to };
  const oldStem = path.split("/").pop().replace(/\.md$/, "");
  pushUndo(`Renamed to ${humanize(m.to.split("/").pop().replace(/\.md$/, ""))}`, () => api("/api/overview/move", { method: "POST", body: { paths: [m.to], name: oldStem } }));
  await refreshAfterChange();
}

async function trashAssets(paths) {
  const res = await api("/api/overview/trash", { method: "POST", body: { paths } });
  if (state.view.type === "doc" && paths.includes(state.view.path)) state.view = { type: "folder", path: dirOf(state.view.path) };
  pushUndo(`Deleted ${paths.length === 1 ? displayTitle(humanize(paths[0].split("/").pop().replace(/\.md$/, ""))) : plural(paths.length, "asset")}`, () => api("/api/overview/restore", { method: "POST", body: { items: res.items } }));
  await refreshAfterChange();
}

function renameDialog(path) {
  const current = displayTitle(humanize(path.split("/").pop().replace(/\.md$/, "")));
  openDialog(`<form class="dlg" id="renameForm"><h2>Rename</h2>
    <p>The page, its folder of outputs and the paths inside it are renamed together.</p>
    <input name="name" value="${esc(current)}" autocomplete="off" required>
    <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Rename</button></div></form>`);
  const input = $("#renameForm [name=name]");
  input.select();
  $("#renameForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    closeDialog();
    try { await renameAsset(path, input.value.trim()); } catch (err) { toast(err.message, true); }
  });
}

function moveDialog(paths) {
  const here = dirOf(paths[0]);
  const folders = allFolders().filter((f) => f.path !== here);
  openDialog(`<form class="dlg move-dlg" id="moveForm"><h2>Move ${paths.length === 1 ? esc(displayTitle(humanize(paths[0].split("/").pop().replace(/\.md$/, "")))) : plural(paths.length, "asset")}</h2>
    <input name="q" placeholder="Find a folder" autocomplete="off">
    <div class="move-list">${folders.map((f) => `<button type="button" class="move-row" data-move-to="${esc(f.path)}" style="padding-left:${10 + f.depth * 16}px">${icon("folder")}<span>${esc(f.title)}</span><small>${esc(f.path)}</small></button>`).join("")}</div>
    <div class="row"><button type="button" class="ghost" data-close>Cancel</button></div></form>`);
  const q = $("#moveForm [name=q]");
  q.focus();
  q.addEventListener("input", () => {
    const needle = q.value.toLowerCase();
    $("#moveForm").querySelectorAll(".move-row").forEach((r) => { r.hidden = needle && !r.textContent.toLowerCase().includes(needle); });
  });
  $("#moveForm").addEventListener("submit", (event) => { event.preventDefault(); $("#moveForm .move-row:not([hidden])")?.click(); });
  $("#moveForm").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-move-to]");
    if (!row) return;
    closeDialog();
    try { await moveAssets(paths, row.dataset.moveTo); } catch (err) { toast(err.message, true); }
  });
}

// The menu itself: one small floating list at the pointer, gone on any click, scroll or Esc.
function closeTileMenu() { $("#tileMenu")?.remove(); }
function openTileMenu(path, x, y) {
  closeTileMenu();
  const menu = Object.assign(document.createElement("div"), { id: "tileMenu", className: "tile-menu" });
  menu.setAttribute("role", "menu");
  const items = [
    ["open", "Open", "↵"], ["peek", "Quick look", "Space"], null,
    ["rename", "Rename…", "F2"], ["move", "Move to…", ""], ["copy", "Copy path for your coding agent", ""], ["pixel", "Make a pixel sprite", ""], null,
    ["delete", "Delete", "Del"],
  ];
  menu.innerHTML = items.map((it) => (it ? `<button type="button" role="menuitem" data-tm="${it[0]}"${it[0] === "delete" ? ' class="danger"' : ""}><span>${it[1]}</span><kbd>${it[2]}</kbd></button>` : "<hr>")).join("");
  menu.dataset.path = path;
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector("button")?.focus();
}
async function tileAction(what, path) {
  closeTileMenu();
  if (what === "open") return go({ type: "doc", path });
  if (what === "peek") { const tile = document.querySelector(`#content .asset-tile[data-tile="${CSS.escape(path)}"]`); return tile && quickLook(tile); }
  if (what === "rename") return renameDialog(path);
  if (what === "pixel") return openPixelNew(path);
  if (what === "move") return moveDialog([path]);
  if (what === "copy") {
    const text = `tessera/art/${path}`;
    try { await navigator.clipboard.writeText(text); toast("Path copied"); } catch { toast(text); }
    return;
  }
  if (what === "delete") { try { await trashAssets([path]); } catch (err) { toast(err.message, true); } }
}
document.addEventListener("contextmenu", (event) => {
  const tile = event.target.closest("#content .asset-tile[data-tile]");
  if (!tile) return;
  event.preventDefault();
  openTileMenu(tile.dataset.tile, event.clientX, event.clientY);
});
document.addEventListener("click", (event) => {
  const item = event.target.closest("#tileMenu [data-tm]");
  if (item) return tileAction(item.dataset.tm, $("#tileMenu").dataset.path);
  if (!event.target.closest("#tileMenu")) closeTileMenu();
});
document.addEventListener("scroll", closeTileMenu, true);

// Drag a tile onto a folder in the tree (or a breadcrumb) to move it there.
document.addEventListener("dragstart", (event) => {
  const tile = event.target.closest?.("#content .asset-tile[data-tile]");
  if (!tile) return;
  event.dataTransfer.setData("application/x-tessera-asset", tile.dataset.tile);
  event.dataTransfer.effectAllowed = "move";
  document.body.classList.add("dragging-asset");
});
document.addEventListener("dragend", () => {
  document.body.classList.remove("dragging-asset");
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("application/x-tessera-asset")) return;
  const folder = event.target.closest?.("#sections [data-folder], .crumbs [data-folder]");
  document.querySelectorAll(".drop-target").forEach((el) => el !== folder && el.classList.remove("drop-target"));
  if (!folder) return;
  event.preventDefault();
  folder.classList.add("drop-target");
});
document.addEventListener("drop", (event) => {
  const path = event.dataTransfer?.getData("application/x-tessera-asset");
  const folder = event.target.closest?.("#sections [data-folder], .crumbs [data-folder]");
  if (!path || !folder) return;
  event.preventDefault();
  folder.classList.remove("drop-target");
  if (dirOf(path) === folder.dataset.folder) return;
  moveAssets([path], folder.dataset.folder).catch((err) => toast(err.message, true));
});

// Keys: Ctrl Z undo, F2 rename and Delete on the hovered or focused tile, Alt ← / Alt → (and mouse buttons) back and forward.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#tileMenu")) { event.preventDefault(); return closeTileMenu(); }
  if (event.target.closest?.("input, textarea, select, [contenteditable]") || $("#dialog")?.open) return;
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z" && state.undo.length) { event.preventDefault(); return runUndo(); }
  if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); return event.key === "ArrowLeft" ? goBack() : goForward(); }
  const tile = document.activeElement?.closest?.("#content .asset-tile[data-tile]") || hoverTile;
  if (!tile || !document.contains(tile)) return;
  if (event.key === "F2") { event.preventDefault(); return renameDialog(tile.dataset.tile); }
  if (event.key === "Delete") { event.preventDefault(); return tileAction("delete", tile.dataset.tile); }
});
document.addEventListener("mouseup", (event) => {
  if (event.button === 3) { event.preventDefault(); goBack(); }
  if (event.button === 4) { event.preventDefault(); goForward(); }
});

// ---------- Motion Studio: keyframe animation on rigged models (motion.js, loaded on demand) ----------
const motionModule = () => import("./motion.js");

async function renderMotionPage() {
  try {
    motionLoaded = await motionModule();
    if (state.view.type !== "motion") return;
    await motionLoaded.render({ api, fileUrl, thumbUrl, esc, toast, state, renderView, humanize });
    renderCrumbs();
  } catch (err) { $("#content").innerHTML = `<div class="empty">${tessArt("error")}<h1>Motion Studio</h1><p>${esc(err.message)}</p></div>`; }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-motion-nav]")) return;
  state.motionSel = null;
  return state.view.type === "motion" ? renderView() : go({ type: "motion" });
});

// ---------- Node Studio: workflows made of steps and wires (flows.js, loaded on demand) ----------
async function renderFlowsPage() {
  try {
    flowsLoaded = await import("./flows.js");
    if (state.view.type !== "nodes") return;
    await flowsLoaded.render({ api, fileUrl, thumbUrl, esc, toast, state, renderView, humanize, go, settingsDialog, onTitle: renderCrumbs });
    renderCrumbs();
  } catch (err) { $("#content").innerHTML = `<div class="empty">${tessArt("error")}<h1>Node Studio</h1><p>${esc(err.message)}</p></div>`; }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-flow-nav]")) return;
  state.flowSel = null;
  return state.view.type === "nodes" ? renderView() : go({ type: "nodes" });
});

// ---------- Pixel Studio: a page of its own (sidebar, ⌘K, asset pages and tile menus all lead here) ----------
// Home: a live "new sprite" maker (pick any picture in the project, see the pixel result as you change size and
// palette) and the library of every sprite in the project. Editor: full size, with every set in a strip on top.
// The server does the pixelizing (one locked palette, canvas and foot anchor per set).

const DIR_LABEL = { s: "Front", se: "Front right", e: "Right", ne: "Back right", n: "Back", nw: "Back left", w: "Left", sw: "Front left" };
const spriteUrl = (set, file) => `${fileUrl(`${set.folder}/${file}`)}?v=${set.v || 0}`;

function openPixelStudio(path, setName) {
  state.pixelSel = { path, set: setName };
  if (state.view.type === "pixel") renderView(); else go({ type: "pixel" });
}

// ---- asset pages: the sets of this asset, as a block that leads into the studio ----
async function mountSpriteBlock() {
  if (state.view.type !== "doc") return;
  const path = state.view.path;
  // Only asset pages with a picture (the hero) get the block; sounds and plain documents don't.
  if (!document.querySelector("#content .winner-box") || state.assetIndex?.[path]?.audio) return;
  let data;
  try { data = await api(`/api/sprites?path=${encodeURIComponent(path)}`); } catch { return; }
  if (state.view.path !== path) return;
  $("#content .sprite-block")?.remove();
  const block = document.createElement("section");
  block.className = "sprite-block";
  block.innerHTML = `<h2 class="group-title">Pixel sprites ${data.sets.length ? `<span>${data.sets.length}</span>` : ""}</h2>
    <div class="sprite-sets">${data.sets.map((s) => spriteCard(s, path)).join("")}
      <button type="button" class="sprite-card add" data-pixel-new="${esc(path)}">${icon("grid")}<span><strong>Make a pixel sprite</strong><small>Opens Pixel Studio</small></span></button></div>`;
  $("#content").append(block);
  animateSpriteCards(block);
}

const spriteCard = (s, asset) => `<button type="button" class="sprite-card" data-sprite-open="${esc(s.name)}" data-sprite-asset="${esc(asset)}" title="Open in Pixel Studio">
  <canvas width="${s.canvas}" height="${s.canvas}" data-sprite-anim='${esc(JSON.stringify(spritePreviewFrames(s)))}' data-fps="${esc(String(previewFps(s)))}"></canvas>
  <span><strong>${esc(displayTitle(humanize(asset.split("/").pop().replace(/\.md$/, ""))))}${s.name !== "main" ? ` · ${esc(s.name)}` : ""}</strong><small>${s.canvas}px · ${s.directions.length} facing${s.directions.length === 1 ? "" : "s"} · ${Object.keys(s.animations).length - 1} anim</small></span></button>`;

function spritePreviewFrames(s) {
  const moving = Object.entries(s.animations).find(([name, e]) => name !== "base" && Object.values(e.frames)[0]?.length);
  const files = moving ? Object.values(moving[1].frames)[0] : Object.values(s.animations.base?.frames || {})[0] || [];
  return files.map((f) => spriteUrl(s, f));
}
const previewFps = (s) => Object.entries(s.animations).find(([n]) => n !== "base")?.[1]?.fps || 4;

// Tiny looping previews on canvases (image-rendering: pixelated), one timer per root.
const spriteTimers = new WeakMap();
function animateSpriteCards(root) {
  const cards = [...root.querySelectorAll("canvas[data-sprite-anim]")].map((c) => ({ c, imgs: JSON.parse(c.dataset.spriteAnim || "[]").map((u) => Object.assign(new Image(), { src: u })), fps: Number(c.dataset.fps) || 4, i: -1, t: 1e9 }));
  clearInterval(spriteTimers.get(root));
  if (!cards.length) return;
  let last = performance.now();
  const timer = setInterval(() => {
    if (!document.contains(root)) return clearInterval(timer);
    const now = performance.now();
    const dt = now - last;
    last = now;
    cards.forEach((k) => {
      k.t += dt;
      if (k.t < 1000 / k.fps) return;
      const next = (k.i + 1) % Math.max(1, k.imgs.length);
      const img = k.imgs[next];
      if (!img?.complete || !img.naturalWidth) return;
      k.t = 0;
      k.i = next;
      const ctx = k.c.getContext("2d");
      ctx.clearRect(0, 0, k.c.width, k.c.height);
      ctx.drawImage(img, 0, 0);
    });
  }, 60);
  spriteTimers.set(root, timer);
}

// ---- the page ----
async function renderPixelPage() {
  const content = $("#content");
  let data;
  try {
    [data] = await Promise.all([pageApi("/api/pixel/home"), studioOptions(), state.serviceModelsReady || Promise.resolve()]);
  } catch (err) { content.innerHTML = `<div class="empty">${tessArt("error")}<h1>Pixel Studio</h1><p>${esc(err.message)}</p></div>`; return; }
  state.spriteMeta = data;
  state.pixelHome = data;
  const sel = state.pixelSel;
  const set = sel && data.sets.find((s) => s.asset === sel.path && s.name === sel.set);
  if (sel && set) return renderPixelEditor(set, data);
  state.pixelSel = null;
  return renderPixelHome(data);
}

const PX_KIND = { character: "Character", creature: "Creature", item: "Item", weapon: "Weapon", prop: "Prop", icon: "Icon", effect: "Effect", tile: "Tile", portrait: "Portrait" };
const PX_VIEW = { side: "Side", "top-down": "Top-down", "three-quarter": "¾ view", isometric: "Isometric", front: "Front" };
const PX_OUTLINE = { black: "Dark outline", selective: "Selective", none: "No outline" };
const PX_SHADING = { flat: "Flat", soft: "Cel", detailed: "Detailed" };
const PX_DETAIL = { low: "Simple", medium: "Medium", high: "Rich" };
const PX_IDEAS = ["a knight with a blue cape and a lantern", "a grumpy slime king with a tiny crown", "a glowing health potion", "a mossy cobblestone floor"];
const ASSET_TO_PX = { character: "character", creature: "creature", item: "item", weapon: "weapon", prop: "prop", ui: "icon", vfx: "effect", vehicle: "prop" };

// Every image model the user can run, best for pixel art first. The first one is tagged Recommended.
function pixelModels() {
  const own = (state.studio?.models || []).filter((m) => m.available).map((m) => ({ id: m.id, label: m.label, price: m.price }));
  const svc = (state.serviceModels?.image || []).map((m) => ({ id: m.id, label: m.label, price: null }));
  const keys = state.pixelHome?.recommended || [];
  const rank = (m) => { const i = keys.findIndex((k) => m.id.toLowerCase().includes(k)); return i < 0 ? 99 : i; };
  const all = [...own, ...svc].sort((a, b) => rank(a) - rank(b));
  return all.map((m, i) => ({ ...m, recommended: i === 0 && rank(m) < 99 }));
}

function pixelState() {
  const n = state.pixelNew ||= { prompt: "", kind: "character", view: "side", canvas: 32, palette: "auto-16", outline: "black", shading: "soft", detail: "medium", count: 4, model: "", ref: "", refTitle: "" };
  const models = pixelModels();
  if (!models.some((m) => m.id === n.model)) n.model = models[0]?.id || "";
  return n;
}

function openPixelNew(path = "") {
  state.pixelSel = null;
  const n = pixelState();
  const a = path && state.assetIndex?.[path];
  if (a) Object.assign(n, { prompt: a.prompt || displayTitle(a.title), kind: ASSET_TO_PX[a.kind] || "character", ref: a.image || "", refTitle: displayTitle(a.title) });
  if (state.view.type === "pixel") renderView(); else go({ type: "pixel" });
  setTimeout(() => $("#pxPrompt")?.focus(), 80);
}

const pxChips = (attr, map, on) => `<div class="cmp-chips">${Object.entries(map).map(([v, l]) => `<button type="button" class="cmp-chip${String(v) === String(on) ? " on" : ""}" ${attr}="${esc(String(v))}">${l}</button>`).join("")}</div>`;
const pxRunning = (path) => Object.values(state.jobs).filter((j) => j.asset === path && ["running", "queued"].includes(j.status));

function pxModelSelect(n) {
  const models = pixelModels();
  if (!models.length) return `<p class="pillar-empty with-art">${tessArt("connect", "sm")}No image model is set up yet. Add one in Settings → Accounts.</p>`;
  return `<label class="px-model"><span class="field-label">Image model</span><select data-px-model>${models.map((m) => `<option value="${esc(m.id)}" ${m.id === n.model ? "selected" : ""}>${m.recommended ? "★ " : ""}${esc(m.label)}${m.price === 0 ? " · free" : m.price != null ? ` · $${m.price.toFixed(3)}` : ""}${m.recommended ? " · Recommended" : ""}</option>`).join("")}</select>
    ${models.find((m) => m.id === n.model)?.recommended ? `<span class="px-rec">Recommended for pixel art</span>` : `<button type="button" class="link-btn" data-px-userec>Use the recommended model</button>`}</label>`;
}

function renderPixelHome(data) {
  const n = pixelState();
  const price = pixelModels().find((m) => m.id === n.model)?.price;
  const palettes = [["auto-8", "Free · 8", null], ["auto-16", "Free · 16", null], ["auto-32", "Free · 32", null], ...Object.entries(data.palettes).map(([k, v]) => [k, k.toUpperCase().replace(/-/g, " "), v])];
  const drafts = data.assets.filter((a) => !a.has_sprite || pxRunning(a.path).length);
  $("#content").innerHTML = `<div class="px-home" id="pxHome">
    <section class="px-create">
      <div class="px-create-main">
        <span class="eyebrow">${icon("grid")} Pixel Studio</span>
        <h1>Describe it. Get real pixel art.</h1>
        <div class="px-prompt-wrap">
          <textarea id="pxPrompt" rows="3" placeholder="A knight with a blue cape and a lantern…">${esc(n.prompt)}</textarea>
          ${n.ref ? `<div class="px-refchip"><img src="${esc(thumbUrl(n.ref, 96))}" alt=""><span>Drawn after <b>${esc(n.refTitle || "this picture")}</b></span><button type="button" data-px-noref title="Don't use the picture">×</button></div>` : ""}
        </div>
        <div class="px-ideas">${PX_IDEAS.map((i) => `<button type="button" data-px-idea="${esc(i)}">${esc(i)}</button>`).join("")}</div>
        <div class="px-opts">
          <div class="cmp-field"><div class="field-label">What</div>${pxChips("data-px-kind", PX_KIND, n.kind)}</div>
          <div class="cmp-field"><div class="field-label">Camera</div>${pxChips("data-px-view", PX_VIEW, n.view)}</div>
          <div class="cmp-field"><div class="field-label">Size</div>${pxChips("data-px-canvas", Object.fromEntries(data.canvases.map((c) => [c, `${c}px`])), n.canvas)}</div>
          <div class="cmp-field"><div class="field-label">Outline</div>${pxChips("data-px-outline", PX_OUTLINE, n.outline)}</div>
          <div class="cmp-field"><div class="field-label">Shading</div>${pxChips("data-px-shading", PX_SHADING, n.shading)}</div>
          <div class="cmp-field"><div class="field-label">Detail</div>${pxChips("data-px-detail", PX_DETAIL, n.detail)}</div>
        </div>
        <div class="field-label">Palette <em>every sprite of this asset is locked to it</em></div>
        <div class="px-pals">${palettes.map(([k, label, colours]) => `<button type="button" class="px-palcard${k === n.palette ? " on" : ""}" data-px-palette="${k}"><span class="px-strip-col">${colours ? colours.slice(0, 16).map((c) => `<i style="background:#${c}"></i>`).join("") : `<i class="auto"></i>`}</span><strong>${esc(label)}</strong></button>`).join("")}</div>
      </div>
      <aside class="px-create-side">
        <div class="px-how">
          <b>How Tessera keeps it pixel-perfect</b>
          <ol><li>The model gets strict pixel-art rules for your size, palette and camera.</li>
          <li>Tessera finds the real pixel grid in each picture and rebuilds it pixel by pixel.</li>
          <li>The palette, size and foot line are locked, so facings and animations always match.</li></ol>
        </div>
        ${pxModelSelect(n)}
        <div class="cmp-field"><div class="field-label">How many to choose from</div>${pxChips("data-px-count", { 1: "1", 2: "2", 3: "3", 4: "4" }, n.count)}</div>
        <button type="button" class="run-btn px-make" data-px-create ${n.model ? "" : "disabled"}>${icon("sparkle")}<span>Generate ${n.count} sprite${n.count > 1 ? "s" : ""}</span>${state.agentCfg?.demo_mode ? "<em>demo</em>" : price != null ? `<em>≈ $${(price * n.count).toFixed(2)}</em>` : ""}<kbd>Ctrl ↵</kbd></button>
      </aside>
    </section>
    ${drafts.length ? `<section class="px-drafts"><h2 class="group-title">Pick the best <span>${drafts.length}</span></h2>${drafts.map(pxDraftCard).join("")}</section>` : ""}
    <section class="px-library">
      <h2 class="group-title">Your sprites <span>${data.sets.length}</span></h2>
      ${data.sets.length ? `<div class="sprite-sets">${data.sets.map((s) => spriteCard(s, s.asset)).join("")}</div>` : `<p class="pillar-empty with-art">${tessArt("pixel", "md")}Your finished sprites land here, animated. Describe your first one above.</p>`}
    </section>
  </div>`;
  animateSpriteCards($("#pxHome"));
}

function pxDraftCard(a) {
  const running = pxRunning(a.path);
  const waiting = running.length ? Math.max(1, state.pixelNew?.count || 4) : 0;
  return `<article class="px-draft" data-px-draft="${esc(a.path)}">
    <header><div><strong>${esc(displayTitle(a.title))}</strong><small>${esc(a.prompt)}</small></div>
      <span class="px-draft-meta">${a.pixel.canvas}px · ${esc(PX_VIEW[a.pixel.view] || a.pixel.view)} · ${esc(a.pixel.palette)}</span>
      <button type="button" class="ghost" data-px-more="${esc(a.path)}" ${running.length ? "disabled" : ""}>${icon("sparkle")} 4 more</button></header>
    <div class="px-cands">
      ${Array.from({ length: waiting }, () => `<div class="px-cand wait"><span class="spinner"></span><small>Drawing…</small></div>`).join("")}
      ${a.candidates.map((c) => `<button type="button" class="px-cand" data-px-pick="${esc(c.image)}" data-px-asset="${esc(a.path)}" title="Use this one">
        <img src="${esc(fileUrl(c.sprite || c.image))}" alt="" class="${c.sprite ? "crisp" : ""}"><span class="px-cand-raw"><img src="${esc(thumbUrl(c.image, 96))}" alt=""></span><b>Use this</b></button>`).join("")}
      ${!waiting && !a.candidates.length ? `<p class="pillar-empty with-art">${tessArt("error", "sm")}Nothing yet: the run may have failed. Press “4 more” to try again.</p>` : ""}
    </div></article>`;
}

function pxSync() {
  const n = pixelState();
  if ($("#pxPrompt")) n.prompt = $("#pxPrompt").value;
}

async function pxCreate() {
  pxSync();
  const n = state.pixelNew;
  if (!n.prompt.trim()) { $("#pxPrompt")?.focus(); return toast("Describe what to draw first.", true); }
  const btn = $("[data-px-create]");
  if (btn) btn.disabled = true;
  try {
    const out = await api("/api/pixel/create", { method: "POST", body: { prompt: n.prompt, kind: n.kind, view: n.view, canvas: n.canvas, palette: n.palette, outline: n.outline, shading: n.shading, detail: n.detail, count: n.count, model: n.model, reference: n.ref } });
    state.jobs[out.job.id] ||= out.job;  // the socket may already have reported it finished
    renderJobDock();
    Object.assign(n, { prompt: "", ref: "", refTitle: "" });
    toast("Drawing your sprites. Pick the best one when they arrive.");
    renderView();
  } catch (err) { toast(err.message, true); if (btn) btn.disabled = false; }
}

async function pxMore(path) {
  try {
    const job = await api("/api/pixel/more", { method: "POST", body: { path, count: 4, model: pixelState().model } });
    state.jobs[job.id] ||= job;  // the socket may already have reported it finished
    renderJobDock();
    renderView();
  } catch (err) { toast(err.message, true); }
}

async function pxPick(path, image) {
  try {
    const set = await api("/api/pixel/pick", { method: "POST", body: { path, image } });
    toast("Locked in. Now turn it around and animate it.");
    openPixelStudio(path, set.name);
  } catch (err) { toast(err.message, true); }
}

// A finished pixel job: the studio shows the new candidates (or the new facings and frames).
function pixelJobDone() {
  if (state.view.type === "pixel" && $("#pxHome")) renderView();
}

// ---- the editor ----
function loadImageData(url, size) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = Object.assign(document.createElement("canvas"), { width: size, height: size });
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, size, size));
    };
    img.onerror = () => resolve(new ImageData(size, size));
    img.src = url;
  });
}
const hexRgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];

async function renderPixelEditor(set, data) {
  const sel = state.pixelSel;
  let ps = state.pixel;
  const same = ps && ps.path === sel.path && ps.set.name === set.name;
  if (!same) {
    ps = state.pixel = { path: sel.path, set: { ...set, v: Date.now() }, anim: "base", dir: set.directions[0] || "s", frames: [], index: 0, tool: "pencil", color: set.palette[0], onion: true, undo: [], dirty: false, playing: true, zoom: 0 };
  } else if (!ps.dirty) {
    ps.set = { ...set, v: Date.now() };
  }
  ps.meta = data;
  const title = displayTitle(humanize(sel.path.split("/").pop().replace(/\.md$/, "")));
  $("#content").innerHTML = `<div class="px-page" id="pxRoot">
    <div class="px-top">
      <button type="button" class="px-back" data-px-home>${icon("chev-left")}<span>Pixel Studio</span></button>
      <div class="px-libstrip">${data.sets.map((s) => `<button type="button" class="px-libitem${s.asset === sel.path && s.name === set.name ? " on" : ""}" data-sprite-open="${esc(s.name)}" data-sprite-asset="${esc(s.asset)}" title="${esc(displayTitle(humanize(s.asset.split("/").pop().replace(/\.md$/, ""))))}${s.name !== "main" ? ` · ${esc(s.name)}` : ""}"><canvas width="${s.canvas}" height="${s.canvas}" data-sprite-anim='${esc(JSON.stringify(spritePreviewFrames(s)))}' data-fps="${previewFps(s)}"></canvas></button>`).join("")}
        <button type="button" class="px-libitem add" data-pixel-new="" title="New sprite">+</button></div>
      <div class="px-title"><strong>${esc(title)}</strong><small>${set.canvas}px · ${set.palette.length} colours · <button type="button" class="link-btn" data-open="${esc(sel.path)}">open asset</button></small></div>
    </div>
    <div class="px-layout">
      <aside class="px-side" id="pxSide"></aside>
      <div class="px-main">
        <div class="px-tools" id="pxTools"></div>
        <div class="px-stage" id="pxStage"><canvas id="pxCanvas"></canvas></div>
        <div class="px-strip" id="pxStrip"></div>
      </div>
      <aside class="px-right"><div class="px-preview"><canvas id="pxPreview"></canvas></div><div id="pxPrevCtl"></div><div id="pxGen"></div><div id="pxExport"></div></aside>
    </div></div>`;
  animateSpriteCards($("#pxRoot .px-libstrip"));
  if (!same || !ps.dirty) await pxLoadFrames();
  pxRender();
  pxBindCanvas();
}

async function pxLoadFrames() {
  const ps = state.pixel;
  const files = ps.set.animations[ps.anim]?.frames?.[ps.dir] || [];
  ps.frames = await Promise.all(files.map((f) => loadImageData(spriteUrl(ps.set, f), ps.set.canvas)));
  ps.index = Math.min(ps.index, Math.max(0, ps.frames.length - 1));
  ps.undo = [];
  ps.dirty = false;
}

function pxRender() {
  const ps = state.pixel;
  if (!ps || !$("#pxRoot")) return;
  const s = ps.set;
  const anims = Object.keys(s.animations).sort((a, b) => (a !== "base") - (b !== "base") || a.localeCompare(b));
  $("#pxSide").innerHTML = `<div class="field-label">Animations</div>
    <div class="px-list">${anims.map((a) => `<button type="button" class="${a === ps.anim ? "on" : ""}" data-px-anim="${esc(a)}">${esc(a === "base" ? "Base sprite" : humanize(a))}<small>${Object.values(s.animations[a].frames)[0]?.length || 0}f</small></button>`).join("")}</div>
    <div class="field-label">Facing</div>
    <div class="px-dirs">${["nw", "n", "ne", "w", "", "e", "sw", "s", "se"].map((d) => (d ? `<button type="button" class="${d === ps.dir ? "on" : ""}${s.animations[ps.anim]?.frames?.[d]?.length ? " has" : ""}" data-px-dir="${d}" title="${DIR_LABEL[d]}">${d.toUpperCase()}</button>` : `<span class="px-dir-me">${icon("character")}</span>`)).join("")}</div>
    ${ps.anim !== "base" ? `<div class="px-animset"><label>FPS <input type="number" min="1" max="30" value="${s.animations[ps.anim].fps}" data-px-fps></label><label class="check"><input type="checkbox" data-px-loop ${s.animations[ps.anim].loop ? "checked" : ""}> Loop</label><button type="button" class="link-btn danger-link" data-px-delanim>Delete animation</button></div>` : ""}
    <div class="field-label">Palette · ${s.palette.length}</div>
    <div class="px-pal">${s.palette.map((c) => `<button type="button" style="background:#${c}" class="${c === ps.color ? "on" : ""}" data-px-color="${c}" title="#${c}"></button>`).join("")}</div>`;
  const tool = (id, label, key) => `<button type="button" class="${ps.tool === id ? "on" : ""}" data-px-tool="${id}" title="${label} (${key})">${label}</button>`;
  $("#pxTools").innerHTML = `<div class="vseg">${tool("pencil", "Pencil", "B")}${tool("eraser", "Eraser", "E")}${tool("fill", "Fill", "G")}${tool("pick", "Pick", "I")}</div>
    <button type="button" class="vtog${ps.onion ? " on" : ""}" data-px-onion title="Onion skin: the previous frame, faint (O)">Onion</button>
    <button type="button" class="vtog" data-px-flip title="Flip this frame horizontally">Flip</button>
    <span class="vgrow"></span>
    <span class="px-hint">Right-click erases · ← → frames · Ctrl Z undo</span>
    <button type="button" class="vtog" data-px-undo title="Undo (Ctrl Z)">Undo</button>
    <button type="button" class="primary" data-px-save ${ps.dirty ? "" : "disabled"}>Save <kbd>Ctrl S</kbd></button>`;
  $("#pxStrip").innerHTML = `${ps.frames.map((_, i) => `<button type="button" class="px-frame${i === ps.index ? " on" : ""}" data-px-frame="${i}"><canvas width="${s.canvas}" height="${s.canvas}"></canvas><small>${i + 1}</small></button>`).join("")}
    <div class="px-frame-ops"><button type="button" class="vtog" data-px-dup title="Duplicate this frame">+ Copy</button><button type="button" class="vtog" data-px-blank title="Add an empty frame">+ Empty</button><button type="button" class="vtog" data-px-left title="Move left">←</button><button type="button" class="vtog" data-px-right title="Move right">→</button><button type="button" class="vtog" data-px-del title="Delete this frame">Delete</button></div>`;
  $("#pxStrip").querySelectorAll(".px-frame canvas").forEach((c, i) => c.getContext("2d").putImageData(ps.frames[i], 0, 0));
  const presets = ps.meta.presets || {};
  const dirWord = DIR_LABEL[ps.dir].toLowerCase();
  const busy = pxRunning(ps.path).length;
  const animSel = $("[data-px-gen-anim]")?.value || "walk";
  $("#pxGen").innerHTML = `<div class="px-card"><div class="px-card-head">${icon("sparkle")}<strong>Generate</strong><small>${busy ? `<span class="spinner"></span> drawing…` : "one sheet, one call"}</small></div>
    <div class="px-gen">
      ${pxModelSelect(pixelState())}
      <div class="field-label">Turnaround</div>
      <div class="px-turn"><button type="button" class="ghost" data-px-turn="4">${icon("turn")} 4 facings</button><button type="button" class="ghost" data-px-turn="8">${icon("turn")} 8 facings</button></div>
      <div class="field-label">Animate · ${esc(dirWord)}</div>
      <label>Move<select data-px-gen-anim>${Object.keys(presets).map((k) => `<option value="${k}" ${k === animSel ? "selected" : ""}>${esc(humanize(k))}</option>`).join("")}<option value="custom">Custom…</option></select></label>
      <label>Frames<select data-px-gen-frames>${[2, 3, 4, 6, 8, 9, 12].map((n) => `<option ${n === (presets[animSel]?.frames || 8) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <input type="text" data-px-gen-notes placeholder="Notes (optional): big wind-up, cape flutters…">
      <button type="button" class="run-btn small" data-px-gen="animation">${icon("play")} Animate ${esc(dirWord)}</button>
    </div></div>`;
  const ex = s.exports || {};
  $("#pxExport").innerHTML = `<div class="px-card"><div class="px-card-head">${icon("download")}<strong>Export</strong><small>sheet · Aseprite · Godot · GIF</small></div>
    <button type="button" class="ghost" data-px-export>${Object.keys(ex).length ? "Export again" : "Export for your engine"}</button>
    ${Object.keys(ex).length ? `<div class="fmt-links">${Object.entries(ex).map(([n, p]) => `<a href="${esc(fileUrl(p))}?v=${s.v}" download>${esc(n)}</a>`).join("")}</div>` : ""}</div>`;
  $("#pxPrevCtl").innerHTML = `<button type="button" class="vtog" data-px-play>${ps.playing ? "Pause" : "Play"}</button><small>${ps.frames.length} frame${ps.frames.length === 1 ? "" : "s"} · ${s.animations[ps.anim]?.fps || 1} fps</small>`;
  pxDraw();
  pxPreviewLoop();
}

function pxScale() {
  const stage = $("#pxStage");
  const n = state.pixel.set.canvas;
  const room = Math.max(160, Math.min((stage?.clientWidth || 520) - 24, innerHeight - 330));
  return Math.max(2, Math.floor(room / n));
}

function pxDraw() {
  const ps = state.pixel;
  const c = $("#pxCanvas");
  if (!ps || !c) return;
  const n = ps.set.canvas;
  const z = pxScale();
  c.width = n * z; c.height = n * z;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) { ctx.fillStyle = (x + y) % 2 ? "#1c1c22" : "#17171c"; ctx.fillRect(x * z, y * z, z, z); }
  const tmp = Object.assign(document.createElement("canvas"), { width: n, height: n });
  const draw = (img, alpha) => { tmp.getContext("2d").putImageData(img, 0, 0); ctx.globalAlpha = alpha; ctx.drawImage(tmp, 0, 0, n * z, n * z); ctx.globalAlpha = 1; };
  if (ps.onion && ps.index > 0 && ps.frames[ps.index - 1]) draw(ps.frames[ps.index - 1], 0.25);
  if (ps.frames[ps.index]) draw(ps.frames[ps.index], 1);
  if (z >= 6) {
    ctx.strokeStyle = "rgba(255,255,255,.05)";
    ctx.beginPath();
    for (let i = 1; i < n; i += 1) { ctx.moveTo(i * z + 0.5, 0); ctx.lineTo(i * z + 0.5, n * z); ctx.moveTo(0, i * z + 0.5); ctx.lineTo(n * z, i * z + 0.5); }
    ctx.stroke();
  }
  const thumb = $(`#pxStrip [data-px-frame="${ps.index}"] canvas`);
  if (thumb && ps.frames[ps.index]) thumb.getContext("2d").putImageData(ps.frames[ps.index], 0, 0);
}

let pxPrevTimer = 0;
function pxPreviewLoop() {
  clearInterval(pxPrevTimer);
  const ps = state.pixel;
  const c = $("#pxPreview");
  if (!ps || !c) return;
  const n = ps.set.canvas;
  c.width = n; c.height = n;
  let i = 0;
  const show = () => { const f = ps.frames[ps.playing ? i % Math.max(1, ps.frames.length) : ps.index]; if (f) c.getContext("2d").putImageData(f, 0, 0); else c.getContext("2d").clearRect(0, 0, n, n); i += 1; };
  show();
  pxPrevTimer = setInterval(() => { if (!document.contains(c)) return clearInterval(pxPrevTimer); show(); }, 1000 / Math.max(1, ps.set.animations[ps.anim]?.fps || 4));
}

function pxPush() {
  const ps = state.pixel;
  ps.undo.push(ps.frames.map((f) => new ImageData(new Uint8ClampedArray(f.data), f.width, f.height)).concat([ps.index]));
  if (ps.undo.length > 60) ps.undo.shift();
  ps.dirty = true;
  const save = $("[data-px-save]");
  if (save) save.disabled = false;
}

function pxPaint(x, y, first) {
  const ps = state.pixel;
  const img = ps.frames[ps.index];
  if (!img) return;
  const n = ps.set.canvas;
  if (x < 0 || y < 0 || x >= n || y >= n) return;
  const at = (y * n + x) * 4;
  const d = img.data;
  if (ps.tool === "pick") {
    if (!d[at + 3]) return;
    const hex = [d[at], d[at + 1], d[at + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    ps.color = ps.set.palette.includes(hex) ? hex : ps.color;
    ps.tool = "pencil";
    return pxRender();
  }
  if (first) pxPush();
  if (ps.tool === "fill") {
    const target = [d[at], d[at + 1], d[at + 2], d[at + 3]].join();
    const [r, g, b] = hexRgb(ps.color);
    if (target === [r, g, b, 255].join()) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const i = (py * n + px) * 4;
      if ([d[i], d[i + 1], d[i + 2], d[i + 3]].join() !== target) continue;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  } else if (ps.tool === "eraser") {
    d[at + 3] = 0;
  } else {
    const [r, g, b] = hexRgb(ps.color);
    d[at] = r; d[at + 1] = g; d[at + 2] = b; d[at + 3] = 255;
  }
  pxDraw();
}

function pxBindCanvas() {
  const c = $("#pxCanvas");
  if (!c) return;
  let down = false;
  const cell = (e) => { const r = c.getBoundingClientRect(); const z = r.width / state.pixel.set.canvas; return [Math.floor((e.clientX - r.left) / z), Math.floor((e.clientY - r.top) / z)]; };
  c.addEventListener("pointerdown", (e) => {
    down = true;
    c.setPointerCapture(e.pointerId);
    const [x, y] = cell(e);
    if (e.button === 2) { const t = state.pixel.tool; state.pixel.tool = "eraser"; pxPaint(x, y, true); state.pixel.tool = t; return; }
    pxPaint(x, y, true);
  });
  c.addEventListener("pointermove", (e) => { if (!down || !["pencil", "eraser"].includes(state.pixel.tool)) return; const [x, y] = cell(e); pxPaint(x, y, false); });
  c.addEventListener("pointerup", () => { down = false; });
  c.addEventListener("contextmenu", (e) => e.preventDefault());
}

function pxUndo() {
  const ps = state.pixel;
  const last = ps?.undo.pop();
  if (!last) return;
  ps.index = last.pop();
  ps.frames = last;
  pxRender();
}

async function pxSave() {
  const ps = state.pixel;
  if (!ps) return;
  const n = ps.set.canvas;
  const tmp = Object.assign(document.createElement("canvas"), { width: n, height: n });
  const frames = ps.frames.map((f) => { tmp.getContext("2d").putImageData(f, 0, 0); return tmp.toDataURL("image/png"); });
  const entry = ps.set.animations[ps.anim] || {};
  try {
    ps.set = { ...(await api("/api/sprites/animation", { method: "PUT", body: { path: ps.path, set: ps.set.name, anim: ps.anim, direction: ps.dir, frames, fps: entry.fps, loop: entry.loop } })), v: Date.now() };
    ps.dirty = false;
    toast("Sprite saved");
    await pxLoadFrames();
    pxRender();
  } catch (err) { toast(err.message, true); }
}

async function pxGenerate(kind, facings = 4) {
  const ps = state.pixel;
  let anim = $("[data-px-gen-anim]")?.value || "walk";
  if (kind === "animation" && anim === "custom") { anim = (await ask({ title: "Name the animation", input: "", placeholder: "cast, dash, wave…", ok: "Make it" })) || ""; if (!anim) return; }
  const frames = Number($("[data-px-gen-frames]")?.value) || 8;
  const directions = facings === 8 ? ["s", "se", "e", "ne", "n", "nw", "w", "sw"] : ["s", "e", "n", "w"];
  try {
    const job = await api("/api/sprites/generate", { method: "POST", body: { path: ps.path, set: ps.set.name, kind, directions, direction: ps.dir, anim, frames, notes: $("[data-px-gen-notes]")?.value || "", model: pixelState().model } });
    state.jobs[job.id] ||= job;
    renderJobDock();
    pxRender();
    toast(kind === "turnaround" ? `Drawing ${facings} facings on one sheet. They're locked to this sprite's palette and size when they arrive.` : `Drawing a ${frames}-frame ${humanize(anim).toLowerCase()} on one sheet. The frames land here, aligned, when it's done.`);
  } catch (err) { toast(err.message, true); }
}

async function pxAddImage() {
  const ps = state.pixel;
  if ($("#pxPick")) return $("#pxPick").remove();
  const asset = await api(`/api/studio/asset?path=${encodeURIComponent(ps.path)}`).catch(() => null);
  const images = [...new Set([asset?.meta?.winner, ...Object.values(asset?.outputs || {}).flat().filter((o) => o?.type === "image").map((o) => o.path)].filter((p) => p && /\.(png|jpe?g|webp)$/i.test(p)))];
  $("#pxGen .px-card").insertAdjacentHTML("beforeend", `<div class="px-pick" id="pxPick"><p class="hint-line">A single pose becomes the ${esc(DIR_LABEL[ps.dir].toLowerCase())} facing; a strip becomes the animation chosen above.</p>
    <div class="sprite-src">${images.slice(0, 24).map((p) => `<button type="button" data-px-use="${esc(p)}"><img src="${esc(thumbUrl(p, 160))}" alt=""></button>`).join("")}</div></div>`);
}

const leaveUnsaved = () => ask({ title: "Leave without saving?", body: "These frames have changes that are not saved.", ok: "Leave", cancel: "Stay", danger: true });

async function pxUseImage(image) {
  const ps = state.pixel;
  const anim = $("[data-px-gen-anim]")?.value || "walk";
  const frames = Number($("[data-px-gen-frames]")?.value) || 8;
  const asStrip = await ask({ title: "What is this picture?", choices: [{ value: "strip", label: `A strip of ${frames} frames` }, { value: "pose", label: `One ${DIR_LABEL[ps.dir].toLowerCase()} pose` }] });
  if (!asStrip) return;
  const strip = asStrip === "strip";
  const name = anim === "custom" ? "anim" : anim;
  try {
    ps.set = { ...(await api("/api/sprites/add", { method: "POST", body: strip ? { path: ps.path, set: ps.set.name, kind: "animation", anim: name, direction: ps.dir, image, frames } : { path: ps.path, set: ps.set.name, kind: "direction", direction: ps.dir, image } })), v: Date.now() };
    ps.anim = strip ? name : "base";
    ps.index = 0;
    await pxLoadFrames();
    pxRender();
  } catch (err) { toast(err.message, true); }
}

// A finished sprite job: refresh the asset block, and the studio if it is open on that sprite.
async function spriteJobDone(job) {
  if (state.view.type === "doc" && state.view.path === job.asset) mountSpriteBlock();
  const ps = state.pixel;
  if (state.view.type !== "pixel" || !ps || ps.path !== job.asset || ps.set.name !== job.sprite?.set) return;
  const data = await api(`/api/sprites?path=${encodeURIComponent(ps.path)}`);
  const set = data.sets.find((s) => s.name === ps.set.name);
  if (!set) return;
  ps.set = { ...set, v: Date.now() };
  if (!ps.dirty) {
    ps.anim = job.sprite.kind === "animation" ? job.sprite.anim : "base";
    ps.dir = job.sprite.direction || ps.dir;
    ps.index = 0;
    await pxLoadFrames();
  }
  pxRender();
  toast(job.sprite.kind !== "animation" ? `${Object.keys(job.sprite.cells || {}).length || 1} facings added` : `${humanize(job.sprite.anim)} animation added`);
}

// ---- one set of listeners for the whole studio (home and editor) ----
document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-pixel-nav], [data-px-crumb]")) {
    if (state.pixel?.dirty && state.view.type === "pixel" && !(await leaveUnsaved())) return;
    state.pixelSel = null;
    return state.view.type === "pixel" ? renderView() : go({ type: "pixel" });
  }
  const openSet = event.target.closest("[data-sprite-open]");
  if (openSet) return openPixelStudio(openSet.dataset.spriteAsset || state.view.path, openSet.dataset.spriteOpen);
  const fresh = event.target.closest("[data-pixel-new]");
  if (fresh) {
    if (state.pixel?.dirty && !(await leaveUnsaved())) return;
    return openPixelNew(fresh.dataset.pixelNew || "");
  }
  if (state.view.type !== "pixel") return;
  const t = event.target.closest("button");
  if (!t) return;
  const ds = t.dataset;
  // home
  if ($("#pxHome")) {
    pxSync();
    const n = state.pixelNew;
    const opt = [["pxKind", "kind"], ["pxView", "view"], ["pxOutline", "outline"], ["pxShading", "shading"], ["pxDetail", "detail"], ["pxPalette", "palette"]].find(([k]) => ds[k]);
    if (opt) { n[opt[1]] = ds[opt[0]]; if (opt[1] === "kind" && ds.pxKind === "tile") n.outline = "none"; return renderPixelHome(state.pixelHome); }
    if (ds.pxCanvas) { n.canvas = Number(ds.pxCanvas); return renderPixelHome(state.pixelHome); }
    if (ds.pxCount) { n.count = Number(ds.pxCount); return renderPixelHome(state.pixelHome); }
    if (ds.pxIdea) { n.prompt = ds.pxIdea; renderPixelHome(state.pixelHome); return $("#pxPrompt")?.focus(); }
    if (t.matches("[data-px-noref]")) { Object.assign(n, { ref: "", refTitle: "" }); return renderPixelHome(state.pixelHome); }
    if (t.matches("[data-px-userec]")) { n.model = pixelModels()[0]?.id || n.model; return renderPixelHome(state.pixelHome); }
    if (t.matches("[data-px-create]")) return pxCreate();
    if (ds.pxMore) return pxMore(ds.pxMore);
    if (ds.pxPick) return pxPick(ds.pxAsset, ds.pxPick);
    return;
  }
  const ps = state.pixel;
  if (!ps || !$("#pxRoot")) return;
  if (t.matches("[data-px-home]")) {
    if (ps.dirty && !(await leaveUnsaved())) return;
    state.pixelSel = null;
    return renderView();
  }
  if (ds.pxTool) { ps.tool = ds.pxTool; return pxRender(); }
  if (ds.pxColor) { ps.color = ds.pxColor; if (ps.tool === "eraser" || ps.tool === "pick") ps.tool = "pencil"; return pxRender(); }
  if (ds.pxFrame !== undefined) { ps.index = Number(ds.pxFrame); return pxRender(); }
  if (ds.pxAnim || ds.pxDir) {
    if (ps.dirty && !(await leaveUnsaved())) return;
    if (ds.pxAnim) ps.anim = ds.pxAnim; else ps.dir = ds.pxDir;
    ps.index = 0;
    await pxLoadFrames();
    return pxRender();
  }
  if (t.matches("[data-px-onion]")) { ps.onion = !ps.onion; return pxRender(); }
  if (t.matches("[data-px-play]")) { ps.playing = !ps.playing; return pxRender(); }
  if (t.matches("[data-px-undo]")) return pxUndo();
  if (t.matches("[data-px-flip]")) {
    const f = ps.frames[ps.index]; if (!f) return;
    pxPush();
    const n = ps.set.canvas; const src = new Uint8ClampedArray(f.data);
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) for (let k = 0; k < 4; k += 1) f.data[(y * n + x) * 4 + k] = src[(y * n + (n - 1 - x)) * 4 + k];
    return pxDraw();
  }
  if (t.matches("[data-px-dup], [data-px-blank]")) {
    pxPush();
    const n = ps.set.canvas;
    const f = t.matches("[data-px-dup]") && ps.frames[ps.index] ? new ImageData(new Uint8ClampedArray(ps.frames[ps.index].data), n, n) : new ImageData(n, n);
    ps.frames.splice(ps.index + 1, 0, f);
    ps.index += 1;
    return pxRender();
  }
  if (t.matches("[data-px-left], [data-px-right]")) {
    const to = ps.index + (t.matches("[data-px-left]") ? -1 : 1);
    if (to < 0 || to >= ps.frames.length) return;
    pxPush();
    [ps.frames[ps.index], ps.frames[to]] = [ps.frames[to], ps.frames[ps.index]];
    ps.index = to;
    return pxRender();
  }
  if (t.matches("[data-px-del]")) {
    if (ps.frames.length <= 1 && ps.anim === "base") return toast("The base sprite needs its frame.", true);
    pxPush();
    ps.frames.splice(ps.index, 1);
    ps.index = Math.max(0, ps.index - 1);
    return pxRender();
  }
  if (t.matches("[data-px-save]")) return pxSave();
  if (t.matches("[data-px-delanim]")) {
    if (!(await ask({ title: `Delete the ${humanize(ps.anim)} animation?`, body: "Every facing of it goes.", ok: "Delete", danger: true }))) return;
    ps.set = { ...(await api(`/api/sprites/animation?path=${encodeURIComponent(ps.path)}&set=${encodeURIComponent(ps.set.name)}&anim=${encodeURIComponent(ps.anim)}`, { method: "DELETE" })), v: Date.now() };
    ps.anim = "base"; ps.index = 0;
    await pxLoadFrames();
    return pxRender();
  }
  if (ds.pxGen) return pxGenerate(ds.pxGen);
  if (ds.pxTurn) return pxGenerate("turnaround", Number(ds.pxTurn));
  if (t.matches("[data-px-userec]")) { pixelState().model = pixelModels()[0]?.id || ""; return pxRender(); }
  if (t.matches("[data-px-addimg]")) return pxAddImage();
  if (ds.pxUse) return pxUseImage(ds.pxUse);
  if (t.matches("[data-px-export]")) {
    try { ps.set = { ...(await api("/api/sprites/export", { method: "POST", body: { path: ps.path, set: ps.set.name } })), v: Date.now() }; toast("Exported next to the sprite frames"); pxRender(); } catch (err) { toast(err.message, true); }
  }
});
document.addEventListener("input", (event) => {
  if (state.view.type === "pixel" && event.target.id === "pxPrompt") pxSync();
});
document.addEventListener("change", (event) => {
  if (state.view.type !== "pixel") return;
  if (event.target.matches("[data-px-model]")) { pxSync(); pixelState().model = event.target.value; return $("#pxHome") ? renderPixelHome(state.pixelHome) : pxRender(); }
  const ps = state.pixel;
  if (ps && event.target.matches("[data-px-fps], [data-px-loop]")) {
    ps.set.animations[ps.anim].fps = Number($("[data-px-fps]").value) || 8;
    ps.set.animations[ps.anim].loop = $("[data-px-loop]").checked;
    ps.dirty = true;
    pxRender();
  }
});
document.addEventListener("keydown", (event) => {
  if (state.view.type === "pixel" && $("#pxHome") && (event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); return pxCreate(); }
  if (state.view.type !== "pixel" || !state.pixel || !$("#pxRoot") || $("#dialog")?.open || event.target.closest?.("input, textarea, select")) return;
  const k = event.key.toLowerCase();
  const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
  const tools = { b: "pencil", e: "eraser", g: "fill", i: "pick" };
  if ((event.ctrlKey || event.metaKey) && k === "z") { stop(); return pxUndo(); }
  if ((event.ctrlKey || event.metaKey) && k === "s") { stop(); return pxSave(); }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (tools[k]) { stop(); state.pixel.tool = tools[k]; return pxRender(); }
  if (k === "o") { stop(); state.pixel.onion = !state.pixel.onion; return pxRender(); }
  if (k === "arrowleft" || k === "arrowright") { stop(); state.pixel.index = Math.max(0, Math.min(state.pixel.frames.length - 1, state.pixel.index + (k === "arrowleft" ? -1 : 1))); return pxRender(); }
}, true);
addEventListener("resize", () => { if (state.view.type === "pixel" && $("#pxCanvas")) pxDraw(); });

// ---------- candidate lightbox: arrows to step, Enter to pick, the prompt each image came from ----------

function openLightbox(path) {
  const list = [...document.querySelectorAll("#content [data-lightbox]")].map((a) => a.dataset.lightbox);
  if (!list.length) return;
  state.lb = { list: [...new Set(list)], index: 0, history: null, asset: state.view.path };
  state.lb.index = Math.max(0, state.lb.list.indexOf(path));
  renderLightbox();
  api(`/api/studio/history?path=${encodeURIComponent(state.view.path)}`).then((d) => { if (state.lb) { state.lb.history = d.history; renderLightbox(); } }).catch(() => {});
}

function renderLightbox() {
  const lb = state.lb;
  let box = $("#lightbox");
  if (!box) { box = Object.assign(document.createElement("div"), { id: "lightbox", className: "lightbox" }); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); document.body.append(box); }
  if (!lb) { box.hidden = true; return; }
  const path = lb.list[lb.index];
  const winner = document.querySelector("#content .out.winner [data-lightbox]")?.dataset.lightbox === path;
  const made = lb.history?.[path];
  const model = made?.model ? String(made.model).replace(/^svc:/, "").split("/").pop() : "";
  box.hidden = false;
  box.innerHTML = `<button type="button" class="lb-close" data-lb-close aria-label="Close">✕</button>
    <button type="button" class="lb-nav prev" data-lb-step="-1" aria-label="Previous"${lb.index ? "" : " disabled"}>‹</button>
    <figure><img src="${esc(fileUrl(path))}" alt="">
      <figcaption>
        <span class="lb-count">${lb.index + 1} / ${lb.list.length}</span>
        ${winner ? `<span class="out-badge win static">${icon("star")}Winner</span>` : `<button type="button" class="primary" data-lb-pick>${icon("star")} Pick winner <kbd>↵</kbd></button>`}
        <span class="grow"></span>
        <a class="ghost btn-link" href="${esc(fileUrl(path))}" target="_blank" rel="noopener">Open full size</a>
      </figcaption>
      ${made ? `<details class="lb-prompt"><summary>${made.asset_prompt ? "Prompt it came from" : "Prompt sent"}${model ? ` · ${esc(model)}` : ""}${made.created_at ? ` · ${esc(timeAgo(made.created_at).toLowerCase())}` : ""}</summary>
        <p>${esc(made.asset_prompt || made.prompt || "")}</p>
        ${made.asset_prompt ? `<button type="button" class="ghost" data-use-prompt="${esc(path)}">Use this prompt again</button>` : ""}</details>` : ""}
    </figure>
    <button type="button" class="lb-nav next" data-lb-step="1" aria-label="Next"${lb.index < lb.list.length - 1 ? "" : " disabled"}>›</button>`;
}

function closeLightbox() { state.lb = null; renderLightbox(); }

async function usePrompt(path) {
  const made = state.lb?.history?.[path];
  if (!made?.asset_prompt) return;
  const box = $("#assetPrompt");
  const before = box?.value ?? "";
  try {
    await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields: { prompt: made.asset_prompt } } });
    closeLightbox();
    await renderView();
    toast("Prompt brought back. Generate images to try it again.", false, { label: "Undo", run: async () => { await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields: { prompt: before } } }); renderView(); } });
  } catch (err) { toast(err.message, true); }
}

// ---------- sound tools: waveform, selection, loop check, trimmed take ----------

let wave = null;
let waveCtx = null; // one shared AudioContext: browsers allow only a handful, and a new one per page leaked them
let seam = null; // the running "Loop check" source, if any

function stopSeam() {
  if (seam) { try { seam.stop(); } catch { /* already stopped */ } seam.disconnect?.(); seam = null; }
  document.querySelectorAll("[data-wave-loop]").forEach((b) => { b.classList.remove("on"); b.lastChild.textContent = "Loop check"; });
}

async function mountWave() {
  const host = $("#content [data-wave-src]");
  if (!host) { stopSeam(); wave = null; return; }
  const src = host.dataset.waveSrc;
  const canvas = host.querySelector("canvas");
  if (wave?.src === src && wave.buffer) { drawWave(canvas); return; }
  stopSeam();
  const mine = wave = { src, buffer: null, sel: null };
  try {
    waveCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const data = await (await fetch(fileUrl(src), { cache: "no-cache" })).arrayBuffer();
    const buffer = await waveCtx.decodeAudioData(data);
    if (wave !== mine) return;
    wave.buffer = buffer;
    drawWave($("#content [data-wave-src] canvas"));
  } catch { if (wave === mine) mine.failed = true; /* the plain player still works */ }
}

function drawWave(canvas) {
  if (!canvas || !wave?.buffer) return;
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 120 * devicePixelRatio;
  const g = canvas.getContext("2d");
  const data = wave.buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  const css = getComputedStyle(canvas);
  g.clearRect(0, 0, w, h);
  if (wave.sel) {
    const [a, b] = wave.sel.map((t) => (t / wave.buffer.duration) * w);
    g.fillStyle = css.getPropertyValue("--wave-sel") || "rgba(255,126,182,.18)";
    g.fillRect(Math.min(a, b), 0, Math.abs(b - a), h);
  }
  g.fillStyle = css.getPropertyValue("--wave") || "#ff7eb6";
  for (let x = 0; x < w; x += 2) {
    let peak = 0;
    for (let i = x * step; i < (x + 1) * step && i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i]));
    const bar = Math.max(1, peak * h * 0.92);
    g.fillRect(x, (h - bar) / 2, 1.5 * devicePixelRatio, bar);
  }
  const host = canvas.closest("[data-wave-src]");
  const label = host?.querySelector(".wave-sel");
  const trim = host?.querySelector("[data-wave-trim]");
  const len = wave.sel ? Math.abs(wave.sel[1] - wave.sel[0]) : 0;
  if (label) { label.hidden = len < 0.05; label.textContent = wave.sel ? `${Math.min(...wave.sel).toFixed(2)}–${Math.max(...wave.sel).toFixed(2)} s` : ""; }
  if (trim) trim.disabled = len < 0.05;
}

function waveTime(event, canvas) {
  const box = canvas.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * wave.buffer.duration;
}

document.addEventListener("pointerdown", (event) => {
  const canvas = event.target.closest?.(".wave-canvas");
  if (!canvas || !wave?.buffer) return;
  const start = waveTime(event, canvas);
  wave.sel = [start, start];
  const move = (e) => { wave.sel[1] = waveTime(e, canvas); drawWave(canvas); };
  const up = (e) => {
    window.removeEventListener("pointermove", move);
    if (Math.abs(wave.sel[1] - wave.sel[0]) < 0.05) {
      // A click (no drag) seeks the player there.
      wave.sel = null;
      const audio = canvas.parentElement.querySelector("audio");
      if (audio) { audio.currentTime = waveTime(e, canvas); audio.play().catch(() => {}); }
    }
    drawWave(canvas);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
});

// Loop check: the sound repeats from 2 seconds before its end, so the seam (end into start) comes round
// every few seconds. Press again to stop. Starting any player stops it too.
async function playLoopSeam(button) {
  if (seam) return stopSeam();
  if (!wave?.buffer) return toast(wave?.failed ? "This sound couldn't be decoded here. Use the player above." : "The sound is still loading.", true);
  try { await waveCtx.resume(); } catch { /* resume is best effort */ }
  document.querySelectorAll("audio").forEach((a) => a.pause());
  const d = wave.buffer.duration;
  const src = waveCtx.createBufferSource();
  src.buffer = wave.buffer;
  src.loop = true;
  src.connect(waveCtx.destination);
  src.onended = () => { if (seam === src) stopSeam(); };
  src.start(0, Math.max(0, d - Math.min(2, d / 2)));
  seam = src;
  if (button) { button.classList.add("on"); button.lastChild.textContent = "Stop loop check"; }
}

// 16-bit PCM WAV of a stretch of the decoded sound.
function wavBlob(buffer, from, to) {
  const rate = buffer.sampleRate;
  const a = Math.floor(from * rate);
  const frames = Math.max(1, Math.floor(to * rate) - a);
  const channels = buffer.numberOfChannels;
  const view = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (o, str) => [...str].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + frames * channels * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * channels * 2, true);
  const data = [...Array(channels)].map((_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i += 1) for (let c = 0; c < channels; c += 1) { view.setInt16(o, Math.max(-1, Math.min(1, data[c][a + i])) * 0x7fff, true); o += 2; }
  return new Blob([view], { type: "audio/wav" });
}

async function saveTrim() {
  if (!wave?.buffer || !wave.sel) return;
  const [from, to] = [Math.min(...wave.sel), Math.max(...wave.sel)];
  const stem = wave.src.split("/").pop().replace(/\.[^.]+$/, "");
  await uploadAudio([new File([wavBlob(wave.buffer, from, to)], `${stem}-trim-${from.toFixed(1)}s.wav`, { type: "audio/wav" })]);
}

// ---------- hover previews: sounds play, models turn ----------

let hoverTimer = 0;
let hoverAudio = null;
let hoverModel = null;

function stopHover() {
  clearTimeout(hoverTimer);
  hoverAudio?.pause();
  hoverAudio = null;
  if (hoverModel) { hoverModel.view?.dispose(); hoverModel.host.remove(); hoverModel = null; }
}

// One sound at a time: pressing a tile or starting any player silences the hover preview
// (and any other player). Capture phase, because media "play" events don't bubble.
document.addEventListener("pointerdown", () => stopHover(), true);
document.addEventListener("click", () => stopHover(), true);
document.addEventListener("play", (event) => {
  if (event.target === hoverAudio) return;
  stopHover();
  stopSeam();
  document.querySelectorAll("audio").forEach((a) => { if (a !== event.target && !a.paused) a.pause(); });
}, true);

document.addEventListener("pointerover", (event) => {
  const tile = event.target.closest?.("[data-hover-audio],[data-hover-model]");
  if (!tile || tile.contains(event.relatedTarget)) return;
  stopHover();
  if (event.pointerType === "touch") return;
  hoverTimer = setTimeout(async () => {
    if (tile.dataset.hoverAudio) {
      hoverAudio = new Audio(fileUrl(tile.dataset.hoverAudio));
      hoverAudio.volume = 0.6;
      hoverAudio.play().catch(() => {});
      return;
    }
    const slot = tile.querySelector(".asset-img");
    const h = hoverModel = { host: Object.assign(document.createElement("div"), { className: "hover-stage" }), view: null };
    slot.append(h.host);
    try {
      const view = await (await viewerModule()).createViewer(h.host, fileUrl(tile.dataset.hoverModel), { autoRotate: true, grid: false });
      if (hoverModel !== h) return view.dispose();
      h.view = view;
      h.host.classList.add("live");
    } catch { /* the picture stays */ }
  }, tile.dataset.hoverAudio ? 250 : 450);
});

document.addEventListener("pointerout", (event) => {
  const tile = event.target.closest?.("[data-hover-audio],[data-hover-model]");
  if (tile && !tile.contains(event.relatedTarget)) stopHover();
});

// ---------- gallery mode and command palette ----------

function setGallery(on) {
  document.body.classList.toggle("gallery-mode", on);
  storeSet("forge.gallery", on ? "1" : "");
  const btn = $("#galleryBtn");
  if (btn) { btn.classList.toggle("on", on); btn.title = on ? "Leave gallery mode (G)" : "Gallery mode: dark, art first (G)"; }
}
setGallery(storeGet("forge.gallery") === "1");

async function paletteItems() {
  if (!state.palette) {
    const board = await loadBoard().catch(() => ({ groups: [] }));
    state.palette = board.groups.flatMap((g) => g.assets.map((a) => ({ label: a.title, hint: `${g.title} · ${a.kind}`, icon: a.audio ? "play" : a.model ? "cube" : "star", run: () => go({ type: "doc", path: a.path }) })));
  }
  const ov = state.overview || { sections: [] };
  const folders = [];
  const walk = (nodes, trail) => nodes.forEach((n) => { folders.push({ label: n.title, hint: trail, icon: "folder", run: () => go({ type: "folder", path: n.path }) }); walk(n.children || [], `${trail} / ${n.title}`); });
  ov.sections.forEach((s) => { folders.push({ label: s.title, hint: `Section ${s.number}`, icon: "folder", run: () => go({ type: "folder", path: s.path }) }); walk(s.children || [], s.title); });
  const onAsset = state.view.type === "doc" && $("#content #assetPrompt");
  const here = state.view.type === "folder" ? state.view.path : "";
  const actions = [
    ...(onAsset ? [["Generate images", "sparkle", () => openPreview("candidates")], ...(is2d() ? [] : [["Make 3D", "cube", () => openPreview("make_3d")], ["Turnaround views", "turn", () => openPreview("views")], ["Add 3D model", "upload", pickModelFile]])] : []),
    ["Overview", "layers", () => go({ type: "home" })], ["Pipeline", "flow", () => go({ type: "pipeline" })], ["Copy update note for my coding agent", "flow", () => copyAgentNote("")], ["Final vault", "box", () => go({ type: "vault" })], ["Levels", "map", () => go({ type: "levels" })], ["Node Studio", "nodes", () => { state.flowSel = null; go({ type: "nodes" }); }], ["Pixel Studio", "grid", () => { state.pixelSel = null; go({ type: "pixel" }); }], ["Motion Studio", "bones", () => { state.motionSel = null; go({ type: "motion" }); }], ["New pixel sprite", "grid", () => openPixelNew(state.view.type === "doc" ? state.view.path : "")],
    [here ? `Generate missing in ${humanize(here.split("/").pop())}` : "Generate all missing", "sparkle", () => batchDialog(here)],
    ...(here ? [["New asset here", "sparkle", () => newAssetDialog(here)]] : []),
    ...(here ? [["Select assets here", "check", () => document.querySelector("[data-select-toggle]")?.click()]] : []),
    ...(is2d() ? [] : [["3D lineup", "cube", openLineup],
      [here ? `Export ${humanize(here.split("/").pop())} for Tripo Studio` : "Export all waiting images for Tripo Studio", "download", async () => exportForTripo(here ? await assetsUnder(here) : null)],
      ["Pair downloaded models", "cube", openModelPairing]]),
    ["Download press kit", "download", downloadPressKit],
    ["Keyboard shortcuts", "grid", openShortcuts],
    [document.body.classList.contains("gallery-mode") ? "Leave gallery mode" : "Gallery mode", "eye", () => setGallery(!document.body.classList.contains("gallery-mode"))],
    ["All projects", "grid", openProjects], ["New project", "sparkle", () => startOnboarding()], ["Settings", "edit", () => settingsDialog()],
  ].map(([label, ic, run]) => ({ label, hint: "Action", icon: ic, run }));
  return [...actions, ...folders, ...state.palette];
}

// Subsequence match: every typed letter in order; earlier, tighter matches score higher.
function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const at = t.indexOf(q);
  if (at >= 0) return 100 - at;
  let i = 0;
  let gaps = 0;
  for (let j = 0; j < t.length && i < q.length; j += 1) { if (t[j] === q[i]) i += 1; else if (i) gaps += 1; }
  return i === q.length ? 50 - gaps : 0;
}

async function openPalette() {
  if ($("#palette")) return;
  const items = await paletteItems();
  const box = Object.assign(document.createElement("div"), { id: "palette", className: "palette" });
  box.innerHTML = `<div class="palette-card" role="dialog" aria-label="Go to"><input id="paletteInput" placeholder="Jump to an asset or folder, or run an action…" autocomplete="off" spellcheck="false"><ul id="paletteList" role="listbox"></ul><footer><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close</footer></div>`;
  document.body.append(box);
  let shown = [];
  let index = 0;
  const draw = () => {
    const q = $("#paletteInput").value.trim();
    shown = items.map((it) => ({ it, score: Math.max(fuzzy(q, it.label), fuzzy(q, `${it.label} ${it.hint}`) - 5) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 40).map((x) => x.it);
    index = Math.min(index, Math.max(0, shown.length - 1));
    $("#paletteList").innerHTML = shown.map((it, i) => `<li role="option" aria-selected="${i === index}" class="${i === index ? "on" : ""}" data-pal="${i}">${icon(it.icon)}<span>${esc(it.label)}</span><small>${esc(it.hint)}</small></li>`).join("") || `<li class="none">Nothing matches. Ask Tess in the chat, or make a new asset from the folder you're in.</li>`;
    $("#paletteList .on")?.scrollIntoView({ block: "nearest" });
  };
  const close = () => box.remove();
  const run = (it) => { close(); it?.run(); };
  box.addEventListener("click", (e) => { const li = e.target.closest("[data-pal]"); if (li) run(shown[Number(li.dataset.pal)]); else if (e.target === box) close(); });
  $("#paletteInput").addEventListener("input", () => { index = 0; draw(); });
  $("#paletteInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); index = Math.min(shown.length - 1, index + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); index = Math.max(0, index - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[index]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  draw();
  $("#paletteInput").focus();
}

// ---------- events for the tools above ----------

document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-board],[data-board-zoom],[data-lineup],[data-batch],[data-press-kit],[data-key-art],[data-install-sample],[data-job-cancel],[data-dock-toggle],[data-lightbox],[data-lb-close],[data-lb-step],[data-lb-pick],[data-use-prompt],[data-wave-loop],[data-wave-trim],[data-viewer-export],[data-height-save],[data-select-toggle],[data-select-tile],[data-select-all],[data-select-run],[data-select-folder],[data-select-clear],[data-select-gen],[data-select-tripo],[data-tripo-folder],[data-tripo-all],[data-pair-open],#galleryBtn,#paletteBtn");
  if (!t) return;
  const d = t.dataset;
  if (d.selectToggle !== undefined) {
    state.select = state.select?.on ? null : { on: true, folder: d.selectToggle, paths: new Set() };
    return renderView();
  }
  if (d.selectTile) {
    // Shift-click ticks every tile between the last one clicked and this one.
    const tiles = [...document.querySelectorAll("[data-select-tile]")].map((x) => x.dataset.selectTile);
    const from = tiles.indexOf(state.select.last), to = tiles.indexOf(d.selectTile);
    if (event.shiftKey && from >= 0 && to >= 0) {
      const on = !state.select.paths.has(d.selectTile);
      tiles.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((p) => state.select.paths[on ? "add" : "delete"](p));
    } else {
      state.select.paths[state.select.paths.has(d.selectTile) ? "delete" : "add"](d.selectTile);
    }
    state.select.last = d.selectTile;
    return syncSelection();
  }
  if (d.selectFolder !== undefined && state.select) {
    const found = await assetsUnder(d.selectFolder).catch((err) => { toast(err.message, true); return []; });
    found.forEach((p) => state.select.paths.add(p));
    toast(`Added ${plural(found.length, "asset")} from ${humanize(d.selectFolder.split("/").pop() || "the project")}`);
    return syncSelection();
  }
  if (d.selectClear !== undefined && state.select) { state.select.paths.clear(); return syncSelection(); }
  if (d.selectGen !== undefined && state.select?.paths.size) return batchDialog(state.select.folder, [...state.select.paths]);
  if (d.selectTripo !== undefined && state.select?.paths.size) return exportForTripo([...state.select.paths]);
  if (d.tripoFolder !== undefined) { closeMenus(); return exportForTripo(await assetsUnder(d.tripoFolder)); }
  if (d.selectAll !== undefined) {
    const all = [...document.querySelectorAll("[data-select-tile]")].map((x) => x.dataset.selectTile);
    state.select.paths = state.select.paths.size === all.length ? new Set() : new Set(all);
    return syncSelection();
  }
  if (d.selectRun !== undefined) return makeSelected3D();
  if (d.tripoAll !== undefined) return exportForTripo(null);
  if (d.pairOpen !== undefined) return openModelPairing();
  if (d.lightbox) {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return; // still opens in a new tab
    event.preventDefault();
    return openLightbox(d.lightbox);
  }
  if (d.board !== undefined) return go({ type: "board" });
  if (d.boardZoom !== undefined) { const b = $("#board"); return Number(d.boardZoom) ? b?.zoomBy(Number(d.boardZoom)) : b?.fit(); }
  if (d.lineup !== undefined) { if (t.closest("#dialog")) closeDialog(); return openLineup(); }
  if (d.batch !== undefined) return batchDialog(d.batch);
  if (d.pressKit !== undefined) return downloadPressKit();
  if (d.keyArt) { event.stopPropagation(); return makeKeyArt(d.keyArt, t); }
  if (d.installSample !== undefined) return installSample(t);
  if (d.dockToggle !== undefined) { state.dockOpen = !state.dockOpen; return renderJobDock(); }
  if (d.lbClose !== undefined) return closeLightbox();
  if (d.lbStep) { state.lb.index = Math.max(0, Math.min(state.lb.list.length - 1, state.lb.index + Number(d.lbStep))); return renderLightbox(); }
  if (d.lbPick !== undefined) return pickWinner(state.lb.list[state.lb.index]);
  if (d.usePrompt) return usePrompt(d.usePrompt);
  if (d.waveLoop !== undefined) return playLoopSeam(t);
  if (d.waveTrim !== undefined) return saveTrim();
  if (t.id === "galleryBtn") return setGallery(!document.body.classList.contains("gallery-mode"));
  if (t.id === "paletteBtn") return openPalette();
  try {
    if (d.jobCancel) {
      state.jobs[d.jobCancel] = await api(`/api/studio/jobs/${encodeURIComponent(d.jobCancel)}/cancel`, { method: "POST" });
      renderJobDock();
    }
    if (d.viewerExport) {
      const blob = await state.viewer.view.exportAs(d.viewerExport);
      const name = `${state.viewer.path.split("/").pop().replace(/\.[^.]+$/, "")}.${d.viewerExport}`;
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    if (d.heightSave !== undefined) {
      const value = Number($("#viewerHeight").value);
      await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields: { height_m: value > 0 ? value : "" } } });
      state.board = null;
      toast(value > 0 ? `Height set to ${value} m` : "Height reset to the default for its kind");
    }
  } catch (err) { toast(err.message, true); }
});

document.addEventListener("change", async (event) => {
  if (!event.target.matches?.("[data-pillar-strength]")) return;
  const value = event.target.value;
  try {
    await api("/api/studio/asset", { method: "PATCH", body: { path: state.view.path, fields: { pillars: value === "normal" ? "" : value } } });
    toast({ off: "Pillars off for this asset", light: "Pillars: palette only", normal: "Pillars back to normal", strong: "Pillars: match closely" }[value]);
  } catch (err) { toast(err.message, true); }
});

document.addEventListener("keydown", (event) => {
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); return $("#palette") ? $("#palette").remove() : openPalette(); }
  if (state.lb) {
    if (event.key === "Escape") { event.preventDefault(); return closeLightbox(); }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); state.lb.index = Math.max(0, Math.min(state.lb.list.length - 1, state.lb.index + (event.key === "ArrowRight" ? 1 : -1))); return renderLightbox(); }
    if (event.key === "Enter" && !typing) { event.preventDefault(); return pickWinner(state.lb.list[state.lb.index]); }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey || $("#dialog").open || $("#palette")) return;
  if (!$("#projectsView").hidden || !$("#settingsView").hidden || !$("#onboarding").hidden) return;
  if (event.key === "g" || event.key === "G") return setGallery(!document.body.classList.contains("gallery-mode"));
  if ((event.key === "p" || event.key === "P") && state.project && $("#projectsView").hidden) return go({ type: "pipeline" });
  if (event.key === "?") { event.preventDefault(); return openShortcuts(); }
  if (event.key === "/") { event.preventDefault(); return shell.openChat(true); }
  if (event.key === "[") { event.preventDefault(); return shell.toggleTree(); }
  // J / K: next and previous asset in the same folder, from an asset page.
  if ((event.key === "j" || event.key === "k") && state.view.type === "doc") { event.preventDefault(); return stepAsset(event.key === "j" ? 1 : -1); }
  // J / K (and the arrows) on the Pipeline: next and previous asset row. Enter opens the focused one.
  if (state.view.type === "pipeline" && ["j", "k", "arrowdown", "arrowup"].includes(event.key.toLowerCase())) {
    event.preventDefault();
    return stepPipelineRow(["j", "arrowdown"].includes(event.key.toLowerCase()) ? 1 : -1);
  }
  // 1–9 on an asset page opens that candidate big.
  if (/^[1-9]$/.test(event.key) && state.view.type === "doc") {
    const list = [...document.querySelectorAll("#content [data-lightbox]")];
    const hit = list[Number(event.key) - 1];
    if (hit) { event.preventDefault(); openLightbox(hit.dataset.lightbox); }
  }
});


// ---------- "More" menus and selection keys ----------
function closeMenus(except) {
  document.querySelectorAll(".menu:not([hidden])").forEach((m) => { if (m !== except) { m.hidden = true; m.previousElementSibling?.setAttribute("aria-expanded", "false"); } });
}

document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-menu]");
  if (toggle) {
    const menu = toggle.nextElementSibling;
    closeMenus(menu);
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", String(!menu.hidden));
    return;
  }
  if (!event.target.closest(".menu")) closeMenus();
  else if (event.target.closest("[role=menuitem]")) setTimeout(() => closeMenus(), 0);
});

document.addEventListener("keydown", (event) => {
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  if (event.key === "Escape" && document.querySelector(".menu:not([hidden])")) { closeMenus(); return; }
  if (typing || $("#dialog").open) return;
  if (state.select && event.key === "Escape") { state.select = null; renderView(); return; }
  if (state.select && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    document.querySelectorAll("[data-select-tile]").forEach((t) => state.select.paths.add(t.dataset.selectTile));
    syncSelection();
    return;
  }
  if (!state.select && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "s" && state.view.type === "folder") {
    const btn = document.querySelector("[data-select-toggle]");
    if (btn) { event.preventDefault(); btn.click(); }
  }
});

// "?" lists every shortcut, so they can be found without reading the code.
const SHORTCUTS = [
  ["Anywhere", [["Ctrl K", "Jump to any page, asset or action"], ["/", "Open Tess's chat"], ["Esc", "Close the chat (when nothing is typed)"], ["G", "Gallery mode: art only"], ["P", "Pipeline: every asset, from request to the game"], ["?", "This list"]]],
  ["Layout", [["[", "Show or hide the project tree"], ["Drag its edge", "Resize the tree (double-click resets it)"]]],
  ["Folder page", [["S", "Select assets"], ["Shift click", "Select a range"], ["Ctrl A", "Select every asset on the page"], ["Esc", "Stop selecting"]]],
  ["Folders", [["Space", "Quick look at the asset under the pointer (← → to step, ↵ to open)"], ["Right-click", "Rename, move, copy path or delete an asset"], ["F2  Del", "Rename or delete the asset under the pointer"], ["Drag a tile", "Drop it on a folder in the tree to move it"], ["Ctrl Z", "Undo the last move, rename or delete"], ["Alt ←  Alt →", "Back and forward"], ["Ctrl +  Ctrl −", "Bigger or smaller thumbnails"]]],
  ["Asset page", [["J  K", "Next and previous asset in the folder"], ["1 – 9", "Open that candidate big"], ["← →", "Step through candidates"], ["Enter", "Pick the open candidate as winner"]]],
  ["Pipeline", [["J K", "Next and previous asset"], ["↓ ↑", "Next and previous asset (arrow keys)"]]],
  ["3D viewer", [["Click a point", "Select it to move"], ["Drag the arrows", "Move it along one axis"], ["Esc", "Cancel placing a point"]]],
];

function openShortcuts() {
  openDialog(`<div class="dlg shortcuts"><h2>Keyboard shortcuts</h2>
    ${SHORTCUTS.map(([group, keys]) => `<section><h3>${esc(group)}</h3><dl>${keys.map(([k, what]) => `<dt>${k.split(" ").map((p) => `<kbd>${esc(p)}</kbd>`).join("")}</dt><dd>${esc(what)}</dd>`).join("")}</dl></section>`).join("")}
    <div class="row"><button type="button" class="ghost" data-close>Close</button></div></div>`);
}


// ---------- Pipeline: every asset from request to the copy in the game (forge/live_link.py) ----------
// One page answers "what is waiting on me, and what does the game really have?". The flow at the top counts the
// assets waiting at each step and is the filter; each row is an asset's track; the last step is read from the game
// folder itself (current, out of date, or edited by hand). Nothing here writes to the game: the note is for the agent.

const PL_AT = {
  concept: { label: "To generate", hint: "nothing to pick from yet", c: "#9d5cff" },
  picked: { label: "To pick", hint: "candidates are waiting", c: "#d2bcff" },
  model: { label: "To model", hint: "picked, no 3D yet", c: "#2dd4bf" },
  game: { label: "To hand off", hint: "finished, not in the game", c: "#38bdf8" },
  ready: { label: "Finished", hint: "ready for a game", c: "#34d399" },
  stale: { label: "Out of date", hint: "the game has an old copy", c: "#f59e0b" },
  shipped: { label: "In the game", hint: "newest files are in", c: "#34d399" },
};
const PL_STEP_TITLE = {
  concept: { done: "Has candidates", todo: "Nothing generated yet", na: "Built, not painted" },
  picked: { done: "Winner picked", todo: "No winner yet", na: "Nothing to pick" },
  model: { done: "3D model made", todo: "No 3D model yet", na: "No 3D for this kind" },
  motion: { done: "Rigged", todo: "Not rigged (optional)", na: "Doesn't move" },
  game: { done: "The newest files are in the game", todo: "Not in the game yet", stale: "The game has an older copy", partial: "Only its picture is in the game: the 3D model isn't", edited: "The game has a copy that was changed by hand", na: "No game folder linked" },
};
const PL_JOB_STEP = { candidates: "concept", variant: "concept", edit: "concept", views: "concept", prop_sheet: "concept", trim_sheet: "concept", make_3d: "model", rig: "motion", animate: "motion" };

const linkReady = () => Boolean(state.link && state.linkProject === state.project);

function pipelineBadge() {
  const stale = linkReady() ? state.link.totals.stale : 0;
  return stale ? `<span class="sec-miss pl-badge" title="${plural(stale, "asset")} out of date in the game">${stale}</span>` : "";
}

// Fetch the snapshot; repaint only when something really changed, so a quiet poll never moves the page.
let linkLoading = null;
function loadLink() {
  if (linkLoading) return linkLoading;
  const project = state.project;
  linkLoading = api("/api/link").then((snap) => {
    if (project !== state.project) return false;
    const key = JSON.stringify({ ...snap, game: { ...snap.game, at: 0, ms: 0, hashed: 0 } });
    const changed = key !== state.linkKey || state.linkProject !== project;
    Object.assign(state, { link: snap, linkKey: key, linkProject: project, linkError: "" });
    if (changed) {
      renderStatusBar();
      const badge = document.querySelector("#sections [data-pipeline]");
      if (badge) { badge.querySelector(".pl-badge")?.remove(); badge.insertAdjacentHTML("beforeend", pipelineBadge()); }
      if (state.view.type === "pipeline") paintPipeline();
    }
    return changed;
  }).catch((err) => {
    if (project === state.project) { state.linkError = err.message; if (state.view.type === "pipeline") paintPipeline(); }
    return false;
  }).finally(() => { linkLoading = null; });
  return linkLoading;
}

// While the page is open the game folder is re-read every few seconds, and the moment you come back from your editor.
setInterval(() => { if (state.view.type === "pipeline" && !document.hidden && state.project && $("#projectsView").hidden) loadLink(); }, 12000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view.type === "pipeline" && state.project) loadLink(); });
window.addEventListener("focus", () => { if (state.view.type === "pipeline" && state.project) loadLink(); });

async function renderPipeline() {
  const content = $("#content");
  if (!$("#plRoot")) {
    // The filter the user last picked in this project (the search text is not kept).
    state.plFilter = storeGet(`forge.pl.${state.project}`) || "";
    content.innerHTML = `<div class="pl pl-enter" id="plRoot">
      <header class="pl-head">
        <div><h1 class="title">Pipeline</h1>
          <p class="lede">Every asset, from the first idea to the copy that sits in your game.</p></div>
        <div class="pl-head-side"><button class="ghost" type="button" data-vault title="Finished assets, laid out for Godot, Unity or Unreal">${icon("download")} Export</button><div class="pl-game" id="plGame"></div></div>
      </header>
      <section class="pl-flow" id="plFlow" aria-label="Where assets are waiting"></section>
      <div id="plAlert"></div>
      <section id="plReq"></section>
      <div class="pl-bar"><span id="plShowing" class="pl-showing"></span><span class="grow"></span>
        <label class="pl-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input id="plSearch" type="search" placeholder="Filter by name or kind…" aria-label="Filter assets" value="${esc(state.plQuery || "")}"></label></div>
      <div class="pl-table" id="plList"></div>
    </div>`;
    setTimeout(() => $("#plRoot")?.classList.remove("pl-enter"), 1100);
  }
  paintPipeline();
  await loadLink();
}

function plCountUp(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll("[data-count]").forEach((el) => {
    const to = Number(el.dataset.count);
    if (!to) return;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 520);
      el.textContent = String(Math.round(to * (1 - (1 - t) ** 3)));
      if (t < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    el.textContent = "0";
    requestAnimationFrame(tick);
    // A hidden window pauses frames: the real number is there when it comes back.
    setTimeout(() => { if (el.isConnected) el.textContent = String(to); }, 700);
  });
}

function plJobs(path) {
  return Object.values(state.jobs).filter((j) => j.asset === path && (j.status === "running" || j.status === "queued"));
}

function plNext(a, jobs) {
  if (jobs.length) {
    const j = jobs.find((x) => x.status === "running") || jobs[0];
    return `<span class="pl-working"><span class="dot busy"></span>${esc(jobLabel(j) || "Working")}${j.status === "queued" ? " · waiting" : sinceTag(j)}</span>`;
  }
  const p = esc(a.path);
  if (a.at === "concept") return `<button type="button" class="pl-act" data-pl-do="generate" data-path="${p}">${icon(a.sound ? "play" : "sparkle")}Generate</button>`;
  if (a.at === "picked") return `<button type="button" class="pl-act" data-pl-do="open" data-path="${p}">${icon("star")}Pick winner</button>`;
  if (a.at === "model") return `<button type="button" class="pl-act" data-pl-do="${a.kind === "kit" ? "open" : "model"}" data-path="${p}">${icon("cube")}${a.kind === "kit" ? "Build kit" : "Make 3D"}</button>`;
  if (a.at === "game") return `<button type="button" class="pl-act" data-pl-note="${p}" title="Copies a note for your coding agent: which files to put into the game">${icon("copy")}Hand off</button>`;
  if (a.at === "stale") return `<button type="button" class="pl-act warn" data-pl-note="${p}" title="Copies a note for your coding agent: which copies to replace">${icon("copy")}Update copy</button>`;
  if (a.at === "shipped") return `<span class="pl-done">${icon("check")}In the game</span>`;
  return `<span class="pl-done">${icon("check")}Finished</span>`;
}

function plRow(a, stages, i) {
  const jobs = plJobs(a.path);
  const busy = new Set(jobs.map((j) => PL_JOB_STEP[j.action]).filter(Boolean));
  const copies = a.files.reduce((n, f) => n + f.copies.length, 0) + a.edited.length;
  let prevLit = false;
  const steps = stages.map((s, idx) => {
    const st = a.stages[s.id];
    const lit = st === "done" || st === "stale" || st === "edited" || st === "partial";
    const line = idx > 0 && lit && prevLit;
    if (st !== "na") prevLit = lit;
    const count = s.id === "concept" && a.options ? a.options : s.id === "motion" && a.clips ? a.clips : s.id === "game" && copies ? copies : "";
    const title = `${s.label}: ${PL_STEP_TITLE[s.id][st] || ""}${s.id === "concept" && a.options ? ` (${a.options})` : ""}${s.id === "motion" && a.clips ? ` · ${plural(a.clips, "clip")}` : ""}`;
    const inner = `<i></i>${count !== "" ? `<em>${count}</em>` : ""}`;
    const cls = `pl-step s-${st}${busy.has(s.id) ? " run" : ""}${line ? " lit" : ""}${idx === 0 ? " first" : ""}`;
    return s.id === "game" && st !== "na"
      ? `<button type="button" class="${cls}" data-pl-peek="${esc(a.path)}" title="${esc(title)} · click for the files" aria-label="${esc(title)}">${inner}</button>`
      : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
  }).join("");
  return `<div class="pl-row at-${a.at}" style="--c:${PL_AT[a.at].c};--i:${Math.min(i, 24)}">
    <button type="button" class="pl-asset" data-open="${esc(a.path)}">
      <span class="pl-thumb">${a.image ? `<img src="${esc(thumbUrl(a.image, 160))}" alt="" loading="lazy" decoding="async">` : kindArt(a.sound ? "sound" : a.kind, "")}</span>
      <span class="pl-name"><strong>${esc(displayTitle(a.title))}</strong><small>${esc(a.kind)}</small></span></button>
    ${steps}
    <div class="pl-next">${plNext(a, jobs)}</div></div>`;
}

function paintPipeline() {
  const root = $("#plRoot");
  if (!root) return;
  const first = root.classList.contains("pl-enter") && !root.dataset.painted;
  if (!linkReady()) {
    $("#plGame").innerHTML = "";
    $("#plGame").hidden = true;
    $("#plFlow").innerHTML = state.linkError ? `<p class="pl-empty"><strong>The pipeline couldn't be read.</strong> ${esc(state.linkError)}</p>` : `<div class="pl-skel" aria-hidden="true">${"<i></i>".repeat(5)}</div>`;
    $("#plList").innerHTML = state.linkError ? "" : `<div class="pl-skel rows" aria-hidden="true">${"<i></i>".repeat(6)}</div>`;
    $("#plAlert").innerHTML = $("#plReq").innerHTML = $("#plShowing").innerHTML = "";
    return;
  }
  const { game, totals, assets, stages, requests } = state.link;
  const order = (game.linked ? ["concept", "picked", "model", "game", "stale", "shipped"] : ["concept", "picked", "model", "ready"])
    .filter((at) => at !== "model" || totals.model || state.link.dimension !== "2d");
  if (state.plFilter && !order.includes(state.plFilter)) state.plFilter = "";
  const filter = state.plFilter || "";

  // The game, top right: what is linked and how much of it is being watched.
  $("#plGame").hidden = false;
  $("#plGame").innerHTML = game.linked
    ? `<span class="dot ok"></span><strong title="${esc(game.folder)}">${esc(game.name)}</strong>${game.engine && game.engine !== "Folder" ? `<em>${esc(game.engine)}</em>` : ""}<small title="Media files in the game folder that Tessera compares with its own. It only reads them.">watching ${fmtCount(game.files)} ${game.files === 1 ? "file" : "files"}${game.truncated ? "+" : ""}</small>`
    : `<button type="button" class="pl-linkbtn" data-pl-link>${icon("link")}Link your game folder</button>`;

  // The flow: how far the project is, and how many assets wait at each step. A step is also the filter.
  const doneKey = game.linked ? "shipped" : "ready";
  const pct = totals.assets ? Math.round((totals[doneKey] / totals.assets) * 100) : 0;
  const stack = [...order].reverse();
  $("#plFlow").innerHTML = totals.assets ? `
    <div class="pl-progress">
      <div class="pl-pct"><b data-count="${pct}">${pct}</b><i>%</i><span>${game.linked ? "in the game" : "finished"}<small>${totals[doneKey]} of ${plural(totals.assets, "asset")}</small></span></div>
      <div class="pl-stack" role="img" aria-label="${stack.map((at) => `${totals[at]} ${PL_AT[at].label.toLowerCase()}`).join(", ")}">${stack.map((at) => `<i style="--n:${totals[at]};--c:${PL_AT[at].c}" title="${totals[at]} · ${esc(PL_AT[at].label)}"></i>`).join("")}</div>
    </div>
    <div class="pl-nodes" style="--cols:${order.length}">${order.map((at) => `<button type="button" class="pl-node${filter === at ? " on" : ""}${totals[at] ? "" : " zero"}" style="--c:${PL_AT[at].c}" data-pl-filter="${at}" aria-pressed="${filter === at}">
      <b data-count="${totals[at]}">${totals[at]}</b><strong>${esc(PL_AT[at].label)}</strong><small>${esc(PL_AT[at].hint)}</small></button>`).join("")}</div>`
    : `<div class="pl-empty"><strong>Nothing in the pipeline yet.</strong> Assets show up here the moment they have a page. Ask Tess to lay out your game, or add an asset in any section.
        <div class="actions-row"><button type="button" class="ghost" data-sb="tess">${icon("sparkle")} Ask Tess</button></div></div>`;

  // One line about what the game is missing, with the note for the agent one click away.
  const waiting = game.linked ? totals.game : 0;
  const staleText = totals.stale_files === 1 ? "1 copy in the game is out of date" : `${totals.stale_files} copies in the game are out of date`;
  const waitText = waiting === 1 ? "1 finished asset isn't in the game yet" : `${waiting} finished assets aren't in the game yet`;
  $("#plAlert").innerHTML = !game.linked && totals.assets
    ? `<div class="pl-alert calm">${icon("link")}<div><strong>Link your game folder to see what's really in the game.</strong><small>Tessera compares the game's files with its own, so it knows which art is in, which is missing and which copies went stale. It only reads the folder.</small></div><button type="button" class="ghost" data-pl-link>Link a game</button></div>`
    : totals.stale || waiting
      ? `<div class="pl-alert${totals.stale ? " warn" : ""}"><span class="dot${totals.stale ? " warn" : " ok"}"></span><div><strong>${[totals.stale ? staleText : "", waiting ? waitText : ""].filter(Boolean).join(" · ")}</strong>
          <small>${totals.stale ? "The art changed after it was copied. ASSETS.md lists every one, so your agent sees them the next time it reads it; or paste it the note now." : "Your coding agent copies finished files in. The note tells it exactly which ones."}</small></div>
          <button type="button" class="primary" data-pl-note="">${icon("copy")} Copy note for your agent</button></div>`
      : "";

  // What the game asked for, each matched to the asset that answers it.
  const open = requests.filter((r) => r.state !== "done");
  const REQ = { new: ["New", "No asset for it yet"], making: ["In the works", "Its asset isn't finished"], ready: ["Art exists", "Its asset has finished files: check they cover the request"] };
  $("#plReq").innerHTML = open.length ? `<h2 class="pl-h">Asked for by the game <span>${open.length}</span>${requests.length > open.length ? `<small>${requests.length - open.length} done</small>` : ""}</h2>
    <div class="pl-reqs">${open.map((r) => `<article class="pl-req st-${r.state}" title="${esc(REQ[r.state][1])}"><span class="pl-req-state">${REQ[r.state][0]}</span><p>${esc(r.text)}</p>
      <div class="pl-req-foot">${r.asset ? `<button type="button" class="mini" data-open="${esc(r.asset)}">${esc(displayTitle(r.title))} ›</button>` : ""}${r.state === "new" ? `<button type="button" class="mini" data-pl-add="${esc(r.text)}">Add page</button>` : ""}${r.state === "ready" ? "" : `<button type="button" class="mini" data-request-make="${esc(r.text)}">Ask Tess</button>`}</div></article>`).join("")}</div>` : "";

  // The rows.
  const q = (state.plQuery || "").trim().toLowerCase();
  const shown = assets.filter((a) => (!filter || a.at === filter) && (!q || `${a.title} ${a.kind} ${a.path}`.toLowerCase().includes(q)));
  $("#plShowing").innerHTML = filter || q
    ? `<button type="button" class="pl-clear" data-pl-filter="" title="Show every asset">${filter ? esc(PL_AT[filter].label) : "Search"} · ${shown.length} <span aria-hidden="true">✕</span></button>`
    : totals.assets ? `<span>${plural(totals.assets, "asset")}</span>` : "";
  const groups = [];
  shown.forEach((a) => { const g = groups.find((x) => x.key === a.section) || groups[groups.push({ key: a.section, title: a.section_title, items: [] }) - 1]; g.items.push(a); });
  let i = 0;
  $("#plList").innerHTML = !totals.assets ? "" : shown.length ? `
    <div class="pl-thead"><span>Asset</span>${stages.map((s) => `<span title="${esc(s.hint)}">${esc(s.label)}</span>`).join("")}<span>Next</span></div>
    ${groups.map((g) => `<section class="pl-group"><h3>${esc(g.title)}<span>${g.items.length}</span></h3>${g.items.map((a) => plRow(a, stages, i++)).join("")}</section>`).join("")}`
    : `<p class="pl-empty">Nothing ${filter ? `is waiting at “${esc(PL_AT[filter].label)}”` : "matches"}${q ? ` for “${esc(q)}”` : ""}. <button type="button" class="mini" data-pl-filter="">Show everything</button></p>`;
  if (first) { root.dataset.painted = "1"; plCountUp(root); }
}

// The files of one asset and where each sits in the game: a card by the row, gone on the next click.
// J / K on the Pipeline: move focus to the next or previous asset row (the browser then runs Enter on it).
function stepPipelineRow(dir) {
  const rows = [...document.querySelectorAll("#plList .pl-asset")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement);
  const next = rows[at < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + dir))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
}

function closePeek() { $("#plPeek")?.remove(); }
function openPeek(path, anchor) {
  const a = state.link?.assets.find((x) => x.path === path);
  closePeek();
  if (!a) return;
  const TAG = { current: "Current", stale: "Out of date" };
  const pop = Object.assign(document.createElement("div"), { id: "plPeek", className: "pl-peek" });
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", `${a.title}: files in the game`);
  pop.dataset.for = path;
  pop.innerHTML = `<header><strong>${esc(displayTitle(a.title))}</strong><small>What Tessera made, and where it is in ${esc(state.link.game.name || "the game")}</small></header>
    ${a.files.length ? `<ul>${a.files.map((f) => `<li><div class="pk-file"><b>${esc(f.label)}</b><code title="${esc(f.path)}">${esc(f.name)}</code><small>${fmtBytes(f.size)}${f.versions > 1 ? ` · version ${f.versions}` : ""}</small></div>
      ${f.copies.length ? f.copies.map((c) => `<div class="pk-copy st-${c.state}"><span>${TAG[c.state]}</span><code title="${esc(c.file)}"><bdi>${esc(c.file)}</bdi></code></div>`).join("") : `<div class="pk-copy st-none"><span>Not copied</span></div>`}</li>`).join("")}</ul>` : `<p>No finished files yet.</p>`}
    ${a.edited.length ? `<p class="pk-edited">Named like it, but not a file Tessera made (changed by hand or converted):${a.edited.map((f) => `<code><bdi>${esc(f)}</bdi></code>`).join("")}</p>` : ""}
    <footer><button type="button" class="mini" data-pl-note="${esc(path)}">Copy note for agent</button><button type="button" class="mini" data-open="${esc(path)}">Open asset</button></footer>`;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w + 40))}px`;
  pop.style.top = `${r.bottom + h + 10 > innerHeight && r.top - h - 10 > 0 ? r.top - h - 8 : r.bottom + 8}px`;
}

async function copyAgentNote(asset) {
  let note;
  try { note = (await api(`/api/link/note?asset=${encodeURIComponent(asset || "")}`)).note; } catch (err) { return toast(err.message, true); }
  try {
    await navigator.clipboard.writeText(note);
    toast("Note copied. Paste it to your coding agent.");
  } catch {
    // No clipboard (an unfocused window): show it, ready to select.
    openDialog(`<div class="dlg"><h2>${icon("copy")} Note for your coding agent</h2><textarea class="pl-note-text" rows="12" readonly>${esc(note)}</textarea><div class="row"><button type="button" class="ghost" data-close>Close</button></div></div>`);
    $("#dialog .pl-note-text")?.select();
  }
}

document.addEventListener("click", async (event) => {
  const peekBtn = event.target.closest("[data-pl-peek]");
  if (peekBtn) return $("#plPeek")?.dataset.for === peekBtn.dataset.plPeek ? closePeek() : openPeek(peekBtn.dataset.plPeek, peekBtn);
  const t = event.target.closest("[data-pipeline],[data-pl-filter],[data-pl-note],[data-pl-do],[data-pl-link],[data-pl-add]");
  if ($("#plPeek") && (!event.target.closest("#plPeek") || event.target.closest("[data-open]"))) closePeek();
  if (!t) return;
  if (t.dataset.pipeline !== undefined) return go({ type: "pipeline" });
  if (t.dataset.plLink !== undefined) return settingsDialog("connect");
  if (t.dataset.plAdd !== undefined) {
    // A request line "Stone Altar: new prop, 2.5 m tall" becomes a new asset named by what comes before the colon.
    const text = t.dataset.plAdd;
    const colon = text.indexOf(":");
    const title = (colon > 0 ? text.slice(0, colon) : text.slice(0, 60)).trim();
    return newAssetDialog("", { title, prompt: text });
  }
  if (t.dataset.plNote !== undefined) { t.disabled = true; await copyAgentNote(t.dataset.plNote); t.disabled = false; return; }
  if (t.dataset.plFilter !== undefined) {
    const next = t.dataset.plFilter;
    state.plFilter = next && state.plFilter !== next ? next : "";
    storeSet(`forge.pl.${state.project}`, state.plFilter);
    if (!next) { state.plQuery = ""; if ($("#plSearch")) $("#plSearch").value = ""; }
    return paintPipeline();
  }
  if (t.dataset.plDo) {
    const path = t.dataset.path;
    const sound = state.link?.assets.find((a) => a.path === path)?.sound;
    go({ type: "doc", path });
    if (t.dataset.plDo === "generate" && !sound) await openPreview("candidates");
    else if (t.dataset.plDo === "model") await openPreview("make_3d");
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id !== "plSearch") return;
  state.plQuery = event.target.value;
  paintPipeline();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && $("#plPeek")) { closePeek(); event.stopPropagation(); } }, true);
$("#content").addEventListener("scroll", closePeek, { passive: true });
