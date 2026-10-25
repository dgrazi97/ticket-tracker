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
  return { result: TT.evaluate(tickets, games), updated, error: !ok, ticketsStale: t.stale, title: t.doc.title || "Tickets" };
}

// ---- Presentation helpers ----
const C = {
  bg: new Color("#0d1117"), card: new Color("#161b22"), text: new Color("#e6edf3"),
  dim: new Color("#8b949e"), green: new Color("#3fb950"), yellow: new Color("#d29922"),
  red: new Color("#f85149"), gray: new Color("#6e7681"), accent: new Color("#58a6ff"),
};
const STATUS_COLOR = { Cashed: C.green, Live: C.yellow, Lost: C.red, Pregame: C.gray, Void: C.gray };
const PRIORITY = { Live: 0, Pregame: 1, Cashed: 2, Lost: 3, Void: 4 };
const pct = p => Math.round(p * 100) + "%";
const money = n => "$" + n.toFixed(2);
function timeStr(ts) {
  if (!ts) return "never";
  const df = new DateFormatter(); df.useNoDateStyle(); df.useShortTimeStyle();
  return df.string(new Date(ts));
}
function lastName(p) {
  const parts = p.replace(/\b(Jr\.?|Sr\.?|II|III|IV)$/i, "").trim().split(" ");
  return parts[parts.length - 1];
}
function fmtNum(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
// The leg this ticket still needs most (lowest chance among unhit legs)
function nextNeeded(t) {
  if (t.status === "Cashed") return "All legs hit";
  if (t.status === "Void") return "Void";
  const dead = t.legs.find(l => l.status === "dead");
  if (dead) return lastName(dead.p) + " " + fmtNum(dead.cur) + "/" + dead.line + " " + dead.label + (dead.isOut ? " (OUT)" : " ✗");
  const open = t.legs.filter(l => l.status !== "hit" && l.status !== "void").sort((a, b) => a.prob - b.prob)[0];
  if (!open) return "";
  return lastName(open.p) + " " + fmtNum(open.cur) + "/" + open.line + " " + open.label;
}
function hits(t) { return t.legs.filter(l => l.status === "hit").length; }
function legCount(t) { return t.legs.filter(l => l.status !== "void").length; }
function addText(stack, s, size, color, bold) {
  const t = stack.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}
function footer(w, data, size) {
  let s = "Updated " + timeStr(data.updated);
  if (data.error) s += " · retrying";
  if (data.ticketsStale) s += " · saved bets";
  addText(w, s, size, data.error || data.ticketsStale ? C.yellow : C.dim, false);
}

// ---- Layouts ----
function buildSmall(w, data) {
  const { tickets, cashed } = data.result;
  const counted = tickets.filter(t => t.status !== "Void");
  const alive = counted.filter(t => t.status === "Live" || t.status === "Pregame").length;
  const best = counted.filter(t => t.status === "Live" || t.status === "Pregame").sort((a, b) => b.prob - a.prob)[0];
  addText(w, "🎟️ TICKETS", 11, C.dim, true);
  w.addSpacer(4);
  addText(w, money(cashed), 26, cashed > 0 ? C.green : C.text, true);
  addText(w, "cashed", 10, C.dim, false);
  w.addSpacer(4);
  addText(w, alive + " of " + counted.length + " alive", 13, alive ? C.yellow : C.red, true);
  if (best) addText(w, "Best: " + best.name + " " + pct(best.prob), 11, C.text, false);
  w.addSpacer();
  footer(w, data, 9);
}

function ticketRow(w, t, large) {
  const row = w.addStack(); row.centerAlignContent();
  const dot = row.addText("●"); dot.font = Font.systemFont(large ? 13 : 12); dot.textColor = STATUS_COLOR[t.status] || C.gray;
  row.addSpacer(6);
  addText(row, t.name, large ? 14 : 13, C.text, true);
  row.addSpacer();
  addText(row, hits(t) + "/" + legCount(t), large ? 13 : 12, C.dim, false);
  row.addSpacer(8);
  const pc = t.status === "Cashed" ? "WIN" : t.status === "Lost" ? "LOST" : t.status === "Void" ? "VOID" : pct(t.prob);
  const pt = addText(row, pc, large ? 14 : 13, STATUS_COLOR[t.status] || C.text, true);
  pt.rightAlignText();
  if (large) {
    const sub = w.addStack(); sub.addSpacer(19);
    addText(sub, nextNeeded(t) + "  ·  pays " + money(t.pays), 11, C.dim, false);
    sub.addSpacer();
  }
}

function buildList(w, data, large) {
  const { tickets, cashed } = data.result;
  const head = w.addStack(); head.centerAlignContent();
  addText(head, "🎟️ " + data.title, large ? 15 : 13, C.text, true);
  head.addSpacer();
  addText(head, "Cashed " + money(cashed), large ? 13 : 11, cashed > 0 ? C.green : C.dim, true);
  w.addSpacer(large ? 8 : 4);
  const max = large ? 7 : 5;
  let shown = tickets;
  if (tickets.length > max) {
    // keep the ones that matter most (live, then pregame...), in tickets.json order
    const keep = tickets.map((t, i) => ({ t, i })).sort((a, b) => (PRIORITY[a.t.status] - PRIORITY[b.t.status]) || (a.i - b.i))
      .slice(0, max - 1).sort((a, b) => a.i - b.i).map(x => x.t);
    shown = keep;
  }
  if (!tickets.length) addText(w, "No tickets yet", 13, C.dim, false);
  shown.forEach((t, i) => { ticketRow(w, t, large); if (i < shown.length - 1) w.addSpacer(large ? 7 : 2); });
  if (shown.length < tickets.length) { w.addSpacer(2); addText(w, "+" + (tickets.length - shown.length) + " more in the tracker", 10, C.dim, false); }
  w.addSpacer();
  footer(w, data, large ? 10 : 9);
}

async function main() {
  let data;
  try { data = await loadData(); }
  catch (e) {
    const c = readJSON(TICKETS_FILE);
    data = { result: TT.evaluate(TT.normalizeTickets(c ? c.doc : { tickets: [] }), {}), updated: null, error: true, ticketsStale: true, title: "Tickets" };
  }
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = TRACKER_URL;
  w.setPadding(12, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + REFRESH_SECONDS * 1000);
  const family = config.runsInWidget ? (config.widgetFamily || "medium") : "large";
  if (family === "small") buildSmall(w, data);
  else buildList(w, data, family === "large" || family === "extraLarge");
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentLarge();
  Script.complete();
  return { w, data };
}

main();
