"use strict";

const POLL_MS = 15000;
const STARTERS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "META", "GOOGL", "AMD"];
const SESSION_LABEL = { pre: "Pre-market", regular: "Regular", post: "After hours" };
const $ = (id) => document.getElementById(id);

const state = { quotes: [], indexes: [], sort: "mine", lastOk: 0, clock: null, offset: 0, pending: new Set(), removing: new Set() };

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const digits = (p) => (Math.abs(p) < 1 ? 4 : 2);
const num = (p) => (p == null ? "–" : p.toLocaleString("en-US", { minimumFractionDigits: digits(p), maximumFractionDigits: digits(p) }));
const money = (p, cur) => (p == null ? "–" : (cur === "USD" ? "$" : "") + num(p));
const dir = (v) => (v == null || Math.abs(v) < 1e-9 ? "flat" : v > 0 ? "up" : "down");
const signed = (v, d = 2) => (v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d));
const pct = (v) => (v == null ? "–" : signed(v) + "%");
const compact = (v) => (v == null ? "–" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v));
const timeIn = (t, tz) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
const dateIn = (t, tz) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
const sameDay = (a, b, tz) => dateIn(a, tz) === dateIn(b, tz);
const now = () => Date.now() / 1000 + state.offset;

/** The figure that best describes a stock right now: the live session, else the latest print. */
function activeMove(q) {
  if (q.session === "pre" && q.pre) return { ...q.pre, key: "pre" };
  if (q.session === "post" && q.post) return { ...q.post, key: "post" };
  if (q.session === "closed" && q.post && q.post.time > (q.regular?.time ?? 0)) return { ...q.post, key: "post" };
  return { ...q.regular, key: "regular" };
}

/* ---------- rolling digits ---------- */
function odometer(el, text) {
  if (el.dataset.value === text) return;
  const same = el.dataset.value && el.dataset.value.length === text.length;
  if (!same) {
    el.innerHTML = [...text].map((c) => (/\d/.test(c)
      ? `<span class="odo-d"><span>${[0,1,2,3,4,5,6,7,8,9].map((n) => `<i>${n}</i>`).join("")}</span></span>`
      : `<span class="odo-c">${esc(c)}</span>`)).join("");
  }
  const cols = el.querySelectorAll(".odo-d > span");
  let i = 0;
  const digitsOnly = [...text].filter((c) => /\d/.test(c));
  // Set the start position on the next frame so new digits also roll into place.
  requestAnimationFrame(() => cols.forEach((col) => { col.style.transform = `translateY(-${Number(digitsOnly[i++]) * 10}%)`; }));
  el.dataset.value = text;
}

/* ---------- chart ---------- */
function chartMarkup(q) {
  const { points, bands } = q.chart || {};
  if (!points || points.length < 2) return `<div class="nochart">No intraday trades yet</div>`;
  const W = 600, H = 104, PAD = 8;
  const t0 = (bands.pre || bands.regular)[0];
  const t1 = (bands.post || bands.regular)[1];
  const base = q.previous_close;
  const prices = points.map((p) => p[1]).concat(base ?? []);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (p) => PAD + (1 - (p - lo) / (hi - lo)) * (H - PAD * 2);

  const bandRects = Object.entries(bands).map(([k, [a, b]]) =>
    `<rect x="${x(a).toFixed(1)}" y="0" width="${(x(b) - x(a)).toFixed(1)}" height="${H}" fill="url(#g-${k})"/>`).join("");

  const paths = Object.entries(bands).map(([k, [a, b]]) => {
    const seg = points.filter((p) => p[0] >= a && p[0] < b);
    if (!seg.length) return "";
    const d = seg.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join("");
    const close = `L${x(seg[seg.length - 1][0]).toFixed(1)} ${H}L${x(seg[0][0]).toFixed(1)} ${H}Z`;
    return `<path d="${d}${close}" fill="url(#g-${k})"/><path class="ln ${k}" d="${d}"/>`;
  }).join("");

  const baseLine = base != null ? `<line class="base" x1="0" x2="${W}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="g-pre" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb454" stop-opacity=".2"/><stop offset="1" stop-color="#ffb454" stop-opacity="0"/></linearGradient>
      <linearGradient id="g-regular" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4de2d0" stop-opacity=".2"/><stop offset="1" stop-color="#4de2d0" stop-opacity="0"/></linearGradient>
      <linearGradient id="g-post" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b491ff" stop-opacity=".2"/><stop offset="1" stop-color="#b491ff" stop-opacity="0"/></linearGradient>
    </defs>
    ${bandRects}${baseLine}<g class="drawn">${paths}</g></svg>`;
}

