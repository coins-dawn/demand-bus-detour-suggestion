// デマンドバスの便をさがす部品（経路の組み立ては trip.js）。
//   latestArrival: 締め切りまでに着く、いちばん遅い便
//   departures: ある時刻よりあとに乗れる便
(function (root) {
  const E = (typeof module !== "undefined") ? require("./engine.js") : root.Engine;
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
  class Planner {
    constructor(data, district) {
      this.data = data;
      this.D = district;
      this.stops = data.stops;
    }
    pt(id) { return this.stops[id]; }

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

  }

  const api = { Planner, GROUPS, hav };
  if (typeof module !== "undefined") module.exports = api; else root.Plan = api;
})(this);
