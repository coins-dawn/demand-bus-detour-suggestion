// 実績の予約を受け付け直して、どれだけ入るか（node tests/replay.test.js）
const fs = require("fs");
const { District } = require("../web/engine.js");
const data = JSON.parse(fs.readFileSync(__dirname + "/../web/data/kawagoe.json"));
let tot = 0, rej = 0;
for (const day of data.days) {
  const line = [day.date];
  for (const g of Object.keys(data.districts)) {
    const D = new District(data, g);
    const t0 = Date.now();
    const { plan, rejected } = D.replay(day.reqs[g]);
    tot += day.reqs[g].length; rej += rejected.length;
    line.push(`地区${g} ${day.reqs[g].length - rejected.length}/${day.reqs[g].length} (${Date.now() - t0}ms)`);
  }
  console.log(line.join("  "));
}
console.log(`受け付けられた割合 ${(100 * (1 - rej / tot)).toFixed(1)}%`);
if (rej / tot > 0.1) { console.error("受け付けられない実績が多すぎる"); process.exit(1); }
