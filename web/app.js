// 画面: 上にヘッダ。左＝条件と候補、中＝カレンダーと時間帯の混み具合、右＝地図（出発地・病院・経路）
const { District, SVC_P, SVC_D } = Engine;
const { Planner, GROUPS, walkSec } = Plan;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (t) => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}`;
const mins = (sec) => Math.max(0, Math.round(sec / 60));
const dur = (sec) => { const m = mins(sec); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}` : `${m}分`; };
const COLORS = { 1: "#1c7ed6", 2: "#e8590c", 3: "#7048e8" };
const ME = "#d6336c", BACK = "#1971c2";
const GROUP_ICON = { rest: "coffee", errand: "cart", sit: "bench" };
const GROUP_COLOR = { rest: "#a0522d", errand: "#2b8a3e", sit: "#1971c2" };
const KIND_ICON = { cafe: "coffee", fast_food: "hamburger", restaurant: "silverware-fork-knife", supermarket: "cart",
  convenience: "store-24-hour", drug: "pill", post: "email", bank: "bank", books: "book-open-variant", bakery: "bread-slice",
  park: "tree", bench: "bench", community: "account-group", library: "library" };
// 混み具合の 4 段階（この地区のこの月の中での位置）
const LV = [
  { t: "空いている", c: "#fff4e6", ink: "#8a5a00" },
  { t: "ふつう", c: "#ffd8a8", ink: "#8a4b00" },
  { t: "混んでいる", c: "#ffa94d", ink: "#7a3300" },
  { t: "とても混んでいる", c: "#e8590c", ink: "#fff" },
];
const chip = (l) => `<span class="lv" style="background:${LV[l].c};color:${LV[l].ink}">${LV[l].t}</span>`;
const BIN = 1800, T0 = 8 * 3600, T1 = 18 * 3600, NB = (T1 - T0) / BIN;
const WD = "月火水木金土日";
function breakIn(a, b) {
  const br = S.data.service.breaks.find(([x, y]) => Engine.hm(x) < b && Engine.hm(y) > a);
  return br ? `${br[0]}〜${br[1]} は運転手の休憩で、車が動きません。` : "";
}
// 開いたときの例（2026-07-08 の実績で、10:00 ちょうどに着く便が埋まっている組）
const DEFAULT = { date: "20260708", orig: "291", hospName: "きりむら内科医院", arr: 10 * 3600 };

const S = {
  data: null, geom: {}, walk: {}, line: new Map(), eng: {}, base: {}, plans: {}, stats: {}, g: "2", cal: null,
  q: null, go: null, back: null, goSel: null, backSel: null, booked: null, res: null,
};
const day = () => S.data.days[+$("day").value];

// ------------------------------------------------------------------ 道路の形
function decode(str) {
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}
function seg(g, a, b) {
  const key = a + ">" + b;
  if (S.line.has(key)) return S.line.get(key);
  const st = S.data.stops;
  let pts = null;
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  const enc = S.geom[g] && S.geom[g][k];
  if (enc) { pts = decode(enc); if (a > b) pts.reverse(); }
  if (!pts || pts.length < 2) pts = [[st[a].lon, st[a].lat], [st[b].lon, st[b].lat]];
  pts[0] = [st[a].lon, st[a].lat]; pts[pts.length - 1] = [st[b].lon, st[b].lat];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][0] - pts[i - 1][0]) * Math.cos(pts[i][1] * Math.PI / 180), dy = pts[i][1] - pts[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const o = { pts, cum, len: cum[cum.length - 1] };
  S.line.set(key, o);
  return o;
}
// 予約 r が乗ってから降りるまでに車が通る道（相乗りの寄り道を含む）
function busPath(g, plan, r) {
  const D = S.eng[g], ids = plan.route.map((x) => D.ids[x.k === "P" ? x.r.pi : x.r.di]);
  const i0 = plan.route.findIndex((x) => x.r === r && x.k === "P"), i1 = plan.route.findIndex((x) => x.r === r && x.k === "D");
  let pts = [];
  for (let i = i0 + 1; i <= i1; i++) if (ids[i] !== ids[i - 1]) pts = pts.concat(seg(g, ids[i - 1], ids[i]).pts);
  return pts;
}
const pt = (c, p = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: p });
const fc = (f) => ({ type: "FeatureCollection", features: f });

// ------------------------------------------------------------------ 運行日（実績の予約を配車の計算で受け付け直す）
function loadDay() {
  const g = S.g, d = day();
  S.eng[g] = new District(S.data, g);
  const r = S.eng[g].replay(d.reqs[g]);
  S.base[g] = r.plan; S.plans[g] = r.plan;
  S.booked = null;
  clearResults();
}

