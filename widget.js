// Ticket Tracker widget for Scriptable (scriptable.app)
// Paste into a new Scriptable script, then add a Scriptable widget to your
// home screen and pick this script. Tap the widget to open the full tracker.
// Data: ESPN public game summaries. iOS decides real refresh timing (~5-15 min).

const TRACKER_URL = "https://dgrazi97.github.io/ticket-tracker/";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=";

// ---- Ticket definitions + stat logic (same as logic.js on the web tracker) ----
const TICKETS = [
  { name: "Paris SGP", time: "9:30 AM", stake: 5, pays: 25.80, legs: [
    { p: "DK Metcalf", ev: "401873011", stat: "rec", line: 4 },
    { p: "Devaughn Vele", ev: "401873011", stat: "rec", line: 3 },
    { p: "Juwan Johnson", ev: "401873011", stat: "rec", line: 3 },
    { p: "Chris Olave", ev: "401873011", stat: "rec", line: 6 },
    { p: "Jaylen Warren", ev: "401873011", stat: "rec", line: 2 },
    { p: "Pat Freiermuth", ev: "401873011", stat: "rec", line: 2 } ] },
  { name: "TD SGPx", time: "1 PM", stake: 5, pays: 71.45, legs: [
    { p: "Ja'Marr Chase", tdp: 0.5, ev: "401873012", stat: "td", line: 1 },
    { p: "Derrick Henry", tdp: 0.58, ev: "401873012", stat: "td", line: 1 },
    { p: "George Kittle", tdp: 0.45, ev: "401873017", stat: "td", line: 1 },
    { p: "Chuba Hubbard", tdp: 0.42, ev: "401873018", stat: "td", line: 1 } ] },
  { name: "TD parlay #2", time: "1 PM", stake: 5, pays: 68.40, legs: [
    { p: "Nico Collins", tdp: 0.45, ev: "401873016", stat: "td", line: 1 },
    { p: "Jonathan Taylor", tdp: 0.55, ev: "401873014", stat: "td", line: 1 },
    { p: "Garrett Wilson", tdp: 0.38, ev: "401873015", stat: "td", line: 1 } ] },
  { name: "Props parlay", time: "1 PM", stake: 10, pays: 67.84, legs: [
    { p: "Aaron Jones", ev: "401873014", stat: "rushyds", line: 39 },
    { p: "Isaiah Likely", ev: "401873016", stat: "recyds", line: 50 },
    { p: "Tetairoa McMillan", ev: "401873018", stat: "recyds", line: 71 } ] },
  { name: "1 PM SGPx", time: "1 PM", stake: 5, pays: 26.86, legs: [
    { p: "Bijan Robinson", ev: "401873017", stat: "rushyds", line: 80 },
    { p: "Michael Penix Jr.", ev: "401873017", stat: "passyds", line: 220 },
    { p: "Deshaun Watson", ev: "401873013", stat: "rushyds", line: 25 },
    { p: "Carson Schwesinger", ev: "401873013", stat: "tackles", line: 8 } ] },
];
const STAT_LABEL = { rec: "rec", recyds: "rec yds", rushyds: "rush yds", passyds: "pass yds", tackles: "tackles", td: "TD" };

