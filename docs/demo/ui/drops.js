// Drag and drop into Tessera: files, whole folders, .zip packs, pictures dragged from a web page, and pastes.
//
// While something is dragged over the window the page says what a drop there would do, on the spot it would land:
//   an asset (its page, its tile on the wall, a grey "not made yet" cube) → the files join that asset;
//   the picked picture on an asset page → it replaces the winner;
//   a section (sidebar, breadcrumbs, folder rows, a folder page) → new assets there, with the section's kind;
//   Tess's bar → attach pictures to the message, or let Tess sort everything;
//   anywhere else → a review sheet, where Tess can sort too.
// Everything goes through /api/drops (forge/drops.py): staged, planned, applied, and undone in one step.

let ctx;
let internalDrag = false;  // a tile or an output dragged inside Tessera is not a drop of files
let hovered = null;
let leaveTimer = 0;

const BATCH_BYTES = 48 * 1024 * 1024;
const BATCH_FILES = 120;
const $ = (s, root = document) => root.querySelector(s);

export function initDrops(context) {
  ctx = context;
  document.body.insertAdjacentHTML("beforeend", `<div id="dropVeil" aria-hidden="true"></div><div id="dropTip" role="status" hidden></div>`);
  document.addEventListener("dragstart", () => { internalDrag = true; }, true);
  document.addEventListener("dragend", () => { internalDrag = false; }, true);
  document.addEventListener("dragenter", onOver);
  document.addEventListener("dragover", onOver);
  document.addEventListener("dragleave", () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(endDrag, 80); });
  document.addEventListener("drop", onDrop);
  document.addEventListener("paste", onPaste);
}

const carriesStuff = (dt) => !!dt && !internalDrag && !dt.types.includes("application/x-tessera-asset")
  && (dt.types.includes("Files") || dt.types.includes("text/uri-list") || dt.types.includes("text/html"));

// ---------- where a drop lands ----------

function shown(el) { return el && !el.hidden && el.offsetParent !== null; }

function targetAt(el) {
  if (!el?.closest) return null;
  const s = ctx.state;
  if ($("#dialog")?.open) return null;
  if (shown($("#onboarding"))) return null;
  if (shown($("#settingsView"))) return null;
  if (shown($("#projectsView"))) return { kind: "projects", el: $("#projectsView"), label: "Import a Tessera project (.zip)" };
  const chat = el.closest(".panel.chat");
  if (chat) {
    const zone = el.closest("[data-dz]");
    if (zone?.dataset.dz === "tess") return { kind: "tess", el: zone, label: ctx.agentReady() ? "Tess sorts and files them for you" : "Connect an agent in Settings so Tess can sort" , off: !ctx.agentReady() };
    return { kind: "attach", el: zone || chat, label: "Attach pictures to your message" };
  }
  if (!s.project || !s.overview) return null;
  const hero = el.closest("[data-drop-winner]");
  if (hero && s.view.type === "doc") return { kind: "asset", path: s.view.path, hero: true, el: hero, label: "Replace the picked picture" };
  const tile = el.closest(".asset-tile[data-tile], .wall-tile[data-tile]");
  if (tile) return { kind: "asset", path: tile.dataset.tile, el: tile, label: `Add to ${tile.dataset.name || ctx.humanize(tile.dataset.tile.split("/").pop().replace(/\.md$/, ""))}` };
  const folder = el.closest("#sections [data-folder], .crumbs [data-folder], .folder-row[data-folder]");
  if (folder) {
    const name = (folder.querySelector(".sec-name, .folder-text strong")?.textContent || folder.textContent).trim();
    return { kind: "folder", path: folder.dataset.folder, el: folder, label: `New assets in ${name || "this section"}` };
  }
  const content = el.closest("#content");
  if (content && s.view.type === "doc" && content.dataset.dropAsset !== undefined) {
    return { kind: "asset", path: s.view.path, el: content, label: `Add to ${ctx.assetTitle(s.view.path)}` };
  }
  if (content && s.view.type === "folder") return { kind: "folder", path: s.view.path, el: content, label: `New assets in ${ctx.humanize(s.view.path.split("/").pop())}` };
  return { kind: "review", el: $("#content") || document.body, label: "Add to the project · you'll check where each goes" };
}

