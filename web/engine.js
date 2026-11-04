// デマンド交通の配車（車 1 台・挿入法）。実績の予約を受け付け直し、そこへ新しい予約を差し込む。
// 規則は data-exploration/scripts/demand_flex_sim.py（2026-10-28 に実績へ合わせたもの）と同じ。
//   走る時間 = OSRM の所要時間 × 1.4 + 60 秒、乗せるのに 5 分・降ろすのに 2 分
//   迎えに行けるのは希望時刻の 5 分前〜10 分後、乗車時間は 1 人で乗ったとき + 15 分まで
//   客を乗せたまま休憩に入れない
(function (root) {
  const K_DRIVE = 1.4, C_DRIVE = 60;
  const SVC_P = 300, SVC_D = 120, DETOUR = 900;
  const W_EARLY = 300, W_LATE = 600;

  const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 3600 + m * 60; };

  class District {
    constructor(data, g) {
      const d = data.districts[g];
      this.g = g;
      this.ids = d.stops;
      this.ix = Object.fromEntries(d.stops.map((s, i) => [s, i]));
      this.n = d.stops.length;
      this.raw = d.drive;
      const sv = data.service;
      this.open = hm(sv.open);
      this.close = hm(sv.close);
      this.breaks = sv.breaks.map(([a, b]) => [hm(a), hm(b)]);
      this.cap = sv.cap;
    }
    drive(a, b) {   // a, b: 区域内の番号
      if (a === b) return 0;
      return this.raw[a * this.n + b] * K_DRIVE + C_DRIVE;
    }
    makeReq(o) {
      // o: {p, d (停留所 id), t, pax, e?, l?, dl?, ...}
      const p = this.ix[o.p], d = this.ix[o.d];
      const r = Object.assign({}, o, { pi: p, di: d });
      if (r.e === undefined) r.e = Math.max(this.open, o.t - W_EARLY);
      if (r.l === undefined) r.l = Math.min(this.close - 60, o.t + W_LATE);
      r.maxride = SVC_P + this.drive(p, d) + DETOUR;
      r.pax = r.pax || 1;
      return r;
    }

    // route: [{r, k:'P'|'D'}]。先頭から詰めて走らせる。無理なら null。
    schedule(route) {
      const times = [], arrs = [];
      const pick = new Map();
      let onboard = 0, pos = null, dep = this.open, ds = 0;
      for (const { r, k } of route) {
        const stop = k === "P" ? r.pi : r.di;
        const dd = pos === null ? 0 : this.drive(pos, stop);
        let arr = dep + dd;
        if (onboard === 0) {
          for (const [b0, b1] of this.breaks) if (dep < b1 && arr > b0) arr = Math.max(dep, b1) + dd;
        }
        let start;
        if (k === "P") {
          start = Math.max(arr, r.e);
          if (onboard === 0) for (const [b0, b1] of this.breaks) if (b0 <= start && start < b1) start = b1;
          if (start > r.l) return null;
        } else {
          start = arr;
        }
        if (onboard > 0) for (const [b0, b1] of this.breaks) if (dep < b1 && start > b0) return null;
        if (k === "P") {
          onboard += r.pax;
          if (onboard > this.cap) return null;
          pick.set(r, start);
          dep = start + SVC_P;
        } else {
          if (start - pick.get(r) > r.maxride) return null;
          if (r.dl !== undefined && start > r.dl) return null;
          onboard -= r.pax;
          dep = start + SVC_D;
        }
        if (dep > this.close) return null;
        times.push(start);
        arrs.push(arr);
        ds += dd;
        pos = stop;
      }
      return { times, arrs, ds };
    }

    plan(route) {
      const s = this.schedule(route);
      return s && { route, times: s.times, arrs: s.arrs, ds: s.ds };
    }

    tryInsert(plan, r) {
      const route = plan.route, times = plan.times, n = route.length;
      const lo = r.e - 3600, hi = r.l + 3600;
      let best = null;
      for (let i = 0; i <= n; i++) {
        if (i < n && times[i] < lo) continue;
        if (i > 0 && times[i - 1] > hi) break;
        for (let j = i; j <= Math.min(n, i + 10); j++) {
          const cand = route.slice(0, i).concat([{ r, k: "P" }], route.slice(i, j), [{ r, k: "D" }], route.slice(j));
          const s = this.schedule(cand);
          if (!s) continue;
          const cost = (s.ds - plan.ds) + 0.1 * Math.abs(s.times[i] - r.t);
          if (!best || cost < best.cost) best = { plan: { route: cand, times: s.times, arrs: s.arrs, ds: s.ds }, cost };
        }
      }
      return best;
    }

    // そのままでは入らないとき、近い時刻の予約を 1 件外して入れ直す（配車システムの組み直しに相当）
    repair(plan, r, k = 6) {
      const seen = new Set();
      const cand = [];
      for (const { r: q, k: kk } of plan.route) {
        if (kk !== "P" || seen.has(q) || q.fixed) continue;
        seen.add(q);
        if (Math.abs(q.t - r.t) <= 3600) cand.push(q);
      }
      cand.sort((a, b) => Math.abs(a.t - r.t) - Math.abs(b.t - r.t));
      for (const q of cand.slice(0, k)) {
        const rest = plan.route.filter((x) => x.r !== q);
        const p0 = rest.length ? this.plan(rest) : { route: [], times: [], arrs: [], ds: 0 };
        if (!p0) continue;
        const b1 = this.tryInsert(p0, r);
        if (!b1) continue;
        const b2 = this.tryInsert(b1.plan, q);
        if (b2) return b2;
      }
      return null;
    }

    insert(plan, r) {
      const b = this.tryInsert(plan, r) || this.repair(plan, r);
      return b ? b.plan : null;
    }

    // 実績の予約を、乗る時刻の順に受け付け直す
    replay(rows) {
      let plan = { route: [], times: [], arrs: [], ds: 0 };
      const rejected = [];
      rows.forEach((o, i) => {
        const r = this.makeReq(Object.assign({ id: "R" + this.g + "-" + i, real: true }, o));
        const np = this.insert(plan, r);
        if (np) plan = np; else rejected.push(r);
      });
      return { plan, rejected };
    }

    // 予約 r が plan のどこで乗り・降りるか
    static when(plan, r) {
      let tp = null, td = null;
      plan.route.forEach((x, i) => {
        if (x.r === r) { if (x.k === "P") tp = plan.times[i]; else td = plan.times[i]; }
      });
      return { tp, td };
    }
  }

  const api = { District, hm, SVC_P, SVC_D };
  if (typeof module !== "undefined") module.exports = api; else root.Engine = api;
})(this);
