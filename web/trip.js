// 片道の経路の候補を作る（行き: 乗り場 → 病院、帰り: 病院 → 乗り場）。
//   同じ地区なら デマンドバス（＋歩く）。地区がちがえば デマンドバス → 電車 → 歩く／デマンドバス。
//   ちょうどの便が取れず待ち時間が長いときは、近くの寄り道の場所で過ごす経路も出す。
//   どれでも行けなければ、歩き（近いとき）かタクシーをすすめる。
(function (root) {
  const isNode = typeof module !== "undefined";
  const E = isNode ? require("./engine.js") : root.Engine;
  const Pl = isNode ? require("./planner.js") : root.Plan;

  const WALK_M_PER_MIN = 50;     // ゆっくり歩く
  const DETOUR = 1.3;            // 道のりが取れていないところは直線の 1.3 倍
  const MAX_ACC_M = 800;         // 病院と乗り場のあいだを歩くのはここまで
  const MAX_STA_M = 800;         // 駅と病院のあいだを歩くのはここまで
  const WALK_ONLY_M = 800;       // これより近ければ「歩いて行ける」を出す
  const WALK_FALLBACK_M = 2000;  // 乗り物で行けないとき、ここまでなら歩き、その先はタクシー
  const PLAT = 5 * 60;           // デマンドバスの乗り場と駅のホームのあいだ（改札を通る時間を含む）
  const W = 3600;                // 行きは 1 時間まで早く着いてよい／帰りは 1 時間まで待ってよい
  const ON_TIME = 10 * 60;       // 待ちがこれより短ければ寄り道は出さない
  const MIN_STAY = 10 * 60;      // 寄り道で過ごす時間がこれより短ければ出さない
  const GROUPS = Pl.GROUPS;
  const HOLIDAYS = new Set(["20260720"]);   // 2026 年 7 月の祝日（海の日）

  const hav = Pl.hav;

  class Trip {
    constructor({ data, med, rail, walk }) {
      this.data = data;
      this.med = new Map(med.list.map((x) => [x.id, x]));
      this.rail = rail;
      this.walk = walk || { p: {}, c: {} };
      this.st = rail.stations;
      this.conns = {};
      this.eng = {};
      this.plans = {};
      this.P = {};
      this.door = {};   // 地区ごとの バス停 ⇔ 病院 の車と歩きの道（door_<g>.json）
    }
    setDoor(g, d) { this.door[g] = d; }
    // バス停 ⇔ 病院 の道（向きはバス停が先）。kind: "c"（車）／"w"（歩き）
    doorOf(a, b, kind) {
      const [s, h] = a[0] === "h" ? [b, a] : [a, b];
      if (h[0] !== "h" || s[0] === "h" || s[0] === "s") return null;
      const g = this.stopG(s), d = g && this.door[g];
      return d && d[kind][`${s}|${h}`] || null;
    }
    // 運行日ごとに、各地区の車の予定（実績を受け付け直したもの）を渡す
    setDay(day, eng, plans) {
      this.day = day;
      this.eng = eng; this.plans = plans;
      this.P = {};
      for (const g of Object.keys(eng)) this.P[g] = new Pl.Planner(this.data, eng[g]);
      this.cal = (day.wd === "土" || day.wd === "日" || HOLIDAYS.has(day.date)) ? "H" : "W";
    }

    // ---------------------------------------------------------------- 場所と歩き
    // 場所のキー: 乗り場の id ／ "h<ID>"（病院・診療所）／ "s<番号>"（寄り道の場所）
    pos(k) {
      if (k[0] === "h") return this.med.get(k.slice(1));
      if (k[0] === "s") return this.data.spots[+k.slice(1)];
      return this.data.stops[k];
    }
    walkM(a, b) {
      if (a === b) return 0;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const w = this.walk.p[key];
      if (w && w[1]) return w[1];
      const dw = this.doorOf(a, b, "w");
      if (dw) return dw[1];
      return hav(this.pos(a), this.pos(b)) * DETOUR;
    }
    walkS(a, b) {
      const m = this.walkM(a, b);
      return m < 30 ? 0 : Math.ceil(m / WALK_M_PER_MIN) * 60;
    }
    stopG(s) {
      for (const [g, d] of Object.entries(this.data.districts)) if (d.stops.includes(s)) return g;
      return null;
    }
    // 寄り道の候補（build_walk.py が起点ごとに選んだもの）
    spotsAt(k) { return (this.walk.c[k] || []).map((i) => ({ i, s: this.data.spots[i], key: "s" + i })); }

    // ---------------------------------------------------------------- 電車（接続を順に見る方法）
    connections() {
      if (this.conns[this.cal]) return this.conns[this.cal];
      const cs = [];
      this.rail.trains[this.cal].forEach((tr, k) => {
        for (let i = 1; i < tr.s.length; i++) cs.push({ k, u: tr.s[i - 1][0], v: tr.s[i][0], td: tr.s[i - 1][2], ta: tr.s[i][1] });
      });
      cs.sort((a, b) => a.td - b.td);
      return this.conns[this.cal] = cs;
    }
    footpaths() { return this.rail.transfer.walk; }
    // 乗り換えは川越駅（かわまるの乗り場の無い駅）でだけ。逆向きに乗って急行に乗り換えるような遠回りはさせない
    hub(i) { return !this.st[i].stop; }

    // 着く駅ごとの締め切り（targets: Map 駅 → その駅に着いていたい時刻）から、乗る駅ごとのいちばん遅い出発を求める
    latestRail(targets) {
      const n = this.st.length, SAME = this.rail.transfer.same;
      const R = Array(n).fill(-Infinity), J = Array(n).fill(null);
      const exit = new Map();
      const cs = this.connections();
      const fp = this.footpaths();
      for (let i = cs.length - 1; i >= 0; i--) {
        const c = cs[i];
        if (!exit.has(c.k)) {
          const tgt = targets.has(c.v) ? targets.get(c.v) : -Infinity;
          if (c.ta <= tgt) exit.set(c.k, { c, final: true });
          else if (this.hub(c.v) && c.ta <= R[c.v] - SAME) exit.set(c.k, { c, final: false });
        }
        if (exit.has(c.k) && c.td > R[c.u]) {
          R[c.u] = c.td; J[c.u] = { c, e: exit.get(c.k) };
          for (const [a, b, sec] of fp) {
            for (const [x, y] of [[a, b], [b, a]]) if (x === c.u && R[x] - sec > R[y]) { R[y] = R[x] - sec; J[y] = { walk: x, sec }; }
          }
        }
      }
      const path = (x) => {
        const legs = [];
        let u = x, guard = 0;
        while (J[u] && guard++ < 6) {
          const j = J[u];
          if (j.walk !== undefined) { legs.push({ walk: true, from: u, to: j.walk, sec: j.sec }); u = j.walk; continue; }
          legs.push({ k: j.c.k, from: u, to: j.e.c.v, td: j.c.td, ta: j.e.c.ta });
          u = j.e.c.v;
          if (j.e.final) break;
        }
        return { legs, end: u };
      };
      return { R, path };
    }
    // 乗る駅ごとの用意ができる時刻（sources）から、各駅にいちばん早く着く時刻
    earliestRail(sources) {
      const n = this.st.length, SAME = this.rail.transfer.same;
      const A = Array(n).fill(Infinity), ready = Array(n).fill(Infinity), J = Array(n).fill(null);
      const from = Array(n).fill(null);   // その駅で乗れるようになったわけ（"src" か、着いた電車・歩き）
      for (const [y, t] of sources) if (t < ready[y]) { ready[y] = t; from[y] = "src"; }
      const board = new Map();
      const fp = this.footpaths();
      for (const c of this.connections()) {
        if (!board.has(c.k) && c.td >= ready[c.u]) board.set(c.k, { c, from: from[c.u] });
        if (board.has(c.k) && c.ta < A[c.v]) {
          const rec = { b: board.get(c.k), e: c };
          A[c.v] = c.ta; J[c.v] = rec;
          if (this.hub(c.v) && c.ta + SAME < ready[c.v]) { ready[c.v] = c.ta + SAME; from[c.v] = rec; }
          for (const [a, b, sec] of fp) {
            for (const [x, y] of [[a, b], [b, a]]) if (x === c.v && c.ta + sec < ready[y]) {
              const w = { walk: x, sec, prev: rec };
              ready[y] = c.ta + sec; from[y] = w;
              if (c.ta + sec < A[y]) { A[y] = c.ta + sec; J[y] = w; }
            }
          }
        }
      }
      const path = (x) => {
        const legs = [];
        let rec = J[x], v = x, guard = 0;
        while (rec && rec !== "src" && guard++ < 8) {
          if (rec.walk !== undefined) { legs.unshift({ walk: true, from: rec.walk, to: v, sec: rec.sec }); v = rec.walk; rec = rec.prev; continue; }
          legs.unshift({ k: rec.b.c.k, from: rec.b.c.u, to: v, td: rec.b.c.td, ta: rec.e.ta });
          v = rec.b.c.u;
          rec = rec.b.from;
        }
        return { legs, start: v };
      };
      return { A, path };
    }
    trainInfo(k) {
      const tr = this.rail.trains[this.cal][k];
      return { line: tr.l, ttype: tr.k, dest: tr.to, lineName: this.rail.lines[tr.l].name, color: this.rail.lines[tr.l].color };
    }
    railSteps(legs) {
      return legs.map((l, i) => l.walk
        ? { type: "transfer", t: i ? legs[i - 1].ta : l.td, sec: l.sec, from: l.from, to: l.to }
        : Object.assign({ type: "train", t: l.td, t1: l.ta, from: l.from, to: l.to, k: l.k, cal: this.cal }, this.trainInfo(l.k)));
    }

    // ---------------------------------------------------------------- 行き
    go(O, hid, T) {
      const H = this.med.get(hid), hk = "h" + hid, g = this.stopG(O), gh = H.g;
      const res = { dir: "go", O, hid, T, g, gh, opts: [] };
      const dOH = this.walkM(O, hk);
      if (dOH <= WALK_ONLY_M) res.opts.push(this.walkOnly(O, hk, T, "go"));
      if (g === gh) res.opts.push(...this.goDemand(O, H, T));
      else res.opts.push(...this.goRail(O, H, T), ...this.goBorder(O, H, T));
      res.mode = g === gh ? "demand" : "rail";
      if (!res.opts.some((o) => o.kind !== "walkonly")) {
        res.none = true;
        res.reason = this.reason(H, g, gh, "go");
        if (!res.opts.length) res.opts.push(this.fallback(O, hk, T, "go", dOH));
      }
      return res;
    }
    // 地区をまたぐとき: 家の地区の中で、病院までタクシーでいちばん早く行けるバス停（境目のバス停）
    border(O, hk) {
      const g = this.stopG(O), d = this.door[g];
      if (!d) return null;
      let best = null;
      for (const s of this.data.districts[g].stops) {
        const c = d.c[`${s}|${hk}`];
        if (c && (!best || c[2] < best.c[2])) best = { s, c };
      }
      if (!best || best.s === O) return null;
      const full = d.c[`${O}|${hk}`];
      if (full && full[2] - best.c[2] < 5 * 60) return null;   // 家から乗るのと 5 分も変わらないなら出さない
      return best;
    }
    taxiSec(c) { return Math.ceil((c[2] * 1.4 + 60) / 60) * 60; }
    // 行き: 境目のバス停まで かわまる、そこからタクシー（タクシーは前もって呼んでおく）
    goBorder(O, H, T) {
      const hk = "h" + H.id, b = this.border(O, hk), g = this.stopG(O);
      if (!b) return [];
      const ride = this.taxiSec(b.c), dl = T - ride - 5 * 60;
      const a = this.P[g].latestArrival(this.plans[g], O, b.s, dl, dl - W);
      if (!a) return [];
      a.g = g;
      return [{ kind: "border", gap: dl - a.td, start: a.tp, end: T, legs: [a], km: b.c[1] / 1000, sec: ride, border: b.s,
        steps: [this.sBoard(a), this.sAlight(a), { type: "taxi", t: T - ride, sec: ride, km: b.c[1] / 1000, from: b.s, to: hk, wait: T - ride - a.td },
          this.sHosp(H, T, T)] }];
    }
    // 帰り: 病院から境目のバス停までタクシー（呼んで 10 分で来るとみる）、そこから かわまる
    backBorder(H, O, T) {
      const hk = "h" + H.id, b = this.border(O, hk), g = this.stopG(O);
      if (!b) return [];
      const ride = this.taxiSec(b.c), t0 = T + 10 * 60, arr = t0 + ride;
      const d = this.P[g].departures(this.plans[g], b.s, O, arr + 2 * 60, arr + W)[0];
      if (!d) return [];
      Object.assign(d, { x: b.s, g });
      return [{ kind: "border", gap: d.tp - arr, slack: d.tp - arr - 2 * 60, start: T, end: d.td, legs: [d], km: b.c[1] / 1000, sec: ride, border: b.s,
        steps: [this.sHospOut(H, T), { type: "taxi", t: t0, sec: ride, km: b.c[1] / 1000, from: hk, to: b.s, call: 10 * 60 },
          this.sWaitStop(b.s, arr, d.tp), this.sBoard(d, b.s), this.sAlight(d, true)] }];
    }
    accOf(H) { return (H.acc || []).filter(([, m]) => m <= MAX_ACC_M).map(([s]) => s); }

    goDemand(O, H, T) {
      const g = H.g, P = this.P[g], plan = this.plans[g], hk = "h" + H.id, D = this.eng[g];
      const xs = this.accOf(H).filter((x) => x !== O);
      // 着く時刻を 10 分ずつ前にずらして、乗れる便をいくつも集める（同じ便は 1 つに）
      const seen = new Set(), res = [];
      for (const x of xs) {
        const wx = this.walkS(x, hk);
        for (let dl = T - wx; dl >= T - W - wx; dl -= 10 * 60) {
          const a = P.latestArrival(plan, O, x, dl, T - W - wx - 30 * 60);
          if (!a) break;
          const key = `${x}|${a.t}`;
          if (!seen.has(key)) {
            seen.add(key);
            // 回り道: ひとりで乗ったときより何秒長く乗るか（相乗りの迎え・送りで遠回りする分）
            const solo = E.SVC_P + D.drive(D.ix[O], D.ix[x]);
            res.push(Object.assign(a, { wx, g, gap: T - a.td - wx, extra: Math.max(0, a.td - a.tp - solo) }));
          }
          dl = Math.min(dl, a.td);
        }
      }
      if (!res.length) return [];
      // いちばんの便: 待ちの短さと、回り道の少なさで選ぶ（相乗りの迎え・送りで遠回りする分は 3 倍で数える）
      const cost = (a) => a.gap + 3 * a.extra;
      const direct = res.slice().sort((p, q) => cost(p) - cost(q))[0];
      const mk = (a, more) => Object.assign({ kind: "direct", gap: a.gap, start: a.tp, end: T, legs: [a],
        steps: [this.sBoard(a), this.sAlight(a), this.sWalk(a.x, hk, a.td + 120), this.sHosp(H, a.td + 120 + a.wx, T)] }, more);
      // もっとちょうどに着くが、遠回りする便（いちばんにはしない。うしろに出す）
      const late = res.filter((a) => a.gap < direct.gap - 10 * 60).sort((p, q) => p.gap - q.gap)[0];
      const opts = [mk(direct, late ? { lateAlt: true } : {})];
      // 早めの便（まっすぐ行って待合室で待つ）: いちばんの便より 15 分以上早く着くもの
      const early = res.filter((a) => a.gap >= direct.gap + 15 * 60 && a.extra < 10 * 60)
        .sort((p, q) => (p.gap + p.extra) - (q.gap + q.extra))[0];
      // 寄り道: 早めに着く便で、病院のまわりで過ごす
      const cands = [];
      for (const a of res) {
        if (a.gap < ON_TIME + MIN_STAY) continue;
        for (const sp of this.spotsAt(hk)) {
          const w1 = this.walkS(a.x, sp.key), w2 = this.walkS(sp.key, hk);
          if (w1 > 12 * 60) continue;
          const stay = T - a.td - 120 - w1 - w2;
          if (stay < MIN_STAY || T - a.td > W + 30 * 60) continue;
          cands.push({ a, sp, w1, w2, stay, score: w1 + w2 + 2 * a.extra + 0.3 * Math.max(0, stay - 45 * 60) });
        }
      }
      for (const c of pick(cands)) {
        const t1 = c.a.td + 120;
        opts.push({ kind: "spot", group: c.sp.s.group, spot: c.sp, stay: c.stay, gap: T - c.a.td, start: c.a.tp, end: T, legs: [c.a],
          steps: [this.sBoard(c.a), this.sAlight(c.a), this.sWalk(c.a.x, c.sp.key, t1), this.sStay(c.sp, t1 + c.w1, c.stay),
            this.sWalk(c.sp.key, hk, T - c.w2), this.sHosp(H, T, T)] });
      }
      if (late) opts.push(mk(late, { detour: true }));
      if (early) opts.push(mk(early, { early: true }));
      return opts;
    }

    goRail(O, H, T) {
      const g = this.stopG(O), gh = H.g, hk = "h" + H.id;
      // 病院側: 駅から 歩く or デマンドバス
      const last = new Map();
      for (const [y, m] of H.sta || []) {
        if (m > MAX_STA_M) continue;
        const Y = this.st[y], ws = this.walkS(Y.stop, hk);
        const dl = T - ws - 120;
        const cur = last.get(y);
        if (!cur || dl > cur.dl) last.set(y, { dl, walk: true, ws });
      }
      this.st.forEach((Y, y) => {
        if (Y.g !== gh || !Y.stop || last.has(y)) return;
        let best = null;
        for (const x of this.accOf(H)) {
          if (x === Y.stop) continue;
          const wx = this.walkS(x, hk);
          const a = this.P[gh].latestArrival(this.plans[gh], Y.stop, x, T - wx, T - W - wx - 30 * 60);
          if (a && (!best || a.tp > best.bus.tp)) best = { bus: Object.assign(a, { wx, g: gh }), dl: a.tp - PLAT };
        }
        if (best) last.set(y, best);
      });
      if (!last.size) return [];
      const targets = new Map([...last].map(([y, v]) => [y, v.dl]));
      const { R, path } = this.latestRail(targets);
      // 家の側: 乗り場 → 駅（デマンドバス or 歩く）
      const routes = [];
      this.st.forEach((X, x) => {
        if (X.g !== g || !X.stop || !isFinite(R[x])) return;
        const rp = path(x), y = rp.end, L = last.get(y);
        if (!L || !rp.legs.length) return;
        const dep = rp.legs[0].td;
        let first = null;
        if (X.stop === O) first = { none: true, start: dep - PLAT };
        else if (hav(this.pos(O), this.pos(X.stop)) * DETOUR <= WALK_ONLY_M) {
          const ws = this.walkS(O, X.stop);
          first = { walk: true, ws, start: dep - PLAT - ws };
        } else {
          const a = this.P[g].latestArrival(this.plans[g], O, X.stop, dep - PLAT, dep - PLAT - W);
          if (a) first = { bus: Object.assign(a, { g }), start: a.tp };
        }
        if (!first) return;
        routes.push({ x, X, rp, L, first, dep, arrive: rp.legs[rp.legs.length - 1].ta });
      });
      if (!routes.length) return [];
      routes.sort((a, b) => b.first.start - a.first.start);
      const r = routes[0];
      const opts = [];
      const base = this.railRouteGo(O, H, T, r, null);
      opts.push(base);
      // 駅で長く待つなら、駅のまわりで過ごす
      if (r.first.bus) {
        const wait = r.dep - PLAT - r.first.bus.td;
        if (wait > ON_TIME) {
          const cands = [];
          for (const sp of this.spotsAt(r.X.stop)) {
            const w1 = this.walkS(r.X.stop, sp.key), w2 = w1;
            const stay = wait - 120 - w1 - w2;
            if (w1 > 10 * 60 || stay < MIN_STAY) continue;
            cands.push({ sp, w1, w2, stay, score: w1 });
          }
          for (const c of pick(cands)) opts.push(this.railRouteGo(O, H, T, r, c));
        }
      }
      // 病院に早く着きすぎるなら、病院のまわりで過ごす
      const hs = base.steps.find((x) => x.type === "hospital");
      if (hs && T - hs.t > ON_TIME) {
        const from = r.L.walk ? this.st[r.rp.end].stop : r.L.bus.x;
        const t0 = r.L.walk ? r.arrive + 120 : r.L.bus.td + 120;
        const cands = [];
        for (const sp of this.spotsAt(hk)) {
          const w1 = this.walkS(from, sp.key), w2 = this.walkS(sp.key, hk);
          const stay = T - t0 - w1 - w2;
          if (w1 > 12 * 60 || stay < MIN_STAY) continue;
          cands.push({ sp, w1, w2, stay, score: w1 + w2, from, t0, hosp: true });
        }
        for (const c of pick(cands)) opts.push(this.railRouteGo(O, H, T, r, c));
      }
      return opts;
    }
    railRouteGo(O, H, T, r, c) {
      const hk = "h" + H.id, steps = [], legs = [];
      const Xs = r.X.stop;
      let start;
      if (r.first.bus) {
        const a = r.first.bus;
        legs.push(a);
        steps.push(this.sBoard(a), this.sAlight(a));
        start = a.tp;
        if (c && !c.hosp) {
          const t1 = a.td + 120;
          steps.push(this.sWalk(Xs, c.sp.key, t1), this.sStay(c.sp, t1 + c.w1, c.stay), this.sWalk(c.sp.key, Xs, r.dep - PLAT - c.w2));
        }
      } else if (r.first.walk) {
        steps.push({ type: "start", t: r.first.start, place: O }, this.sWalk(O, Xs, r.first.start));
        start = r.first.start;
      } else {
        steps.push({ type: "start", t: r.dep - PLAT, place: O });
        start = r.dep - PLAT;
      }
      steps.push({ type: "station", t: r.dep - PLAT, sec: PLAT, st: r.x, wait: r.dep - PLAT - (r.first.bus && !c ? r.first.bus.td + 120 : r.dep - PLAT) });
      steps.push(...this.railSteps(r.rp.legs));
      const Y = this.st[r.rp.end];
      const arr = r.arrive;
      steps.push({ type: "exit", t: arr, st: r.rp.end });
      if (!r.L.walk) { const b = r.L.bus; legs.push(b); steps.push(this.sBoard(b), this.sAlight(b)); }
      if (c && c.hosp) {
        steps.push(this.sWalk(c.from, c.sp.key, c.t0), this.sStay(c.sp, c.t0 + c.w1, c.stay), this.sWalk(c.sp.key, hk, T - c.w2), this.sHosp(H, T, T));
      } else if (r.L.walk) {
        steps.push(this.sWalk(Y.stop, hk, arr + 120), this.sHosp(H, arr + 120 + r.L.ws, T));
      } else {
        const b = r.L.bus;
        steps.push(this.sWalk(b.x, hk, b.td + 120), this.sHosp(H, b.td + 120 + b.wx, T));
      }
      const gapStation = r.first.bus ? r.dep - PLAT - r.first.bus.td : 0;
      return { kind: c ? "spot" : "rail", group: c && c.sp.s.group, spot: c && c.sp, stay: c && c.stay, gap: gapStation,
        start, end: T, legs, rail: r.rp.legs, steps, at: c && c.hosp ? "hosp" : "station", station: r.x };
    }

    // ---------------------------------------------------------------- 帰り
    // 帰り。opt.plans: 行きの予約を入れた車の予定（地区ごと）。opt.buffer: 診察がのびても間に合うように 1 時間まで遅い便も出す
    back(hid, O, T, opt = {}) {
      const keep = this.plans;
      if (opt.plans) this.plans = Object.assign({}, this.plans, opt.plans);
      try {
        const H = this.med.get(hid), hk = "h" + hid, g = this.stopG(O), gh = H.g;
        const res = { dir: "back", O, hid, T, g, gh, opts: [] };
        const dOH = this.walkM(O, hk);
        if (dOH <= WALK_ONLY_M) res.opts.push(this.walkOnly(hk, O, T, "back"));
        if (g === gh) res.opts.push(...this.backDemand(H, O, T, !!opt.buffer));
        else res.opts.push(...this.backRail(H, O, T), ...this.backBorder(H, O, T));
        res.mode = g === gh ? "demand" : "rail";
        if (!res.opts.some((o) => o.kind !== "walkonly")) {
          res.none = true;
          res.reason = this.reason(H, g, gh, "back");
          if (!res.opts.length) res.opts.push(this.fallback(hk, O, T, "back", dOH));
        }
        if (opt.buffer) for (const o of res.opts) if (o.steps[0].type === "hospout") o.steps[0].end = true;
        return res;
      } finally { this.plans = keep; }
    }
    backDemand(H, O, T, buffer) {
      const g = H.g, P = this.P[g], plan = this.plans[g], hk = "h" + H.id;
      const res = [], late = [];
      for (const x of this.accOf(H)) {
        if (x === O) continue;
        const wx = this.walkS(hk, x);
        const d = P.departures(plan, x, O, T + wx, T + W)[0];
        if (d) res.push(Object.assign(d, { x, wx, g }));
        if (buffer) {
          const l = P.departures(plan, x, O, T + W - 30 * 60, T + W).pop();
          if (l) late.push(Object.assign(l, { x, wx, g }));
        }
      }
      if (!res.length) return [];
      res.sort((p, q) => p.tp - q.tp);
      late.sort((p, q) => q.tp - p.tp);
      const now = res[0];
      const wait = now.tp - (T + now.wx);
      const slack = (d) => d.tp - d.wx - T;   // 診察がこれだけのびても間に合う
      const opts = [{ kind: "direct", gap: wait, slack: slack(now), start: T, end: now.td, legs: [now],
        steps: [this.sHospOut(H, T), this.sWalk(hk, now.x, T), this.sWaitStop(now.x, T + now.wx, now.tp), this.sBoard(now, now.y), this.sAlight(now, true)] }];
      // 余裕をもって遅い便を予約し、病院で待つ
      const L = late[0];
      if (L && L.tp - now.tp >= 15 * 60) {
        const wh = L.tp - L.wx - T;
        opts.push({ kind: "wait", gap: wh, slack: slack(L), start: T, end: L.td, legs: [L],
          steps: [this.sHospOut(H, T), { type: "waithosp", t: T, sec: wh, h: H.id }, this.sWalk(hk, L.x, L.tp - L.wx), this.sBoard(L, L.y), this.sAlight(L, true)] });
      }
      if (wait <= ON_TIME && !L) return opts;
      const buses = (wait > ON_TIME ? res : []).concat(L ? late : []);
      const cands = [];
      for (const d of buses) {
        for (const sp of this.spotsAt(hk)) {
          const w1 = this.walkS(hk, sp.key), w2 = this.walkS(sp.key, d.x);
          if (w2 > 12 * 60) continue;
          const stay = d.tp - T - w1 - w2;
          if (stay < MIN_STAY) continue;
          // 遅い便に乗るほうを先に（診察がのびても間に合う）
          cands.push({ d, sp, w1, w2, stay, score: w1 + w2 - (buffer ? 0.3 * (d.tp - now.tp) : -0.2 * (d.tp - now.tp)) });
        }
      }
      for (const c of pick(cands)) {
        opts.push({ kind: "spot", group: c.sp.s.group, spot: c.sp, stay: c.stay, gap: c.d.tp - T, slack: slack(c.d), start: T, end: c.d.td, legs: [c.d],
          steps: [this.sHospOut(H, T), this.sWalk(hk, c.sp.key, T), this.sStay(c.sp, T + c.w1, c.stay), this.sWalk(c.sp.key, c.d.x, c.d.tp - c.w2),
            this.sBoard(c.d, c.d.y), this.sAlight(c.d, true)] });
      }
      return opts;
    }
    backRail(H, O, T) {
      const g = this.stopG(O), gh = H.g, hk = "h" + H.id;
      const first = new Map();
      for (const [y, m] of H.sta || []) {
        if (m > MAX_STA_M) continue;
        const Y = this.st[y], ws = this.walkS(hk, Y.stop);
        first.set(y, { ready: T + ws + 120, walk: true, ws });
      }
      this.st.forEach((Y, y) => {
        if (Y.g !== gh || !Y.stop || first.has(y)) return;
        let best = null;
        for (const x of this.accOf(H)) {
          if (x === Y.stop) continue;
          const wx = this.walkS(hk, x);
          const d = this.P[gh].departures(this.plans[gh], x, Y.stop, T + wx, T + W)[0];
          if (d && (!best || d.td < best.bus.td)) best = { bus: Object.assign(d, { x, wx, g: gh }), ready: d.td + PLAT };
        }
        if (best) first.set(y, best);
      });
      if (!first.size) return [];
      const { A, path } = this.earliestRail(new Map([...first].map(([y, v]) => [y, v.ready])));
      const routes = [];
      this.st.forEach((X, x) => {
        if (X.g !== g || !X.stop || !isFinite(A[x])) return;
        const rp = path(x), F = first.get(rp.start);
        if (!F || !rp.legs.length) return;
        const arr = A[x];
        let last = null;
        if (X.stop === O) last = { none: true, end: arr + PLAT };
        else if (hav(this.pos(O), this.pos(X.stop)) * DETOUR <= WALK_ONLY_M) {
          const ws = this.walkS(X.stop, O);
          last = { walk: true, ws, end: arr + PLAT + ws };
        } else {
          const d = this.P[g].departures(this.plans[g], X.stop, O, arr + PLAT, arr + PLAT + W)[0];
          if (d) last = { bus: Object.assign(d, { x: X.stop, g }), end: d.td };
        }
        if (!last) return;
        routes.push({ x, X, rp, F, last, arr, dep: rp.legs[0].td });
      });
      if (!routes.length) return [];
      routes.sort((a, b) => a.last.end - b.last.end);
      const r = routes[0];
      const opts = [this.railRouteBack(H, O, T, r, null)];
      // 着いた駅でデマンドバスを長く待つなら、駅のまわりで過ごす
      if (r.last.bus) {
        const wait = r.last.bus.tp - (r.arr + PLAT);
        if (wait > ON_TIME) {
          const cands = [];
          for (const sp of this.spotsAt(r.X.stop)) {
            const w1 = this.walkS(r.X.stop, sp.key);
            const stay = wait - w1 * 2;
            if (w1 > 10 * 60 || stay < MIN_STAY) continue;
            cands.push({ sp, w1, w2: w1, stay, score: w1 });
          }
          for (const c of pick(cands)) opts.push(this.railRouteBack(H, O, T, r, c));
        }
      }
      return opts;
    }
    railRouteBack(H, O, T, r, c) {
      const hk = "h" + H.id, steps = [this.sHospOut(H, T)], legs = [];
      const Y = this.st[r.rp.start];
      if (r.F.walk) steps.push(this.sWalk(hk, Y.stop, T));
      else {
        const b = r.F.bus;
        legs.push(b);
        steps.push(this.sWalk(hk, b.x, T), this.sWaitStop(b.x, T + b.wx, b.tp), this.sBoard(b, b.y), this.sAlight(b));
      }
      steps.push({ type: "station", t: r.F.walk ? T + r.F.ws : r.F.bus.td, sec: r.F.walk ? 120 : PLAT, st: r.rp.start, wait: r.dep - r.F.ready });
      steps.push(...this.railSteps(r.rp.legs));
      steps.push({ type: "exit", t: r.arr, st: r.x });
      const Xs = r.X.stop;
      let end;
      if (r.last.bus) {
        const d = r.last.bus;
        legs.push(d);
        if (c) {
          const t1 = r.arr + PLAT;
          steps.push(this.sWalk(Xs, c.sp.key, t1), this.sStay(c.sp, t1 + c.w1, c.stay), this.sWalk(c.sp.key, Xs, d.tp - c.w2));
        } else steps.push(this.sWaitStop(Xs, r.arr + PLAT, d.tp));
        steps.push(this.sBoard(d, d.y), this.sAlight(d, true));
        end = d.td;
      } else if (r.last.walk) {
        steps.push(this.sWalk(Xs, O, r.arr + PLAT), { type: "goal", t: r.last.end, place: O });
        end = r.last.end;
      } else {
        steps.push({ type: "goal", t: r.arr + PLAT, place: O });
        end = r.arr + PLAT;
      }
      // 診察がのびても間に合う時間: 歩いて駅へ行くなら電車まで、かわまるで駅へ行くならその便まで
      const slack = r.F.walk ? r.dep - r.F.ready : r.F.bus.tp - r.F.bus.wx - T;
      return { kind: c ? "spot" : "rail", group: c && c.sp.s.group, spot: c && c.sp, stay: c && c.stay, slack,
        gap: r.last.bus ? r.last.bus.tp - (r.arr + PLAT) : 0, start: T, end, legs, rail: r.rp.legs, steps, at: "station", station: r.x };
    }

    // ---------------------------------------------------------------- 乗り物で行けないとき
    walkOnly(a, b, T, dir) {
      const s = this.walkS(a, b);
      const t0 = dir === "go" ? T - s : T, t1 = dir === "go" ? T : T + s;
      return { kind: "walkonly", start: t0, end: t1, sec: s, legs: [], m: this.walkM(a, b),
        steps: [{ type: "start", t: t0, place: a }, { type: "walk", t: t0, sec: s, from: a, to: b }, { type: "goal", t: t1, place: b }] };
    }
    fallback(a, b, T, dir, m) {
      if (m <= WALK_FALLBACK_M) return Object.assign(this.walkOnly(a, b, T, dir), { kind: "walkfar" });
      // タクシー: 道路の道のりと走る時間（OSRM の車）。かわまると同じく 1.4 倍＋1 分で見る。取れていなければ直線の 1.35 倍・22km/h
      const dc = this.doorOf(a, b, "c");
      const km = dc ? dc[1] / 1000 : hav(this.pos(a), this.pos(b)) * 1.35 / 1000;
      const ride = Math.ceil((dc ? dc[2] * 1.4 + 60 : km / 22 * 3600) / 60) * 60;
      const t0 = dir === "go" ? T - ride : T, t1 = dir === "go" ? T : T + ride;
      return { kind: "taxi", start: t0, end: t1, sec: ride, km, legs: [],
        steps: [{ type: "start", t: t0, place: a }, { type: "taxi", t: t0, sec: ride, km, from: a, to: b }, { type: "goal", t: t1, place: b }] };
    }
    reason(H, g, gh, dir) {
      const acc = this.accOf(H).length, sta = (H.sta || []).some(([, m]) => m <= MAX_STA_M);
      if (g === gh && !acc) return "noStop";
      if (g !== gh && !acc && !sta) return "noStop";
      return "full";
    }

    // ---------------------------------------------------------------- 手順（表示用）
    sBoard(a, stop) { return { type: "board", t: a.tp, stop: stop || a.r.p, g: a.g, booked: a.t, share: share(a.plan, a.r, this.eng[a.g]) }; }
    sAlight(a, home) { return { type: "alight", t: a.td, stop: a.r.d, home: !!home }; }
    sWalk(from, to, t) { const sec = this.walkS(from, to); return { type: "walk", t, sec, from, to }; }
    sStay(sp, t, sec) { return { type: "stay", t, sec, spot: sp.s, key: sp.key }; }
    sHosp(H, t, until) { return { type: "hospital", t, h: H.id, until }; }
    sHospOut(H, t) { return { type: "hospout", t, h: H.id }; }
    sWaitStop(stop, t, tp) { return { type: "waitstop", t, sec: tp - t, stop }; }
  }

  // 乗り合い: 乗っているあいだに同じ車に乗っているほかの人の数と、途中で寄るバス停の数
  function share(plan, r, D) {
    if (!plan || !r) return null;
    const on = new Map(), co = new Map(), mid = new Set();
    let ride = false;
    for (const { r: q, k } of plan.route) {
      if (q === r) { if (k === "P") { ride = true; for (const [id, x] of on) co.set(id, x); } else break; continue; }
      if (k === "P") { on.set(q.id, q.pax || 1); if (ride) co.set(q.id, q.pax || 1); }
      else on.delete(q.id);
      if (ride) { const sid = D.ids[k === "P" ? q.pi : q.di]; if (sid !== r.p && sid !== r.d) mid.add(sid); }
    }
    let pax = 0; for (const v of co.values()) pax += v;
    return pax ? { pax, stops: mid.size } : null;
  }
  // まとまりごとに 2 つまで（種類が重ならないように）、短い順
  function pick(cands) {
    const out = [];
    cands.sort((p, q) => p.score - q.score);
    for (const g of Object.keys(GROUPS)) {
      const kinds = new Set(), seen = new Set();
      for (const c of cands) {
        if (c.sp.s.group !== g || kinds.has(c.sp.s.kind) || seen.has(c.sp.i)) continue;
        kinds.add(c.sp.s.kind); seen.add(c.sp.i);
        out.push(c);
        if (kinds.size >= 2) break;
      }
    }
    return out;
  }

  const api = { Trip, GROUPS, PLAT, WALK_M_PER_MIN };
  if (isNode) module.exports = api; else root.TripPlan = api;
})(this);
