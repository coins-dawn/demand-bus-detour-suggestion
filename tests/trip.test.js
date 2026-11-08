// 片道の経路の候補が、筋の通った時刻になっているか（node tests/trip.test.js）
//   ・どの組でも候補が 1 つ以上出る（乗り物で行けなければ 歩き／タクシー）
//   ・手順の時刻が前に戻らない。行きは着きたい時刻までに着き、帰りは出る時刻より前に動かない
//   ・電車は、駅に着いてから乗り、乗った駅より先の駅で降りる
const fs = require("fs");
const { District } = require("../web/engine.js");
const { Trip } = require("../web/trip.js");
const rd = (f) => JSON.parse(fs.readFileSync(__dirname + "/../web/data/" + f));
const data = rd("kawagoe.json"), med = rd("med.json"), rail = rd("rail.json"), walk = rd("walk.json");
const tr = new Trip({ data, med, rail, walk });
const days = ["20260708", "20260711", "20260720"].map((d) => data.days.find((x) => x.date === d));
const origins = { 1: ["432", "449"], 2: ["291", "278"], 3: ["060", "013"] };
const cnt = {}, bad = [];
let n = 0;
for (const day of days) {
  const eng = {}, plans = {};
  for (const g of Object.keys(data.districts)) { eng[g] = new District(data, g); plans[g] = eng[g].replay(day.reqs[g]).plan; }
  tr.setDay(day, eng, plans);
  for (const [g, os] of Object.entries(origins)) for (const o of os) for (const H of med.list.filter((_, i) => i % 3 === 0)) for (const T of [9.5 * 3600, 13 * 3600]) {
    for (const dir of ["go", "back"]) {
      const r = dir === "go" ? tr.go(o, H.id, T) : tr.back(H.id, o, T);
      n++;
      const key = `${dir}:${r.mode}:${r.none ? "none-" + r.reason : "ok"}`;
      cnt[key] = (cnt[key] || 0) + 1;
      if (!r.opts.length) bad.push(`${day.date} ${dir} ${o} ${H.name}: 候補なし`);
      for (const op of r.opts) {
        const ts = op.steps.filter((s) => s.t != null && s.type !== "walk" && s.type !== "transfer").map((s) => s.t);
        for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - 60) { bad.push(`${day.date} ${dir} ${o} ${H.name} ${op.kind}: 時刻が戻る ${ts.join(",")}`); break; }
        if (dir === "go" && op.end > T) bad.push(`${day.date} go ${o} ${H.name} ${op.kind}: 遅れて着く`);
        if (dir === "back" && ts[0] < T) bad.push(`${day.date} back ${o} ${H.name} ${op.kind}: 出る前に動く`);
        const st = op.steps.find((s) => s.type === "station"), t0 = op.steps.find((s) => s.type === "train");
        if (t0 && st && t0.t < st.t) bad.push(`${day.date} ${dir} ${o} ${H.name}: 駅に着く前に電車が出る`);
        for (const s of op.steps) if (s.type === "train" && s.t1 <= s.t) bad.push(`${day.date} ${dir}: 電車の時刻がおかしい`);
      }
    }
  }
}
console.log("組", n, cnt);
if (bad.length) { console.log("おかしいもの", bad.length); console.log(bad.slice(0, 15).join("\n")); process.exit(1); }
console.log("OK");