// ------------------------------------------------------------------ 混み具合の集計（地区ごと、ひと月分）
function stats(g) {
  if (S.stats[g]) return S.stats[g];
  const bins = {}, tot = {};
  for (const d of S.data.days) {
    const b = Array(NB).fill(0); let n = 0;
    for (const r of d.reqs[g]) { const k = Math.floor((r[2] - T0) / BIN); if (k >= 0 && k < NB) b[k] += r[4]; n += r[4]; }
    bins[d.date] = b; tot[d.date] = n;
  }
  const qs = (arr) => { const s = arr.slice().sort((a, b) => a - b); return { Q: [0.33, 0.67, 0.9].map((p) => s[Math.floor(p * (s.length - 1))]), s }; };
  const win = [];
  for (const b of Object.values(bins)) for (let k = 1; k < NB; k++) win.push(b[k - 1] + b[k]);
  return S.stats[g] = { bins, tot, day: qs(Object.values(tot)), win: qs(win) };
}
const level = (v, Q) => v <= Q[0] ? 0 : v <= Q[1] ? 1 : v <= Q[2] ? 2 : 3;
// [a, a+1 時間) に乗る人の数
function winCount(b, a) {
  let n = 0;
  for (let k = 0; k < NB; k++) { const t = T0 + k * BIN; if (t >= a && t < a + 3600) n += b[k]; }
  return n;
}

// ------------------------------------------------------------------ 中のペイン: カレンダー
function renderCal() {
  const st = stats(S.g), d = day(), byDate = new Map(S.data.days.map((x, i) => [x.date, i]));
  if (!S.cal) S.cal = d.date.slice(0, 6);
  const y = +S.cal.slice(0, 4), m = +S.cal.slice(4, 6);
  $("cal-title").textContent = `${y}年${m}月`;
  const months = [...new Set(S.data.days.map((x) => x.date.slice(0, 6)))];
  $("cal-prev").disabled = months.indexOf(S.cal) <= 0;
  $("cal-next").disabled = months.indexOf(S.cal) >= months.length - 1;
  const first = new Date(y, m - 1, 1), nd = new Date(y, m, 0).getDate(), lead = (first.getDay() + 6) % 7;
  let h = WD.split("").map((w, i) => `<span class="wd${i >= 5 ? " we" : ""}">${w}</span>`).join("");
  for (let i = 0; i < lead; i++) h += `<span></span>`;
  for (let dd = 1; dd <= nd; dd++) {
    const key = `${y}${String(m).padStart(2, "0")}${String(dd).padStart(2, "0")}`, idx = byDate.get(key);
    if (idx === undefined) { h += `<span class="day off" title="運行の記録なし">${dd}</span>`; continue; }
    const l = level(st.tot[key], st.day.Q);
    h += `<button class="day${key === d.date ? " sel" : ""}" data-i="${idx}" style="background:${LV[l].c};color:${LV[l].ink}" title="${m}/${dd} 予約 ${st.tot[key]} 人・${LV[l].t}">${dd}</button>`;
  }
  $("cal").innerHTML = h;
  $("cal").querySelectorAll("button.day").forEach((b) => b.onclick = () => { $("day").value = b.dataset.i; onDay(); });
  $("cal-scale").innerHTML = LV.map((x) => `<span><i style="background:${x.c}"></i>${x.t}</span>`).join("") + (h.includes("day off") ? `<span><i class="off"></i>記録なし</span>` : "");
  const n = st.tot[d.date], rank = st.day.s.filter((v) => v > n).length / st.day.s.length;
  const l = level(n, st.day.Q);
  $("day-verdict").innerHTML = `<b>${+d.date.slice(4, 6)}月${+d.date.slice(6)}日（${d.wd}）</b>の${S.data.districts[S.g].name}は ${chip(l)}<br>
    <span class="vsub">予約 ${n} 人。この月で多いほうから ${Math.max(1, Math.round(rank * 100))}% の日</span>`;
}

// ------------------------------------------------------------------ 中のペイン: この日の時間帯ごとの予約
function renderChart() {
  const st = stats(S.g), d = day(), b = st.bins[d.date];
  const T = +$("arr").value, E = T + +$("dur").value;
  const goA = T - 3600, backA = E;
  const lgo = level(winCount(b, goA), st.win.Q), lback = level(winCount(b, backA), st.win.Q);
  const brk = S.data.service.breaks.map(([x, y]) => [Engine.hm(x), Engine.hm(y)]);
  const max = Math.max(6, ...b);
  const inW = (t, a) => t >= a && t < a + 3600;
  let bars = "";
  for (let k = 0; k < NB; k++) {
    const t = T0 + k * BIN, isBrk = brk.some(([x, y]) => t >= x && t < y);
    let cls = isBrk ? "brk" : "", style = `height:${(b[k] / max) * 100}%`;
    if (!isBrk && inW(t, goA)) { cls = "hl"; style += `;background:${LV[lgo].c};border-color:${ME}`; }
    else if (!isBrk && inW(t, backA)) { cls = "hl"; style += `;background:${LV[lback].c};border-color:${BACK}`; }
    bars += `<i class="${cls}" style="${style}" title="${fmt(t)}〜 ${isBrk ? "休憩" : b[k] + "人"}"></i>`;
  }
  const pc = (t) => ((t - T0) / (T1 - T0)) * 100;
  const tag = (a, cls, label) => {
    const x0 = Math.max(T0, a), x1 = Math.min(T1, a + 3600);
    return x1 > x0 ? `<span class="span ${cls}" style="left:${pc(x0)}%;width:${pc(x1) - pc(x0)}%">${label}</span>` : "";
  };
  $("chart").innerHTML = `
    <div class="plot"><div class="bars">${bars}</div>
</div>
    <div class="spans">${tag(goA, "go", "行き")}${tag(backA, "back", "帰り")}</div>
    <div class="axis">${[8, 10, 12, 14, 16, 18].map((h) => `<span style="left:${pc(h * 3600)}%">${h}時</span>`).join("")}</div>`;
  $("time-verdict").innerHTML = `
    <div class="vrow"><span class="lab go">行き</span>${fmt(T)} に着く便 ${chip(lgo)}<span class="vsub">${fmt(goA)}〜${fmt(T)} に乗る人 ${winCount(b, goA)} 人</span></div>
    <div class="vrow"><span class="lab back">帰り</span>${fmt(E)} ごろから ${chip(lback)}<span class="vsub">${fmt(E)}〜${fmt(E + 3600)} に乗る人 ${winCount(b, backA)} 人</span></div>`;
  $("chart-note").innerHTML = `棒は、この日の 30 分ごとに乗る人の数（実績の予約）。しま模様は運転手の休憩。
    混み具合は、この地区のこの月の 1 時間ごとの数の中での位置です。`;
}
function renderMid() { renderCal(); renderChart(); }

