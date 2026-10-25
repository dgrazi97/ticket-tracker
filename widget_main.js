// ---- Widget (Scriptable) ----------------------------------------------------
const TRACKER_URL = "https://dgrazi97.github.io/ticket-tracker/";
const TICKETS_URL = TRACKER_URL + "tickets.json";
const REFRESH_SECONDS = 60; // ask iOS for ~1 min; iOS still throttles (often 5-15 min)

// ---- Local cache (FileManager.local) so a failed fetch still shows something ----
const FM = FileManager.local();
const DIR = FM.joinPath(FM.documentsDirectory(), "ticket-tracker");
const TICKETS_FILE = FM.joinPath(DIR, "tickets.json");
const DATA_FILE = FM.joinPath(DIR, "espn-cache.json");
function readJSON(path) {
  try { if (FM.fileExists(path)) return JSON.parse(FM.readString(path)); } catch (e) {}
  return null;
}
function writeJSON(path, obj) {
  try { if (!FM.fileExists(DIR)) FM.createDirectory(DIR, true); FM.writeString(path, JSON.stringify(obj)); } catch (e) {}
}

// tickets.json is fetched every run (cache-busted) so new bets show up without re-pasting
async function loadTickets() {
  try {
    const r = new Request(TICKETS_URL + "?t=" + Date.now());
    r.timeoutInterval = 15;
    r.headers = { "Cache-Control": "no-cache" };
    const doc = await r.loadJSON();
    if (!doc || !Array.isArray(doc.tickets)) throw new Error("bad tickets.json");
    writeJSON(TICKETS_FILE, { doc, fetched: Date.now() });
    return { doc, stale: false };
  } catch (e) {
    const c = readJSON(TICKETS_FILE);
    return { doc: c ? c.doc : { tickets: [] }, stale: true, fetched: c ? c.fetched : null };
  }
}

async function fetchRaw(events) {
  const raw = {};
  let failures = 0;
  await Promise.all(events.map(async e => {
    try {
      const r = new Request(TT.summaryUrl(e.sport, e.ev));
      r.timeoutInterval = 15;
      const d = await r.loadJSON();
      if (!d || !d.header) throw new Error("bad response");
      // keep only what the parser needs so the cache stays small
      raw[e.key] = { header: d.header, boxscore: { players: (d.boxscore && d.boxscore.players) || [] }, injuries: d.injuries || [] };
    } catch (err) { failures++; }
  }));
  return { raw, failures };
}

async function loadData() {
  const t = await loadTickets();
  const tickets = TT.normalizeTickets(t.doc);
  const events = TT.eventsOf(tickets);
  const cache = readJSON(DATA_FILE) || { raw: {}, updated: null };
  let fresh;
  try { fresh = await fetchRaw(events); } catch (e) { fresh = { raw: {}, failures: events.length || 1 }; }
  const raw = {};
  for (const e of events) { const v = fresh.raw[e.key] || (cache.raw || {})[e.key]; if (v) raw[e.key] = v; }
  const ok = fresh.failures === 0;
  const updated = ok ? Date.now() : (cache.updated || null);
  writeJSON(DATA_FILE, { raw, updated: updated || Date.now() });
  const sportOf = {}; for (const e of events) sportOf[e.key] = e.sport;
  const games = {};
  for (const k of Object.keys(raw)) { try { games[k] = TT.parseSummary(raw[k], sportOf[k]); } catch (e) {} }
  const result = TT.evaluate(tickets, games);
  return { result, view: TT.currentView(result, Date.now()), updated, error: !ok, ticketsStale: t.stale };
}

// ---- Presentation -------------------------------------------------------------
const C = {
  bg: new Color("#0d1117"), text: new Color("#e6edf3"), dim: new Color("#8b949e"),
  green: new Color("#3fb950"), yellow: new Color("#d29922"), red: new Color("#f85149"),
  gray: new Color("#6e7681"), white: new Color("#ffffff"),
};
const STATUS_COLOR = { Cashed: C.green, Live: C.yellow, Lost: C.red, Pregame: C.gray, Void: C.gray };
const PRIORITY = { Live: 0, Pregame: 1, Cashed: 2, Lost: 3, Void: 4 };
const pct = p => Math.round(p * 100) + "%";
const money = n => "$" + n.toFixed(2);
const fmtNum = n => Number.isInteger(n) ? String(n) : n.toFixed(1);

