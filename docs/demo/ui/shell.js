// The frame around the pages: the project tree (resizable, hideable), the status bar's popovers, and Tess's chat.
// Tess is a bar at the bottom of the window whose conversation opens upward as a sheet; she can also dock to the
// right or float. On a phone she is a full-screen sheet behind a launcher pill.
// app.js owns the content; this module owns where things sit, and remembers it.

const KEY = "tessera.layout";
const LIMITS = { tree: [180, 420], dockW: [300, 640] };
const CHAT_MIN = { w: 360, h: 420 };
const MOBILE = "(max-width: 900px)";

const LAYOUT_V = 2;

const defaults = () => ({
  v: LAYOUT_V, tree: 248, showTree: true,
  chat: { mode: "", x: -1, y: -1, w: 420, h: 620, dockW: 400 },
});

let layout = load();
let unread = 0;
const listeners = new Set();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") {
      const chat = { ...defaults().chat, ...(saved.chat || {}) };
      // Layout 2 made the bar Tess's home: everyone starts there once, then their own choice is remembered again.
      if (saved.v !== LAYOUT_V) chat.mode = "bar";
      return { ...defaults(), tree: saved.tree ?? 248, showTree: saved.showTree ?? true, chat };
    }
  } catch { /* storage blocked or corrupt: start fresh */ }
  return defaults();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ ...layout, v: LAYOUT_V })); } catch { /* private window */ }
}

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const $ = (sel) => document.querySelector(sel);
export const isMobile = () => matchMedia(MOBILE).matches;

// ---------- the project tree ----------

function applyRegions() {
  const shell = $("#studio");
  if (!shell) return;
  shell.style.setProperty("--tree-w", `${clamp(layout.tree, LIMITS.tree)}px`);
  shell.classList.toggle("no-tree", !layout.showTree);
  document.querySelectorAll("[data-toggle-region='tree']").forEach((b) => {
    b.classList.toggle("on", layout.showTree);
    b.setAttribute("aria-pressed", String(layout.showTree));
  });
  emit();
}

export function toggleTree(force) {
  layout.showTree = force ?? !layout.showTree;
  save();
  applyRegions();
}

// Drag the tree's edge to resize it; double-click resets it.
function initSplitters() {
  document.querySelectorAll("[data-resizer='tree']").forEach((bar) => {
    bar.addEventListener("dblclick", () => { layout.tree = defaults().tree; save(); applyRegions(); });
    bar.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      bar.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, v: layout.tree };
      document.body.classList.add("resizing", "resizing-h");
      const move = (e) => { layout.tree = clamp(start.v + e.clientX - start.x, LIMITS.tree); applyRegions(); };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing", "resizing-h");
        save();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up, { once: true });
      bar.addEventListener("pointercancel", up, { once: true });
    });
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-toggle-region='tree']")) toggleTree();
  });
}

// ---------- status bar popovers (jobs, requests): open on click, close on Esc or a click elsewhere ----------

let popFor = "";
export function openPop(name, html, anchor) {
  let pop = $("#sbPop");
  if (!pop) {
    pop = Object.assign(document.createElement("div"), { id: "sbPop", className: "sb-pop" });
    pop.setAttribute("role", "dialog");
    document.body.append(pop);
  }
  popFor = name;
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor?.getBoundingClientRect();
  if (r) {
    pop.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    pop.style.left = "auto";
  }
}
export const popOpen = (name) => !$("#sbPop")?.hidden && popFor === name;
export function closePop() {
  const pop = $("#sbPop");
  if (pop) pop.hidden = true;
  popFor = "";
}
document.addEventListener("click", (event) => {
  if (popFor && !event.target.closest("#sbPop, [data-sb]")) closePop();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && popFor) { closePop(); event.preventDefault(); }
});

// ---------- chat window ----------

// The desktop mode (bar, floating or docked) is remembered. The bar is always there; its conversation is a sheet
// that is open only while it is being used (`barOpen`), so the page keeps the whole window.
// On a phone the chat is a full-screen sheet that is open only while asked for.
export const chatMode = () => (["float", "dock"].includes(layout.chat.mode) ? layout.chat.mode : "bar");
let chatOff = false;
let sheetOpen = false;
let barOpen = false;
const shownMode = () => (chatOff ? "closed" : isMobile() ? (sheetOpen ? "sheet" : "closed") : chatMode());
// "Shown" means the conversation can be read right now: a collapsed bar does not count.
export const chatShown = () => { const mode = shownMode(); return mode === "bar" ? barOpen : mode !== "closed"; };
const hasMessages = () => Boolean($("#messages .msg"));

export function setChatOff(off) {
  chatOff = off;
  document.body.classList.toggle("chat-off", off);
  applyChat();
}

