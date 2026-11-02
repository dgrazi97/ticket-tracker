#!/usr/bin/env node
// Grade every ticket in tickets.json from ESPN box scores + the paper-bets ledger, and annotate it
// for the tracker and widget (backward compatible: only adds fields, and sets the existing `status`
// override once a ticket is final).
//   ticket.state     live | pending | won | lost | void
//   ticket.profit    net $ once settled (bonus bets: stake not at risk), else null
//   ticket.day       ET date (YYYY-MM-DD) of the ticket's first game
//   ticket.settledAt ISO time it was first seen settled
//   ticket.status    cashed | lost | void (unchanged meaning; set when final so old clients freeze it)
//   leg.result       hit | dead once final for that leg
//   doc.days         [{day, label, won, lost, live, pending, staked, net}] newest first
// Usage: node grade.js [--all] [--ledger PATH] [--sync-ledger] [--dry]
//   --all          re-fetch games for already-settled tickets too
//   --sync-ledger  write final won/lost back to open ledger entries with the same id
const fs = require("fs"), path = require("path");
const TT = require("./logic.js");
const ROOT = __dirname, FILE = path.join(ROOT, "tickets.json");
const argv = process.argv.slice(2), has = f => argv.includes(f);
const li = argv.indexOf("--ledger");
const LEDGER = li >= 0 ? argv[li + 1] : path.join(ROOT, "..", "paper_bets_ledger.json");
const SETTLED = { cashed: 1, won: 1, lost: 1, void: 1 };
const nowIso = () => { const d = new Date(), off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-", a = Math.abs(off);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(a / 60 | 0)}:${p(a % 60)}`; };

function ledgerIndex() {
  try {
    const d = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    const bets = Array.isArray(d) ? d : d.bets || [];
    const by = {};
    for (const b of bets) { const id = b.id || b.key; if (id) by[id] = b; }
    return { doc: d, bets, by };
  } catch (e) { return { doc: null, bets: [], by: {} }; }
}
function ledgerResult(b) {
  if (!b) return null;
  const s = String(b.status || b.result || "").toLowerCase();
  if (s === "won" || s === "cashed" || s === "win") return "cashed";
  if (s === "lost" || s === "loss") return "lost";
  if (s === "void" || s === "push") return "void";
  return null;
}

async function fetchJson(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(url, { signal: ctl.signal, headers: { "Cache-Control": "no-cache" } });
      clearTimeout(to);
      if (r.ok) return await r.json();
    } catch (e) {}
  }
  return null;
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const raw = doc.tickets || [];
  const L = ledgerIndex();
  // Ledger-settled tickets get the ledger's result as the override (manual status still wins).
  for (const t of raw) {
    const lr = ledgerResult(L.by[t.id]);
    if (lr && !t.status) t.status = lr;
    if (L.by[t.id] && (L.by[t.id].bonus_bet || L.by[t.id].bonus) && t.bonus == null) t.bonus = true;
  }
  // re-grade from scratch: manual/ledger `status` + ESPN decide; the previous `state` is only output
  const tickets = TT.normalizeTickets({ tickets: raw.map(t => Object.assign({}, t, { state: undefined })) });
  const needFetch = new Set();
  tickets.forEach((t, i) => {
    const settled = SETTLED[t.override];
    if (has("--all") || !settled || !raw[i].day) for (const l of t.legs) needFetch.add(l.key);
  });
  const events = TT.eventsOf(tickets).filter(e => needFetch.has(e.key));
  const games = {};
  let fails = 0, idx = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (idx < events.length) {
      const e = events[idx++];
      const d = await fetchJson(TT.summaryUrl(e.sport, e.ev));
      if (d && d.header) games[e.key] = TT.parseSummary(d, e.sport); else fails++;
    }
  }));
  const res = TT.evaluate(tickets, games);
  const STATE = { Live: "live", Pregame: "pending", Cashed: "won", Lost: "lost", Void: "void" };
  const now = Date.now();
  const synced = [];
  res.tickets.forEach((et, i) => {
    const t = raw[i];
    let state = STATE[et.status];
    // a "lost" that only comes from a pregame scratch (DK usually voids that leg) is not final
    const finalDead = et.legs.some(l => l.status === "dead" && (l.result === "dead" || l.result === "lost" || (l.game && l.game.state !== "pre")));
    if (state === "lost" && !SETTLED[et.override] && !finalDead) state = et.legs.some(l => l.game && l.game.state === "in") ? "live" : "pending";
    t.state = state;
    if (!t.status && state === "won") t.status = "cashed";
    if (!t.status && state === "lost") t.status = "lost";
    t.profit = TT.profitOf(et, { won: "Cashed", lost: "Lost", void: "Void" }[state] || "");
    // leg results once final for that leg (hits are permanent; dead only from live/final games)
    et.legs.forEach((l, j) => {
      const rl = t.legs[j]; if (!rl || rl.result) return;
      if (l.status === "hit") rl.result = "hit";
      else if (l.status === "dead" && l.game && l.game.state === "post") rl.result = "dead";
    });
    // day: first game's ET date; fall back to the placed date
    const day = TT.ticketDay(Object.assign({}, et, { day: null })) || (t.placedAt ? TT.etDayKey(Date.parse(t.placedAt)) : null);
    if (day) t.day = day;
    if (state === "won" || state === "lost" || state === "void") {
      if (!t.settledAt) { const last = TT.ticketTimes(et).last; t.settledAt = new Date(Math.min(now, last || now)).toISOString(); }
    } else delete t.settledAt;
    // optional: write final results back to open ledger entries
    const lb = L.by[t.id];
    if (has("--sync-ledger") && lb && !ledgerResult(lb) && (state === "won" || state === "lost")) {
      lb.status = state; lb.profit = t.profit;
      lb.graded = nowIso() + " graded from ESPN box scores (tracker grade.js)";
      synced.push(t.id + " " + state);
    }
  });
  // daily summary (newest first), from the same evaluation the widget does
  const graded = TT.evaluate(TT.normalizeTickets(doc), games);
  const g = TT.dayGroups(graded, now);
  doc.days = g.sections.slice().sort((a, b) => (a.key < b.key ? 1 : -1)).map(s => ({
    day: s.key, label: s.label, won: s.won, lost: s.lost, live: s.live, pending: s.pending, staked: s.staked, net: s.net,
  }));
  doc.schema = 2;
  const todaySec = g.sections.find(s => s.isToday);
  if (!has("--dry")) {
    doc.updated = nowIso();
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(FILE + ".tmp", FILE);
    if (synced.length && L.doc) {
      fs.writeFileSync(LEDGER + ".tmp", JSON.stringify(L.doc, null, 2) + "\n");
      fs.renameSync(LEDGER + ".tmp", LEDGER);
    }
  }
  // preview, in widget order
  const view = TT.currentView(graded, now);
  const mark = { Live: "LIVE", Pregame: "NEXT", Cashed: "WIN ", Lost: "LOSS", Void: "VOID" };
  const lines = [];
  for (const s of g.sections) {
    lines.push(`== ${s.label}  ${s.won}-${s.lost}  net ${TT.signedMoney(s.net)}` + (s.live ? `  · ${s.live} live` : "") + (s.pending ? `  · ${s.pending} upcoming` : ""));
    if (!s.isToday && !s.live && !has("--verbose")) continue;
    for (const t of s.tickets) {
      const p = t.profit != null ? TT.signedMoney(t.profit) : `$${t.stake} → $${t.pays}`;
      lines.push(`   ${mark[t.status]}  ${t.name}  ${p}`);
    }
  }
  console.log(lines.join("\n"));
  console.log(`graded ${raw.length} tickets; fetched ${events.length - fails}/${events.length} games` + (fails ? ` (${fails} failed)` : "")
    + (synced.length ? `; ledger synced: ${synced.join(", ")}` : "") + (todaySec ? `; today ${todaySec.won}-${todaySec.lost} ${TT.signedMoney(todaySec.net)}` : ""));
  if (fails) process.exitCode = 0;
})();