const norm = s => (s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();

// Parse a summary JSON into { game, players: {normName: {rec,recyds,rushyds,passyds,tackles,td}}, out: Set }
function parseSummary(d) {
  const comp = (d.header && d.header.competitions && d.header.competitions[0]) || {};
  const st = comp.status || {};
  const type = st.type || {};
  const teams = (comp.competitors || []).map(c => ({ abbr: c.team && c.team.abbreviation, score: c.score, homeAway: c.homeAway }));
  const away = teams.find(t => t.homeAway === "away") || teams[1] || {};
  const home = teams.find(t => t.homeAway === "home") || teams[0] || {};
  const game = {
    state: type.state || "pre", completed: !!type.completed,
    detail: type.shortDetail || type.detail || "", period: st.period || 0,
    clock: st.displayClock || "", away, home,
  };
  const players = {};
  const get = n => (players[n] = players[n] || { rec: 0, recyds: 0, rushyds: 0, passyds: 0, tackles: 0, td: 0, team: "" });
  const bp = (d.boxscore && d.boxscore.players) || [];
  for (const team of bp) {
    const abbr = team.team && team.team.abbreviation;
    for (const cat of team.statistics || []) {
      const keys = cat.keys || [];
      for (const a of cat.athletes || []) {
        const n = norm(a.athlete && a.athlete.displayName);
        if (!n) continue;
        const p = get(n); p.team = abbr;
        const v = k => { const i = keys.indexOf(k); return i < 0 ? 0 : (parseFloat(String(a.stats[i]).split("/")[0]) || 0); };
        if (cat.name === "receiving") { p.rec = v("receptions"); p.recyds = v("receivingYards"); p.td += v("receivingTouchdowns"); }
        else if (cat.name === "rushing") { p.rushyds = v("rushingYards"); p.td += v("rushingTouchdowns"); }
        else if (cat.name === "passing") { p.passyds = v("passingYards"); }
        else if (cat.name === "defensive") { p.tackles = v("totalTackles"); }
      }
    }
  }
  const out = new Set();
  for (const t of d.injuries || []) for (const i of t.injuries || []) {
    if (String(i.status).toLowerCase() === "out" && i.athlete) out.add(norm(i.athlete.displayName));
  }
  return { game, players, out };
}

function fracLeft(g) {
  if (g.state === "pre") return 1;
  if (g.state === "post") return 0;
  const per = g.period || 1;
  const [m, s] = String(g.clock || "15:00").split(":").map(Number);
  const secLeftQ = (m || 0) * 60 + (s || 0);
  if (per > 4) return Math.max(0.02, secLeftQ / 3600);
  if (/half/i.test(g.detail)) return 0.5;
  return Math.max(0, ((4 - per) * 900 + secLeftQ) / 3600);
}

// simple priors: expected per-game value given the line (books set floor lines below the mean)
const PRIOR = { rec: l => l * 1.35, recyds: l => l * 1.15, rushyds: l => l * 1.15, passyds: l => l * 1.1, tackles: l => l * 1.05 };
function poissonAtLeast(lam, k) {
  if (k <= 0) return 1; let term = Math.exp(-lam), cdf = term;
  for (let i = 1; i < k; i++) { term *= lam / i; cdf += term; }
  return Math.max(0, Math.min(1, 1 - cdf));
}
function normAtLeast(mu, sd, x) { // P(X >= x)
  if (sd <= 0) return mu >= x ? 1 : 0;
  const z = (x - mu) / sd, t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = 1 - 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function legEstimate(leg, cur, g) {
  const need = leg.line - cur;
  if (need <= 0) return 1;
  const r = fracLeft(g);
  if (r <= 0) return 0;
  const elapsed = 1 - r;
  if (leg.stat === "td") { const lam = -Math.log(1 - (leg.tdp || 0.4)); return 1 - Math.exp(-lam * r); }
  const mu0 = PRIOR[leg.stat](leg.line);
  const pace = elapsed > 0.05 ? cur / elapsed : mu0;
  const w = Math.min(0.6, elapsed);
  const muRem = r * (w * pace + (1 - w) * mu0);
  if (leg.stat === "rec" || leg.stat === "tackles") return poissonAtLeast(muRem, Math.ceil(need));
  const sd = 0.55 * mu0 * Math.sqrt(r);
  return normAtLeast(muRem, sd, need);
}

// games: {eventId: parsedSummary}
function evaluate(games) {
  let cashed = 0;
  const tickets = TICKETS.map(t => {
    const legs = t.legs.map(leg => {
      const G = games[leg.ev];
      const g = G ? G.game : { state: "pre", detail: "", away: {}, home: {} };
      const n = norm(leg.p);
      const ps = G && G.players[n];
      const cur = ps ? ps[leg.stat] : 0;
      const isOut = G ? G.out.has(n) : false;
      let status = "pending";
      if (cur >= leg.line) status = "hit";
      else if (isOut || g.state === "post") status = "dead";
      else if (g.state === "in") status = "live";
      const prob = status === "hit" ? 1 : status === "dead" ? 0 : legEstimate(leg, cur, g);
      return { ...leg, label: STAT_LABEL[leg.stat], cur, status, prob, isOut, game: g };
    });
    let status = "Pregame";
    if (legs.some(l => l.status === "dead")) status = "Lost";
    else if (legs.every(l => l.status === "hit")) status = "Cashed";
    else if (legs.some(l => l.game.state !== "pre")) status = "Live";
    const prob = status === "Lost" ? 0 : legs.reduce((a, l) => a * l.prob, 1);
    if (status === "Cashed") cashed += t.pays;
    return { ...t, legs, status, prob };
  });
  return { tickets, cashed };
}


// ---- Data fetch with cache fallback ----
const CACHE_NAME = "ticket-tracker-cache.json";
function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), CACHE_NAME) };
}
function readCache() {
  try { const { fm, path } = cachePath(); if (fm.fileExists(path)) return JSON.parse(fm.readString(path)); } catch (e) {}
  return null;
}
function writeCache(obj) {
  try { const { fm, path } = cachePath(); fm.writeString(path, JSON.stringify(obj)); } catch (e) {}
}

