"use strict";

// ------------------------------------------------------------------ 状態
const PALETTE = ["#2f6fed", "#e0562d", "#2a9d5c", "#8b46c9", "#c9358a",
                 "#0d8f9e", "#b8860b", "#5566aa", "#606770"];

let state = null;      // {name, roles:[str], options:{merge,timecodes}, segments:[...]}
let activeIdx = 0;     // キーボード操作のカーソル行
let playingIdx = -1;   // 現在再生中の行
let saveTimer = null;
let dirty = false;
let undoStack = [];    // 破壊的操作の取り消し履歴

const audio = document.getElementById("audio");
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ ユーティリティ
function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
// 行の時刻表示用（分:秒.小数）。編集時の精度を保つため fmt() より細かい。
function fmtPrecise(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + s.toFixed(2).padStart(5, "0");
}
// "1:02.50" / "62.5" / "62.5s" などを秒数へ。解釈できなければ null。
function parseTimeInput(str) {
  str = (str || "").trim().replace(/s$/i, "");
  if (!str) return null;
  if (str.includes(":")) {
    const parts = str.split(":");
    if (parts.length !== 2) return null;
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!isFinite(m) || !isFinite(s) || m < 0 || s < 0) return null;
    return m * 60 + s;
  }
  const v = Number(str);
  return isFinite(v) && v >= 0 ? v : null;
}
function roleColor(role) {
  if (!state) return "#999";
  const i = state.roles.indexOf(role);
  return i < 0 ? "#999" : PALETTE[i % PALETTE.length];
}
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}
function isEditing() {
  const a = document.activeElement;
  return a && a.classList && a.classList.contains("text");
}

// ------------------------------------------------------------------ 保存
function setSaveState(kind) {
  const el = $("saveState");
  el.className = kind;
  el.textContent = { dirty: "未保存…", saving: "保存中…", saved: "保存済み", err: "保存失敗", "": "—" }[kind] || "—";
}
function scheduleSave() {
  dirty = true;
  setSaveState("dirty");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}
async function doSave() {
  if (!state) return;
  clearTimeout(saveTimer);
  setSaveState("saving");
  try {
    const res = await fetch("/api/save?name=" + encodeURIComponent(state.name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roles: state.roles, options: state.options, segments: state.segments }),
    });
    const j = await res.json();
    if (j.ok) { dirty = false; setSaveState("saved"); }
    else setSaveState("err");
  } catch (e) { setSaveState("err"); }
}
// 離脱時に取りこぼしを送る
window.addEventListener("beforeunload", () => {
  if (dirty && state) {
    const blob = new Blob(
      [JSON.stringify({ roles: state.roles, options: state.options, segments: state.segments })],
      { type: "application/json" });
    navigator.sendBeacon("/api/save?name=" + encodeURIComponent(state.name), blob);
  }
});

// ------------------------------------------------------------------ 読み込み
async function loadProjectList() {
  const res = await fetch("/api/list");
  const j = await res.json();
  const sel = $("projectSel");
  sel.innerHTML = "";
  for (const p of j.projects) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name + (p.annotated ? " ●" : "") + (p.audio ? "" : " (音声なし)");
    sel.appendChild(opt);
  }
  const last = localStorage.getItem("lastProject");
  if (last && j.projects.some((p) => p.name === last)) sel.value = last;
  if (sel.value) await loadProject(sel.value);
  else { $("emptyMsg").style.display = "block"; }
}

async function loadProject(name) {
  if (dirty) await doSave();
  const res = await fetch("/api/project?name=" + encodeURIComponent(name));
  if (!res.ok) { toast("読み込み失敗"); return; }
  state = await res.json();
  state.roles = state.roles || [];
  state.options = state.options || { merge: true, timecodes: false };
  activeIdx = 0; playingIdx = -1; dirty = false;
  undoStack = []; updateUndoBtn();
  localStorage.setItem("lastProject", name);

  audio.pause();
  audio.src = state.has_audio ? "/audio?name=" + encodeURIComponent(name) : "";
  seekbar.disabled = !state.has_audio;
  seekbar.value = 0;
  seekbar.style.background = "var(--line)";
  audio.playbackRate = parseFloat($("rate").value);
  $("optMerge").checked = !!state.options.merge;
  $("optTime").checked = !!state.options.timecodes;
  $("emptyMsg").style.display = "none";
  setSaveState("");
  renderRoles();
  renderSegments();
}