function showTip(target, event) {
  const tip = $("#dropTip");
  tip.textContent = target.label;
  tip.className = `drop-tip${target.off ? " off" : ""}${target.kind === "tess" ? " tess" : ""}`;
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 12, Math.max(12, event.clientX + 16));
  const y = Math.min(window.innerHeight - tip.offsetHeight - 12, Math.max(12, event.clientY + 18));
  tip.style.transform = `translate(${x}px, ${y}px)`;
}

function markTarget(target) {
  if (hovered?.el === target?.el) return;
  hovered?.el?.classList.remove("drop-on");
  hovered = target;
  target?.el?.classList.add("drop-on");
}

function startDrag() {
  if (document.body.classList.contains("dropping")) return;
  document.body.classList.add("dropping");
  const chat = $(".panel.chat");
  if (chat && !chat.querySelector(".dz-split")) {
    chat.insertAdjacentHTML("beforeend", `<div class="dz-split"><div data-dz="attach">${ctx.icon("upload")}<span>Attach to message</span></div>
      <div data-dz="tess"${ctx.agentReady() ? "" : ` class="off"`}><img class="tess-art" src="ui/art/tess-drops.webp" alt="" aria-hidden="true" draggable="false">${ctx.icon("sparkle")}<span>Let Tess sort them</span></div></div>`);
  }
}

function endDrag() {
  document.body.classList.remove("dropping");
  markTarget(null);
  $("#dropTip").hidden = true;
  document.querySelectorAll(".dz-split").forEach((el) => el.remove());
}

function onOver(event) {
  if (!carriesStuff(event.dataTransfer)) return;
  event.preventDefault();
  clearTimeout(leaveTimer);
  startDrag();
  const target = targetAt(event.target);
  event.dataTransfer.dropEffect = target && !target.off ? "copy" : "none";
  markTarget(target);
  if (target) showTip(target, event); else $("#dropTip").hidden = true;
}

// ---------- reading what was dropped ----------

// Folders only open while the drop event lasts, so their entries are taken first and read afterwards.
function entriesOf(dt) {
  return [...(dt.items || [])].map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)).filter(Boolean);
}

async function readEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject)).catch(() => null);
    if (file) out.push({ file, path: `${prefix}${file.name}` });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
    if (out.length > 4000) return;
  }
}