// Row heights (pt) used by the fitting algorithm; rows are drawn with these exact heights.
const H = { header: 18, afterHeader: 4, title: 15, afterTitle: 1, chip11: 13, chip10: 12, chip9: 11, gap: 4, more: 12 };
const PAD = { v: 10, h: 12 };
// Widget sizes (pt) by screen width, from Apple's published widget dimensions.
function widgetSize(family) {
  let w = 430;
  try { const s = Device.screenSize(); w = Math.min(s.width, s.height); } catch (e) {}
  const t = w >= 428 ? { small: [170, 170], medium: [364, 170], large: [364, 382] }
    : w >= 414 ? { small: [169, 169], medium: [360, 169], large: [360, 379] }
    : w >= 390 ? { small: [158, 158], medium: [338, 158], large: [338, 354] }
    : w >= 375 ? { small: [155, 155], medium: [329, 155], large: [329, 345] }
    : { small: [141, 141], medium: [292, 141], large: [292, 311] };
  const fam = family === "extraLarge" ? "large" : family;
  const [ww, hh] = t[fam] || t.large;
  return { w: ww - 2 * PAD.h, h: hh - 2 * PAD.v };
}

function timeStr(ts) {
  if (!ts) return "never";
  const df = new DateFormatter(); df.useNoDateStyle(); df.useShortTimeStyle();
  return df.string(new Date(ts));
}
function lastName(p) {
  const parts = String(p).replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, "").trim().split(/\s+/);
  return parts[parts.length - 1];
}
// Last names; first initial added when two different players share one.
function nameMap(tickets) {
  const byLast = {};
  for (const t of tickets) for (const l of t.legs) { const k = lastName(l.p); (byLast[k] = byLast[k] || new Set()).add(l.p); }
  return leg => {
    if (leg.short) return leg.short;
    const ln = lastName(leg.p);
    return byLast[ln] && byLast[ln].size > 1 ? leg.p.trim()[0] + ". " + ln : ln;
  };
}
function shortName(name) {
  let s = String(name).replace(/\bparlay\b/ig, "").replace(/\s+/g, " ").trim();
  const noSgp = s.replace(/\s*\bSGPx?\b\s*$/i, "").trim();
  if (noSgp.length > 2) s = noSgp;
  return s || String(name);
}
function kickoff(t) {
  if (t.time) return String(t.time).replace(/:00\b/, "").replace(/\s+/g, " ");
  const f = TT.ticketTimes(t).first;
  return f ? timeStr(f) : "";
}
function hits(t) { return t.legs.filter(l => l.status === "hit").length; }
function legCount(t) { return t.legs.filter(l => l.status !== "void").length; }
function liveDetail(t) { // clock for single-game live tickets, e.g. "7:30 - 2nd"
  const evs = new Set(t.legs.map(l => l.key));
  if (evs.size !== 1) { const n = new Set(t.legs.filter(l => l.game.state === "in").map(l => l.key)).size; return n ? n + " live" : ""; }
  const g = t.legs[0].game; return g.state === "in" ? String(g.detail || "") : "";
}

function chipText(l, name) {
  if (l.status === "void") return name + " void";
  const pre = l.game.state === "pre" && l.status !== "hit" && l.status !== "dead";
  if (l.anytime) {
    const mark = l.status === "hit" ? " ✓" : l.status === "dead" ? " ✗" : "";
    if (l.line <= 1) return name + " TD" + (mark || (pre ? " –" : " " + fmtNum(l.cur))) + (l.isOut && l.status === "dead" ? " OUT" : "");
    return name + " TD " + (pre ? "–" : fmtNum(l.cur)) + "/" + fmtNum(l.line) + mark;
  }
  if (l.isOut && l.status === "dead") return name + " OUT ✗";
  return name + " " + (pre ? "–" : fmtNum(l.cur)) + "/" + fmtNum(l.line) + (l.status === "hit" ? " ✓" : l.status === "dead" ? " ✗" : "");
}
function chipColor(l) {
  if (l.status === "hit") return C.green;
  if (l.status === "dead") return C.red;
  if (l.status === "void") return C.gray;
  if (l.game.state === "pre") return C.gray;
  return l.prob < 0.3 ? C.yellow : C.white; // live: yellow = behind pace
}