// ------------------------------------------------------------------ ロール凡例
function renderRoles() {
  const box = $("roles");
  box.innerHTML = "";
  state.roles.forEach((role, i) => {
    const chip = document.createElement("div");
    chip.className = "role-chip";
    chip.innerHTML =
      '<span class="key">' + (i + 1) + '</span>' +
      '<span class="swatch" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
      '<span class="name" contenteditable="true" spellcheck="false"></span>' +
      '<button class="del" title="削除">×</button>';
    const nameEl = chip.querySelector(".name");
    nameEl.textContent = role;
    nameEl.addEventListener("blur", () => renameRole(i, nameEl.textContent.trim()));
    nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); } });
    chip.querySelector(".del").addEventListener("click", () => deleteRole(i));
    box.appendChild(chip);
  });
  const add = document.createElement("button");
  add.id = "addRole";
  add.textContent = "＋ ロール";
  add.addEventListener("click", addRole);
  box.appendChild(add);
}
function addRole() {
  const name = prompt("ロール名", "話者" + (state.roles.length + 1));
  if (!name) return;
  state.roles.push(name.trim());
  renderRoles(); renderSegments(); scheduleSave();
}
function renameRole(i, newName) {
  if (!newName || newName === state.roles[i]) { renderRoles(); return; }
  const old = state.roles[i];
  state.roles[i] = newName;
  // 割り当て済みの行も追従
  state.segments.forEach((s) => { if (s.role === old) s.role = newName; });
  renderRoles(); renderSegments(); scheduleSave();
}
function deleteRole(i) {
  const role = state.roles[i];
  const used = state.segments.filter((s) => s.role === role).length;
  if (used && !confirm("「" + role + "」は " + used + " 行で使用中です。削除すると未設定に戻ります。よろしいですか？")) return;
  state.roles.splice(i, 1);
  state.segments.forEach((s) => { if (s.role === role) s.role = null; });
  renderRoles(); renderSegments(); scheduleSave();
}

// ------------------------------------------------------------------ セグメント描画
function renderSegments() {
  const box = $("segments");
  box.innerHTML = "";
  const topAdd = document.createElement("button");
  topAdd.className = "add-row-btn";
  topAdd.textContent = "＋ 先頭に行を追加";
  topAdd.title = "最初のセリフより前に、聞き取れていない発話を追加";
  topAdd.addEventListener("click", () => insertSegAt(0));
  box.appendChild(topAdd);
  const frag = document.createDocumentFragment();
  state.segments.forEach((seg, idx) => frag.appendChild(buildSeg(seg, idx)));
  box.appendChild(frag);
  updateActiveClass();
}

function buildSeg(seg, idx) {
  const row = document.createElement("div");
  row.className = "seg" + (seg.manual ? " manual" : "");
  row.dataset.idx = idx;

  row.appendChild(buildTimeCell(seg, idx));

  const roleCell = document.createElement("div");
  roleCell.className = "role-cell";
  state.roles.forEach((role, ri) => {
    const b = document.createElement("button");
    b.className = "role-btn" + (seg.role === role ? " on" : "");
    b.textContent = role;
    if (seg.role === role) b.style.background = PALETTE[ri % PALETTE.length];
    b.title = "キー " + (ri + 1);
    b.addEventListener("click", (e) => { e.stopPropagation(); assignRole(idx, seg.role === role ? null : role); });
    roleCell.appendChild(b);
  });
  row.appendChild(roleCell);

  const text = document.createElement("div");
  text.className = "text" + (seg.text !== seg.original ? " edited" : "");
  text.contentEditable = "true";
  text.spellcheck = false;
  text.textContent = seg.text;
  text.addEventListener("focus", () => setActive(idx, false));
  text.addEventListener("input", () => {
    seg.text = text.textContent;
    text.classList.toggle("edited", seg.text !== seg.original);
    scheduleSave();
  });
  row.appendChild(text);

  const ops = document.createElement("div");
  ops.className = "ops";
  const splitB = mkOp("分割", "カーソル位置で分割（再生中ならその時刻を境界に使用）", () => splitSeg(idx));
  const mergeB = mkOp("↑結合", "上の行と結合", () => mergeUp(idx));
  const addB = mkOp("＋行", "この行の後に、聞き取れていない発話用の行を追加", () => insertSegAt(idx + 1));
  const delB = mkOp("削除", "この行を削除 (D)", () => deleteSeg(idx));
  ops.appendChild(splitB); ops.appendChild(mergeB); ops.appendChild(addB); ops.appendChild(delB);
  row.appendChild(ops);

  row.addEventListener("mousedown", (e) => {
    if (e.target.closest("button") || e.target.classList.contains("text") || e.target.classList.contains("t-val")) return;
    setActive(idx);
  });
  return row;
}
function mkOp(label, title, fn) {
  const b = document.createElement("button");
  b.textContent = label; b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

// --- 時刻セル（開始/終了を個別に編集・再生位置から設定） ------------
function buildTimeCell(seg, idx) {
  const cell = document.createElement("div");
  cell.className = "time-cell";

  ["start", "end"].forEach((field) => {
    const trow = document.createElement("div");
    trow.className = "t-row";

    const val = document.createElement("span");
    val.className = "t-val";
    val.contentEditable = "false";
    val.spellcheck = false;
    val.textContent = fmtPrecise(seg[field]);
    val.title = "クリック: この位置へ移動 / ダブルクリック: 時刻を直接編集";
    val.addEventListener("click", (e) => {
      e.stopPropagation();
      if (val.isContentEditable) return;
      seek(seg[field], true);
      setActive(idx);
    });
    val.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      beginEditTime(val, idx, field);
    });
    trow.appendChild(val);

    const setB = document.createElement("button");
    setB.className = "t-set";
    setB.textContent = "●";
    setB.title = (field === "start" ? "開始" : "終了") + "時刻を今の再生位置に合わせる";
    setB.addEventListener("click", (e) => {
      e.stopPropagation();
      setTimeFromPlayback(idx, field);
    });
    trow.appendChild(setB);

    cell.appendChild(trow);
  });

  if (seg.manual) {
    const badge = document.createElement("span");
    badge.className = "badge-manual";
    badge.textContent = "追加";
    badge.title = "手動で追加した行";
    cell.appendChild(badge);
  }
  return cell;
}

