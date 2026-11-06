// 行き・帰りの便の候補を作る。
//   行き: 病院に着きたい時刻 T に間に合う便。ちょうどの便が取れなければ、早めに着いて近くで過ごす経路も出す。
//   帰り: 診察が終わる見込み E のすぐあとの便と、「幅」W のぶん遅らせた便。あいだを近くで過ごす経路を出す。
(function (root) {
  const E = (typeof module !== "undefined") ? require("./engine.js") : root.Engine;
  const WALK_M_PER_MIN = 50;    // ゆっくり歩く（分速 50m）
  const DETOUR = 1.3;           // 道なりは直線の 1.3 倍
  const NEAR_STOP_M = 500;      // 病院の近くの乗り場（ここで乗り降りしてもよい）
  const MAX_WALK_MIN = 12;      // 過ごす場所まで歩くのはここまで
  const MIN_STAY = 10 * 60;     // 過ごす時間がこれより短ければ出さない
  const ON_TIME = 10 * 60;      // 着きたい時刻のこれより前に着くなら「ちょうど着く」。寄り道は出さない
  const STEP = 5 * 60;
  const GROUPS = {
    rest: { label: "落ち着ける場所", icon: "coffee" },
    errand: { label: "ついでの用事", icon: "cart" },
    sit: { label: "座って待てる場所", icon: "bench" },
  };

  function hav(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const walkSec = (a, b) => {
    const m = hav(a, b) * DETOUR;
    return m < 30 ? 0 : Math.ceil(m / WALK_M_PER_MIN) * 60;
  };

  class Planner {
    constructor(data, district) {
      this.data = data;
      this.D = district;
      this.stops = data.stops;
    }
    pt(id) { return this.stops[id]; }

    nearStops(h) {
      const H = this.pt(h);
      return this.D.ids.filter((s) => s !== h && hav(this.pt(s), H) <= NEAR_STOP_M)
        .sort((a, b) => hav(this.pt(a), H) - hav(this.pt(b), H)).slice(0, 5);
    }

    spotsNear(h) {
      const H = this.pt(h);
      return this.data.spots.filter((s) => walkSec(s, H) <= MAX_WALK_MIN * 60);
    }

    // 乗り場 X で降りる便のうち、deadline までに着くもっとも遅い便
    latestArrival(plan, o, x, deadline, earliest) {
      const D = this.D;
      const solo = E.SVC_P + D.drive(D.ix[o], D.ix[x]);
      for (let t = Math.floor((deadline - solo) / STEP) * STEP; t + solo >= earliest; t -= STEP) {
        if (t < D.open) break;
        const r = D.makeReq({ id: "U-go-" + x + "-" + t, p: o, d: x, t, pax: 1, dl: deadline, user: true, fixed: true });
        const np = D.insert(plan, r);
        if (np) {
          const w = E.District.when(np, r);
          if (w.td >= earliest) return { x, t, r, plan: np, tp: w.tp, td: w.td };
        }
      }
      return null;
    }

    // 乗り場 Y から乗る便を、ready 以降・until までの各時刻で試す
    departures(plan, y, home, ready, until) {
      const D = this.D, out = [];
      for (let t = Math.ceil(ready / STEP) * STEP; t <= until; t += STEP) {
        if (t > D.close - 600) break;
        const r = D.makeReq({ id: "U-back-" + y + "-" + t, p: y, d: home, t, e: t, l: t + 600, pax: 1, user: true, fixed: true });
        const np = D.insert(plan, r);
        if (np) {
          const w = E.District.when(np, r);
          out.push({ y, t, r, plan: np, tp: w.tp, td: w.td });
        }
      }
      return out;
    }

    // ------------------------------------------------------------ 行き
    outbound(plan, o, h, T, W) {
      const H = this.pt(h);
      const xs = [h].concat(this.nearStops(h));
      const res = [];
      for (const x of xs) {
        const wx = walkSec(this.pt(x), H);
        const a = this.latestArrival(plan, o, x, T - wx, T - W - wx - 30 * 60);
        if (a) res.push(Object.assign(a, { walkXH: wx }));
      }
      const opts = [];
      const direct = res.find((a) => a.x === h) || res.slice().sort((p, q) => (p.td + p.walkXH) - (q.td + q.walkXH)).pop();
      if (!direct) return { opts, none: true, alt: this.altGo(plan, o, h, T, W) };
      const gap = T - direct.td - direct.walkXH;
      opts.push({
        kind: "direct", group: null, bus: direct, gap, withinW: gap <= W,
        steps: this.stepsGo(direct, null, h, T),
      });
      // ちょうど着く便（10 分前まで）が取れたら、寄り道は出さない
      if (gap <= ON_TIME) return { opts };
      // 早めに着く: 降りた乗り場 → 過ごす場所 → 病院
      const cands = [];
      for (const a of res) {
        const X = this.pt(a.x);
        for (const s of this.spotsNear(h)) {
          const w1 = walkSec(X, s), w2 = walkSec(s, H);
          if (w1 > MAX_WALK_MIN * 60) continue;
          const stay = T - a.td - w1 - w2;
          if (stay < MIN_STAY || T - a.td > W + 30 * 60) continue;
          cands.push({ a, s, w1, w2, stay, score: w1 + w2 - 0.2 * (a.td - direct.td) });
        }
      }
      for (const c of this.pick(cands)) {
        opts.push({ kind: "spot", group: c.s.group, spot: c.s, bus: c.a, stay: c.stay, gap: T - c.a.td,
                    withinW: T - c.a.td <= W, steps: this.stepsGo(c.a, c, h, T) });
      }
      return { opts };
    }

    // 幅の中で取れないとき: もっと早く着く便と、遅れて着く便を探す（どちらも案内だけ）
    altGo(plan, o, h, T, W) {
      const D = this.D;
      const earlier = this.latestArrival(plan, o, h, T - W - 30 * 60, D.open);
      let later = null;
      const solo = E.SVC_P + D.drive(D.ix[o], D.ix[h]);
      for (let t = Math.ceil((T - solo) / STEP) * STEP; t <= T + 2 * 3600; t += STEP) {
        const r = D.makeReq({ id: "U-alt-" + t, p: o, d: h, t, pax: 1, user: true });
        const np = D.insert(plan, r);
        if (np) { const w = E.District.when(np, r); if (w.td > T) { later = { tp: w.tp, td: w.td }; break; } }
      }
      return { earlier: earlier && { tp: earlier.tp, td: earlier.td }, later };
    }

    stepsGo(a, c, h, T) {
      const st = [];
      st.push({ type: "board", t: a.tp, stop: a.r.p });
      st.push({ type: "alight", t: a.td, stop: a.x });
      if (c) {
        st.push({ type: "walk", t: a.td + 120, sec: c.w1, to: c.s });
        st.push({ type: "stay", t: a.td + 120 + c.w1, sec: c.stay - 120, spot: c.s });
        st.push({ type: "walk", t: T - c.w2, sec: c.w2, to: { hospital: h } });
      } else if (a.walkXH > 0) {
        st.push({ type: "walk", t: a.td + 120, sec: a.walkXH, to: { hospital: h } });
      }
      st.push({ type: "hospital", t: c ? T : a.td + a.walkXH, h, until: T });
      return st;
    }

    // ------------------------------------------------------------ 帰り
    inbound(plan, home, h, end, W) {
      const H = this.pt(h);
      const ys = [h].concat(this.nearStops(h));
      const opts = [];
      // すぐ帰る（病院の前から、終わってすぐの便）
      const now = this.departures(plan, h, home, end, end + Math.max(W, 60 * 60))[0];
      if (now) {
        opts.push({ kind: "now", bus: now, wait: now.tp - end, slack: now.t - end,
                    steps: this.stepsBack(now, null, h, end) });
      }
      if (!opts.length) {
        const nx = this.departures(plan, h, home, end + Math.max(W, 60 * 60), this.D.close)[0];
        return { opts, none: true, next: nx && { t: nx.t, tp: nx.tp, td: nx.td } };
      }
      if (W <= 0) return { opts };
      // 余裕をもって予約（W のぶん遅い便）。病院で待つ
      const late = this.departures(plan, h, home, end + W - 30 * 60, end + W).pop();
      if (late && (!now || late.t - now.t >= 15 * 60)) {
        opts.push({ kind: "wait", bus: late, wait: late.tp - end, slack: late.t - end,
                    steps: this.stepsBack(late, null, h, end) });
      }
      // 余裕をもって予約し、あいだを近くで過ごす。過ごす場所に近い乗り場から乗る
      const cands = [];
      const cache = new Map();
      for (const s of this.spotsNear(h)) {
        const w1 = walkSec(H, s);
        let best = null;
        for (const y of ys) {
          const w2 = walkSec(s, this.pt(y));
          if (w2 > MAX_WALK_MIN * 60) continue;
          if (!best || w2 < best.w2) best = { y, w2 };
        }
        if (!best) continue;
        const key = best.y;
        if (!cache.has(key)) {
          cache.set(key, this.departures(plan, key, home, end + Math.max(W - 30 * 60, 15 * 60), end + W).pop() || null);
        }
        const bus = cache.get(key);
        if (!bus) continue;
        const stay = bus.t - end - w1 - best.w2;
        if (stay < MIN_STAY) continue;
        cands.push({ a: bus, s, w1, w2: best.w2, stay, score: w1 + best.w2 });
      }
      for (const c of this.pick(cands)) {
        opts.push({ kind: "spot", group: c.s.group, spot: c.s, bus: c.a, stay: c.stay,
                    wait: c.a.tp - end, slack: c.a.t - end - walkSec(H, this.pt(c.a.y)),
                    steps: this.stepsBack(c.a, c, h, end) });
      }
      return { opts, none: !opts.length };
    }

    stepsBack(b, c, h, end) {
      const st = [{ type: "hospital", t: end, h, end: true }];
      if (c) {
        st.push({ type: "walk", t: end, sec: c.w1, to: c.s });
        st.push({ type: "stay", t: end + c.w1, sec: c.stay, spot: c.s });
        st.push({ type: "walk", t: b.t - c.w2, sec: c.w2, to: { stop: b.y } });
      } else if (b.y !== h) {
        const w = walkSec(this.pt(h), this.pt(b.y));
        st.push({ type: "walk", t: b.t - w, sec: w, to: { stop: b.y } });
      }
      st.push({ type: "board", t: b.tp, stop: b.y, booked: b.t });
      st.push({ type: "alight", t: b.td, stop: b.r.d, home: true });
      return st;
    }

    // まとまりごとに 2 つまで（種類が重ならないように）、歩く距離の短い順
    pick(cands) {
      const out = [];
      cands.sort((p, q) => p.score - q.score);
      for (const g of Object.keys(GROUPS)) {
        const kinds = new Set();
        for (const c of cands) {
          if (c.s.group !== g || kinds.has(c.s.kind)) continue;
          kinds.add(c.s.kind);
          out.push(c);
          if (kinds.size >= 2) break;
        }
      }
      return out;
    }
  }

  const api = { Planner, GROUPS, walkSec, hav };
  if (typeof module !== "undefined") module.exports = api; else root.Plan = api;
})(this);