function attachChartHover(card) {
  const box = card.querySelector(".chart");
  let cross, tip;
  const clear = () => { cross?.remove(); tip?.remove(); cross = tip = null; };
  box.addEventListener("pointerleave", clear);
  box.addEventListener("pointermove", (e) => {
    const q = state.quotes.find((s) => s.symbol === card.dataset.symbol);
    const pts = q?.chart?.points, bands = q?.chart?.bands;
    if (!pts || pts.length < 2) return;
    const r = box.getBoundingClientRect();
    const t0 = (bands.pre || bands.regular)[0], t1 = (bands.post || bands.regular)[1];
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    const p = pts.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a));
    const px = ((p[0] - t0) / (t1 - t0)) * box.clientWidth;
    if (!cross) {
      cross = document.createElement("div"); cross.className = "cross";
      tip = document.createElement("div"); tip.className = "tip";
      box.append(cross, tip);
    }
    cross.style.left = px + "px";
    tip.textContent = `${money(p[1], q.currency)} · ${timeIn(p[0], q.timezone)}`;
    tip.style.left = Math.max(0, Math.min(px - tip.offsetWidth / 2, box.clientWidth - tip.offsetWidth)) + "px";
  });
}

/* ---------- cards ---------- */
function sessionCell(key, q) {
  const m = q[key];
  const isLive = q.session === key;
  let when = "";
  if (m?.time) {
    const today = sameDay(m.time, now(), q.timezone);
    when = today ? timeIn(m.time, q.timezone) : dateIn(m.time, q.timezone);
  }
  const body = m?.price != null
    ? `<div class="p">${money(m.price, q.currency)}</div><div class="c ${dir(m.change)}">${signed(m.change)} ${pct(m.pct)}</div>`
    : `<div class="none">${q.has_ext ? "No trades yet" : "Not offered"}</div>`;
  return `<div class="sess ${key} ${isLive ? "live" : ""}">
    <div class="name"><span>${key === "regular" ? "Regular" : key === "pre" ? "Pre" : "Post"}</span><span class="when">${isLive ? "Live" : when}</span></div>${body}</div>`;
}

function cardInner(q) {
  if (q.error) {
    return `<div class="card-head"><div class="card-id"><h3>${esc(q.symbol)}</h3></div>
      <button class="remove" data-remove="${esc(q.symbol)}" aria-label="Remove ${esc(q.symbol)}" title="Remove">✕</button></div>
      <div class="err">${esc(q.error)}</div>`;
  }
  return `<div class="card-head">
      <div class="card-id"><h3>${esc(q.symbol)}</h3><p title="${esc(q.name)}">${esc(q.name)}</p></div>
      <div class="hero-price"><div class="odo" data-odo></div><div class="chg" data-chg></div><div class="lbl" data-lbl></div></div>
      <button class="remove" data-remove="${esc(q.symbol)}" aria-label="Remove ${esc(q.symbol)}" title="Remove">✕</button>
    </div>
    <div class="sessions" data-sessions></div>
    <div class="chart" data-chart></div>
    <div class="stats" data-stats></div>`;
}

