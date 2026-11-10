// 画面: 上にヘッダ。左＝条件（行き／帰り・地区・出発地・目的地・日付・時刻）、その右＝候補、背景＝地図
const { District } = Engine;
const { GROUPS } = Plan;
const { Trip, PLAT } = TripPlan;

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
const HOLIDAYS = new Set(["20260720"]);

const S = {
  data: null, med: null, rail: null, walk: { p: {}, c: {} }, geom: {}, line: new Map(), eng: {}, base: {}, stats: {},
  dir: "go", g: "2", stop: "", hosp: "", di: -1, T: null, res: null, sel: null, view: "form",
};
const day = () => S.data.days[S.di];
const jdate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${y}年${m}月${d}日`; };
const medOf = (id) => S.med.list.find((x) => x.id === id);
let trip;

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
  const key = g + a + ">" + b;
  if (S.line.has(key)) return S.line.get(key);
  const st = S.data.stops;
  let pts = null;
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  const enc = S.geom[g] && S.geom[g][k];
  if (enc) { pts = decode(enc); if (a > b) pts.reverse(); }
  if (!pts || pts.length < 2) pts = [[st[a].lon, st[a].lat], [st[b].lon, st[b].lat]];
  pts[0] = [st[a].lon, st[a].lat]; pts[pts.length - 1] = [st[b].lon, st[b].lat];
  const o = { pts };
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
// 歩く道（OSRM の徒歩で取った形。なければまっすぐ）
const xy = (k) => { const p = trip.pos(k); return [p.lon, p.lat]; };
function walkPath(a, b) {
  const w = S.walk.p[a < b ? `${a}|${b}` : `${b}|${a}`];
  let pts = w ? decode(w[0]) : [];
  if (w && a > b) pts.reverse();
  return [xy(a)].concat(pts, [xy(b)]);
}
function railPath(i, j) {
  const p = S.rail.paths[i < j ? `${i}|${j}` : `${j}|${i}`];
  const st = S.rail.stations;
  if (!p) return [[st[i].lon, st[i].lat], [st[j].lon, st[j].lat]];
  return i < j ? p : p.slice().reverse();
}
const pt = (c, p = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: p });
const fc = (f) => ({ type: "FeatureCollection", features: f });

// 寄り道のスポットの地区: 地区の範囲の中ならその地区、外ならいちばん近いバス停の地区
function inside([x, y], poly) {
  let c = false;
  for (let i = 0; i < poly.length - 1; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
function spotDistrict(s) {
  for (const [g, d] of Object.entries(S.data.districts)) if (inside([s.lon, s.lat], d.hull)) return g;
  let best = null, bd = Infinity;
  for (const [g, d] of Object.entries(S.data.districts)) for (const id of d.stops) {
    const p = S.data.stops[id], dd = (p.lon - s.lon) ** 2 + (p.lat - s.lat) ** 2;
    if (dd < bd) { bd = dd; best = g; }
  }
  return best;
}

// ------------------------------------------------------------------ 運行日（実績の予約を配車の計算で受け付け直す。3 地区とも）
function loadDay() {
  const d = day();
  for (const g of Object.keys(S.data.districts)) {
    S.eng[g] = new District(S.data, g);
    S.base[g] = S.eng[g].replay(d.reqs[g]).plan;
  }
  trip.setDay(d, S.eng, S.base);
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
function winCount(b, a) {
  let n = 0;
  for (let k = 0; k < NB; k++) { const t = T0 + k * BIN; if (t >= a && t < a + 3600) n += b[k]; }
  return n;
}
// 行きは着く時刻の前の 1 時間、帰りは出る時刻からの 1 時間
const winStart = (T) => S.dir === "go" ? T - 3600 : T;

// ------------------------------------------------------------------ 吹き出し（日付のカレンダー・時刻の棒グラフ）
function openPop(kind) {
  const anchor = $(kind);
  $("pop").hidden = false;
  $("pop").dataset.kind = kind;
  if (kind === "date") renderCal(); else renderChart();
  const pane = $("pane"), r = anchor.getBoundingClientRect(), app = document.querySelector(".app").getBoundingClientRect();
  if (window.innerWidth > 900) {
    $("pop").style.left = (pane.offsetLeft + pane.offsetWidth + 10) + "px";
    $("pop").style.top = Math.max(12, Math.min(r.top - app.top - 40, app.height - $("pop").offsetHeight - 12)) + "px";
  } else { $("pop").style.left = ""; $("pop").style.top = ""; }
}
function closePop() { $("pop").hidden = true; }

function renderCal() {
  const st = stats(S.g), byDate = new Map(S.data.days.map((x, i) => [x.date, i]));
  const ym = S.data.days[0].date.slice(0, 6), y = +ym.slice(0, 4), m = +ym.slice(4, 6);
  $("pop-title").textContent = `日付をえらぶ（${S.data.districts[S.g].name}の混み具合）`;
  const first = new Date(y, m - 1, 1), nd = new Date(y, m, 0).getDate(), lead = (first.getDay() + 6) % 7;
  let h = WD.split("").map((w, i) => `<span class="wd${i >= 5 ? " we" : ""}">${w}</span>`).join("");
  for (let i = 0; i < lead; i++) h += `<span></span>`;
  for (let dd = 1; dd <= nd; dd++) {
    const key = `${ym}${String(dd).padStart(2, "0")}`, idx = byDate.get(key);
    if (idx === undefined) { h += `<span class="day off" title="運行の記録なし">${dd}</span>`; continue; }
    const l = level(st.tot[key], st.day.Q);
    const hol = HOLIDAYS.has(key) ? " hol" : "";
    h += `<button type="button" class="day${idx === S.di ? " sel" : ""}${hol}" data-i="${idx}" style="background:${LV[l].c};color:${LV[l].ink}" title="${m}/${dd} 予約 ${st.tot[key]} 人・${LV[l].t}">${dd}</button>`;
  }
  $("pop-body").innerHTML = `<div class="cal-title">${y}年${m}月</div><div class="cal">${h}</div>
    <div class="scale">${LV.map((x) => `<span><i style="background:${x.c}"></i>${x.t}</span>`).join("")}</div>
    <p class="note">色は、その日に${S.data.districts[S.g].name}のかわまるに乗った人の数（実績）。この月の中で多いか少ないかを 4 段階で出しています。</p>`;
  $("pop-body").querySelectorAll("button.day").forEach((b) => b.onclick = () => { setDate(+b.dataset.i); closePop(); });
}
function timeChoices() {
  const out = [];
  if (S.dir === "go") for (let t = 8.5 * 3600; t <= 17.5 * 3600; t += 1800) out.push(t);
  else for (let t = 8 * 3600; t <= 17 * 3600; t += 1800) out.push(t);
  return out;
}
function renderChart() {
  const go = S.dir === "go";
  $("pop-title").textContent = go ? "病院に着きたい時刻をえらぶ" : "病院を出る時刻をえらぶ";
  if (S.di < 0) { $("pop-body").innerHTML = `<p class="note big">先に日付をえらんでください。</p>`; return; }
  const st = stats(S.g), d = day(), b = st.bins[d.date];
  const brk = S.data.service.breaks.map(([x, y]) => [Engine.hm(x), Engine.hm(y)]);
  const max = Math.max(6, ...b);
  const T = S.T;
  const inW = (t) => T != null && t >= winStart(T) && t < winStart(T) + 3600;
  let bars = "";
  for (let k = 0; k < NB; k++) {
    const t = T0 + k * BIN, isBrk = brk.some(([x, y]) => t >= x && t < y);
    bars += `<i class="${isBrk ? "brk" : ""}${!isBrk && inW(t) ? " hl" : ""}" style="height:${(b[k] / max) * 100}%" title="${fmt(t)}〜 ${isBrk ? "休憩" : b[k] + "人"}"></i>`;
  }
  const pc = (t) => ((t - T0) / (T1 - T0)) * 100;
  const btns = timeChoices().map((t) => {
    const l = level(winCount(b, winStart(t)), st.win.Q);
    return `<button type="button" class="tbtn${t === T ? " sel" : ""}" data-t="${t}" style="--lv:${LV[l].c};--ink:${LV[l].ink}">${fmt(t)}</button>`;
  }).join("");
  let verdict = "";
  if (T != null) {
    const a = winStart(T), n = winCount(b, a), l = level(n, st.win.Q);
    verdict = `<div class="verdict">${go ? `${fmt(T)} に着く便` : `${fmt(T)} から乗る便`} ${chip(l)}<span class="vsub">${fmt(a)}〜${fmt(a + 3600)} に乗る人 ${n} 人</span></div>`;
  }
  $("pop-body").innerHTML = `
    <div class="dayline">${+d.date.slice(4, 6)}月${+d.date.slice(6)}日（${d.wd}）・${S.data.districts[S.g].name}</div>
    ${verdict}
    <div class="chart"><div class="plot"><div class="bars">${bars}</div></div>
      <div class="axis">${[8, 10, 12, 14, 16, 18].map((h) => `<span style="left:${pc(h * 3600)}%">${h}時</span>`).join("")}</div></div>
    <div class="tbtns">${btns}</div>
    <p class="note">棒は、この日の 30 分ごとに乗った人の数（実績）。しま模様は運転手の休憩。ボタンの色は、${go ? "着く時刻の前の 1 時間" : "出る時刻からの 1 時間"}の混み具合です。</p>`;
  $("pop-body").querySelectorAll(".tbtn").forEach((x) => x.onclick = () => { S.T = +x.dataset.t; renderChart(); syncForm(); clearResults(); setTimeout(closePop, 250); });
}

// ------------------------------------------------------------------ 左のペイン
const stopName = (id) => (S.data.stops[id] || {}).name || id;
function stopsOf(g) {
  return S.data.districts[g].stops.slice().sort((a, b) => stopName(a).localeCompare(stopName(b), "ja"));
}
function stopOptions() {
  return `<option value="">バス停をえらぶ</option>` + stopsOf(S.g).map((s) => `<option value="${s}">${esc(stopName(s))}</option>`).join("");
}
function hospOptions() {
  return `<option value="">病院・診療所をえらぶ</option>` + S.med.list.filter((h) => h.g === S.g).map((h) =>
    `<option value="${h.id}">${esc(h.name)}${h.kind === "病院" ? "（病院）" : ""}</option>`).join("");
}
function syncForm() {
  const go = S.dir === "go";
  $("pane").classList.toggle("go", go); $("pane").classList.toggle("back", !go);
  document.querySelector(".app").classList.toggle("back", !go);
  $("dir").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", b.dataset.d === S.dir));
  $("lab-from").textContent = go ? "出発地（バス停）" : "出発地（病院）";
  $("lab-to").textContent = go ? "目的地（病院）" : "目的地（バス停）";
  $("lab-time").textContent = go ? "病院に着きたい時刻" : "病院を出る時刻";
  const stopSel = go ? $("from") : $("to"), hospSel = go ? $("to") : $("from");
  stopSel.innerHTML = stopOptions(); hospSel.innerHTML = hospOptions();
  stopSel.value = S.stop; hospSel.value = S.hosp;
  stopSel.onchange = () => { S.stop = stopSel.value; clearResults(); focusSel(); };
  hospSel.onchange = () => { S.hosp = hospSel.value; clearResults(); focusSel(); };
  const d = S.di >= 0 ? day() : null;
  $("date").textContent = d ? `${+d.date.slice(4, 6)}月${+d.date.slice(6)}日（${d.wd}）` : "えらぶ";
  $("date").classList.toggle("empty", !d);
  $("time").textContent = S.T != null ? fmt(S.T) : "えらぶ";
  $("time").classList.toggle("empty", S.T == null);
  $("go").disabled = !(S.stop && S.hosp && S.di >= 0 && S.T != null);
}
function setDir(d) {
  if (d === S.dir) return;
  S.dir = d;
  if (S.T != null && !timeChoices().includes(S.T)) S.T = null;
  syncForm(); clearResults(); closePop();
}
function setDistrict(g) {
  if (g === S.g) return;
  S.g = g; S.stop = "";
  if (S.hosp && medOf(S.hosp).g !== g) S.hosp = "";
  $("dist").value = g;
  syncForm(); clearResults();
  filterMap();
  if (!$("pop").hidden) openPop($("pop").dataset.kind);
  const ids = S.data.districts[g].stops, st = S.data.stops;
  fitCoords(ids.map((s) => [st[s].lon, st[s].lat]));
}
// 地図は選んだ地区のバス停・病院・寄り道のスポットだけ
function filterMap() {
  if (!map) return;
  if (popup) popup.remove();
  const f = ["==", ["get", "g"], S.g];
  for (const id of ["hull-l", "stops", "hosps", "spots"]) map.setFilter(id, f);
}
function setDate(i) {
  S.di = i;
  loadDay(); syncForm(); clearResults();
}
function setStop(id) {
  const g = trip.stopG(id);
  if (g !== S.g) return;   // ほかの地区のバス停は選べない
  S.stop = id; syncForm(); clearResults(); focusSel();
}
function setHosp(id) { S.hosp = id; syncForm(); clearResults(); focusSel(); }
function focusSel() {
  const cs = [];
  if (S.stop) cs.push(xy(S.stop));
  if (S.hosp) cs.push(xy("h" + S.hosp));
  if (cs.length) fitCoords(cs, cs.length === 1 ? 15 : 15);
}

// ------------------------------------------------------------------ 候補
function clearResults() {
  S.res = S.sel = null;
  setView("form");
  drawTrace();
}
function placeName(k) {
  if (!k) return "";
  if (k[0] === "h") return medOf(k.slice(1)).name;
  if (k[0] === "s") { const s = S.data.spots[+k.slice(1)]; return s.name || s.label; }
  return stopName(k);
}
const stName = (i) => S.rail.stations[i].name;

function search(ev) {
  ev && ev.preventDefault();
  closePop();
  const r = S.dir === "go" ? trip.go(S.stop, S.hosp, S.T) : trip.back(S.hosp, S.stop, S.T);
  S.res = r;
  setView("list");
  const H = medOf(S.hosp), go = S.dir === "go";
  $("list-title").innerHTML = go ? `<span class="ic ic-hospital-building"></span>行きの経路をえらぶ` : `<span class="ic ic-home-variant"></span>帰りの経路をえらぶ`;
  $("list-sub").textContent = go ? `${stopName(S.stop)} → ${H.name}、${fmt(S.T)} までに着く経路です。`
    : `${H.name} → ${stopName(S.stop)}、${fmt(S.T)} に病院を出る経路です。`;
  const notes = [];
  const hn = hospNote(H);
  if (hn) notes.push(`<p class="note-card warn"><span class="ic ic-information-outline"></span>${hn}</p>`);
  if (r.mode === "rail") notes.push(`<p class="note-card"><span class="ic ic-train"></span>${esc(H.name)}は${S.data.districts[H.g].name}にあり、${S.data.districts[r.g].name}のかわまるでは行けません（地区をまたいで乗れません）。電車と組み合わせます。</p>`);
  if (r.none) notes.push(`<p class="note-card bad">${noneText(r, H)}</p>`);
  $("notes").innerHTML = notes.join("");
  $("list").innerHTML = r.opts.map((o, i) => card(o, i)).join("");
  $("list").querySelectorAll(".opt").forEach((b) => b.onclick = () => select(+b.dataset.i));
  const first = r.opts.findIndex((o) => o.kind !== "walkonly");
  const sp = r.opts.findIndex((o) => o.kind === "spot");
  const big = first >= 0 && (r.opts[first].gap || 0) > 20 * 60;
  select(big && sp >= 0 ? sp : Math.max(0, first));
  fitCoords(S.coords);
}
function noneText(r, H) {
  const by = r.mode === "rail" ? "デマンドバスと電車" : "デマンドバス";
  if (r.reason === "noStop") return `${esc(H.name)}のまわり ${r.mode === "rail" ? "800m に、かわまるのバス停も駅もありません" : "800m に、かわまるのバス停がありません"}。${by}では行けないので、${r.opts.some((o) => o.kind === "taxi") ? "タクシー" : "歩き"}をおすすめします。`;
  return `${S.dir === "go" ? `${fmt(r.T)} に間に合う` : `${fmt(r.T)} から 1 時間のあいだに乗れる`}${by}の便は、ほかの予約で埋まっています。${r.opts.some((o) => o.kind === "taxi") ? "タクシー" : "歩き"}か、時刻を変えてさがしてください。`;
}
// 医療情報ネットの休診日・外来受付時間とくらべる
function hospNote(H) {
  const d = day(), dt = +d.date.slice(6), w = WD.indexOf(d.wd), nth = Math.ceil(dt / 7);
  const key = HOLIDAYS.has(d.date) ? "祝" : d.wd;
  const slots = H.rc[key] || H.sh[key] || [];
  const closed = HOLIDAYS.has(d.date) ? H.hol === "0" : (H.ow[w] === "0" || H.wk[(nth - 1) * 7 + w] === "0" || !slots.length);
  const md = `${+d.date.slice(4, 6)}月${dt}日（${d.wd}${HOLIDAYS.has(d.date) ? "・祝" : ""}）`;
  if (closed) return `医療情報ネットでは、${esc(H.name)}は${md}は休診です。`;
  if (S.dir !== "go") return "";
  const hm = (s) => Engine.hm(s);
  const ok = slots.some(([a, b]) => S.T >= hm(a) - 30 * 60 && S.T <= hm(b));
  const lab = H.rc[key] ? "外来受付" : "診療時間";
  if (!ok) return `${fmt(S.T)} は${esc(H.name)}の${lab}（${slots.map(([a, b]) => `${a}〜${b}`).join("、")}）の外です。`;
  return "";
}

function stepRows(steps) {
  const li = (tm, ic, body, cls = "") => `<li class="${cls}"><span class="tm">${tm}</span><span class="ic ic-${ic}"></span><span>${body}</span></li>`;
  return "<ul class=\"steps\">" + steps.map((s) => {
    switch (s.type) {
      case "start": return li(fmt(s.t), s.place[0] === "h" ? "hospital-building" : "bus-stop", `<b>${esc(placeName(s.place))}</b> を出る`);
      case "goal": return li(fmt(s.t), s.place[0] === "h" ? "hospital-building" : "home-variant", `<b>${esc(placeName(s.place))}</b> に着く`);
      case "board": return li(fmt(s.t), "van", `<b>${esc(stopName(s.stop))}</b> でかわまるに乗る`);
      case "alight": return li(fmt(s.t), "bus-stop", `${esc(stopName(s.stop))} で降りる`);
      case "walk": return s.sec > 0 ? li("", "walk", `歩いて ${mins(s.sec)} 分`, "walk") : "";
      case "taxi": return li("", "taxi", `タクシーで約 ${mins(s.sec)} 分（約 ${s.km.toFixed(1)}km）`, "walk");
      case "waitstop": return s.sec > 5 * 60 ? li("", "clock-outline", `乗り場で ${dur(s.sec)} 待つ`, "walk") : "";
      case "station": return li(fmt(s.t), "train", `${esc(stName(s.st))}へ（改札・ホームまで約 ${mins(s.sec)} 分）`);
      case "train": return li(fmt(s.t), "train", `<b style="color:${s.color}">${esc(s.lineName)}</b> ${esc(s.ttype)}・${esc(s.dest)}行き<br><span class="spotname">${esc(stName(s.from))} → ${esc(stName(s.to))}（${fmt(s.t1)} 着）</span>`, "train");
      case "transfer": return li("", "walk", `川越駅で乗り換え（約 ${mins(s.sec)} 分）`, "walk");
      case "exit": return li(fmt(s.t), "train", `${esc(stName(s.st))} で降りる`);
      case "stay": {
        const sp = s.spot;
        return li(`${fmt(s.t)}〜`, GROUP_ICON[sp.group], `<b>${esc(sp.label)}</b>で ${dur(s.sec)}${sp.name ? `<br><span class="spotname">${esc(sp.name)}</span>` : ""}`, `c-${sp.group}`);
      }
      case "hospital": return li(fmt(s.t), "hospital-building", `<b>${esc(medOf(s.h).name)}</b> に着く` + (s.until - s.t > 5 * 60 ? `<br><span class="spotname">待合室で ${dur(s.until - s.t)} 待つ</span>` : ""));
      case "hospout": return li(fmt(s.t), "hospital-building", `<b>${esc(medOf(s.h).name)}</b> を出る`);
    }
    return "";
  }).join("") + "</ul>";
}
function card(o, i) {
  const go = S.dir === "go";
  let tag = "", ttl = "", note = "";
  const where = o.at === "station" ? `${stName(o.station)}のまわり` : go ? "病院のまわり" : "病院のまわり";
  switch (o.kind) {
    case "direct":
      if (go) {
        const g = mins(o.gap);
        tag = g <= 10 ? `<span class="tag safe">ちょうど着く</span>` : `<span class="tag">${dur(o.gap)}早く着く</span>`;
        ttl = g <= 10 ? `病院へまっすぐ` : `病院へまっすぐ。待合室で ${dur(o.gap)} 待つ`;
        if (g > 10) note = `<p class="note">${fmt(S.T)} にちょうど着く便は、ほかの予約で埋まっています。</p>`;
      } else {
        const g = mins(o.gap);
        tag = g <= 10 ? `<span class="tag safe">すぐ乗れる</span>` : `<span class="tag">${dur(o.gap)}待つ</span>`;
        ttl = g <= 10 ? `病院を出てすぐ乗る` : `乗り場で ${dur(o.gap)} 待って乗る`;
        if (g > 10) note = `<p class="note">すぐあとの便は、ほかの予約で埋まっています。</p>`;
      }
      break;
    case "rail": {
      const tr = o.steps.filter((s) => s.type === "train");
      tag = `<span class="tag rail"><span class="ic ic-train"></span>電車を使う</span>`;
      ttl = `${tr.map((t) => esc(t.lineName)).filter((v, k, a) => a.indexOf(v) === k).join("・")}で ${esc(stName(tr[0].from))} → ${esc(stName(tr[tr.length - 1].to))}`;
      if (mins(o.gap) > 10) note = `<p class="note">${go ? `駅で電車を ${dur(o.gap)} 待ちます。ちょうど電車に乗れる便は、ほかの予約で埋まっています。` : `駅でかわまるを ${dur(o.gap)} 待ちます。電車を降りてすぐの便は、ほかの予約で埋まっています。`}</p>`;
      break;
    }
    case "spot": {
      const G = GROUPS[o.group];
      tag = `<span class="tag ${o.group}"><span class="ic ic-${G.icon}"></span>${G.label}</span>` + (o.rail ? ` <span class="tag rail"><span class="ic ic-train"></span>電車</span>` : "");
      ttl = `${where}の${esc(o.spot.s.label)}で ${dur(o.stay)} 過ごす`;
      break;
    }
    case "walkonly":
      tag = `<span class="tag safe"><span class="ic ic-walk"></span>歩いて行ける</span>`;
      ttl = `歩いて約 ${mins(o.sec)} 分（約 ${Math.round(o.m / 10) * 10}m）`;
      break;
    case "walkfar":
      tag = `<span class="tag risk"><span class="ic ic-walk"></span>歩く</span>`;
      ttl = `歩いて約 ${mins(o.sec)} 分（約 ${(o.m / 1000).toFixed(1)}km）`;
      note = `<p class="note">少し遠いので、無理のないように。</p>`;
      break;
    case "taxi":
      tag = `<span class="tag risk"><span class="ic ic-taxi"></span>タクシー</span>`;
      ttl = `タクシーで約 ${mins(o.sec)} 分（約 ${o.km.toFixed(1)}km）`;
      note = `<p class="note">時間と距離は目安です。料金はタクシー会社に確かめてください。</p>`;
      break;
  }
  return `<button class="opt ${o.kind}" data-i="${i}">${tag}<div class="ttl">${ttl}</div>${note}${stepRows(o.steps)}</button>`;
}
function select(i) {
  S.sel = S.res.opts[i];
  $("list").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", +b.dataset.i === i));
  drawTrace();
}

// 経路全体を、乗換案内の結果のような縦の時系列で出す
function routeItems(o) {
  const items = [];
  const node = (key, x) => {
    const last = items[items.length - 1];
    if (last && last.kind === "node" && last.key === key) {
      if (x.dep != null) last.dep = x.dep;
      if (last.arr == null && x.arr != null) last.arr = x.arr;
      last.subs.push(...(x.subs || []));
      last.tags = [...new Set([...last.tags, ...(x.tags || [])])];
      return last;
    }
    const n = Object.assign({ kind: "node", key, subs: [], tags: [], arr: null, dep: null }, x);
    items.push(n); return n;
  };
  const color = S.dir === "go" ? ME : BACK;
  let board = null;
  for (const s of o.steps) {
    switch (s.type) {
      case "start": node(s.place, { name: placeName(s.place), dep: s.t, type: s.place[0] === "h" ? "hosp" : "stop" }); break;
      case "goal": node(s.place, { name: placeName(s.place), arr: s.t, type: s.place[0] === "h" ? "hosp" : "stop" }); break;
      case "board": node(s.stop, { name: stopName(s.stop), dep: s.t, tags: ["乗車"], type: "stop" }); board = s; break;
      case "alight":
        items.push({ kind: "seg", mode: "bus", color, t0: board.t, t1: s.t, g: board.g });
        node(s.stop, { name: stopName(s.stop), arr: s.t, tags: ["降車"], type: "stop" }); break;
      case "waitstop": if (s.sec > 5 * 60) node(s.stop, { name: stopName(s.stop), arr: s.t, type: "stop", subs: [`乗り場で ${dur(s.sec)} 待つ`] }); break;
      case "walk": if (s.sec > 0) items.push({ kind: "seg", mode: "walk", color, sec: s.sec }); break;
      case "taxi": items.push({ kind: "seg", mode: "taxi", color: "#495057", sec: s.sec, km: s.km }); break;
      case "station": items.push({ kind: "seg", mode: "walk", color, sec: s.sec, label: "駅の改札・ホームへ" }); break;
      case "exit": items.push({ kind: "seg", mode: "walk", color, sec: PLAT, label: "改札を出る" }); break;
      case "transfer": items.push({ kind: "seg", mode: "walk", color, sec: s.sec, label: "川越駅で JR と東武を乗り換え" }); break;
      case "train":
        node("st" + s.from, { name: stName(s.from), dep: s.t, tags: ["乗車"], type: "station" });
        items.push({ kind: "seg", mode: "train", color: s.color, t0: s.t, t1: s.t1, s });
        node("st" + s.to, { name: stName(s.to), arr: s.t1, tags: ["降車"], type: "station" });
        break;
      case "stay": {
        const sp = s.spot;
        node(s.key, { name: sp.name || sp.label, arr: s.t, dep: s.t + s.sec, type: "spot", group: sp.group, tags: ["寄り道"],
          subs: [`<span class="c-${sp.group}"><span class="ic ic-${GROUP_ICON[sp.group]}"></span>${esc(sp.label)}で ${dur(s.sec)} 過ごす</span>`] });
        break;
      }
      case "hospital":
        node("h" + s.h, { name: medOf(s.h).name, arr: s.t, type: "hosp", tags: ["病院"], subs: s.until - s.t > 5 * 60 ? [`待合室で ${dur(s.until - s.t)} 待つ`] : [] }); break;
      case "hospout": node("h" + s.h, { name: medOf(s.h).name, dep: s.t, type: "hosp", tags: ["病院"] }); break;
    }
  }
  return items;
}
function showAll() {
  const o = S.sel;
  setView("all");
  const items = routeItems(o);
  const walk = items.filter((x) => x.mode === "walk" && !x.label).reduce((a, x) => a + x.sec, 0);
  const nBus = items.filter((x) => x.mode === "bus").length, nTr = items.filter((x) => x.mode === "train").length;
  const nSpot = items.filter((x) => x.type === "spot").length;
  const row = (x, i) => {
    if (x.kind === "seg") {
      if (x.mode === "bus") return `<div class="rt-seg bus"><div class="rt-t"></div><div class="rt-rail"><i style="background:${x.color}"></i></div>
        <div class="rt-body"><div class="rt-mode" style="color:${x.color}"><span class="ic ic-van"></span>デマンドバス かわまる ${esc(S.data.districts[x.g].name)}</div>
        <div class="rt-mt">${fmt(x.t0)} 発 → ${fmt(x.t1)} 着（${mins(x.t1 - x.t0)}分）・予約して乗る</div></div></div>`;
      if (x.mode === "train") return `<div class="rt-seg train"><div class="rt-t"></div><div class="rt-rail"><i style="background:${x.color}"></i></div>
        <div class="rt-body"><div class="rt-mode" style="color:${x.color}"><span class="ic ic-train"></span>${esc(x.s.lineName)} ${esc(x.s.ttype)}・${esc(x.s.dest)}行き</div>
        <div class="rt-mt">${fmt(x.t0)} 発 → ${fmt(x.t1)} 着（${mins(x.t1 - x.t0)}分）</div></div></div>`;
      if (x.mode === "taxi") return `<div class="rt-seg bus"><div class="rt-t"></div><div class="rt-rail"><i style="background:${x.color}"></i></div>
        <div class="rt-body"><div class="rt-mode"><span class="ic ic-taxi"></span>タクシー 約 ${mins(x.sec)}分（約 ${x.km.toFixed(1)}km・目安）</div></div></div>`;
      return `<div class="rt-seg walk"><div class="rt-t"></div><div class="rt-rail"><i style="border-color:${x.color}"></i></div>
        <div class="rt-body"><div class="rt-mode walk"><span class="ic ic-walk"></span>${x.label ? esc(x.label) + " 約" : "徒歩"} ${mins(x.sec)}分</div></div></div>`;
    }
    const end = i === 0 || i === items.length - 1;
    const ic = x.type === "hosp" ? "hospital-building" : x.type === "spot" ? GROUP_ICON[x.group] : x.type === "station" ? "train" : end ? "home-variant" : "bus-stop";
    const times = [x.arr != null ? `<b>${fmt(x.arr)}</b>` : "", x.dep != null && x.dep !== x.arr ? `<span>${fmt(x.dep)}</span>` : ""].filter(Boolean);
    return `<div class="rt-node ${x.type}${end ? " end" : ""}"><div class="rt-t">${x.arr == null && x.dep != null ? `<b>${fmt(x.dep)}</b>` : times.join("")}</div>
      <div class="rt-rail"><span class="dot ${x.type}"><span class="ic ic-${ic}"></span></span></div>
      <div class="rt-body"><div class="rt-name">${esc(x.name)}${x.tags.map((t) => `<span class="rt-tag">${t}</span>`).join("")}</div>
      ${x.subs.map((t) => `<div class="rt-sub">${t}</div>`).join("")}</div></div>`;
  };
  const t0 = o.steps[0].t, t1 = o.steps[o.steps.length - 1].t;
  const chips = [nBus ? `デマンドバス ${nBus}回` : "", nTr ? `電車 ${nTr}本` : "", walk ? `徒歩 ${mins(walk)}分` : "", nSpot ? `寄り道 ${nSpot}か所` : "", o.kind === "taxi" ? "タクシー" : ""].filter(Boolean);
  $("all-body").innerHTML = `
    <div class="rt-head">
      <div class="rt-time">${fmt(t0)} <span class="ar">→</span> ${fmt(t1)}</div>
      <div class="rt-dur">${dur(t1 - t0)}（${S.dir === "go" ? "行き" : "帰り"}）</div>
      <div class="rt-chips">${chips.map((c) => `<span>${c}</span>`).join("")}</div>
    </div>
    <div class="rt">${items.map(row).join("")}</div>`;
  drawTrace();
  fitCoords(S.coords);
}
function setView(v) {
  S.view = v;
  $("mid").hidden = v === "form";
  document.querySelector(".app").classList.toggle("res", v !== "form");
  $("v-list").hidden = v !== "list"; $("v-all").hidden = v !== "all";
  const n = { list: 0, all: 1 }[v];
  $("stepper").innerHTML = [["list", S.dir === "go" ? "1 行きの経路" : "1 帰りの経路"], ["all", "2 経路全体"]].map(([k, l], i) =>
    (i ? `<span class="arrow">›</span>` : "") + `<button data-v="${k}" class="${i === n ? "on" : ""}" ${i === 1 && !S.sel ? "disabled" : ""}>${l}</button>`).join("");
  $("stepper").querySelectorAll("button").forEach((x) => x.onclick = () => {
    if (x.dataset.v === "all") showAll(); else { setView("list"); drawTrace(); fitCoords(S.coords); }
  });
  $("res-body").scrollTop = 0;
}

// ------------------------------------------------------------------ 地図の部品
async function svgImg(name, color, px) {
  const svg = (await (await fetch(`icons/${name}.svg`)).text()).replace(/currentColor/g, color).replace(/width="1em" height="1em"/, `width="${px}" height="${px}"`);
  const img = new Image(); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); await img.decode();
  return img;
}
async function icon(name, fg, bg, size = 44, ring = "#fff") {
  const img = await svgImg(name, fg, size * 0.58);
  const c = document.createElement("canvas"); c.width = c.height = size;
  const x = c.getContext("2d");
  x.beginPath(); x.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  x.fillStyle = bg; x.fill();
  x.lineWidth = 3; x.strokeStyle = ring; x.stroke();
  x.drawImage(img, size * 0.21, size * 0.21, size * 0.58, size * 0.58);
  return x.getImageData(0, 0, size, size);
}
// バス停（角丸の四角）
async function stopIcon(bg) {
  const size = 30, img = await svgImg("bus-stop", "#fff", 20);
  const c = document.createElement("canvas"); c.width = c.height = size;
  const x = c.getContext("2d");
  x.beginPath(); x.roundRect(3, 3, size - 6, size - 6, 6); x.fillStyle = bg; x.fill(); x.lineWidth = 2.5; x.strokeStyle = "#fff"; x.stroke();
  x.drawImage(img, 5, 5, 20, 20);
  return x.getImageData(0, 0, size, size);
}
// ピン（丸＋とがり）
async function pin(name, bg) {
  const w = 44, h = 56;
  const img = await svgImg(name, "#fff", 24);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.beginPath(); x.moveTo(w / 2, h - 2); x.lineTo(w / 2 - 11, 34); x.lineTo(w / 2 + 11, 34); x.closePath();
  x.arc(w / 2, 21, 19, 0, Math.PI * 2);
  x.fillStyle = bg; x.fill(); x.lineWidth = 2.5; x.strokeStyle = "#fff"; x.stroke();
  x.beginPath(); x.arc(w / 2, 21, 16.5, 0, Math.PI * 2); x.fillStyle = bg; x.fill();
  x.drawImage(img, w / 2 - 12, 9, 24, 24);
  return x.getImageData(0, 0, w, h);
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

// ------------------------------------------------------------------ 地図
let map, popup;
function drawTrace() {
  if (!map || !map.getSource("route")) return;
  const F = [], marks = [];
  const leg = S.dir === "go" ? "go" : "back";
  const line = (c, kind, extra = {}) => c.length > 1 && F.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: Object.assign({ kind, leg }, extra) });
  const o = S.sel;
  if (o) {
    for (const b of o.legs) line(busPath(b.g, b.plan, b.r), "bus");
    for (const s of o.steps) {
      if (s.type === "walk" && s.sec > 0) line(walkPath(s.from, s.to), "walk");
      if (s.type === "train") line(railPath(s.from, s.to), "train", { color: s.color });
      if (s.type === "taxi") line([xy(s.from), xy(s.to)], "taxi");
      if (s.type === "stay") marks.push(pt([s.spot.lon, s.spot.lat], { icon: "pin-" + s.spot.group, label: s.spot.name || s.spot.label }));
      if (s.type === "train") {
        for (const k of [s.from, s.to]) { const st = S.rail.stations[k]; marks.push(pt([st.lon, st.lat], { icon: "pin-train", label: st.name })); }
      }
    }
  }
  if (S.stop) marks.push(pt(xy(S.stop), { icon: S.dir === "go" ? "pin-home" : "pin-home", label: stopName(S.stop) }));
  if (S.hosp) marks.push(pt(xy("h" + S.hosp), { icon: "pin-hosp", label: medOf(S.hosp).name }));
  S.coords = F.flatMap((f) => f.geometry.coordinates).concat(marks.map((m) => m.geometry.coordinates));
  map.getSource("route").setData(fc(F));
  map.getSource("marks").setData(fc(marks));
  legend();
}
function mapPad(p) {
  if (window.innerWidth <= 900) return 40;
  const box = $("mid").hidden ? $("pane") : $("mid");
  const left = box.offsetLeft + box.offsetWidth;
  return { top: p, bottom: p + 40, left: left + p, right: p + 50 };
}
function fitCoords(cs, maxZoom = 15.5) {
  if (!map || !cs || !cs.length) return;
  const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: mapPad(60), maxZoom, duration: 700 });
}
function legend() {
  const c = S.dir === "go" ? ME : BACK;
  const walk = `<span class="ln dash" style="background:repeating-linear-gradient(90deg, ${c} 0 5px, transparent 5px 9px)"></span>`;
  const rows = [];
  if (S.sel) {
    rows.push(`<div><span class="ln" style="background:${c}"></span>かわまる　${walk}歩く</div>`);
    if (S.sel.steps.some((s) => s.type === "train")) rows.push(`<div><span class="ln" style="background:${S.rail.lines.TJ.color}"></span>東武東上線　<span class="ln" style="background:${S.rail.lines.JK.color}"></span>JR川越線</div>`);
    rows.push(`<div class="sub">白い点・破線が流れる向きが進む向き</div>`);
  } else {
    rows.push(`<div><span class="lg-stop" style="background:${COLORS[S.g]}"></span>かわまるのバス停（${esc(S.data.districts[S.g].name)}）</div>`);
    rows.push(`<div><span class="lg-dot" style="background:#e03131"></span>病院　<span class="lg-dot" style="background:#f783ac"></span>診療所</div>`);
    rows.push(`<div class="sub">押すと、くわしい情報と登録のボタンが出ます</div>`);
  }
  $("legend").innerHTML = rows.join("");
}
function closedText(H) {
  const out = [];
  const offW = WD.split("").filter((w, i) => H.ow[i] === "0");
  if (offW.length) out.push(`${offW.join("・")}曜`);
  for (let n = 0; n < 5; n++) for (let i = 0; i < 7; i++) if (H.ow[i] === "1" && H.wk[n * 7 + i] === "0") out.push(`第${n + 1}${WD[i]}曜`);
  if (H.hol === "0") out.push("祝日");
  return out.join("、");
}
function hospPopup(H) {
  const go = S.dir === "go";
  const rc = Object.keys(H.rc).length ? H.rc : H.sh, lab = Object.keys(H.rc).length ? "外来受付" : "診療時間";
  // 同じ時間の曜日はまとめる（月火水金 9:00〜12:00、14:30〜18:00）
  const groups = [];
  for (const w of (WD + "祝").split("")) {
    if (!rc[w]) continue;
    const txt = rc[w].map(([a, b]) => `${a.replace(/^0/, "")}〜${b.replace(/^0/, "")}`).join("、");
    const g = groups.find((x) => x.txt === txt);
    if (g) g.days += w; else groups.push({ days: w, txt });
  }
  const rows = groups.map((g) => `<tr><th>${g.days}</th><td>${g.txt}</td></tr>`).join("");
  const closed = closedText(H);
  const deps = H.deps.slice(0, 8).join("、") + (H.deps.length > 8 ? ` ほか ${H.deps.length - 8}` : "");
  return `<div class="pp">
    <div class="pp-kind" style="color:${H.kind === "病院" ? "#c92a2a" : "#d6336c"}">${H.kind}・${esc(S.data.districts[H.g].name)}</div>
    <div class="pp-name">${esc(H.name)}</div>
    <div class="pp-addr">${esc(H.addr)}</div>
    ${rows ? `<div class="pp-h">${lab}</div><table class="pp-t">${rows}</table>` : ""}
    ${closed ? `<div class="pp-row"><b>休診</b> ${esc(closed)}</div>` : ""}
    ${H.other ? `<div class="pp-row"><b>ほかの休み</b> ${esc(H.other)}</div>` : ""}
    ${deps ? `<div class="pp-row"><b>診療科</b> ${esc(deps)}</div>` : ""}
    ${H.hp ? `<div class="pp-row"><a href="${esc(H.hp)}" target="_blank" rel="noopener">ホームページ</a></div>` : ""}
    <div class="pp-src">出典: 医療情報ネット（${jdate(S.med.asof)}時点）</div>
    <button type="button" class="pp-btn ${go ? "go" : "back"}" data-h="${H.id}">${go ? "目的地に登録する" : "出発地に登録する"}</button></div>`;
}
function stopPopup(id) {
  const go = S.dir === "go", g = trip.stopG(id);
  const sta = S.rail.stations.find((s) => s.stop === id);
  return `<div class="pp">
    <div class="pp-kind" style="color:${COLORS[g]}">かわまるのバス停・${esc(S.data.districts[g].name)}</div>
    <div class="pp-name">${esc(stopName(id))}</div>
    ${sta ? `<div class="pp-row"><span class="ic ic-train"></span>${esc(sta.name)}（${esc(S.rail.lines[sta.line].name)}）のそば</div>` : ""}
    <button type="button" class="pp-btn ${go ? "go" : "back"}" data-s="${id}">${go ? "出発地に登録する" : "目的地に登録する"}</button></div>`;
}
function openPopup(lngLat, html) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ maxWidth: "300px", offset: 14 }).setLngLat(lngLat).setHTML(html).addTo(map);
  const el = popup.getElement();
  el.querySelectorAll(".pp-btn").forEach((b) => b.onclick = () => {
    if (b.dataset.h) setHosp(b.dataset.h); else setStop(b.dataset.s);
    popup.remove();
  });
}

async function initMap() {
  const d = S.data;
  map = new maplibregl.Map({ container: "map", style: await baseStyle(), center: [139.47, 35.9], zoom: 12, attributionControl: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution:
    `データ: <a href="https://ckan.odpt.org/" target="_blank" rel="noopener">公共交通オープンデータセンター</a>・医療情報ネット ほか／<a href="about.html">出典の詳細</a>` }), "bottom-right");
  await new Promise((r) => map.on("load", r));
  map.addImage("pin-home", await pin("home-variant", "#343a40"));
  map.addImage("pin-hosp", await pin("hospital-building", "#c92a2a"));
  map.addImage("pin-train", await pin("train", "#495057"));
  for (const g of Object.keys(GROUP_ICON)) map.addImage("pin-" + g, await pin(GROUP_ICON[g], GROUP_COLOR[g]));
  map.addImage("hosp", await icon("hospital-building", "#fff", "#e03131", 32));
  map.addImage("clinic", await icon("hospital-building", "#fff", "#f06595", 26));
  for (const g of Object.keys(d.districts)) map.addImage("stop-" + g, await stopIcon(COLORS[g]));
  map.addImage("station", await icon("train", "#fff", "#495057", 30));
  for (const s of d.spots) if (!map.hasImage("k-" + s.kind)) map.addImage("k-" + s.kind, await icon(KIND_ICON[s.kind] || "map-marker", "#fff", GROUP_COLOR[s.group], 30));

  map.addSource("hull", { type: "geojson", data: fc(Object.entries(d.districts).map(([g, x]) =>
    ({ type: "Feature", geometry: { type: "Polygon", coordinates: [x.hull] }, properties: { g, color: COLORS[g] } }))) });
  map.addLayer({ id: "hull-l", type: "line", source: "hull", filter: ["==", ["get", "g"], S.g],
    paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.7 } });

  // 鉄道（JR川越線・東武東上線）
  const rl = [];
  for (const [k, segs] of Object.entries(S.rail.shapes)) for (const c of segs) rl.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: { color: S.rail.lines[k].color } });
  map.addSource("rail", { type: "geojson", data: fc(rl) });
  map.addLayer({ id: "rail-l", type: "line", source: "rail", layout: { visibility: "none", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 3.5, "line-opacity": 0.75 } });
  map.addSource("stations", { type: "geojson", data: fc(S.rail.stations.filter((s, i, a) => a.findIndex((x) => x.name === s.name) === i)
    .map((s) => pt([s.lon, s.lat], { name: s.name.replace(/駅$/, "") + "駅" }))) });
  map.addLayer({ id: "stations", type: "symbol", source: "stations", layout: { visibility: "none",
    "icon-image": "station", "icon-size": 0.7, "icon-allow-overlap": true, "text-field": ["get", "name"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#343a40", "text-halo-color": "#fff", "text-halo-width": 1.6 } });

  // 寄り道のスポット（はじめは出さない）
  map.addSource("spots", { type: "geojson", data: fc(d.spots.map((s, i) => pt([s.lon, s.lat], { icon: "k-" + s.kind, name: s.name || s.label, label: s.label, g: S.spotG[i] }))) });
  map.addLayer({ id: "spots", type: "symbol", source: "spots", layout: { visibility: "none",
    "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 16, 0.75], "icon-allow-overlap": true,
    "text-field": ["step", ["zoom"], "", 15.5, ["get", "name"]], "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-font": ["Noto Sans Regular"], "text-optional": true },
    paint: { "text-color": "#495057", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  // かわまるのバス停（全部）
  const stopF = [];
  for (const [g, x] of Object.entries(d.districts)) for (const s of x.stops) stopF.push(pt([d.stops[s].lon, d.stops[s].lat], { id: s, g, name: d.stops[s].name }));
  map.addSource("stops", { type: "geojson", data: fc(stopF) });
  map.addLayer({ id: "stops", type: "symbol", source: "stops", layout: {
    "icon-image": ["concat", "stop-", ["get", "g"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.35, 15, 0.75], "icon-allow-overlap": true,
    "text-field": ["step", ["zoom"], "", 15, ["get", "name"]], "text-size": 10.5, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"], "text-optional": true },
    paint: { "text-color": "#343a40", "text-halo-color": "#fff", "text-halo-width": 1.3 } });
  // 病院・診療所（医療情報ネット）
  map.addSource("hosps", { type: "geojson", data: fc(S.med.list.map((x) => pt([x.lon, x.lat], { id: x.id, name: x.name, kind: x.kind, g: x.g }))) });
  map.addLayer({ id: "hosps", type: "symbol", source: "hosps", layout: {
    "icon-image": ["match", ["get", "kind"], "病院", "hosp", "clinic"],
    "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.45, 15, 0.85], "icon-allow-overlap": true,
    "symbol-sort-key": ["match", ["get", "kind"], "病院", 2, 1],
    "text-field": ["step", ["zoom"], ["match", ["get", "kind"], "病院", ["get", "name"], ""], 14.5, ["get", "name"]], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"], "text-optional": true },
    paint: { "text-color": "#c92a2a", "text-halo-color": "#fff", "text-halo-width": 1.4 } });

  // 経路（線の上を白い点が流れて向きを示す）
  map.addSource("route", { type: "geojson", data: fc([]) });
  const legColor = ["match", ["get", "leg"], "go", ME, "back", BACK, "#495057"];
  map.addLayer({ id: "route-train", type: "line", source: "route", filter: ["==", ["get", "kind"], "train"],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 7, "line-opacity": 0.9 } });
  map.addLayer({ id: "route-taxi", type: "line", source: "route", filter: ["==", ["get", "kind"], "taxi"],
    layout: { "line-cap": "round" }, paint: { "line-color": "#495057", "line-width": 3, "line-dasharray": [0.5, 2] } });
  map.addLayer({ id: "route-bus", type: "line", source: "route", filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": legColor, "line-width": 6, "line-opacity": 0.9 } });
  map.addLayer({ id: "route-walk", type: "line", source: "route", filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": legColor, "line-width": 4, "line-dasharray": [1.5, 1.5] } });
  map.addLayer({ id: "route-ants", type: "line", source: "route", filter: ["in", ["get", "kind"], ["literal", ["bus", "train"]]],
    layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": "#fff", "line-width": 2.5, "line-dasharray": [0, 4, 3] } });

  map.addSource("marks", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "marks", type: "symbol", source: "marks", layout: {
    "icon-image": ["get", "icon"], "icon-anchor": "bottom", "icon-size": 0.85, "icon-allow-overlap": true,
    "text-field": ["get", "label"], "text-size": 12, "text-anchor": "top", "text-offset": [0, 0.3], "text-font": ["Noto Sans Bold"], "text-allow-overlap": false, "text-optional": true },
    paint: { "text-color": "#212529", "text-halo-color": "#fff", "text-halo-width": 1.8 } });

  const vis = (ids, on) => ids.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
  $("ly-stops").onchange = (e) => vis(["stops"], e.target.checked);
  $("ly-hosps").onchange = (e) => vis(["hosps"], e.target.checked);
  $("ly-spots").onchange = (e) => vis(["spots"], e.target.checked);
  $("ly-rail").onchange = (e) => vis(["rail-l", "stations"], e.target.checked);

  map.on("click", "hosps", (e) => { const f = e.features[0]; openPopup(f.geometry.coordinates, hospPopup(medOf(f.properties.id))); });
  map.on("click", "stops", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["hosps"] }).length) return;
    const f = e.features[0]; openPopup(f.geometry.coordinates, stopPopup(f.properties.id));
  });
  map.on("click", "spots", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["hosps", "stops"] }).length) return;
    const f = e.features[0]; openPopup(f.geometry.coordinates, `<div class="pp"><div class="pp-kind">${esc(f.properties.label)}</div><div class="pp-name">${esc(f.properties.name)}</div><div class="pp-src">出典: OpenStreetMap</div></div>`);
  });
  for (const l of ["hosps", "stops", "spots"]) {
    map.on("mouseenter", l, () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", l, () => map.getCanvas().style.cursor = "");
  }

  filterMap();

  // 白い点を流す（MapLibre の線の破線をずらしていく）
  const SEQ = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
    [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
  const D = 1.5, G = 1.5, L = D + G;
  const WSEQ = SEQ.map((_, i) => { const f = (i / SEQ.length) * L; return f < G ? [0, f, D, G - f] : [f - G, G, L - f, 0]; });
  let k = -1;
  const ants = (ts) => {
    const n = Math.floor(ts / 70) % SEQ.length;
    if (n !== k) { k = n; map.setPaintProperty("route-ants", "line-dasharray", SEQ[n]); map.setPaintProperty("route-walk", "line-dasharray", WSEQ[n]); }
    requestAnimationFrame(ants);
  };
  requestAnimationFrame(ants);
}

async function main() {
  const get = (p) => fetch(p).then((r) => r.ok ? r.json() : null).catch(() => null);
  [S.data, S.med, S.rail, S.walk] = await Promise.all([get("data/kawagoe.json"), get("data/med.json"), get("data/rail.json"), get("data/walk.json")]);
  S.walk = S.walk || { p: {}, c: {} };
  const gs = Object.keys(S.data.districts);
  const gg = await Promise.all(gs.map((g) => get(`data/geom_${g}.json`)));
  gs.forEach((g, i) => S.geom[g] = gg[i] || {});
  trip = new Trip({ data: S.data, med: S.med, rail: S.rail, walk: S.walk });
  S.spotG = S.data.spots.map(spotDistrict);
  $("dist").innerHTML = Object.entries(S.data.districts).map(([g, x]) => `<option value="${g}">${esc(x.name)}</option>`).join("");
  $("dist").value = S.g;
  $("dist").onchange = () => setDistrict($("dist").value);
  $("dir").querySelectorAll("button").forEach((b) => b.onclick = () => setDir(b.dataset.d));
  $("date").onclick = () => $("pop").hidden || $("pop").dataset.kind !== "date" ? openPop("date") : closePop();
  $("time").onclick = () => $("pop").hidden || $("pop").dataset.kind !== "time" ? openPop("time") : closePop();
  $("pop-close").onclick = closePop;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  syncForm();
  await initMap();
  drawTrace();
  const ids = S.data.districts[S.g].stops, st = S.data.stops;
  fitCoords(ids.map((s) => [st[s].lon, st[s].lat]));
  $("form").onsubmit = search;
  $("to-all").onclick = showAll;
  window.S = S; window.map = map; window.trip = trip; window.READY = true;
}
main();
