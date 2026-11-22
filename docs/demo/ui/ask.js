// Tessera's own confirm and prompt, in place of the browser's grey boxes: same dark sheet as every other dialog,
// buttons that say what they do, Enter for the main one and Escape to back out. It is its own <dialog>, so it can
// stand over a sheet that is already open without replacing it.
//
//   await ask({ title, body, ok: "Delete", danger: true })            → true / false
//   await ask({ title, input: "", placeholder: "cast" })              → the text, or null
//   await ask({ title, choices: [{ value, label }, …] })              → the picked value, or null

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function ask({ title, body = "", ok = "OK", cancel = "Cancel", danger = false, input = null, placeholder = "", choices = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "ask-dlg";
    const buttons = choices
      ? choices.map((c, i) => `<button type="${i === 0 ? "submit" : "button"}" class="${i === 0 ? "primary" : "ghost"}" data-ask-pick="${i}">${esc(c.label)}</button>`).join("")
      : `<button type="submit" class="${danger ? "danger" : "primary"}">${esc(ok)}</button>`;
    dlg.innerHTML = `<form class="dlg" method="dialog">
      <h2>${esc(title)}</h2>
      ${body ? `<p>${esc(body)}</p>` : ""}
      ${input !== null ? `<input name="answer" value="${esc(input)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">` : ""}
      <div class="row"><button type="button" class="ghost" data-ask-cancel>${esc(cancel)}</button>${buttons}</div>
    </form>`;
    document.body.appendChild(dlg);
    let answer = input !== null || choices ? null : false;
    let settled = false;
    // Settles at once rather than on the dialog's own "close" event, which some browsers only fire on the next paint.
    const done = () => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(answer);
    };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });  // Escape
    dlg.addEventListener("close", done);
    dlg.querySelector("[data-ask-cancel]").addEventListener("click", done);
    dlg.querySelectorAll("[data-ask-pick]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      answer = choices[Number(b.dataset.askPick)].value;
      done();
    }));
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (choices) answer = choices[0].value;
      else if (input !== null) {
        const text = dlg.querySelector("input").value.trim();
        if (!text) return dlg.querySelector("input").focus();
        answer = text;
      } else answer = true;
      done();
    });
    dlg.showModal();
    const focus = dlg.querySelector("input") || dlg.querySelector("[type=submit]");
    focus?.focus();
    focus?.select?.();
  });
}