function updateCard(card, q, isNew) {
  if (q.error) {
    if (!card.classList.contains("error")) { card.className = "card error"; card.innerHTML = cardInner(q); }
    return;
  }
  if (card.classList.contains("error") || !card.querySelector("[data-odo]")) {
    card.className = "card";
    card.innerHTML = cardInner(q);
    attachChartHover(card);
    isNew = true;
  }
  const m = activeMove(q);
  const previous = Number(card.dataset.price);
  if (previous && m.price !== previous) {
    card.classList.remove("flash-up", "flash-down");
    void card.offsetWidth; // restart the animation
    card.classList.add(m.price > previous ? "flash-up" : "flash-down");
  }
  card.dataset.price = m.price ?? "";
  odometer(card.querySelector("[data-odo]"), money(m.price, q.currency));
  const chg = card.querySelector("[data-chg]");
  chg.className = "chg " + dir(m.change);
  chg.textContent = `${signed(m.change)} (${pct(m.pct)})`;
  card.querySelector("[data-lbl]").textContent = SESSION_LABEL[m.key];
  card.querySelector("[data-sessions]").innerHTML = ["pre", "regular", "post"].map((k) => sessionCell(k, q)).join("");
  const chart = card.querySelector("[data-chart]");
  // Rewriting the SVG would drop an open hover tooltip's siblings, so only redraw on new data.
  const sig = JSON.stringify(q.chart?.points?.at(-1)) + (q.chart?.points?.length ?? 0);
  if (chart.dataset.sig !== sig) {
    chart.querySelector("svg, .nochart")?.remove();
    chart.insertAdjacentHTML("afterbegin", chartMarkup(q));
    chart.classList.toggle("intro", !!isNew);
    chart.dataset.sig = sig;
  }
  card.querySelector("[data-stats]").innerHTML =
    `<span>Day <b>${num(q.day_low)} – ${num(q.day_high)}</b></span>
     <span>52W <b>${num(q.year_low)} – ${num(q.year_high)}</b></span>
     <span>Vol <b>${compact(q.volume)}</b></span>${q.stale ? `<span class="stale">Delayed: showing last good quote</span>` : ""}`;
}

function sorted() {
  const list = [...state.quotes];
  if (state.sort === "alpha") list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (state.sort === "movers") {
    const size = (q) => (q.error ? -1 : Math.abs(activeMove(q).pct ?? 0));
    list.sort((a, b) => size(b) - size(a));
  }
  return list;
}

function renderGrid() {
  const grid = $("grid");
  const existing = new Map([...grid.children].map((c) => [c.dataset.symbol, c]));
  const list = sorted();
  list.forEach((q, i) => {
    let card = existing.get(q.symbol);
    const isNew = !card;
    if (isNew) {
      card = document.createElement("article");
      card.className = "card";
      card.dataset.symbol = q.symbol;
      card.style.animationDelay = `${Math.min(i * 45, 400)}ms`;
      card.draggable = true;
      card.innerHTML = cardInner(q);
      if (!q.error) attachChartHover(card);
    }
    updateCard(card, q, isNew);
    if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
    existing.delete(q.symbol);
  });
  existing.forEach((c) => { if (!c.classList.contains("leaving")) c.remove(); });
}

function renderPulse() {
  const ok = state.quotes.filter((q) => !q.error);
  const moves = ok.map((q) => ({ q, m: activeMove(q) }));
  const adv = moves.filter((x) => x.m.change > 0).length;
  const dec = moves.filter((x) => x.m.change < 0).length;
  $("advancers").textContent = adv;
  $("decliners").textContent = dec;
  $("breadthFill").style.width = (adv + dec ? (adv / (adv + dec)) * 100 : 50) + "%";
  $("heat").innerHTML = moves.map(({ q, m }) => {
    const strength = Math.min(Math.abs(m.pct ?? 0) / 4, 1);
    const rgb = (m.pct ?? 0) >= 0 ? "52,227,160" : "255,92,124";
    return `<button class="tile" data-locate="${esc(q.symbol)}" title="${esc(q.name)}" style="background:rgba(${rgb},${(0.08 + strength * 0.55).toFixed(2)})"><b>${esc(q.symbol)}</b><span>${pct(m.pct)}</span></button>`;
  }).join("");
  $("pulseSection").hidden = !state.quotes.length;
}

function renderTape() {
  const ok = [...state.indexes, ...state.quotes].filter((q) => !q.error);
  const seen = new Set();
  const items = ok.filter((q) => !seen.has(q.symbol) && seen.add(q.symbol)).map((q) => {
    const m = activeMove(q);
    return `<span class="tape-item"><b>${esc(q.symbol)}</b>${num(m.price)} <span class="${dir(m.change)}">${pct(m.pct)}</span></span>`;
  }).join("");
  // Doubled so the -50% keyframe loops seamlessly.
  $("tapeTrack").innerHTML = items + items;
  $("tape").classList.toggle("off", !items);
}