// ---- Fitting ---------------------------------------------------------------------
// plan = { items: [{ t, mode: "full"|"one"|"title" }], font, perRow, more: "+N ..." | null }
function chipH(font) { return font >= 11 ? H.chip11 : font >= 10 ? H.chip10 : H.chip9; }
function itemH(it, plan) {
  let h = H.title;
  const n = it.mode === "full" ? Math.ceil((it.maxLegs || it.t.legs.length) / plan.perRow) : it.mode === "one" ? 1 : 0;
  if (n) h += H.afterTitle + n * chipH(plan.font);
  return h;
}
function planHeight(plan) {
  let h = H.header + H.afterHeader;
  plan.items.forEach((it, i) => { h += itemH(it, plan) + (i ? H.gap : 0); });
  if (plan.more) h += H.gap + H.more;
  return h;
}
const sortTickets = ts => ts.map((t, i) => ({ t, i })).sort((a, b) => (PRIORITY[a.t.status] - PRIORITY[b.t.status]) || (a.i - b.i)).map(x => x.t);
const isLive = t => t.status === "Live";
const isOpen = t => t.status === "Live" || t.status === "Pregame";

// Generic shrink: try fonts/columns, then collapse non-live items (settled first, from the bottom),
// then drop non-live items into "+N other". Live legs are only trimmed if nothing else is left.
function fit(items, budget, opts) {
  const variants = opts.variants;
  const mk = (v, its, more) => ({ items: its.map(x => Object.assign({}, x)), font: v.font, perRow: v.perRow, more });
  for (const v of variants) { const p = mk(v, items, opts.more ? opts.more(0) : null); if (planHeight(p) <= budget) return p; }
  const v = variants[variants.length - 1];
  let p = mk(v, items, opts.more ? opts.more(0) : null);
  // collapse non-live: settled -> title (already), pregame "full" -> "one" -> "title", bottom-up
  for (const target of ["one", "title"]) {
    for (let i = p.items.length - 1; i >= 0 && planHeight(p) > budget; i--) {
      const it = p.items[i];
      if (isLive(it.t) || it.mode === "title") continue;
      if (target === "one" && it.mode === "full" && Math.ceil(it.t.legs.length / p.perRow) > 1) it.mode = "one";
      else if (target === "title") it.mode = "title";
    }
    if (planHeight(p) <= budget) return p;
  }
  // drop non-live items from the bottom (settled first since they sort last)
  let dropped = 0;
  while (planHeight(p) > budget) {
    let idx = -1;
    for (let i = p.items.length - 1; i >= 0; i--) if (!isLive(p.items[i].t)) { idx = i; break; }
    if (idx < 0) break;
    p.items.splice(idx, 1); dropped++;
    p.more = "+" + (dropped + (opts.extra || 0)) + " other" + (dropped + (opts.extra || 0) === 1 ? "" : "s");
  }
  let liveDropped = 0;
  // last resort (live legs alone overflow): trim chip rows off the last ticket, then drop it
  while (planHeight(p) > budget && p.items.length) {
    const last = p.items[p.items.length - 1];
    const n = last.mode === "full" ? (last.maxLegs || last.t.legs.length) : 0;
    if (n > p.perRow) last.maxLegs = (Math.ceil(n / p.perRow) - 1) * p.perRow;
    else { p.items.pop(); liveDropped++; }
    if (liveDropped) { const o = dropped + (opts.extra || 0); p.more = "+" + liveDropped + " more live" + (o ? ", +" + o + " other" + (o === 1 ? "" : "s") : ""); }
  }
  return p;
}

function pageParam() {
  const a = (typeof args !== "undefined" && args.widgetParameter) ? String(args.widgetParameter) : "";
  const m = a.match(/(\d)/); return m ? Number(m[1]) : 0;
}
const LARGE_VARIANTS = [{ font: 11, perRow: 3 }, { font: 10, perRow: 3 }, { font: 9, perRow: 4 }];

