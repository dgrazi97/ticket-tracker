// Ticket Tracker logic (works in browser and node)
(function (root) {
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

  const api = { TICKETS, parseSummary, evaluate, fracLeft, legEstimate, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TT = api;
})(typeof window !== "undefined" ? window : globalThis);