function renderIndexes() {
  $("indexes").innerHTML = state.indexes.filter((q) => !q.error).map((q) => {
    const m = activeMove(q);
    return `<div class="index"><b>${esc(q.symbol)}</b><small>${SESSION_LABEL[m.key]}</small><div class="v ${dir(m.change)}">${pct(m.pct)}</div></div>`;
  }).join("");
}

function renderEmpty() {
  const empty = !state.quotes.length && !state.pending.size;
  $("empty").hidden = !empty;
  $("toolbar").hidden = empty;
  $("chips").innerHTML = STARTERS.map((s) => `<button data-add="${s}">+ ${s}</button>`).join("");
}

function renderAll() {
  renderGrid(); renderPulse(); renderTape(); renderIndexes(); renderEmpty(); tickClock();
}

/* ---------- market clock ---------- */
function tickClock() {
  const spy = state.indexes.find((q) => !q.error && q.periods);
  if (!spy) return;
  const { pre, regular, post } = spy.periods;
  const t = now();
  const tz = spy.timezone;
  $("clockTime").textContent = `New York · ${new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: tz })}`;
  let session = "closed", next = null, nextLabel = "";
  if (t < pre.start) { next = pre.start; nextLabel = "Pre-market opens in"; }
  else if (t < pre.end) { session = "pre"; next = pre.end; nextLabel = "Opening bell in"; }
  else if (t < regular.end) { session = "regular"; next = regular.end; nextLabel = "Closing bell in"; }
  else if (t < post.end) { session = "post"; next = post.end; nextLabel = "After hours ends in"; }
  const names = { pre: "Pre-market trading", regular: "Market open", post: "After-hours trading", closed: "Market closed" };
  $("clockState").textContent = names[session];
  $("clockState").dataset.session = session;
  $("clockSub").textContent = next ? `${nextLabel} ${countdown(next - t)}` : "Showing the latest session's closing and after-hours prices";
  $("ribbon").dataset.session = session;
  const marker = $("nowMarker");
  marker.hidden = session === "closed";
  if (!marker.hidden) marker.style.left = (((t - pre.start) / (post.end - pre.start)) * 100).toFixed(2) + "%";
}

function countdown(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? h + "h " : ""}${String(m).padStart(h ? 2 : 1, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

function renderStatus() {
  const age = state.lastOk ? Math.floor(Date.now() / 1000 - state.lastOk) : null;
  const bad = age == null || age > POLL_MS / 1000 * 3;
  $("liveDot").classList.toggle("bad", bad);
  $("statusText").textContent = age == null ? "Connecting" : bad ? `Can't reach the server. Last update ${age}s ago` : `Updated ${age}s ago`;
}

/* ---------- data ---------- */
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch("/api/quotes");
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.quotes = data.quotes.filter((q) => !state.removing.has(q.symbol));
    state.indexes = data.indexes;
    state.offset = data.server_time - Date.now() / 1000;
    state.lastOk = Date.now() / 1000;
    renderAll();
  } catch (err) {
    console.warn("Quote refresh failed", err);
  } finally {
    polling = false;
    renderStatus();
  }
}