async function fetchRaw() {
  const ids = [...new Set(TICKETS.flatMap(t => t.legs.map(l => l.ev)))];
  const raw = {};
  let failures = 0;
  await Promise.all(ids.map(async id => {
    try {
      const r = new Request(ESPN + id);
      r.timeoutInterval = 15;
      const d = await r.loadJSON();
      if (!d || !d.header) throw new Error("bad response");
      // keep only what the parser needs so the cache stays small
      raw[id] = { header: d.header, boxscore: { players: (d.boxscore && d.boxscore.players) || [] }, injuries: d.injuries || [] };
    } catch (e) { failures++; }
  }));
  return { raw, failures, total: ids.length };
}

async function loadData() {
  const cache = readCache();
  let fresh = null;
  try { fresh = await fetchRaw(); } catch (e) { fresh = { raw: {}, failures: 1, total: 1 }; }
  const raw = Object.assign({}, cache ? cache.raw : {}, fresh.raw);
  const ok = fresh.failures === 0;
  const updated = ok ? Date.now() : (cache ? cache.updated : null);
  if (Object.keys(fresh.raw).length) writeCache({ raw, updated: ok ? Date.now() : (cache ? cache.updated : Date.now()) });
  const games = {};
  for (const id of Object.keys(raw)) { try { games[id] = parseSummary(raw[id]); } catch (e) {} }
  return { result: evaluate(games), updated, error: !ok };
}

// ---- Presentation helpers ----
const C = {
  bg: new Color("#0d1117"), card: new Color("#161b22"), text: new Color("#e6edf3"),
  dim: new Color("#8b949e"), green: new Color("#3fb950"), yellow: new Color("#d29922"),
  red: new Color("#f85149"), gray: new Color("#6e7681"), accent: new Color("#58a6ff"),
};
const STATUS_COLOR = { Cashed: C.green, Live: C.yellow, Lost: C.red, Pregame: C.gray };
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
  const dead = t.legs.find(l => l.status === "dead");
  if (dead) return lastName(dead.p) + " " + fmtNum(dead.cur) + "/" + dead.line + " " + dead.label + (dead.isOut ? " (OUT)" : " ✗");
  const open = t.legs.filter(l => l.status !== "hit").sort((a, b) => a.prob - b.prob)[0];
  if (!open) return "";
  return lastName(open.p) + " " + fmtNum(open.cur) + "/" + open.line + " " + open.label;
}
function hits(t) { return t.legs.filter(l => l.status === "hit").length; }
function addText(stack, s, size, color, bold) {
  const t = stack.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}
function footer(w, data, size) {
  const s = data.error ? "Updated " + timeStr(data.updated) + " · retrying" : "Updated " + timeStr(data.updated);
  addText(w, s, size, data.error ? C.yellow : C.dim, false);
}

// ---- Layouts ----
function buildSmall(w, data) {
  const { tickets, cashed } = data.result;
  const alive = tickets.filter(t => t.status === "Live" || t.status === "Pregame").length;
  const best = tickets.filter(t => t.status !== "Lost" && t.status !== "Cashed").sort((a, b) => b.prob - a.prob)[0];
  addText(w, "🎟️ TICKETS", 11, C.dim, true);
  w.addSpacer(4);
  addText(w, money(cashed), 26, cashed > 0 ? C.green : C.text, true);
  addText(w, "cashed", 10, C.dim, false);
  w.addSpacer(4);
  addText(w, alive + " of " + tickets.length + " alive", 13, alive ? C.yellow : C.red, true);
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
  addText(row, hits(t) + "/" + t.legs.length, large ? 13 : 12, C.dim, false);
  row.addSpacer(8);
  const pc = t.status === "Cashed" ? "WIN" : t.status === "Lost" ? "LOST" : pct(t.prob);
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
  addText(head, "🎟️ Sunday Tickets", large ? 15 : 13, C.text, true);
  head.addSpacer();
  addText(head, "Cashed " + money(cashed), large ? 13 : 11, cashed > 0 ? C.green : C.dim, true);
  w.addSpacer(large ? 8 : 4);
  tickets.forEach((t, i) => { ticketRow(w, t, large); if (i < tickets.length - 1) w.addSpacer(large ? 7 : 2); });
  w.addSpacer();
  footer(w, data, large ? 10 : 9);
}

async function main() {
  let data;
  try { data = await loadData(); }
  catch (e) { const c = readCache(); data = { result: evaluate({}), updated: c ? c.updated : null, error: true }; }
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = TRACKER_URL;
  w.setPadding(12, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const family = config.runsInWidget ? (config.widgetFamily || "medium") : "large";
  if (family === "small") buildSmall(w, data);
  else buildList(w, data, family === "large" || family === "extraLarge");
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentLarge();
  Script.complete();
  return { w, data };
}

main();