export function setChatWindow(mode, { focus = false } = {}) {
  if (!["closed", "bar", "float", "dock"].includes(mode)) return;
  const was = shownMode();
  if (isMobile()) sheetOpen = mode !== "closed";
  else {
    // On a desktop "closed" is the collapsed bar.
    barOpen = mode === "bar" ? barOpen : false;
    layout.chat.mode = mode === "closed" ? "bar" : mode;
    save();
  }
  if (chatShown()) unread = 0;
  applyChat();
  if (mode !== "closed" && focus) requestAnimationFrame(() => $("#input")?.focus());
  if (mode === "closed" && was === "sheet" && $("#chatWin")?.contains(document.activeElement)) $("#chatLauncher")?.focus();
}

// Open the bar's sheet (when there is a conversation to show) or fold it back to the bar.
function setBarOpen(open) {
  if (barOpen === open) return;
  barOpen = open;
  if (open) unread = 0;
  applyChat();
}

export function openChat(focus = true) {
  if (!isMobile() && chatMode() === "bar") {
    setBarOpen(hasMessages());
    if (focus) requestAnimationFrame(() => $("#input")?.focus());
    return;
  }
  setChatWindow(isMobile() ? "dock" : chatMode(), { focus });
}

export function closeChat() {
  if (isMobile()) return setChatWindow("closed");
  if (chatMode() !== "bar") { layout.chat.last = chatMode(); return setChatWindow("bar"); }
  setBarOpen(false);
  if ($("#chatWin")?.contains(document.activeElement)) document.activeElement.blur();
}

export function toggleChat() {
  if (chatShown()) closeChat();
  else openChat();
}

// A float position that fits the window, defaulting to the bottom-right corner above the status bar.
function placeFloat() {
  const c = layout.chat;
  const vw = innerWidth, vh = innerHeight, top = 48, bottom = 32;
  c.w = Math.min(Math.max(c.w, CHAT_MIN.w), vw - 24);
  c.h = Math.min(Math.max(c.h, CHAT_MIN.h), vh - top - bottom);
  if (c.x < 0 || c.y < 0) { c.x = vw - c.w - 20; c.y = vh - c.h - bottom - 12; }
  c.x = Math.max(8, Math.min(c.x, vw - c.w - 8));
  c.y = Math.max(top, Math.min(c.y, vh - c.h - bottom));
}