// ------------------------------------------------------------------ 左のペイン: 入力
function fillForm() {
  const d = S.data;
  S.g = (d.origins.find((x) => x.id === DEFAULT.orig) || d.origins[0]).g;
  $("dist").innerHTML = Object.entries(d.districts).map(([g, x]) =>
    `<button type="button" role="tab" data-g="${g}" style="--c:${COLORS[g]}">${esc(x.name)}</button>`).join("");
  $("dist").querySelectorAll("button").forEach((b) => b.onclick = () => setDistrict(b.dataset.g));
  const byM = new Map();
  d.days.forEach((x, i) => { const k = x.date.slice(0, 6); if (!byM.has(k)) byM.set(k, []); byM.get(k).push([x, i]); });
  $("day").innerHTML = [...byM].map(([k, xs]) => `<optgroup label="${k.slice(0, 4)}年${+k.slice(4)}月">` +
    xs.map(([x, i]) => `<option value="${i}">${+x.date.slice(4, 6)}月${+x.date.slice(6)}日（${x.wd}）</option>`).join("") + "</optgroup>").join("");
  const di = d.days.findIndex((x) => x.date === DEFAULT.date);
  $("day").value = String(di >= 0 ? di : 0);
  fillOrig();
  if (d.origins.some((x) => x.id === DEFAULT.orig)) $("orig").value = DEFAULT.orig;
  markDistrict();
  const times = [];
  for (let t = 8.5 * 3600; t <= 16.5 * 3600; t += 1800) times.push(t);
  $("arr").innerHTML = times.map((t) => `<option value="${t}">${fmt(t)}</option>`).join("");
  $("arr").value = String(DEFAULT.arr);
  $("dur").innerHTML = [[1800, "30分"], [3600, "1時間"], [5400, "1時間30分"], [7200, "2時間"], [10800, "3時間"]]
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("dur").value = "3600";
  fillHosp();
  const dh = d.hospitals.find((x) => x.name === DEFAULT.hospName && x.g === S.g);
  if (dh) $("hosp").value = dh.id;
  $("orig").onchange = () => { fillHosp(); clearResults(); fitTo([$("orig").value, $("hosp").value]); };
  $("hosp").onchange = () => { clearResults(); fitTo([$("orig").value, $("hosp").value]); };
  $("day").onchange = onDay;
  $("arr").onchange = $("dur").onchange = () => { clearResults(); renderChart(); };
}
function onDay() { S.cal = day().date.slice(0, 6); loadDay(); renderMid(); }
function fillOrig() {
  $("orig").innerHTML = S.data.origins.filter((x) => x.g === S.g).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
}
function fillHosp() {
  $("hosp").innerHTML = S.data.hospitals.filter((x) => x.g === S.g).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
}
function markDistrict() {
  $("dist").querySelectorAll("button").forEach((b) => { const on = b.dataset.g === S.g; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
}
function setDistrict(g) {
  if (g === S.g) return;
  S.g = g; S.q = null;
  markDistrict(); fillOrig(); fillHosp();
  loadDay(); renderMid();
  if (map) map.setFilter("hull-l", ["==", ["get", "g"], g]);
  fitTo([$("orig").value, $("hosp").value]);
}

// ------------------------------------------------------------------ 候補の表示
function clearResults() {
  if (S.booked) cancel();
  S.go = S.back = S.goSel = S.backSel = null;
  setView("info");
  drawTrace();
}
function sname(id) { return esc((S.data.stops[id] || {}).name || id); }
function hname(id) { const h = S.data.hospitals.find((x) => x.id === id); return esc(h ? h.name : sname(id)); }

function stepRows(steps) {
  const li = (tm, ic, body, cls = "") => `<li class="${cls}"><span class="tm">${tm}</span><span class="ic ic-${ic}"></span><span>${body}</span></li>`;
  return "<ul class=\"steps\">" + steps.map((s) => {
    switch (s.type) {
      case "board": return li(fmt(s.t), "van", `<b>${sname(s.stop)}</b> で乗る`);
      case "alight": return li(fmt(s.t), "bus-stop", `${sname(s.stop)} で降りる${s.home ? "（家の近く）" : ""}`);
      case "walk": return s.sec > 0 ? li("", "walk", `歩いて ${mins(s.sec)} 分`, "walk") : "";
      case "stay": {
        const sp = s.spot;
        return li(`${fmt(s.t)}〜`, GROUP_ICON[sp.group], `<b>${esc(sp.label)}</b>で ${dur(s.sec)}${sp.name ? `<br><span class="spotname">${esc(sp.name)}</span>` : ""}`, `c-${sp.group}`);
      }
      case "hospital":
        if (s.end) return li(fmt(s.t), "hospital-building", `診察が終わる（見込み）`);
        return li(fmt(s.t), "hospital-building", `<b>${hname(s.h)}</b> に着く` + (s.until - s.t > 5 * 60 ? `<br><span class="spotname">待合室で ${dur(s.until - s.t)} 待つ</span>` : ""));
    }
    return "";
  }).join("") + "</ul>";
}

function goCard(o, i, q) {
  let tag, ttl, note = "";
  if (o.kind === "direct") {
    const g = mins(o.gap);
    tag = g <= 10 ? `<span class="tag safe">ちょうど着く</span>` : `<span class="tag">${dur(o.gap)}早く着く</span>`;
    ttl = g <= 10 ? `病院へまっすぐ。${fmt(o.bus.td + o.bus.walkXH)} に着く` : `病院へまっすぐ。待合室で ${dur(o.gap)} 待つ`;
  } else {
    const G = GROUPS[o.group];
    tag = `<span class="tag ${o.group}"><span class="ic ic-${G.icon}"></span>${G.label}</span>`;
    ttl = `${esc(o.spot.label)}で ${dur(o.stay - 120)} 過ごしてから病院へ`;
  }
  if (!o.withinW) note = `<p class="note warn">1 時間より早く着きます</p>`;
  if (o.kind === "direct" && i === 0 && mins(o.gap) > 10) note += `<p class="note">${breakIn(o.bus.td, q.T) || `${fmt(q.T)} にちょうど着く便は、ほかの予約で埋まっています。`}</p>`;
  return `<button class="opt" data-i="${i}">${tag}<div class="ttl">${ttl}</div>${note}${stepRows(o.steps)}</button>`;
}
function backCard(o, i, q) {
  let tag, ttl, note = "";
  const sl = mins(o.slack);
  const risk = sl < 15 ? `<span class="tag risk">診察がのびると乗り遅れる</span>` : `<span class="tag safe">診察が ${dur(o.slack)} のびても間に合う</span>`;
  if (o.kind === "now") {
    ttl = `終わってすぐ帰る。${fmt(o.bus.tp)} に乗る`;
    tag = `<span class="tag">すぐ帰る</span> ${risk}`;
    if (mins(o.wait) > 10) note = `<p class="note">${breakIn(q.T + q.Dur, o.bus.tp) || "すぐあとの便はほかの予約で埋まっています。"}${dur(o.wait)}待ちます。</p>`;
  } else if (o.kind === "wait") {
    ttl = `余裕をもって ${fmt(o.bus.tp)} に乗る。病院で待つ`;
    tag = risk;
  } else {
    const G = GROUPS[o.group];
    ttl = `${esc(o.spot.label)}で ${dur(o.stay)} 過ごして ${fmt(o.bus.tp)} に乗る`;
    tag = `<span class="tag ${o.group}"><span class="ic ic-${G.icon}"></span>${G.label}</span> ${risk}`;
  }
  return `<button class="opt" data-i="${i}">${tag}<div class="ttl">${ttl}</div>${note}${stepRows(o.steps)}</button>`;
}

// 待ってもよい時間は 1 時間で固定（行きは 1 時間まで早く着いてよい、帰りは 1 時間まで遅らせてよい）
const W_FIXED = 3600;
function search(ev) {
  ev && ev.preventDefault();
  if (S.booked) { S.plans[S.booked.q.g] = S.base[S.booked.q.g]; S.booked = null; $("booked").hidden = true; }
  const o = $("orig").value, h = $("hosp").value, g = S.g;
  const q = { o, h, g, T: +$("arr").value, Dur: +$("dur").value, W: W_FIXED };
  S.q = q;
  q.P = new Planner(S.data, S.eng[g]);
  S.res = [{ W: W_FIXED, go: q.P.outbound(S.base[g], o, h, q.T, W_FIXED) }];
  showW(0);
  fitCoords(S.coords);
}
function showW(k) {
  const q = S.q, r = S.res[k], o = q.o, h = q.h;
  q.W = r.W;
  const go = r.go;
  S.go = go;
  S.goSel = S.backSel = null;
  setView("go");
  $("out-sub").textContent = `${S.data.stops[o].name} → ${S.data.stops[h].name}、${fmt(q.T)} までに着く便です。`;
  if (go.none) {
    const a = go.alt || {};
    $("out-list").innerHTML = `<div class="empty">${fmt(q.T)} に間に合う便は、1 時間前までに着く便の中ではほかの予約で埋まっています。` +
      (a.earlier ? `<br>・<b>${fmt(a.earlier.td)} 着</b>（${dur(q.T - a.earlier.td)}前）の便なら取れます。` : "") +
      (a.later ? `<br>・<b>${fmt(a.later.td)} 着</b>の便なら取れます（病院の予約の時刻を動かせるなら）。` : "") + `</div>`;
    $("to-back").disabled = true;
    drawTrace(); return;
  }
  $("to-back").disabled = false;
  $("out-list").innerHTML = go.opts.map((x, i) => goCard(x, i, q)).join("");
  $("out-list").querySelectorAll(".opt").forEach((b) => b.onclick = () => selectGo(+b.dataset.i));
  const sp = go.opts[0].gap > 20 * 60 ? go.opts.findIndex((x) => x.kind === "spot") : -1;
  selectGo(sp > 0 ? sp : 0);
}
function selectGo(i) {
  if (S.goSel !== S.go.opts[i]) S.backSel = null;   // 行きを変えたら帰りは選び直し
  S.goSel = S.go.opts[i];
  $("out-list").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", +b.dataset.i === i));
  drawTrace();
}
// 帰りの候補（選んだ行きの便を入れた運行に差し込む）
function showBack() {
  const q = S.q, end = q.T + q.Dur;
  const back = q.P.inbound(S.goSel.bus.plan, q.o, q.h, end, q.W);
  const keep = S.backSel && S.back === back;
  S.back = back;
  setView("back");
  $("back-sub").textContent = `診察が ${fmt(end)} ごろに終わる見込みとして、${fmt(end)}〜${fmt(end + q.W)} に出る便をさがしました。`;
  if (back.none) {
    $("back-list").innerHTML = `<div class="empty">この時間帯の帰りの便は、ほかの予約で埋まっています。` +
      (back.next ? `<br>次に取れるのは <b>${fmt(back.next.tp)} 発</b>です。` : `<br>この日はもう取れません。`) + `</div>`;
    S.backSel = null; $("to-all").disabled = true; drawTrace(); return;
  }
  $("to-all").disabled = false;
  $("back-list").innerHTML = back.opts.map((x, k) => backCard(x, k, q)).join("");
  $("back-list").querySelectorAll(".opt").forEach((b) => b.onclick = () => selectBack(+b.dataset.i));
  const safe = back.opts.findIndex((x) => x.kind === "spot" && mins(x.slack) >= 15);
  selectBack(keep ? back.opts.indexOf(S.backSel) : (safe >= 0 ? safe : 0));
  fitCoords(S.coords);
}
function selectBack(i) {
  S.backSel = S.back.opts[i];
  $("back-list").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", +b.dataset.i === i));
  drawTrace();
}
// 経路全体（行き → 病院 → 帰り）
function showAll() {
  const q = S.q, g = S.goSel, b = S.backSel;
  setView("all");
  const stays = [g, b].filter((x) => x.spot).map((x) => `${x === g ? "行き" : "帰り"}: ${esc(x.spot.label)}${x.spot.name ? `（${esc(x.spot.name)}）` : ""}で ${dur(x === g ? x.stay - 120 : x.stay)}`);
  const walk = [...g.steps, ...b.steps].filter((s) => s.type === "walk").reduce((a, s) => a + s.sec, 0);
  $("all-body").innerHTML = `
    <div class="allsum">
      <div class="big">${fmt(g.bus.tp)} ${sname(g.bus.r.p)} で乗る → ${fmt(b.bus.td)} ${sname(b.bus.r.d)} に帰る</div>
      <div>病院 ${hname(q.h)}：${fmt(q.T)} 着の予定、診察は ${fmt(q.T + q.Dur)} ごろまで（見込み）</div>
      <div>帰りの便は、診察が ${dur(b.slack)} のびても間に合います</div>
      <div>寄り道：${stays.length ? stays.join("／") : "なし"}</div>
      <div>歩く：合わせて ${mins(walk)} 分</div>
    </div>
    <div class="leg-h c-me"><span class="ic ic-van"></span>行き</div>
    <div class="alllist">${stepRows(g.steps)}</div>
    <div class="leg-h c-back"><span class="ic ic-home-variant"></span>帰り</div>
    <div class="alllist">${stepRows(b.steps)}</div>
    <p class="sub" style="margin-top:10px">帰りを先に押さえるので、診察のあとに電話して待つ必要がありません。</p>`;
  $("all-foot").hidden = !!S.booked; $("booked").hidden = !S.booked;
  drawTrace();
  fitCoords(S.coords);
}
// 真ん中のペインの切り替え: info（カレンダーと棒グラフ）／go／back／all
function setView(v) {
  S.view = v;
  $("mid-info").hidden = v !== "info"; $("mid-res").hidden = v === "info";
  for (const k of ["go", "back", "all"]) $("v-" + k).hidden = v !== k;
  const n = { go: 0, back: 1, all: 2 }[v];
  const can = [!!S.go, !!S.goSel && !S.go.none, !!(S.goSel && S.backSel)];
  $("stepper").innerHTML = [["go", "1 行きの便"], ["back", "2 帰りの便"], ["all", "3 経路全体"]].map(([k, l], i) =>
    (i ? `<span class="arrow">›</span>` : "") + `<button data-v="${k}" class="${i === n ? "on" : ""}" ${i <= n || can[i] ? "" : "disabled"}>${l}</button>`).join("") +
    `<button class="home" data-v="info">混み具合を見る</button>`;
  $("stepper").querySelectorAll("button").forEach((x) => x.onclick = () => {
    const to = x.dataset.v;
    if (to === "back") showBack(); else if (to === "all") showAll(); else { setView(to); drawTrace(); if (to === "go") fitCoords(S.coords); }
  });
  $("res-body").scrollTop = 0;
}

async function icon(name, fg, bg, size = 44, ring = null) {
  const svg = (await (await fetch(`icons/${name}.svg`)).text()).replace(/currentColor/g, fg).replace(/width="1em" height="1em"/, `width="${size * 0.58}" height="${size * 0.58}"`);
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement("canvas"); c.width = c.height = size;
  const x = c.getContext("2d");
  x.beginPath(); x.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  x.fillStyle = bg; x.fill();
  x.lineWidth = 3; x.strokeStyle = ring || "#fff"; x.stroke();
  x.drawImage(img, size * 0.21, size * 0.21, size * 0.58, size * 0.58);
  return x.getImageData(0, 0, size, size);
}

// 背景地図: OpenFreeMap の positron から、水・公園・道路・鉄道と市町の名前だけを残す
const KEEP = new Set(["background", "park", "water", "waterway",
  "highway_minor", "highway_major_casing", "highway_major_inner", "highway_major_subtle",
  "highway_motorway_casing", "highway_motorway_inner", "highway_motorway_subtle", "railway",
  "label_city", "label_town"]);
async function baseStyle() {
  const st = await (await fetch("https://tiles.openfreemap.org/styles/positron")).json();
  st.layers = st.layers.filter((l) => KEEP.has(l.id)).map((l) => {
    if (l.type === "symbol") {
      l.layout = Object.assign({}, l.layout, { "text-field": ["coalesce", ["get", "name:ja"], ["get", "name"]] });
      l.paint = Object.assign({}, l.paint, { "text-color": "#8a939b", "text-halo-color": "#fff", "text-halo-width": 1.5 });
    }
    if (l.id === "railway") l.paint = Object.assign({}, l.paint, { "line-color": "#c3c8cd", "line-width": 1.2 });
    return l;
  });
  return st;
}

function book() {
  const q = S.q, g = q.g, b = S.backSel;
  S.plans[g] = b.bus.plan;
  const w1 = Engine.District.when(S.plans[g], S.goSel.bus.r), w2 = Engine.District.when(S.plans[g], b.bus.r);
  S.booked = { q, go: S.goSel, back: b, w1, w2 };
  $("all-foot").hidden = true;
  $("booked").hidden = false;
  $("booked-text").innerHTML = `<p><b>予約しました</b>（この画面の中だけの予約です）</p>
    <p>行き ${fmt(w1.tp)} ${sname(S.goSel.bus.r.p)} で乗車 → ${fmt(w1.td)} ${sname(S.goSel.bus.x)}<br>
    帰り ${fmt(w2.tp)} ${sname(b.bus.y)} で乗車 → ${fmt(w2.td)} ${sname(b.bus.r.d)}</p>`;
  $("res-body").scrollTop = 1e6;
}
function cancel() {
  if (S.booked) S.plans[S.booked.q.g] = S.base[S.booked.q.g];
  S.booked = null;
  $("booked").hidden = true; $("all-foot").hidden = false;
}

// ------------------------------------------------------------------ 歩く道（OSRM の徒歩で取った形。なければまっすぐ）
// a, b は乗り場の id か、寄り道の場所（spots の要素）
function walkPath(a, b) {
  const key = (x) => typeof x === "string" ? x : "s" + S.data.spots.indexOf(x);
  const xy = (x) => typeof x === "string" ? [S.data.stops[x].lon, S.data.stops[x].lat] : [x.lon, x.lat];
  const ka = key(a), kb = key(b), enc = S.walk[ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`];
  let pts = enc ? decode(enc) : [];
  if (enc && ka > kb) pts.reverse();
  return [xy(a)].concat(pts, [xy(b)]);
}

// ------------------------------------------------------------------ 地図
let map;
function drawTrace() {
  if (!map || !map.getSource("route")) return;
  const F = [], marks = [];
  const st = S.data.stops, P = (id) => [st[id].lon, st[id].lat];
  const v = S.view || "info", q = S.q;
  const go = v === "go" || v === "all" ? S.goSel : null, back = v === "back" || v === "all" ? S.backSel : null;
  const o = q ? q.o : $("orig").value, h = q ? q.h : $("hosp").value, g = S.g;
  const plan = back ? back.bus.plan : go && go.bus.plan;
  const line = (c, kind, leg) => c.length > 1 && F.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: { kind, leg } });
  const spots = [];
  if (go && plan) {
    line(busPath(g, plan, go.bus.r), "bus", "go");
    const X = P(go.bus.x), H = P(h);
    if (go.spot) { line(walkPath(go.bus.x, go.spot), "walk", "go"); line(walkPath(go.spot, h), "walk", "go"); spots.push(go.spot); }
    else if (go.bus.x !== h) line(walkPath(go.bus.x, h), "walk", "go");
  } else if (v === "info" && S.data.stops[o] && S.data.stops[h]) {
    line(seg(g, o, h).pts, "bus", "pre");   // さがす前: 出発地から病院への道
  }
  if (back && plan) {
    line(busPath(g, plan, back.bus.r), "bus", "back");
    const Y = P(back.bus.y), H = P(h);
    if (back.spot) { line(walkPath(h, back.spot), "walk", "back"); line(walkPath(back.spot, back.bus.y), "walk", "back"); spots.push(back.spot); }
    else if (back.bus.y !== h) line(walkPath(h, back.bus.y), "walk", "back");
  }
  marks.push(pt(P(o), { icon: "pin-home", label: st[o].name }));
  marks.push(pt(P(h), { icon: "pin-hosp", label: hname(h) }));
  for (const s of spots) marks.push(pt([s.lon, s.lat], { icon: "pin-" + s.group, label: s.name || s.label }));
  S.coords = F.flatMap((f) => f.geometry.coordinates).concat(marks.map((m) => m.geometry.coordinates));
  map.getSource("route").setData(fc(F));
  map.getSource("marks").setData(fc(marks));
  legend(v);
}
function fitTo(ids) {
  if (!map) return;
  const st = S.data.stops;
  const xs = ids.map((i) => st[i].lon), ys = ids.map((i) => st[i].lat);
  const pad = mapPad(110);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: pad, maxZoom: 15, duration: 700 });
}
// 地図の上に浮かんでいるペインのぶん、左を空けて合わせる
function mapPad(p) {
  if (window.innerWidth <= 900) return 50;
  const left = parseFloat(getComputedStyle($("mid")).left) + $("mid").offsetWidth;
  return { top: p, bottom: p + 40, left: left + p, right: p };
}
function fitCoords(cs) {
  if (!map || !cs || !cs.length) return;
  const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
  const pad = mapPad(60);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: pad, maxZoom: 15.5, duration: 700 });
}
function legend(v) {
  const walk = (c) => `<span class="ln dash" style="background:repeating-linear-gradient(90deg, ${c} 0 5px, transparent 5px 9px)"></span>`;
  const rows = [];
  if (v === "go" || v === "all") rows.push(`<div><span class="ln" style="background:${ME}"></span>行き（車）　${walk(ME)}歩く</div>`);
  if (v === "back" || v === "all") rows.push(`<div><span class="ln" style="background:${BACK}"></span>帰り（車）　${walk(BACK)}歩く</div>`);
  $("legend").innerHTML = rows.length
    ? rows.join("") + `<div class="sub">白い点・破線が流れる向きが進む向き</div>`
    : `<div><span class="ln" style="background:#495057"></span>出発地から病院への道（車）</div><div class="sub">便をさがすと、行きと帰りの道を出します</div>`;
}
// ピン（丸＋とがり）
async function pin(name, bg) {
  const w = 44, h = 56;
  const svg = (await (await fetch(`icons/${name}.svg`)).text()).replace(/currentColor/g, "#fff").replace(/width="1em" height="1em"/, `width="24" height="24"`);
  const img = new Image(); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); await img.decode();
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.beginPath(); x.moveTo(w / 2, h - 2); x.lineTo(w / 2 - 11, 34); x.lineTo(w / 2 + 11, 34); x.closePath();
  x.arc(w / 2, 21, 19, 0, Math.PI * 2);
  x.fillStyle = bg; x.fill(); x.lineWidth = 2.5; x.strokeStyle = "#fff"; x.stroke();
  x.beginPath(); x.arc(w / 2, 21, 16.5, 0, Math.PI * 2); x.fillStyle = bg; x.fill();
  x.drawImage(img, w / 2 - 12, 9, 24, 24);
  return x.getImageData(0, 0, w, h);
}
async function initMap() {
  const d = S.data;
  map = new maplibregl.Map({
    container: "map", style: await baseStyle(), center: [139.44, 35.9], zoom: 12,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution:
    `データ: <a href="https://ckan.odpt.org/" target="_blank" rel="noopener">公共交通オープンデータセンター</a>（CC BY 4.0）／<a href="about.html">出典の詳細</a>` }), "bottom-right");
  await new Promise((r) => map.on("load", r));
  map.addImage("pin-home", await pin("home-variant", "#343a40"));
  map.addImage("pin-hosp", await pin("hospital-building", "#c92a2a"));
  for (const g of Object.keys(GROUP_ICON)) map.addImage("pin-" + g, await pin(GROUP_ICON[g], GROUP_COLOR[g]));
  map.addImage("hosp", await icon("hospital-building", "#fff", "#e03131", 30));
  for (const s of d.spots) if (!map.hasImage("k-" + s.kind)) map.addImage("k-" + s.kind, await icon(KIND_ICON[s.kind] || "map-marker", "#fff", GROUP_COLOR[s.group], 30));

  map.addSource("hull", { type: "geojson", data: fc(Object.entries(d.districts).map(([g, x]) =>
    ({ type: "Feature", geometry: { type: "Polygon", coordinates: [x.hull] }, properties: { g, color: COLORS[g] } }))) });
  map.addLayer({ id: "hull-l", type: "line", source: "hull", filter: ["==", ["get", "g"], S.g],
    paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.6 } });

  // 寄り道のスポット・病院（表示を切り替えられる）
  map.addSource("spots", { type: "geojson", data: fc(d.spots.map((s) => pt([s.lon, s.lat], { icon: "k-" + s.kind, name: s.name || s.label }))) });
  map.addLayer({ id: "spots", type: "symbol", source: "spots", layout: {
    "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.45, 16, 0.8], "icon-allow-overlap": true,
    "text-field": ["step", ["zoom"], "", 15.5, ["get", "name"]], "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-font": ["Noto Sans Regular"], "text-optional": true },
    paint: { "text-color": "#495057", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  map.addSource("hosps", { type: "geojson", data: fc(d.hospitals.map((x) => pt([d.stops[x.id].lon, d.stops[x.id].lat], { name: x.name }))) });
  map.addLayer({ id: "hosps", type: "symbol", source: "hosps", layout: {
    "icon-image": "hosp", "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 0.85], "icon-allow-overlap": true,
    "text-field": ["step", ["zoom"], "", 13.5, ["get", "name"]], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"], "text-optional": true },
    paint: { "text-color": "#c92a2a", "text-halo-color": "#fff", "text-halo-width": 1.4 } });

  // 経路（線の上を白い点が流れて向きを示す）
  map.addSource("route", { type: "geojson", data: fc([]) });
  const legColor = ["match", ["get", "leg"], "go", ME, "back", BACK, "#495057"];
  map.addLayer({ id: "route-bus", type: "line", source: "route", filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": legColor, "line-width": 6, "line-offset": ["match", ["get", "leg"], "pre", 0, 3.5], "line-opacity": 0.9 } });
  map.addLayer({ id: "route-walk", type: "line", source: "route", filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": legColor, "line-width": 4, "line-offset": ["match", ["get", "leg"], "back", 8, 3], "line-dasharray": [1.5, 1.5] } });
  map.addLayer({ id: "route-ants", type: "line", source: "route", filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: { "line-color": "#fff", "line-width": 2.5, "line-offset": ["match", ["get", "leg"], "pre", 0, 3.5], "line-dasharray": [0, 4, 3] } });

  map.addSource("marks", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "marks", type: "symbol", source: "marks", layout: {
    "icon-image": ["get", "icon"], "icon-anchor": "bottom", "icon-size": 0.85, "icon-allow-overlap": true,
    "text-field": ["get", "label"], "text-size": 12, "text-anchor": "top", "text-offset": [0, 0.3], "text-font": ["Noto Sans Bold"], "text-allow-overlap": false, "text-optional": true },
    paint: { "text-color": "#212529", "text-halo-color": "#fff", "text-halo-width": 1.8 } });

  $("ly-spots").onchange = (e) => map.setLayoutProperty("spots", "visibility", e.target.checked ? "visible" : "none");
  $("ly-hosps").onchange = (e) => map.setLayoutProperty("hosps", "visibility", e.target.checked ? "visible" : "none");

  // 白い点を流す（MapLibre の線の破線をずらしていく）
  const SEQ = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
    [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
  // 歩く道は破線そのものを流す（長さ 1.5 の線と 1.5 のすき間を、少しずつ先へずらす）
  const D = 1.5, G = 1.5, L = D + G;
  const WSEQ = SEQ.map((_, i) => {
    const f = (i / SEQ.length) * L;
    return f < G ? [0, f, D, G - f] : [f - G, G, L - f, 0];
  });
  let k = -1;
  const ants = (ts) => {
    const n = Math.floor(ts / 70) % SEQ.length;
    if (n !== k) { k = n; map.setPaintProperty("route-ants", "line-dasharray", SEQ[n]); map.setPaintProperty("route-walk", "line-dasharray", WSEQ[n]); }
    requestAnimationFrame(ants);
  };
  requestAnimationFrame(ants);
}

async function main() {
  S.data = await (await fetch("data/kawagoe.json")).json();
  const gs = Object.keys(S.data.districts);
  const gg = await Promise.all(gs.map((g) => fetch(`data/geom_${g}.json`).then((r) => r.ok ? r.json() : {}).catch(() => ({}))));
  gs.forEach((g, i) => S.geom[g] = gg[i]);
  S.walk = await fetch("data/walk.json").then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  fillForm();
  $("cal-prev").onclick = () => { const ms = [...new Set(S.data.days.map((x) => x.date.slice(0, 6)))]; S.cal = ms[Math.max(0, ms.indexOf(S.cal) - 1)]; renderCal(); };
  $("cal-next").onclick = () => { const ms = [...new Set(S.data.days.map((x) => x.date.slice(0, 6)))]; S.cal = ms[Math.min(ms.length - 1, ms.indexOf(S.cal) + 1)]; renderCal(); };
  loadDay();
  renderMid();
  await initMap();
  drawTrace();
  fitTo([$("orig").value, $("hosp").value]);
  $("form").onsubmit = search;
  $("book").onclick = book;
  $("to-back").onclick = showBack;
  $("to-all").onclick = showAll;
  $("reset").onclick = cancel;
  window.S = S; window.map = map; window.READY = true;
}
main();
