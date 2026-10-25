#!/usr/bin/env python3
"""Manage tickets.json for the Ticket Tracker (web + Scriptable widget), then git commit + push.

Usage:
  add_ticket.py add '<ticket JSON>'      add a ticket (JSON string)
  add_ticket.py add path/to/ticket.json  add a ticket from a file ('-' = stdin)
  add_ticket.py add ... --replace        overwrite a ticket with the same id
  add_ticket.py status <id> cashed|lost|void|clear   manual settle (clear = back to live grading)
  add_ticket.py remove <id>              delete a ticket
  add_ticket.py list                     show tickets
  add_ticket.py validate                 check tickets.json
Options: --no-push (commit only), --no-git (just write the file), --wait (poll Pages until live),
         --message "..." (commit message)

Ticket JSON (sport defaults to football/nfl; can be set per ticket or per leg):
  {"id": "optional", "name": "SNF SGP", "stake": 5, "payout": 31.5, "time": "8:20 PM",
   "placedAt": "optional ISO time (default now)", "sport": "football/nfl",
   "legs": [{"player": "Travis Kelce", "team": "KC", "event": "401873020", "stat": "rec", "line": 5},
            {"player": "Kenneth Walker III", "team": "SEA", "event": "401873020", "stat": "anytimeTD", "line": 1, "tdProb": 0.45}]}
"""
import argparse, datetime, json, os, re, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(ROOT, "tickets.json")
PAGES = "https://dgrazi97.github.io/ticket-tracker/tickets.json"
SETTLE = {"cashed", "lost", "void"}
KNOWN_STATS = {
    "football": "rec recYds rushYds passYds tackles anytimeTD passTD completions passAtt ints rushAtt longRush longRec rushRecYds passRushYds soloTackles sacks defInts fgMade kickPts".split(),
    "basketball": "pts reb ast threes stl blk tov stocks pra pr pa ra fgm ftm oreb dreb".split(),
    "hockey": "goals ast pts shots saves blocks hits".split(),
    "baseball": "hits hr rbi runs hrr walks ks hitsAllowed er".split(),
}
ALIAS_HINT = {"td": "anytimeTD", "rushyds": "rushYds", "recyds": "recYds", "passyds": "passYds", "3pm": "threes", "points": "pts",
              "rebounds": "reb", "assists": "ast", "receptions": "rec", "sog": "shots", "strikeouts": "ks"}


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def load():
    with open(PATH) as f:
        return json.load(f)


def save(doc):
    doc["updated"] = now_iso()
    tmp = PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, PATH)


def slug(s):
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")[:40] or "ticket"


def validate_ticket(t, warn=print):
    errs = []
    if not isinstance(t, dict):
        return ["ticket must be an object"]
    for k in ("name", "stake", "payout", "legs"):
        if k not in t:
            errs.append(f"missing '{k}'")
    for k in ("stake", "payout"):
        if k in t and not isinstance(t[k], (int, float)):
            errs.append(f"'{k}' must be a number")
    if "status" in t and t["status"] not in SETTLE:
        errs.append("status must be cashed/lost/void (or omitted)")
    legs = t.get("legs") or []
    if not isinstance(legs, list) or not legs:
        errs.append("legs must be a non-empty list")
        legs = []
    for i, l in enumerate(legs):
        tag = f"leg {i + 1}"
        for k in ("player", "event", "stat", "line"):
            if k not in l:
                errs.append(f"{tag}: missing '{k}'")
        if "line" in l and not isinstance(l["line"], (int, float)):
            errs.append(f"{tag}: line must be a number (the N in 'N+')")
        if "event" in l and not re.fullmatch(r"\d+", str(l["event"])):
            errs.append(f"{tag}: event must be an ESPN event id (digits)")
        if "tdProb" in l and not (isinstance(l["tdProb"], (int, float)) and 0 < l["tdProb"] < 1):
            errs.append(f"{tag}: tdProb must be between 0 and 1")
        sport = l.get("sport") or t.get("sport") or "football/nfl"
        if not re.fullmatch(r"[a-z0-9.\-]+/[a-z0-9.\-]+", sport):
            errs.append(f"{tag}: sport must look like 'football/nfl'")
        stat = str(l.get("stat", ""))
        known = KNOWN_STATS.get(sport.split("/")[0], [])
        if stat and stat not in known:
            hint = ALIAS_HINT.get(re.sub(r"[^a-z0-9]", "", stat.lower()))
            warn(f"  note: {tag} stat '{stat}' is not a canonical {sport.split('/')[0]} stat"
                 + (f" (it will be read as '{hint}')" if hint else " (falls back to the raw ESPN boxscore key)"))
        if not l.get("team"):
            warn(f"  note: {tag} has no team abbr")
    return errs