function applyChat() {
  const win = $("#chatWin");
  const launcher = $("#chatLauncher");
  if (!win) return;
  const mode = shownMode();
  document.body.dataset.chat = mode;
  win.hidden = mode === "closed";
  win.classList.toggle("floating", mode === "float");
  win.classList.toggle("docked", mode === "dock");
  win.classList.toggle("sheet", mode === "sheet");
  win.classList.toggle("bar", mode === "bar");
  win.classList.toggle("open", mode === "bar" && barOpen);
  win.style.cssText = "";
  syncBarStatus();
  if (mode === "float") {
    placeFloat();
    const c = layout.chat;
    Object.assign(win.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  }
  document.body.style.setProperty("--dock-w", `${clamp(layout.chat.dockW, LIMITS.dockW)}px`);
  const dockBtn = $("#chatDockBtn");
  if (dockBtn) {
    const docked = mode === "dock";
    dockBtn.title = docked ? "Float the chat" : "Dock Tess to the right";
    dockBtn.setAttribute("aria-label", dockBtn.title);
    dockBtn.classList.toggle("on", docked);
  }
  if (launcher) {
    launcher.hidden = chatOff || mode !== "closed";
    launcher.querySelector(".count").textContent = unread ? String(unread) : "";
    launcher.classList.toggle("has-unread", unread > 0);
  }
  emit();
}

// The line above the collapsed bar: what Tess is doing, or that she has answered.
function syncBarStatus() {
  const el = $("#barStatus");
  if (!el) return;
  const busy = document.body.classList.contains("tess-busy");
  const show = shownMode() === "bar" && !barOpen && (busy || unread > 0);
  el.hidden = !show;
  if (!show) return;
  const steps = document.querySelectorAll("#liveStatus .live-steps li.running > span, #liveStatus .live-steps li:last-child > span");
  const doing = (steps[0]?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
  el.classList.toggle("busy", busy);
  el.querySelector("span").textContent = busy ? doing || "Tess is working…" : "Tess answered";
}

function initChatWindow() {
  const win = $("#chatWin");
  if (!win) return;
  // The bar's status line sits above the composer and opens the sheet.
  const status = Object.assign(document.createElement("button"), { type: "button", id: "barStatus", className: "bar-status", hidden: true });
  status.innerHTML = "<i></i><span></span><em>Open</em>";
  win.querySelector(".composer")?.before(status);
  status.addEventListener("click", () => openChat(true));
  // The sheet opens when the bar is used and there is a conversation to show, and folds away on a click elsewhere.
  win.addEventListener("focusin", () => { if (shownMode() === "bar" && hasMessages()) setBarOpen(true); });
  document.addEventListener("pointerdown", (event) => {
    if (shownMode() !== "bar" || !barOpen) return;
    if (win.contains(event.target) || event.target.closest("dialog, #sbPop, .toast, .ctx-menu, .palette")) return;
    setBarOpen(false);
  });
  // Drag by the header (not its buttons).
  const head = win.querySelector(".chat-head");
  head.addEventListener("pointerdown", (event) => {
    if (chatMode() !== "float" || isMobile() || event.button !== 0 || event.target.closest("button, a, input")) return;
    event.preventDefault();
    head.setPointerCapture(event.pointerId);
    const c = layout.chat;
    const start = { x: event.clientX, y: event.clientY, cx: c.x, cy: c.y };
    win.classList.add("dragging");
    const move = (e) => { c.x = start.cx + e.clientX - start.x; c.y = start.cy + e.clientY - start.y; applyChat(); };
    const up = () => { head.removeEventListener("pointermove", move); win.classList.remove("dragging"); save(); };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up, { once: true });
    head.addEventListener("pointercancel", up, { once: true });
  });
  head.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button") && !isMobile()) setChatWindow(chatMode() === "dock" ? "float" : "dock");
  });
  // Resize from any edge or corner when floating; from the left edge when docked.
  win.querySelectorAll("[data-resize]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (isMobile()) return;
      const mode = chatMode();
      const edge = handle.dataset.resize;
      if (mode === "dock" && edge !== "w") return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const c = layout.chat;
      const start = { x: event.clientX, y: event.clientY, cx: c.x, cy: c.y, w: c.w, h: c.h, dockW: c.dockW };
      document.body.classList.add("resizing");
      const move = (e) => {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (mode === "dock") { c.dockW = clamp(start.dockW - dx, LIMITS.dockW); applyChat(); return; }
        if (edge.includes("e")) c.w = Math.max(CHAT_MIN.w, start.w + dx);
        if (edge.includes("s")) c.h = Math.max(CHAT_MIN.h, start.h + dy);
        if (edge.includes("w")) { const w = Math.max(CHAT_MIN.w, start.w - dx); c.x = start.cx + start.w - w; c.w = w; }
        if (edge.includes("n")) { const h = Math.max(CHAT_MIN.h, start.h - dy); c.y = start.cy + start.h - h; c.h = h; }
        applyChat();
      };
      const up = () => { handle.removeEventListener("pointermove", move); document.body.classList.remove("resizing"); save(); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#chatDockBtn")) setChatWindow(chatMode() === "dock" ? "float" : "dock", { focus: true });
    else if (event.target.closest("#chatCloseBtn")) closeChat();
    else if (event.target.closest("#chatLauncher")) openChat();
  });
  // Esc closes the chat when there is nothing typed (and nothing else, like the model list, is open).
  win.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if ($("#modelPop") && !$("#modelPop").hidden) return;
    if (($("#input")?.value || "").trim()) return;
    event.preventDefault();
    closeChat();
  });
  // "Working" and "answered" come from the chat's own DOM, so app.js needs no hooks for them.
  let wasBusy = false, statusRaf = 0;
  new MutationObserver(() => {
    // What she is doing right now changes often: redraw the bar's line at most once a frame, and only while it shows.
    if (statusRaf || $("#barStatus")?.hidden !== false) return;
    statusRaf = requestAnimationFrame(() => { statusRaf = 0; syncBarStatus(); });
  }).observe($("#messages"), { childList: true, subtree: true, characterData: true });
  const busy = () => {
    const on = Boolean(document.querySelector("#sessionTabs .tab.running"));
    $("#chatLauncher")?.classList.toggle("busy", on);
    document.body.classList.toggle("tess-busy", on);
    // She started because of something typed into the bar: show the conversation. She finished unseen: say so.
    if (on && !wasBusy && shownMode() === "bar" && win.contains(document.activeElement)) setBarOpen(true);
    if (!on && wasBusy && !chatShown()) unread = 1;
    wasBusy = on;
    applyChat();
  };
  new MutationObserver(busy).observe($("#sessionTabs"), { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  busy();
}

// The chat's mode when the user has never chosen one: the bar.
export function defaultChat(mode = "bar") {
  if (!layout.chat.mode) { layout.chat.mode = ["float", "dock"].includes(mode) ? mode : "bar"; save(); applyChat(); }
}

// ---------- layout listeners ----------

export function onLayoutChange(fn) { listeners.add(fn); }
function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* a listener's bug must not break the frame */ } }); }

// ---------- start ----------

export function initShell() {
  initSplitters();
  initChatWindow();
  applyRegions();
  applyChat();
  let raf = 0;
  addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { applyChat(); emit(); }); });
  matchMedia(MOBILE).addEventListener?.("change", () => { applyChat(); applyRegions(); });
}
