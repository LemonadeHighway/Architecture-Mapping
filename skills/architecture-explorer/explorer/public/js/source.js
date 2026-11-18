// A read-only source viewer: the lines around a file:line from the scan, with the line highlighted.
import { esc } from "./model.js";

export async function openSource(modal, file, line, toast) {
  modal.hidden = false;
  modal.innerHTML = `<div class="box"><div class="bar"><span class="path">${esc(file)}:${line}</span></div><div class="code"><div class="skeleton" style="height:240px;margin:12px"></div></div></div>`;
  const close = () => {
    modal.hidden = true;
    modal.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  modal.onclick = (ev) => {
    if (ev.target === modal) close();
  };
  try {
    const r = await fetch(`/api/source?file=${encodeURIComponent(file)}&line=${line}&context=40`);
    if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
    const s = await r.json();
    const lines = s.lines.map((t, i) => {
      const no = s.start + i;
      return `<div class="ln${no === s.line ? " hit" : ""}"><span class="no">${no}</span><span>${esc(t) || " "}</span></div>`;
    }).join("");
    const vscode = `vscode://file/${s.editorPath.replace(/\\/g, "/")}:${s.line}`;
    modal.innerHTML = `<div class="box"><div class="bar"><span class="path">${esc(s.file)}:${s.line} <span class="faint">(${s.total} lines)</span></span><button class="btn" id="src-copy">Copy path:line</button><a class="btn" href="${esc(vscode)}">Open in VS Code</a><button class="btn" id="src-close">Close</button></div><div class="code">${lines}</div></div>`;
    modal.querySelector("#src-close").onclick = close;
    modal.querySelector("#src-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(`${s.file}:${s.line}`);
        toast("Copied.");
      } catch {
        toast("Couldn't copy.", true);
      }
    };
    modal.querySelector(".ln.hit")?.scrollIntoView({ block: "center" });
  } catch (e) {
    modal.innerHTML = `<div class="box"><div class="bar"><span class="path">${esc(file)}:${line}</span><button class="btn" id="src-close">Close</button></div><div class="empty">Couldn't load the source: ${esc(e.message)}</div></div>`;
    modal.querySelector("#src-close").onclick = close;
  }
}