function toast(message, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

async function addTicker(raw) {
  const symbol = raw.trim().toUpperCase();
  if (!symbol) return false;
  const form = $("addForm");
  form.classList.add("busy");
  state.pending.add(symbol);
  try {
    const { quote } = await api("POST", "/api/watchlist", { symbol });
    state.quotes = state.quotes.filter((q) => q.symbol !== quote.symbol).concat(quote);
    renderAll();
    document.querySelector(`[data-symbol="${CSS.escape(quote.symbol)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    state.pending.delete(symbol);
    form.classList.remove("busy");
    renderEmpty();
  }
}

async function removeTicker(symbol) {
  const card = document.querySelector(`[data-symbol="${CSS.escape(symbol)}"]`);
  card?.classList.add("leaving");
  state.removing.add(symbol); // a poll already in flight must not bring the card back
  try {
    await api("DELETE", `/api/watchlist/${encodeURIComponent(symbol)}`);
    state.quotes = state.quotes.filter((q) => q.symbol !== symbol);
    setTimeout(() => { card?.remove(); renderAll(); }, 220);
    setTimeout(() => state.removing.delete(symbol), POLL_MS);
  } catch (err) {
    state.removing.delete(symbol);
    card?.classList.remove("leaving");
    toast(err.message, true);
  }
}

/* ---------- interactions ---------- */
document.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) return void removeTicker(rm.dataset.remove);
  const add = e.target.closest("[data-add]");
  if (add) { add.disabled = true; addTicker(add.dataset.add).finally(() => { add.disabled = false; }); return; }
  const locate = e.target.closest("[data-locate]");
  if (locate) {
    const card = document.querySelector(`[data-symbol="${CSS.escape(locate.dataset.locate)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.add("located");
    setTimeout(() => card?.classList.remove("located"), 1400);
  }
  const sort = e.target.closest("[data-sort]");
  if (sort) {
    state.sort = sort.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("on", b === sort));
    renderGrid();
  }
  if (!e.target.closest("#addForm")) hideSuggest();
});

document.addEventListener("pointermove", (e) => {
  const card = e.target.closest?.(".card");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("addInput")) { e.preventDefault(); $("addInput").focus(); }
});

/* Drag to reorder */
let dragged = null;
$("grid").addEventListener("dragstart", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  dragged = card;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", card.dataset.symbol);
});
$("grid").addEventListener("dragover", (e) => {
  if (!dragged) return;
  e.preventDefault();
  document.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
  const over = e.target.closest(".card");
  if (over && over !== dragged) over.classList.add("drop-target");
});
$("grid").addEventListener("drop", async (e) => {
  e.preventDefault();
  const over = e.target.closest(".card");
  if (!dragged || !over || over === dragged) return;
  const symbols = sorted().map((q) => q.symbol).filter((s) => s !== dragged.dataset.symbol);
  symbols.splice(symbols.indexOf(over.dataset.symbol), 0, dragged.dataset.symbol);
  state.quotes.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
  state.sort = "mine";
  document.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("on", b.dataset.sort === "mine"));
  renderGrid();
  try { await api("PUT", "/api/watchlist", { tickers: symbols }); }
  catch (err) { toast(err.message, true); }
});
$("grid").addEventListener("dragend", () => {
  dragged?.classList.remove("dragging");
  document.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
  dragged = null;
});

/* Add box with suggestions */
const input = $("addInput");
const list = $("suggest");
let suggestions = [], selected = -1, searchTimer, searchSeq = 0;

function hideSuggest() { list.hidden = true; suggestions = []; selected = -1; }
function renderSuggest() {
  list.innerHTML = suggestions.map((s, i) =>
    `<li data-i="${i}" class="${i === selected ? "on" : ""}"><b>${esc(s.symbol)}</b><span>${esc(s.name)}</span><em>${esc(s.exchange)}</em></li>`).join("");
  list.hidden = !suggestions.length;
}
input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  const seq = ++searchSeq;
  if (!q) return hideSuggest();
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      suggestions = results; selected = -1; renderSuggest();
    } catch { hideSuggest(); }
  }, 180);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideSuggest(); return; }
  if (!suggestions.length) return;
  if (e.key === "ArrowDown") { e.preventDefault(); selected = (selected + 1) % suggestions.length; renderSuggest(); }
  if (e.key === "ArrowUp") { e.preventDefault(); selected = (selected - 1 + suggestions.length) % suggestions.length; renderSuggest(); }
});
list.addEventListener("mousedown", async (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  e.preventDefault();
  const symbol = suggestions[Number(li.dataset.i)].symbol;
  submit(symbol);
});
$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submit(selected >= 0 ? suggestions[selected].symbol : input.value);
});
async function submit(symbol) {
  searchSeq++;
  clearTimeout(searchTimer);
  hideSuggest();
  if (await addTicker(symbol)) input.value = "";
  input.focus();
}

renderEmpty();
poll();
setInterval(poll, POLL_MS);
setInterval(() => { tickClock(); renderStatus(); }, 1000);