function urlFrom(dt) {
  const list = (dt.getData("text/uri-list") || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  const html = dt.getData("text/html") || "";
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  return img || list || "";
}

// ---------- staging ----------

function progress(text, busy = true) {
  const tip = $("#dropTip");
  tip.innerHTML = `${busy ? `<span class="spinner"></span>` : ""}<span>${ctx.esc(text)}</span>`;
  tip.className = "drop-tip docked";
  tip.style.transform = "";
  tip.hidden = false;
}
const doneProgress = () => { const tip = $("#dropTip"); if (tip.classList.contains("docked")) tip.hidden = true; };

function postForm(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      xhr.status < 300 ? resolve(data) : reject(new Error(data.detail || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Tessera isn't answering. Is it still running?"));
    xhr.send(form);
  });
}

const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function stage(items) {
  const total = items.reduce((n, i) => n + i.file.size, 0);
  let sent = 0;
  let drop = "";
  let result = null;
  for (let i = 0; i < items.length;) {
    const batch = [];
    let bytes = 0;
    while (i < items.length && batch.length < BATCH_FILES && (bytes === 0 || bytes + items[i].file.size <= BATCH_BYTES)) {
      bytes += items[i].file.size;
      batch.push(items[i++]);
    }
    const form = new FormData();
    batch.forEach(({ file, path }) => { form.append("files", file, file.name); form.append("paths", path); });
    const base = sent;
    const url = `/api/drops?project=${encodeURIComponent(ctx.state.project)}${drop ? `&drop=${drop}` : ""}`;
    result = await postForm(url, form, (loaded) => progress(total > 2 * 1048576 ? `Copying ${plural(items.length, "file")} · ${mb(base + loaded)} of ${mb(total)}` : `Copying ${plural(items.length, "file")}…`));
    drop = result.id;
    sent += bytes;
  }
  return result;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------- dropping ----------

async function onDrop(event) {
  if (!carriesStuff(event.dataTransfer)) return;
  event.preventDefault();
  const target = hovered || targetAt(event.target);
  const dt = event.dataTransfer;
  const entries = entriesOf(dt);
  const loose = [...dt.files];
  const url = loose.length ? "" : urlFrom(dt);
  endDrag();
  if (!target || target.off) return target?.off && ctx.toast("Connect your coding agent in Settings → Tess, then Tess can sort drops for you.", true);
  let items = [];
  if (entries.some((e) => e.isDirectory)) {
    progress("Reading the folder…");
    for (const entry of entries) await readEntry(entry, "", items);
  } else {
    items = loose.map((file) => ({ file, path: file.name }));
  }
  try {
    await handle(target, items, url);
  } catch (err) {
    ctx.toast(err.message, true);
  } finally {
    doneProgress();
  }
}

async function onPaste(event) {
  if (event.target.closest?.("input, textarea, select, [contenteditable]") || $("#dialog")?.open) return;
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length || !ctx.state.project || !ctx.state.overview) return;
  event.preventDefault();
  const s = ctx.state;
  const target = s.view.type === "doc" && $("#content [data-drop-winner]") ? { kind: "asset", path: s.view.path }
    : s.view.type === "folder" ? { kind: "folder", path: s.view.path } : { kind: "review" };
  try { await handle(target, files.map((file, i) => ({ file, path: file.name === "image.png" ? `pasted-${Date.now()}-${i}.png` : file.name }))); }
  catch (err) { ctx.toast(err.message, true); }
  finally { doneProgress(); }
}

async function handle(target, items, url = "") {
  if (target.kind === "projects") {
    const zip = items.find((i) => /\.zip$/i.test(i.file.name));
    return zip ? ctx.importArchive(zip.file) : ctx.toast("Drop a Tessera project .zip here to import it.", true);
  }
  if (target.kind === "attach") {
    const images = items.map((i) => i.file).filter((f) => f.type.startsWith("image/"));
    if (images.length) ctx.addFiles(images);
    else if (url) ctx.toast("Save the picture first, then drop the file on the message.", true);
    if (images.length < items.length) ctx.toast(images.length ? "Only pictures can go with a message; the rest was left out. Drop them on “Let Tess sort them” instead." : "Only pictures can go with a message. Drop other files on “Let Tess sort them”.", !images.length);
    return;
  }
  if (!items.length && !url) return;
  const staged = url
    ? (progress("Downloading…"), await ctx.api("/api/drops/url", { method: "POST", body: { url } }))
    : await stage(items);
  if (!staged.files.length) return reportSkipped(staged.skipped, true);
  const where = target.kind === "asset" || target.kind === "folder" ? target.path : "";
  let plan = await ctx.api(`/api/drops/${staged.id}/plan?target=${encodeURIComponent(where)}`);
  if (target.kind === "tess") {
    progress(`Tess is looking at ${plural(plan.rows.length, "asset")}…`);
    plan = await ctx.api(`/api/drops/${staged.id}/tess`, { method: "POST", body: { plan } });
    if (plan.sorted_by !== "tess") return reviewSheet(plan);
    return applyPlan(plan, plan.rows, "tess");
  }
  if (target.kind === "review") return reviewSheet(plan);
  if (target.hero) plan.rows.forEach((r) => { r.pick = r.type === "image"; });
  return applyPlan(plan, plan.rows, target.kind);
}

function reportSkipped(skipped, nothing = false) {
  if (!skipped?.length) return;
  const why = [...new Set(skipped.map((s) => s.why))].slice(0, 2).join(", ");
  ctx.toast(nothing ? `Nothing to add: ${plural(skipped.length, "file")} skipped (${why}).` : `${plural(skipped.length, "file")} skipped (${why}).`, nothing);
}

async function applyPlan(plan, rows, how) {
  progress(`Adding ${plural(rows.filter((r) => r.action !== "skip").length, "asset")}…`);
  const result = await ctx.api(`/api/drops/${plan.id}/apply`, { method: "POST", body: { rows } });
  const made = result.created.length;
  const filled = result.updated.length;
  const into = filled === 1 ? `added to ${ctx.assetTitle(result.updated[0])}` : `added to ${plural(filled, "asset")}`;
  const parts = [made && plural(made, "new asset"), filled && into].filter(Boolean).join(" · ");
  let label = how === "tess" ? `Tess filed ${parts}` : parts.replace(/^./, (c) => c.toUpperCase());
  if (!made && filled === 1 && plan.rows.some((r) => r.pick)) label = `New picture picked for ${ctx.assetTitle(result.updated[0])}`;
  if (!made && !filled) label = "Nothing was added";
  await ctx.refresh();
  if (made || filled) ctx.pushUndo(label, async () => { await ctx.api(`/api/drops/${plan.id}/undo`, { method: "POST" }); await ctx.reload(); });
  else ctx.toast(label);
  if (result.problems.length) setTimeout(() => ctx.toast(`${plural(result.problems.length, "asset")} couldn't be added: ${result.problems[0].why}`, true), 2500);
  ctx.flash([...result.created, ...result.updated]);
  if (plan.skipped?.length) setTimeout(() => reportSkipped(plan.skipped), 4000);
}

// ---------- the review sheet ----------

function fileSrc(plan, rel) {
  return `/api/drops/${plan.id}/file?project=${encodeURIComponent(ctx.state.project)}&path=${encodeURIComponent(rel)}`;
}

function rowThumb(plan, row) {
  const image = row.files.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f) && !(row.textures || []).includes(f));
  if (image) return `<img src="${ctx.esc(fileSrc(plan, image))}" alt="" loading="lazy">`;
  return ctx.icon(row.type === "model" ? "cube" : row.type === "audio" ? "sound" : "upload");
}