function beginEditTime(el, idx, field) {
  el.contentEditable = "true";
  el.classList.add("editing");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    else if (e.key === "Escape") {
      e.preventDefault();
      el.textContent = fmtPrecise(state.segments[idx][field]);
      el.blur();
    }
  };
  const onBlur = () => {
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("blur", onBlur);
    el.contentEditable = "false";
    el.classList.remove("editing");
    commitTimeEdit(idx, field, el.textContent);
  };
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", onBlur);
}

function commitTimeEdit(idx, field, text) {
  const seg = state.segments[idx];
  const val = parseTimeInput(text);
  if (val === null) { toast("時刻を解釈できません（例: 12.5 や 1:02.50）"); refreshRow(idx); return; }
  if (field === "start" && val >= seg.end) { toast("開始は終了より前にしてください"); refreshRow(idx); return; }
  if (field === "end" && val <= seg.start) { toast("終了は開始より後にしてください"); refreshRow(idx); return; }
  pushUndo("時刻編集");
  seg[field] = val;
  refreshRow(idx);
  scheduleSave();
}

function setTimeFromPlayback(idx, field) {
  if (!state.has_audio) { toast("音声がありません"); return; }
  commitTimeEdit(idx, field, String(audio.currentTime));
}

// 聞き取れていない発話を挿入する。insertIdx の位置に空行を差し込む。
function insertSegAt(insertIdx) {
  pushUndo("追加");
  const prev = state.segments[insertIdx - 1];
  const next = state.segments[insertIdx];
  const start = prev ? prev.end : Math.max(0, (next ? next.start : 1.5) - 1.5);
  let end = (next && next.start > start) ? Math.min(next.start, start + 1.5) : start + 1.5;
  if (end <= start) end = start + 0.5;
  const seg = {
    id: Date.now() + insertIdx, start, end,
    text: "", original: null, role: null, manual: true,
  };
  state.segments.splice(insertIdx, 0, seg);
  renderSegments();
  setActive(insertIdx);
  scheduleSave();
  toast("行を追加しました。時刻を調整し、テキストを入力してください（⌘Z で取り消し）");
  requestAnimationFrame(() => {
    const el = document.querySelector('.seg[data-idx="' + insertIdx + '"] .text');
    if (el) el.focus();
  });
}

// ------------------------------------------------------------------ 行操作
function assignRole(idx, role) {
  state.segments[idx].role = role;
  refreshRow(idx);
  scheduleSave();
}
function refreshRow(idx) {
  const old = document.querySelector('.seg[data-idx="' + idx + '"]');
  if (old) old.replaceWith(buildSeg(state.segments[idx], idx));
  updateActiveClass();
}

