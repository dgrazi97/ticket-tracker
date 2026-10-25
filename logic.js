// Ticket Tracker logic, shared by the web tracker (index.html) and the
// Scriptable widget (widget.js is built from this file by build_widget.py).
// Tickets live in tickets.json; nothing here is ticket-specific.
(function (root) {
  const DEFAULT_SPORT = "football/nfl";
  const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/";
  const summaryUrl = (sport, ev) => ESPN_BASE + (sport || DEFAULT_SPORT) + "/summary?event=" + encodeURIComponent(ev);
  const gameKey = (sport, ev) => (sport || DEFAULT_SPORT) + ":" + ev;
  const sportRoot = s => String(s || DEFAULT_SPORT).split("/")[0];

  // ---- Stat registry --------------------------------------------------------
  // parts: ESPN boxscore keys ("category.key" or bare "key"), summed.
  // count: small whole-number stat -> Poisson model. prior: expected value = line * prior.
  // anytime: rate model driven by the leg's pregame probability (tdProb).
  const STATS = {
    football: {
      rec:        { parts: ["receiving.receptions"], label: "rec", count: true, prior: 1.35 },
      recYds:     { parts: ["receiving.receivingYards"], label: "rec yds", prior: 1.15 },
      rushYds:    { parts: ["rushing.rushingYards"], label: "rush yds", prior: 1.15 },
      passYds:    { parts: ["passing.passingYards"], label: "pass yds", prior: 1.1 },
      tackles:    { parts: ["defensive.totalTackles"], label: "tackles", count: true, prior: 1.05 },
      anytimeTD:  { parts: ["receiving.receivingTouchdowns", "rushing.rushingTouchdowns"], label: "TD", anytime: true, defProb: 0.4, anyText: "Anytime TD" },
      passTD:     { parts: ["passing.passingTouchdowns"], label: "pass TD", count: true, prior: 1.15 },
      completions:{ parts: ["passing.completions"], label: "completions", prior: 1.1 },
      passAtt:    { parts: ["passing.passingAttempts"], label: "pass att", prior: 1.1 },
      ints:       { parts: ["passing.interceptions"], label: "INT thrown", count: true, prior: 1.15 },
      rushAtt:    { parts: ["rushing.rushingAttempts"], label: "rush att", prior: 1.15 },
      longRush:   { parts: ["rushing.longRushing"], label: "long rush", prior: 1.15 },
      longRec:    { parts: ["receiving.longReception"], label: "long rec", prior: 1.15 },
      rushRecYds: { parts: ["rushing.rushingYards", "receiving.receivingYards"], label: "rush+rec yds", prior: 1.15 },
      passRushYds:{ parts: ["passing.passingYards", "rushing.rushingYards"], label: "pass+rush yds", prior: 1.1 },
      soloTackles:{ parts: ["defensive.soloTackles"], label: "solo tackles", count: true, prior: 1.05 },
      sacks:      { parts: ["defensive.sacks"], label: "sacks", count: true, prior: 1.1 },
      defInts:    { parts: ["interceptions.interceptions"], label: "INT", count: true, prior: 1.1 },
      fgMade:     { parts: ["kicking.fieldGoalsMade"], label: "FG made", count: true, prior: 1.1 },
      kickPts:    { parts: ["kicking.totalKickingPoints"], label: "kick pts", count: true, prior: 1.1 },
    },
    basketball: {
      pts:    { parts: ["points"], label: "pts", prior: 1.1 },
      reb:    { parts: ["rebounds"], label: "reb", count: true, prior: 1.1 },
      ast:    { parts: ["assists"], label: "ast", count: true, prior: 1.1 },
      threes: { parts: ["threePointFieldGoalsMade"], label: "3PM", count: true, prior: 1.15 },
      stl:    { parts: ["steals"], label: "stl", count: true, prior: 1.1 },
      blk:    { parts: ["blocks"], label: "blk", count: true, prior: 1.1 },
      tov:    { parts: ["turnovers"], label: "TO", count: true, prior: 1.1 },
      stocks: { parts: ["steals", "blocks"], label: "stl+blk", count: true, prior: 1.1 },
      pra:    { parts: ["points", "rebounds", "assists"], label: "pts+reb+ast", prior: 1.1 },
      pr:     { parts: ["points", "rebounds"], label: "pts+reb", prior: 1.1 },
      pa:     { parts: ["points", "assists"], label: "pts+ast", prior: 1.1 },
      ra:     { parts: ["rebounds", "assists"], label: "reb+ast", count: true, prior: 1.1 },
      fgm:    { parts: ["fieldGoalsMade"], label: "FGM", count: true, prior: 1.1 },
      ftm:    { parts: ["freeThrowsMade"], label: "FTM", count: true, prior: 1.1 },
      oreb:   { parts: ["offensiveRebounds"], label: "OREB", count: true, prior: 1.1 },
      dreb:   { parts: ["defensiveRebounds"], label: "DREB", count: true, prior: 1.1 },
    },
    hockey: {
      goals:  { parts: ["goals"], label: "goal", anytime: true, defProb: 0.3, anyText: "Anytime goal" },
      ast:    { parts: ["assists"], label: "ast", count: true, prior: 1.1 },
      pts:    { parts: ["goals", "assists"], label: "pts", count: true, prior: 1.1 },
      shots:  { parts: ["shotsTotal"], label: "SOG", count: true, prior: 1.15 },
      saves:  { parts: ["saves"], label: "saves", prior: 1.05 },
      blocks: { parts: ["blockedShots"], label: "blocks", count: true, prior: 1.1 },
      hits:   { parts: ["hits"], label: "hits", count: true, prior: 1.1 },
    },
    baseball: {
      hits:   { parts: ["batting.hits"], label: "hits", count: true, prior: 1.1 },
      hr:     { parts: ["batting.homeRuns"], label: "HR", anytime: true, defProb: 0.12, anyText: "To hit a HR" },
      rbi:    { parts: ["batting.RBIs"], label: "RBI", count: true, prior: 1.1 },
      runs:   { parts: ["batting.runs"], label: "runs", count: true, prior: 1.1 },
      hrr:    { parts: ["batting.hits", "batting.runs", "batting.RBIs"], label: "H+R+RBI", count: true, prior: 1.1 },
      walks:  { parts: ["batting.walks"], label: "BB", count: true, prior: 1.1 },
      ks:     { parts: ["pitching.strikeouts"], label: "K", count: true, prior: 1.1 },
      hitsAllowed: { parts: ["pitching.hits"], label: "hits allowed", count: true, prior: 1.0 },
      er:     { parts: ["pitching.earnedRuns"], label: "ER", count: true, prior: 1.0 },
    },
  };
  // Free-form names people type -> canonical stat names
  const ALIASES = {
    rec: "rec", recs: "rec", receptions: "rec", catches: "rec",
    recyds: "recYds", recyards: "recYds", receivingyards: "recYds", receivingyds: "recYds",
    rushyds: "rushYds", rushyards: "rushYds", rushingyards: "rushYds", rushingyds: "rushYds",
    passyds: "passYds", passyards: "passYds", passingyards: "passYds", passingyds: "passYds",
    tackles: "tackles", tacklesast: "tackles", tacklesassists: "tackles", totaltackles: "tackles",
    td: "anytimeTD", tds: "anytimeTD", anytimetd: "anytimeTD", atd: "anytimeTD", touchdown: "anytimeTD",
    passtd: "passTD", passtds: "passTD", passingtd: "passTD", passingtds: "passTD",
    completions: "completions", comp: "completions", cmp: "completions", passatt: "passAtt", attempts: "passAtt",
    ints: "ints", int: "ints", interceptions: "ints", rushatt: "rushAtt", carries: "rushAtt",
    longrush: "longRush", longestrush: "longRush", longrec: "longRec", longestreception: "longRec",
    rushrecyds: "rushRecYds", scrimmageyds: "rushRecYds", passrushyds: "passRushYds",
    solotackles: "soloTackles", sacks: "sacks", defints: "defInts", fgmade: "fgMade", kickpts: "kickPts", kickingpoints: "kickPts",
    pts: "pts", points: "pts", reb: "reb", rebs: "reb", rebounds: "reb", ast: "ast", asts: "ast", assists: "ast",
    threes: "threes", "3pm": "threes", "3s": "threes", "3ptm": "threes", threepointersmade: "threes", threesmade: "threes",
    stl: "stl", steals: "stl", blk: "blk", blocks: "blk", tov: "tov", turnovers: "tov", to: "tov",
    stocks: "stocks", stlblk: "stocks", pra: "pra", ptsrebast: "pra", pr: "pr", ptsreb: "pr", pa: "pa", ptsast: "pa", ra: "ra", rebast: "ra",
    fgm: "fgm", ftm: "ftm", oreb: "oreb", dreb: "dreb",
    goals: "goals", goal: "goals", anytimegoal: "goals", shots: "shots", sog: "shots", shotsongoal: "shots", saves: "saves", hits: "hits",
    hr: "hr", homeruns: "hr", homerun: "hr", rbi: "rbi", rbis: "rbi", runs: "runs", hrr: "hrr", hitsrunsrbis: "hrr",
    walks: "walks", bb: "walks", ks: "ks", k: "ks", strikeouts: "ks", hitsallowed: "hitsAllowed", er: "er", earnedruns: "er",
  };
  // Sport-specific overrides for shared words (e.g. hockey "blocks" = blocked shots)
  const SPORT_ALIASES = { hockey: { blocks: "blocks", blk: "blocks", blockedshots: "blocks" } };

  function statDef(stat, sport) {
    const sr = sportRoot(sport);
    const table = STATS[sr] || {};
    const raw = String(stat || "");
    if (table[raw]) return Object.assign({ name: raw }, table[raw]);
    const k = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    const canon = (SPORT_ALIASES[sr] && SPORT_ALIASES[sr][k]) || ALIASES[k];
    if (canon && table[canon]) return Object.assign({ name: canon }, table[canon]);
    // Generic fallback: raw ESPN boxscore key(s), "+"-joined, optionally "category.key"
    const parts = raw.split("+").map(s => s.trim()).filter(Boolean);
    return { name: raw, parts, label: raw, generic: true, prior: 1.15 };
  }

  const norm = s => (s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();

  // ---- tickets.json -> internal tickets ------------------------------------
  function normalizeTickets(doc) {
    const list = Array.isArray(doc) ? doc : ((doc && doc.tickets) || []);
    return list.map((t, i) => {
      const tSport = t.sport || DEFAULT_SPORT;
      const legs = (t.legs || []).map(l => {
        const sport = l.sport || tSport;
        const ev = String(l.event != null ? l.event : l.ev);
        const def = statDef(l.stat, sport);
        const tdp = l.tdProb != null ? l.tdProb : (l.pregameProb != null ? l.pregameProb : l.tdp);
        return {
          p: l.player || l.p, team: l.team || "", sport, ev, key: gameKey(sport, ev),
          stat: def.name, def, line: Number(l.line), tdp: tdp != null ? Number(tdp) : undefined,
          result: l.result ? String(l.result).toLowerCase() : undefined,
        };
      });
      return {
        id: t.id || ("ticket" + i), name: t.name || ("Ticket " + (i + 1)), time: t.time || "",
        stake: Number(t.stake) || 0, pays: Number(t.payout != null ? t.payout : t.pays) || 0,
        override: t.status ? String(t.status).toLowerCase() : undefined,
        placedAt: t.placedAt || null, legs,
      };
    });
  }
  function eventsOf(tickets) {
    const seen = {}, out = [];
    for (const t of tickets) for (const l of t.legs) if (!seen[l.key]) { seen[l.key] = 1; out.push({ key: l.key, sport: l.sport, ev: l.ev }); }
    return out;
  }

  // ---- ESPN summary parsing --------------------------------------------------
  // Returns { game, players: {normName: {team, raw: {"cat.key": n, "key": n}}}, out: Set, sport }
  function parseNum(x) { return parseFloat(String(x).split("/")[0]) || 0; }
  function parseSummary(d, sport) {
    const comp = (d.header && d.header.competitions && d.header.competitions[0]) || {};
    const st = comp.status || {};
    const type = st.type || {};
    const teams = (comp.competitors || []).map(c => ({ abbr: c.team && c.team.abbreviation, score: c.score, homeAway: c.homeAway }));
    const away = teams.find(t => t.homeAway === "away") || teams[1] || {};
    const home = teams.find(t => t.homeAway === "home") || teams[0] || {};
    const game = {
      state: type.state || "pre", completed: !!type.completed,
      detail: type.shortDetail || type.detail || "", period: st.period || 0,
      clock: st.displayClock || "", away, home, sport: sport || DEFAULT_SPORT,
    };
    const players = {};
    const bp = (d.boxscore && d.boxscore.players) || [];
    for (const team of bp) {
      const abbr = team.team && team.team.abbreviation;
      for (const cat of team.statistics || []) {
        const keys = cat.keys || [];
        const cname = cat.name || cat.type || "";
        for (const a of cat.athletes || []) {
          const n = norm(a.athlete && a.athlete.displayName);
          if (!n) continue;
          const p = players[n] = players[n] || { team: abbr, raw: {} };
          p.team = abbr;
          const stats = a.stats || [];
          keys.forEach((key, i) => {
            const val = stats[i];
            if (val == null) return;
            const put = (k, v) => { if (cname) p.raw[cname + "." + k] = v; if (!(k in p.raw)) p.raw[k] = v; };
            const sep = key.indexOf("/") >= 0 ? "/" : (key.indexOf("-") > 0 ? "-" : null);
            const m = sep && String(val).match(/^\s*(-?\d+(?:\.\d+)?)\s*[\/-]\s*(\d+(?:\.\d+)?)\s*$/);
            if (sep && m) { const [k1, k2] = key.split(sep); put(k1, parseFloat(m[1])); put(k2, parseFloat(m[2])); put(key, parseFloat(m[1])); }
            else put(key, parseNum(val));
          });
        }
      }
    }
    const out = new Set();
    for (const t of d.injuries || []) for (const i of t.injuries || []) {
      if (String(i.status).toLowerCase() === "out" && i.athlete) out.add(norm(i.athlete.displayName));
    }
    return { game, players, out, sport: game.sport };
  }

  function statValue(ps, def) {
    if (!ps) return 0;
    let s = 0;
    for (const part of def.parts) { const v = ps.raw[part]; if (typeof v === "number" && !isNaN(v)) s += v; }
    return s;
  }
  function findPlayer(G, leg) {
    if (!G) return null;
    const n = norm(leg.p);
    if (G.players[n]) return G.players[n];
    // fallback for name variants: same team, same last name, same first initial, unique
    const parts = n.split(" "); if (parts.length < 2) return null;
    const last = parts[parts.length - 1], fi = parts[0][0];
    const team = String(leg.team || "").toUpperCase();
    const hits = Object.keys(G.players).filter(k => {
      const q = k.split(" ");
      return q[q.length - 1] === last && q[0][0] === fi && (!team || String(G.players[k].team || "").toUpperCase() === team);
    });
    return hits.length === 1 ? G.players[hits[0]] : null;
  }

  // ---- Time left -------------------------------------------------------------
  const CLOCKS = {
    "football": { per: 4, len: 900, half: /half/i },
    "basketball/nba": { per: 4, len: 720 }, "basketball/wnba": { per: 4, len: 600 },
    "basketball/womens-college-basketball": { per: 4, len: 600 },
    "basketball/mens-college-basketball": { per: 2, len: 1200 },
    "basketball": { per: 4, len: 720 }, "hockey": { per: 3, len: 1200 },
  };
  function clockFor(sport) { const s = sport || DEFAULT_SPORT; return CLOCKS[s] || CLOCKS[sportRoot(s)] || null; }
  function fracLeft(g) {
    if (g.state === "pre") return 1;
    if (g.state === "post") return 0;
    const sport = g.sport || DEFAULT_SPORT, root = sportRoot(sport);
    if (root === "baseball") {
      const inn = g.period || 1, det = String(g.detail || "");
      let done = (inn - 1) * 2;
      if (/^(bot|mid)/i.test(det)) done += 1; else if (/^end/i.test(det)) done += 2;
      return Math.max(0.02, 1 - done / 18);
    }
    if (root === "soccer") {
      if (/half/i.test(g.detail)) return 0.5;
      const min = parseInt(String(g.clock || "0"), 10) || 0;
      return Math.max(0.02, 1 - min / 90);
    }
    const c = clockFor(sport) || { per: 4, len: 900 };
    const total = c.per * c.len;
    const per = g.period || 1;
    const [m, s] = String(g.clock || (c.len / 60) + ":00").split(":").map(Number);
    const secLeftQ = (m || 0) * 60 + (s || 0);
    if (per > c.per) return Math.max(0.02, secLeftQ / total);
    if ((c.half || /halftime/i).test(g.detail)) return 0.5;
    return Math.max(0, ((c.per - per) * c.len + secLeftQ) / total);
  }

  // ---- Probability model -------------------------------------------------------
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
    const def = leg.def || statDef(leg.stat, leg.sport);
    const need = leg.line - cur;
    if (need <= 0) return 1;
    const r = fracLeft(g);
    if (r <= 0) return 0;
    const elapsed = 1 - r;
    if (def.anytime || leg.tdp != null && !def.count && def.generic) {
      // rate model: pregame P(at least 1) = tdp; remaining time scales the rate
      const lam = -Math.log(1 - (leg.tdp || def.defProb || 0.4));
      return poissonAtLeast(lam * r, Math.ceil(need));
    }
    const mu0 = leg.line * (def.prior || 1.15);
    const pace = elapsed > 0.05 ? cur / elapsed : mu0;
    const w = Math.min(0.6, elapsed);
    const muRem = r * (w * pace + (1 - w) * mu0);
    const isCount = def.count || (def.generic && mu0 < 12);
    if (isCount) return poissonAtLeast(muRem, Math.ceil(need));
    const sd = 0.55 * mu0 * Math.sqrt(r);
    return normAtLeast(muRem, sd, need);
  }

  // ---- Evaluate tickets against parsed games ({gameKey: parsedSummary}) -------
  const OPEN = { Pregame: 1, Live: 1 };
  function evaluate(tickets, games) {
    games = games || {};
    let cashed = 0, inPlay = 0, potential = 0;
    const out = tickets.map(t => {
      const legs = t.legs.map(leg => {
        const G = games[leg.key];
        const g = G ? G.game : { state: "pre", detail: "", away: {}, home: {}, sport: leg.sport };
        const ps = findPlayer(G, leg);
        const cur = statValue(ps, leg.def);
        const isOut = G ? G.out.has(norm(leg.p)) : false;
        let status = "pending";
        if (leg.result === "void") status = "void";
        else if (leg.result === "hit" || leg.result === "won") status = "hit";
        else if (leg.result === "dead" || leg.result === "lost") status = "dead";
        else if (cur >= leg.line) status = "hit";
        else if (isOut || g.state === "post") status = "dead";
        else if (g.state === "in") status = "live";
        const prob = status === "hit" || status === "void" ? 1 : status === "dead" ? 0 : legEstimate(leg, cur, g);
        const def = leg.def;
        return Object.assign({}, leg, {
          label: def.label, anytime: !!def.anytime, anyText: def.anyText || ("Anytime " + def.label),
          cur, status, prob, isOut, game: g,
        });
      });
      const live = legs.filter(l => l.status !== "void");
      let status = "Pregame";
      if (t.override === "void" || !live.length) status = "Void";
      else if (t.override === "cashed" || t.override === "won") status = "Cashed";
      else if (t.override === "lost") status = "Lost";
      else if (live.some(l => l.status === "dead")) status = "Lost";
      else if (live.every(l => l.status === "hit")) status = "Cashed";
      else if (live.some(l => l.game.state !== "pre")) status = "Live";
      const prob = status === "Cashed" ? 1 : (status === "Lost" || status === "Void") ? 0 : live.reduce((a, l) => a * l.prob, 1);
      if (status === "Cashed") cashed += t.pays;
      if (OPEN[status]) { inPlay += t.stake; potential += t.pays; }
      return Object.assign({}, t, { legs, status, prob });
    });
    return { tickets: out, cashed, inPlay, potential };
  }

  const api = {
    DEFAULT_SPORT, STATS, ALIASES, summaryUrl, gameKey, statDef, normalizeTickets, eventsOf,
    parseSummary, statValue, evaluate, fracLeft, legEstimate, norm,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TT = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