function planLarge(tickets, budget, page) {
  const sorted = sortTickets(tickets);
  if (!page) { // default: live tickets with every leg, everything else one title line
    const items = sorted.map(t => ({ t, mode: isLive(t) ? "full" : "title" }));
    return fit(items, budget, { variants: LARGE_VARIANTS });
  }
  // paged: every open ticket with its legs; page 1 takes whole tickets in order until full, page 2 the rest
  const all = sorted.map(t => ({ t, mode: isOpen(t) ? "full" : "title" }));
  const base = { font: 11, perRow: 3, more: null };
  const p1 = [];
  for (const it of all) {
    const trial = Object.assign({}, base, { items: p1.concat([it]) });
    if (planHeight(trial) > budget && p1.length) break;
    p1.push(it);
  }
  if (page === 1) return fit(p1, budget, { variants: LARGE_VARIANTS });
  const rest = all.slice(p1.length);
  if (!rest.length) return { items: [], font: 11, perRow: 3, more: null, note: "All tickets on widget 1" };
  return fit(rest, budget, { variants: LARGE_VARIANTS });
}
function planMedium(tickets, budget) {
  const sorted = sortTickets(tickets);
  const live = sorted.filter(isLive), other = sorted.filter(t => !isLive(t));
  const V = [{ font: 11, perRow: 2 }, { font: 10, perRow: 2 }];
  if (live.length) {
    const more = n => other.length ? "+" + other.length + " other" + (other.length === 1 ? "" : "s") : null;
    return fit(live.map(t => ({ t, mode: "full" })), budget, { variants: V, more, extra: other.length });
  }
  // nothing live: next-up title lines while they fit, then "+N other"
  const p = { items: [], font: 11, perRow: 2, more: null };
  for (let i = 0; i < other.length; i++) {
    const left = other.length - i - 1;
    const trial = Object.assign({}, p, { items: p.items.concat([{ t: other[i], mode: "title" }]), more: left ? "+" + left + " other" + (left === 1 ? "" : "s") : null });
    if (planHeight(trial) > budget) break;
    Object.assign(p, trial);
  }
  if (p.items.length < other.length) { const n = other.length - p.items.length; p.more = "+" + n + " other" + (n === 1 ? "" : "s"); }
  return p;
}

// ---- Drawing -----------------------------------------------------------------------
function addText(stack, s, size, color, bold) {
  const t = stack.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.7;
  return t;
}
function drawHeader(w, data, view, size, page) {
  const head = w.addStack(); head.size = new Size(size.w, H.header); head.centerAlignContent();
  addText(head, view.title, 14, C.text, true);
  head.addSpacer();
  addText(head, money(view.cashed) + " cashed", 11, view.cashed > 0 ? C.green : C.dim, true);
  head.addSpacer(6);
  let s = timeStr(data.updated);
  if (data.error || data.ticketsStale) s += " !";
  if (page) s += " · " + page + "/2";
  addText(head, s, 10, data.error || data.ticketsStale ? C.yellow : C.dim, false);
  w.addSpacer(H.afterHeader);
}
function drawTitle(w, t, size) {
  const row = w.addStack(); row.size = new Size(size.w, H.title); row.centerAlignContent();
  const dot = row.addText("●"); dot.font = Font.systemFont(10); dot.textColor = STATUS_COLOR[t.status] || C.gray;
  row.addSpacer(4);
  addText(row, shortName(t.name), 12, C.text, true);
  const sub = t.status === "Pregame" ? kickoff(t) : t.status === "Live" ? liveDetail(t) : "";
  if (sub && sub !== shortName(t.name)) { row.addSpacer(5); addText(row, sub, 10, C.dim, false); }
  row.addSpacer();
  addText(row, hits(t) + "/" + legCount(t), 11, C.dim, false);
  row.addSpacer(6);
  const pc = t.status === "Cashed" ? "WIN" : t.status === "Lost" ? "LOST" : t.status === "Void" ? "VOID" : pct(t.prob);
  addText(row, pc, 12, STATUS_COLOR[t.status] === C.gray ? C.text : STATUS_COLOR[t.status], true);
  row.addSpacer(6);
  addText(row, money(t.pays), 11, t.status === "Cashed" ? C.green : C.dim, false);
}
function drawChips(w, it, plan, size, nm) {
  const legs = it.maxLegs ? it.t.legs.slice(0, it.maxLegs) : it.mode === "one" ? it.t.legs.slice(0, plan.perRow) : it.t.legs;
  const rh = chipH(plan.font), cw = Math.floor((size.w - 8) / plan.perRow);
  w.addSpacer(H.afterTitle);
  for (let i = 0; i < legs.length; i += plan.perRow) {
    const row = w.addStack(); row.size = new Size(size.w, rh); row.centerAlignContent();
    row.addSpacer(8); // indent under the dot
    for (let j = i; j < i + plan.perRow; j++) {
      const cell = row.addStack(); cell.size = new Size(cw, rh); cell.centerAlignContent();
      const l = legs[j];
      if (l) {
        let s = chipText(l, nm(l));
        const lastShown = (it.mode === "one" || it.maxLegs) && j === legs.length - 1 && it.t.legs.length > legs.length;
        if (lastShown) s += "  +" + (it.t.legs.length - legs.length);
        addText(cell, s, plan.font, chipColor(l), l.status === "hit" || l.status === "dead");
      }
      cell.addSpacer();
    }
  }
}
function drawPlan(w, plan, size, nm) {
  plan.items.forEach((it, i) => {
    if (i) w.addSpacer(H.gap);
    drawTitle(w, it.t, size);
    if (it.mode !== "title") drawChips(w, it, plan, size, nm);
  });
  if (plan.note) addText(w, plan.note, 11, C.dim, false);
  if (plan.more) { w.addSpacer(H.gap); const r = w.addStack(); r.size = new Size(size.w, H.more); addText(r, plan.more, 10, C.dim, false); r.addSpacer(); }
  w.addSpacer();
}