function setActive(idx, scroll = true) {
  activeIdx = Math.max(0, Math.min(idx, state.segments.length - 1));
  updateActiveClass();
  if (scroll) scrollToRow(activeIdx);
}
function updateActiveClass() {
  document.querySelectorAll(".seg").forEach((el) => {
    const i = +el.dataset.idx;
    el.classList.toggle("active", i === activeIdx);
    el.classList.toggle("playing", i === playingIdx);
  });
}
function scrollToRow(idx) {
  const el = document.querySelector('.seg[data-idx="' + idx + '"]');
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

// カーソル位置で分割
function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}
function splitSeg(idx) {
  const seg = state.segments[idx];
  const el = document.querySelector('.seg[data-idx="' + idx + '"] .text');
  let pos = el ? caretOffset(el) : null;
  const text = seg.text;
  if (pos === null || pos <= 0 || pos >= text.length) pos = Math.floor(text.length / 2);
  if (text.length < 2) { toast("分割できません"); return; }
  pushUndo("分割");
  let boundary;
  const t = audio.currentTime;
  if (state.has_audio && t > seg.start && t < seg.end) {
    boundary = t; // 再生位置がこの行の範囲内なら、それを境界として使う（文字数比率より正確）
  } else {
    const ratio = pos / text.length;
    boundary = seg.start + (seg.end - seg.start) * ratio;
  }
  const first = { ...seg, text: text.slice(0, pos).trim(), end: boundary };
  const second = {
    id: Date.now() + idx, start: boundary, end: seg.end,
    text: text.slice(pos).trim(), original: "", role: seg.role,
  };
  first.original = "";  // 編集扱い
  state.segments.splice(idx, 1, first, second);
  renderSegments();
  setActive(idx + 1);
  scheduleSave();
}
function pushUndo(label) {
  undoStack.push({ segs: JSON.parse(JSON.stringify(state.segments)), active: activeIdx, label });
  if (undoStack.length > 100) undoStack.shift();
  updateUndoBtn();
}
function undo() {
  if (!undoStack.length) { toast("これ以上は戻せません"); return; }
  const u = undoStack.pop();
  state.segments = u.segs;
  renderSegments();
  setActive(Math.min(u.active, state.segments.length - 1));
  scheduleSave();
  updateUndoBtn();
  toast("元に戻しました" + (u.label ? "（" + u.label + "）" : ""));
}
function updateUndoBtn() {
  const b = $("undoBtn");
  if (b) b.disabled = undoStack.length === 0;
}

function deleteSeg(idx) {
  if (state.segments.length <= 1) { toast("最後の1行は削除できません"); return; }
  pushUndo("削除");
  state.segments.splice(idx, 1);
  renderSegments();
  setActive(Math.min(idx, state.segments.length - 1));
  scheduleSave();
  toast("1行削除しました（⌘Z で取り消し）");
}
function mergeUp(idx) {
  if (idx === 0) { toast("先頭行は結合できません"); return; }
  pushUndo("結合");
  const prev = state.segments[idx - 1], cur = state.segments[idx];
  prev.text = (prev.text + " " + cur.text).trim();
  prev.end = cur.end;
  prev.original = "";
  if (!prev.role) prev.role = cur.role;
  state.segments.splice(idx, 1);
  renderSegments();
  setActive(idx - 1);
  scheduleSave();
}

// ------------------------------------------------------------------ 音声
function seek(t, play) {
  if (!state || !state.has_audio) return;
  audio.currentTime = Math.max(0, t);
  if (play) audio.play();
}
function updatePlaying() {
  const t = audio.currentTime;
  let idx = -1;
  const segs = state.segments;
  for (let i = 0; i < segs.length; i++) {
    if (t >= segs[i].start && t < segs[i].end) { idx = i; break; }
    if (segs[i].start > t) break;
  }
  if (idx !== playingIdx) {
    playingIdx = idx;
    updateActiveClass();
    if (idx >= 0 && $("follow").checked && !isEditing()) scrollToRow(idx);
  }
}