function rowFacts(row) {
  const c = row.counts || {};
  const bits = [];
  if (c.model) bits.push(plural(c.model, "model"));
  if (row.textures?.length) bits.push(plural(row.textures.filter((t) => /\.(png|jpe?g|webp|tga|bmp)$/i.test(t)).length, "texture"));
  const pics = (c.image || 0) - (row.textures || []).filter((t) => /\.(png|jpe?g|webp|tga|bmp)$/i.test(t)).length;
  if (pics > 0) bits.push(pics > 2 && !c.model ? `${pics} frames` : plural(pics, "picture"));
  if (c.audio) bits.push(plural(c.audio, "sound"));
  return bits.filter((b) => !b.startsWith("0 ")).join(" · ");
}

function rowHtml(plan, row) {
  const kinds = plan.kinds.map((k) => `<option value="${k}"${k === row.kind ? " selected" : ""}>${ctx.esc(ctx.kindLabel(k))}</option>`).join("");
  const matchTitle = row.match ? ctx.assetTitle(row.match) : "";
  return `<div class="drop-row${row.action === "skip" ? " skip" : ""}${row.tess ? " by-tess" : ""}" data-row="${row.id}">
    <span class="drop-thumb">${rowThumb(plan, row)}</span>
    <div class="drop-main">
      <input class="drop-title" value="${ctx.esc(row.title)}" aria-label="Name" maxlength="60"${row.action === "add" ? " disabled" : ""}>
      <small>${ctx.esc(rowFacts(row))}${row.tess ? ` · <b class="tess-mark">${ctx.icon("sparkle")}Tess</b>` : ""}</small>
    </div>
    <select class="drop-action" aria-label="What to do">
      <option value="new"${row.action === "new" ? " selected" : ""}>New asset</option>
      ${row.match ? `<option value="add"${row.action === "add" ? " selected" : ""}>Add to ${ctx.esc(matchTitle)}</option>` : ""}
      <option value="skip"${row.action === "skip" ? " selected" : ""}>Skip</option>
    </select>
    <select class="drop-kind" aria-label="Kind"${row.action !== "new" ? " disabled" : ""}>${kinds}</select>
    <input class="drop-folder" list="dropFolders" value="${ctx.esc(row.folder)}" placeholder="Top of the project" aria-label="Folder"${row.action !== "new" ? " disabled" : ""}>
  </div>`;
}

function readRows(plan) {
  for (const el of document.querySelectorAll("#dropForm .drop-row")) {
    const row = plan.rows.find((r) => String(r.id) === el.dataset.row);
    if (!row) continue;
    row.title = $(".drop-title", el).value.trim() || row.title;
    row.action = $(".drop-action", el).value;
    row.kind = $(".drop-kind", el).value;
    row.folder = $(".drop-folder", el).value.trim().replace(/^\/+|\/+$/g, "");
  }
}

function sheetCount(plan) {
  const keep = plan.rows.filter((r) => r.action !== "skip");
  const made = keep.filter((r) => r.action === "new").length;
  return { keep: keep.length, label: made === keep.length ? `Add ${plural(made, "asset")}` : `Add ${keep.length} (${made} new)` };
}

