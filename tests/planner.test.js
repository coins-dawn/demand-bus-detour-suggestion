// 行き・帰りの候補が出るか（node tests/planner.test.js）
const fs = require("fs");
const { District } = require("../web/engine.js");
const { Planner } = require("../web/planner.js");
const data = JSON.parse(fs.readFileSync(__dirname + "/../web/data/kawagoe.json"));
const fmt = (t) => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}`;
let fails = 0, early = 0, n = 0;
for (const o of data.origins) {
  for (const h of data.hospitals.filter((x) => x.g === o.g)) {
    for (const day of data.days.filter((_, i) => i % 40 === 0)) {
      for (const T of [9 * 3600, 10 * 3600, 14 * 3600]) {
        const D = new District(data, o.g);
        const P = new Planner(data, D);
        const base = D.replay(day.reqs[o.g]).plan;
        const go = P.outbound(base, o.id, h.id, T, 3600);
        n++;
        if (go.none) { fails++; continue; }
        const d = go.opts[0];
        if (d.gap > 15 * 60) early++;
        const back = P.inbound(d.bus.plan, o.id, h.id, T + 3600, 3600);
        if (o.id === "012" && h.id === "019" && T === 10 * 3600) {
          console.log(day.date, "行き", go.opts.map((x) => `${x.kind}${x.spot ? ":" + x.spot.label : ""} ${fmt(x.bus.tp)}→${fmt(x.bus.td)}`).join(" | "));
          console.log("         帰り", back.opts.map((x) => `${x.kind}${x.spot ? ":" + x.spot.label : ""} ${fmt(x.bus.tp)}→${fmt(x.bus.td)}`).join(" | "));
        }
      }
    }
  }
}
console.log(`組 ${n}、行きが取れない ${fails}、15 分より早く着くしかない ${early}`);