def normalize_ticket(t, doc):
    t = dict(t)
    if "pays" in t and "payout" not in t:
        t["payout"] = t.pop("pays")
    t.setdefault("placedAt", now_iso())
    if not t.get("id"):
        base = slug(t.get("name", "ticket")) + "_" + datetime.date.today().strftime("%m%d")
        ids, n, cand = {x["id"] for x in doc["tickets"]}, 2, base
        while cand in ids:
            cand, n = f"{base}_{n}", n + 1
        t["id"] = cand
    legs = []
    for l in t.get("legs", []):
        l = dict(l)
        if "event" in l:
            l["event"] = str(l["event"])
        if "sport" not in l:
            l["sport"] = t.get("sport", "football/nfl")
        legs.append(l)
    t["legs"] = legs
    order = ["id", "name", "time", "stake", "payout", "status", "placedAt", "dkTicket", "odds", "sport", "legs"]
    return {**{k: t[k] for k in order if k in t}, **{k: v for k, v in t.items() if k not in order}}


def git(*args, check=True):
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f"git {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r


def commit_push(msg, push=True):
    git("add", "tickets.json")
    if not git("diff", "--cached", "--quiet", check=False).returncode:
        print("no changes to commit")
        return
    git("commit", "-q", "-m", msg)
    if push:
        git("pull", "-q", "--rebase", "origin", "HEAD", check=False)
        git("push", "-q", "origin", "HEAD")
        print("pushed:", msg)
    else:
        print("committed (not pushed):", msg)


def wait_live(stamp, timeout=240):
    print("waiting for GitHub Pages to serve the update...", flush=True)
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            req = urllib.request.Request(f"{PAGES}?t={int(time.time() * 1000)}", headers={"Cache-Control": "no-cache"})
            live = json.load(urllib.request.urlopen(req, timeout=15))
            if live.get("updated") == stamp:
                print(f"live after {int(time.time() - t0)}s")
                return True
        except Exception:
            pass
        time.sleep(10)
    print("not live yet (Pages can take a few minutes); it will appear on its own")
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["add", "status", "remove", "list", "validate"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--replace", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--no-git", action="store_true")
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--message", "-m")
    a = ap.parse_args()
    doc = load()
    tickets = doc.setdefault("tickets", [])
    by_id = {t["id"]: i for i, t in enumerate(tickets)}

    if a.cmd == "list":
        for t in tickets:
            legs = "; ".join(f"{l['player']} {l['line']}+ {l['stat']}" for l in t["legs"])
            print(f"{t['id']}  [{t.get('status', 'live')}]  {t['name']}  ${t['stake']} -> ${t['payout']}  ({legs})")
        print(f"{len(tickets)} ticket(s)")
        return
    if a.cmd == "validate":
        bad = 0
        if len(by_id) != len(tickets):
            print("duplicate ids!"); bad += 1
        for t in tickets:
            e = validate_ticket(t, warn=lambda *_: None)
            if e:
                bad += 1; print(t.get("id"), e)
        print("ok" if not bad else f"{bad} problem(s)")
        sys.exit(1 if bad else 0)

    if a.cmd == "add":
        if len(a.args) != 1:
            sys.exit("add needs one argument: a JSON string, a file path, or '-'")
        src = a.args[0]
        if src == "-":
            raw = sys.stdin.read()
        elif src.lstrip().startswith("{"):
            raw = src
        else:
            raw = open(src.lstrip("@")).read()
        try:
            t = json.loads(raw)
        except json.JSONDecodeError as e:
            sys.exit(f"bad JSON: {e}")
        t = normalize_ticket(t, doc)
        errs = validate_ticket(t)
        if errs:
            sys.exit("ticket rejected:\n  " + "\n  ".join(errs))
        if t["id"] in by_id:
            if not a.replace:
                sys.exit(f"id '{t['id']}' already exists (use --replace)")
            tickets[by_id[t["id"]]] = t
            msg = f"Update ticket {t['id']}"
        else:
            tickets.append(t)
            msg = f"Add ticket {t['id']}: {t['name']} (${t['stake']} -> ${t['payout']})"
    elif a.cmd == "status":
        if len(a.args) != 2:
            sys.exit("status needs: <id> cashed|lost|void|clear")
        tid, st = a.args[0], a.args[1].lower()
        if tid not in by_id:
            sys.exit(f"no ticket '{tid}'")
        t = tickets[by_id[tid]]
        if st == "clear":
            t.pop("status", None)
        elif st in SETTLE:
            t["status"] = st
        else:
            sys.exit("status must be cashed, lost, void or clear")
        tickets[by_id[tid]] = normalize_ticket(t, doc)
        msg = f"Ticket {tid}: {st}"
    elif a.cmd == "remove":
        if len(a.args) != 1:
            sys.exit("remove needs: <id>")
        tid = a.args[0]
        if tid not in by_id:
            sys.exit(f"no ticket '{tid}'")
        tickets.pop(by_id[tid])
        msg = f"Remove ticket {tid}"

    save(doc)
    print(f"tickets.json: {len(tickets)} ticket(s)")
    if not a.no_git:
        commit_push(a.message or msg, push=not a.no_push)
        if a.wait and not a.no_push:
            wait_live(doc["updated"])


if __name__ == "__main__":
    main()