// --- シークバー ---
let scrubbing = false;
const seekbar = $("seekbar");
function renderSeek() {
  const d = audio.duration;
  const pct = d ? (audio.currentTime / d) * 100 : 0;
  if (!scrubbing) seekbar.value = Math.round(pct * 10); // 0..1000
  seekbar.style.background =
    "linear-gradient(to right, var(--accent) " + pct + "%, var(--line) " + pct + "%)";
}
seekbar.addEventListener("input", () => {
  scrubbing = true;
  const d = audio.duration || 0;
  const t = (seekbar.value / 1000) * d;
  $("clock").textContent = fmt(t) + " / " + fmt(d);
  seekbar.style.background =
    "linear-gradient(to right, var(--accent) " + (seekbar.value / 10) + "%, var(--line) " + (seekbar.value / 10) + "%)";
});
seekbar.addEventListener("change", () => {
  const d = audio.duration || 0;
  audio.currentTime = (seekbar.value / 1000) * d;
  scrubbing = false;
  if (state && state.has_audio) audio.play(); // クリック/シークした位置から再生
});

audio.addEventListener("timeupdate", () => {
  $("clock").textContent = fmt(audio.currentTime) + " / " + fmt(audio.duration);
  renderSeek();
  updatePlaying();
});
audio.addEventListener("play", () => { $("playPause").textContent = "⏸"; });
audio.addEventListener("pause", () => { $("playPause").textContent = "▶"; });
audio.addEventListener("loadedmetadata", () => { $("clock").textContent = "0:00 / " + fmt(audio.duration); renderSeek(); });

function togglePlay() {
  if (!state || !state.has_audio) { toast("音声がありません"); return; }
  if (audio.paused) audio.play(); else audio.pause();
}

// ------------------------------------------------------------------ キーボード
document.addEventListener("keydown", (e) => {
  if (!state) return;
  // ロール名やテキスト編集中はショートカット無効（Escで抜ける）
  const editing = document.activeElement && document.activeElement.isContentEditable;
  if (editing) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
  if (e.key >= "1" && e.key <= "9") {
    const ri = +e.key - 1;
    if (ri < state.roles.length) {
      e.preventDefault();
      assignRole(activeIdx, state.roles[ri]);
      if (activeIdx < state.segments.length - 1) setActive(activeIdx + 1);
    }
    return;
  }
  if (e.key === "0") { e.preventDefault(); assignRole(activeIdx, null); return; }
  if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
    e.preventDefault(); setActive(activeIdx + 1); return;
  }
  if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
    e.preventDefault(); setActive(activeIdx - 1); return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const el = document.querySelector('.seg[data-idx="' + activeIdx + '"] .text');
    if (el) { el.focus(); document.getSelection().selectAllChildren(el); document.getSelection().collapseToEnd(); }
    return;
  }
  if (e.key === "d" || e.key === "D") { e.preventDefault(); deleteSeg(activeIdx); return; }
  if (e.key === "i" || e.key === "I") { e.preventDefault(); insertSegAt(activeIdx + 1); return; }
  if (e.key === "r" || e.key === "R") { e.preventDefault(); seek(state.segments[activeIdx].start, true); return; }
  if (e.key === "ArrowLeft") { e.preventDefault(); seek(audio.currentTime - 3, false); return; }
  if (e.key === "ArrowRight") { e.preventDefault(); seek(audio.currentTime + 3, false); return; }
});

// ------------------------------------------------------------------ ヘッダー操作
$("projectSel").addEventListener("change", (e) => loadProject(e.target.value));
$("playPause").addEventListener("click", togglePlay);
$("undoBtn").addEventListener("click", undo);
$("rate").addEventListener("change", (e) => { audio.playbackRate = parseFloat(e.target.value); });
$("optMerge").addEventListener("change", (e) => { state.options.merge = e.target.checked; scheduleSave(); });
$("optTime").addEventListener("change", (e) => { state.options.timecodes = e.target.checked; scheduleSave(); });

$("exportBtn").addEventListener("click", async () => {
  if (!state) return;
  if (dirty) await doSave();
  const res = await fetch("/api/export?name=" + encodeURIComponent(state.name), { method: "POST" });
  const j = await res.json();
  if (j.ok) {
    let msg = "書き出しました: " + j.path.split("/").pop() + "（" + j.lines + "行）";
    if (j.unlabeled) msg += " ／ 未ラベル " + j.unlabeled + " 行は (未設定) で出力";
    toast(msg);
  } else toast("書き出し失敗");
});

$("resetBtn").addEventListener("click", async () => {
  if (!state) return;
  if (!confirm("トランスクリプトから作り直します。付与したロールと編集は失われます。よろしいですか？")) return;
  const res = await fetch("/api/reset?name=" + encodeURIComponent(state.name), { method: "POST" });
  if (res.ok) { state = await res.json(); activeIdx = 0; renderRoles(); renderSegments(); toast("再読込しました"); }
});

// ------------------------------------------------------------------ 起動
loadProjectList();