function buildSmall(w, data, view) {
  const counted = view.shown.filter(t => t.status !== "Void");
  const open = counted.filter(isOpen);
  const best = open.slice().sort((a, b) => b.prob - a.prob)[0];
  addText(w, "🎟️ " + view.title.toUpperCase(), 10, C.dim, true);
  w.addSpacer(4);
  addText(w, money(view.cashed), 26, view.cashed > 0 ? C.green : C.text, true);
  addText(w, "cashed", 10, C.dim, false);
  w.addSpacer(4);
  addText(w, open.length + " of " + counted.length + " alive", 13, open.length ? C.yellow : C.red, true);
  if (best) addText(w, "Best: " + shortName(best.name) + " " + pct(best.prob), 11, C.text, false);
  w.addSpacer();
  let s = "Updated " + timeStr(data.updated);
  if (data.error) s += " · retrying";
  addText(w, s, 9, data.error || data.ticketsStale ? C.yellow : C.dim, false);
}

async function main() {
  let data;
  try { data = await loadData(); }
  catch (e) {
    const c = readJSON(TICKETS_FILE);
    const result = TT.evaluate(TT.normalizeTickets(c ? c.doc : { tickets: [] }), {});
    data = { result, view: TT.currentView(result, Date.now()), updated: null, error: true, ticketsStale: true };
  }
  const view = data.view;
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = TRACKER_URL;
  w.setPadding(PAD.v, PAD.h, PAD.v, PAD.h);
  w.refreshAfterDate = new Date(Date.now() + REFRESH_SECONDS * 1000);
  const family = config.runsInWidget ? (config.widgetFamily || "medium") : "large";
  const size = widgetSize(family);
  let plan = null;
  if (family === "small") buildSmall(w, data, view);
  else {
    const large = family !== "medium";
    const page = large ? pageParam() : 0;
    const budget = size.h;
    plan = large ? planLarge(view.shown, budget, page) : planMedium(view.shown, budget);
    drawHeader(w, data, view, size, page);
    if (!view.shown.length) addText(w, "No tickets yet", 12, C.dim, false);
    drawPlan(w, plan, size, nameMap(view.shown));
    plan.height = planHeight(plan); plan.budget = budget;
  }
  try { globalThis.__ttLast = { plan, view, family, size }; } catch (e) {}
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentLarge();
  Script.complete();
}

await main();