function reviewSheet(plan) {
  doneProgress();
  const files = plan.rows.reduce((n, r) => n + r.files.length, 0);
  const folders = [...new Set([...plan.sections, ...plan.rows.map((r) => r.folder)])].filter(Boolean);
  const ready = ctx.agentReady();
  ctx.openDialog(`<form class="dlg sheet tone-sky drop-sheet" id="dropForm">
    ${ctx.sheetHead("upload", `Add to ${ctx.projectTitle()}`, `${plural(files, "file")} · ${plural(plan.rows.length, "asset")}`,
      "Your own files: nothing is generated and nothing is spent. Pictures join an asset as candidates; an asset with no picked picture gets the first one.")}
    ${plan.note ? `<p class="drop-note">${ctx.esc(plan.note)}</p>` : ""}
    <div class="drop-rows" id="dropRows">${plan.rows.map((r) => rowHtml(plan, r)).join("")}</div>
    <datalist id="dropFolders">${folders.map((f) => `<option value="${ctx.esc(f)}">`).join("")}</datalist>
    ${plan.skipped?.length ? `<details class="drop-skipped"><summary>${plural(plan.skipped.length, "file")} left out</summary><ul>${plan.skipped.slice(0, 80).map((s) => `<li><code>${ctx.esc(s.name)}</code> ${ctx.esc(s.why)}</li>`).join("")}</ul></details>` : ""}
    <footer class="sheet-foot">
      <button type="button" class="ghost tess-sort" data-drop-tess${ready ? "" : " disabled title=\"Connect your coding agent in Settings → Tess first\""}>${ctx.icon("sparkle")}${plan.sorted_by === "tess" ? "Sort again" : "Let Tess sort"}</button>
      <span class="grow"></span>
      <button type="button" class="ghost" data-close>Cancel</button>
      <button class="run-btn" id="dropGo">${ctx.icon("check")}${sheetCount(plan).label}</button>
    </footer>
  </form>`);
  const form = $("#dropForm");
  form.addEventListener("change", (event) => {
    readRows(plan);
    const el = event.target.closest(".drop-row");
    if (el && event.target.classList.contains("drop-action")) {
      const row = plan.rows.find((r) => String(r.id) === el.dataset.row);
      el.outerHTML = rowHtml(plan, row);
    }
    const count = sheetCount(plan);
    $("#dropGo").innerHTML = `${ctx.icon("check")}${count.label}`;
    $("#dropGo").disabled = !count.keep;
  });
  form.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-drop-tess]")) return;
    readRows(plan);
    const btn = event.target.closest("[data-drop-tess]");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>Tess is looking…`;
    form.classList.add("sorting");
    try {
      const sorted = await ctx.api(`/api/drops/${plan.id}/tess`, { method: "POST", body: { plan } });
      Object.assign(plan, sorted);
      $("#dropRows").innerHTML = plan.rows.map((r) => rowHtml(plan, r)).join("");
      document.querySelectorAll("#dropRows .drop-row.by-tess").forEach((el, i) => { el.style.animationDelay = `${i * 40}ms`; el.classList.add("arrive"); });
      if (sorted.note) ctx.toast(sorted.note, true);
      $("#dropFolders").innerHTML = [...new Set([...plan.sections, ...plan.rows.map((r) => r.folder)])].filter(Boolean).map((f) => `<option value="${ctx.esc(f)}">`).join("");
      $("#dropGo").innerHTML = `${ctx.icon("check")}${sheetCount(plan).label}`;
    } catch (err) {
      ctx.toast(err.message, true);
    } finally {
      form.classList.remove("sorting");
      btn.disabled = false;
      btn.innerHTML = `${ctx.icon("sparkle")}Sort again`;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    readRows(plan);
    ctx.closeDialog();
    try { await applyPlan(plan, plan.rows, "review"); } catch (err) { ctx.toast(err.message, true); } finally { doneProgress(); }
  });
}

// File pickers ("Add 3D model", "Use a picture from your computer") go the same way as a drop on that spot.
export async function dropFiles(target, files) {
  try { await handle({ ...target, kind: target.kind || "asset" }, [...files].map((file) => ({ file, path: file.name }))); }
  catch (err) { ctx.toast(err.message, true); }
  finally { doneProgress(); }
}
