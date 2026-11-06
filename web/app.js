// 画面: 左に予約の入力と候補、右に地図（実績の予約で動くデマンドの車）
const { District, SVC_P, SVC_D } = Engine;
const { Planner, GROUPS, walkSec } = Plan;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (t) => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}`;
const mins = (sec) => Math.max(0, Math.round(sec / 60));
const dur = (sec) => { const m = mins(sec); return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}` : `${m}分`; };
const COLORS = { 1: "#1c7ed6", 2: "#e8590c", 3: "#7048e8" };
const ME = "#d6336c";
const GROUP_ICON = { rest: "coffee", errand: "cart", sit: "bench" };
const GROUP_COLOR = { rest: "#a0522d", errand: "#2b8a3e", sit: "#1971c2" };
const DAY0 = 7 * 3600 + 50 * 60, DAY1 = 18 * 3600 + 10 * 60;
// [a, b] にかかる運転手の休憩
function breakIn(a, b) {
  const br = S.data.service.breaks.find(([x, y]) => Engine.hm(x) < b && Engine.hm(y) > a);
  return br ? `${br[0]}〜${br[1]} は運転手の休憩で、車が動きません。` : "";
}
// 開いたときの例（2025-09-03 の実績で、10:00 ちょうどに着く便が埋まっている組）
const DEFAULT = { date: "20250903", orig: "291", hosp: null, hospName: "きりむら内科医院", arr: 10 * 3600 };

const S = {
  data: null, geom: {}, line: new Map(), eng: {}, base: {}, plans: {}, rejected: 0, tl: {},
  g: "2", rej: {}, t: 8 * 3600, speed: 60, playing: true,
  q: null, go: null, back: null, goSel: null, backSel: null, booked: null, me: null,
};

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
function along(o, f) {
  if (o.len === 0) return o.pts[0];
  const d = f * o.len;
  let i = 1;
  while (i < o.cum.length - 1 && o.cum[i] < d) i++;
  const r = (d - o.cum[i - 1]) / ((o.cum[i] - o.cum[i - 1]) || 1);
  return [o.pts[i - 1][0] + (o.pts[i][0] - o.pts[i - 1][0]) * r, o.pts[i - 1][1] + (o.pts[i][1] - o.pts[i - 1][1]) * r];
}

// 線 o の f0〜f1 の部分
function slice(o, f0, f1) {
  const d0 = f0 * o.len, d1 = f1 * o.len, out = [along(o, f0)];
  for (let i = 1; i < o.pts.length - 1; i++) if (o.cum[i] > d0 && o.cum[i] < d1) out.push(o.pts[i]);
  out.push(along(o, f1));
  return out;
}

// ------------------------------------------------------------------ 車の動き
const BOARD = SVC_P * 0.75;   // 乗る人が車に着く（ここで乗っている人が増える）
const ALIGHT = (e) => e.r.user ? 60 : SVC_D;
function timeline(g, plan) {
  const D = S.eng[g], ents = [];
  let prev = null;
  plan.route.forEach((x, i) => {
    const si = x.k === "P" ? x.r.pi : x.r.di, id = D.ids[si];
    const dd = prev === null ? 0 : D.drive(prev.si, si);
    const arr = plan.arrs[i], start = plan.times[i];
    ents.push({ from: prev ? prev.id : id, to: id, leave: arr - dd, arr, start, end: start + (x.k === "P" ? SVC_P : SVC_D), k: x.k, r: x.r });
    prev = { si, id };
  });
  return ents;
}
function busAt(g, t) {
  // 走り出すときは、まず経路の線を引き（車はその間とまっている）、引き終わったら線の上を走る。
  // 線を引く長さは画面の上で 0.5 秒ほど（再生の速さに合わせる）
  const E = S.tl[g], st = S.data.stops;
  if (!E.length) return null;
  const at = (id) => [st[id].lon, st[id].lat];
  let on = 0, me = false, p = null, line = null;
  for (const e of E) {
    if (e.k === "P" && t >= e.start + BOARD) { on += e.r.pax; if (e.r.user) me = true; }
    if (e.k === "D" && t >= e.start) { on -= e.r.pax; if (e.r.user) me = false; }
  }
  if (t < E[0].leave) return { p: at(E[0].to), on, me };
  for (let i = 0; i < E.length; i++) {
    const e = E[i];
    if (t < e.leave) { p = at(e.from); break; }
    if (t < e.arr) {
      const o = seg(g, e.from, e.to), D = e.arr - e.leave, draw = Math.min(0.4 * D, 0.5 * S.speed);
      if (t < e.leave + draw) { p = at(e.from); line = { c: slice(o, 0, (t - e.leave) / draw), drawing: 1 }; }
      else { const f = (t - e.leave - draw) / (D - draw); p = along(o, f); line = { c: slice(o, f, 1) }; }
      break;
    }
    const nx = E[i + 1];
    if (!nx || t < nx.leave) { p = at(e.to); break; }
  }
  return { p, on, me, line };
}
// 乗り場の人: 待つ → 車へ歩いて乗り込む／車から出てくる → 少し離れて消える。
// 位置は乗り場からの画面上のずれ（px）で持ち、描くときに地図の座標に直す
const ease = (f) => f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f);
const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
function peopleAt(g, t) {
  const out = [], st = S.data.stops;
  for (const e of S.tl[g]) {
    const s = st[e.to], c = [s.lon, s.lat], me = !!e.r.user, n = Math.min(3, e.r.pax), t0 = e.start;
    for (let k = 0; k < n; k++) {
      const W = [34 + k * 14, 4], push = (d, op, sz) => out.push({ c, d, op, sz, me });
      if (e.k === "P") {
        const wait = me ? 120 : 300;
        if (t >= t0 - wait && t < t0) push(W, Math.min(1, (t - t0 + wait) / 30), 1);
        else if (t >= t0 && t < t0 + BOARD) {
          const f = (t - t0) / BOARD;
          push(mix(W, [0, -2], ease(f)), f < 0.7 ? 1 : (1 - f) / 0.3, 1 - 0.4 * f);
        }
      } else {
        const A = [34 + k * 14, 8], dd = ALIGHT(e);
        if (t >= t0 && t < t0 + dd) { const f = (t - t0) / dd; push(mix([0, -2], A, ease(f)), Math.min(1, f / 0.25), 0.6 + 0.4 * f); }
        else if (!me && t >= t0 + dd && t < t0 + dd + 150) {
          const f = (t - t0 - dd) / 150;
          push(mix(A, [A[0] + 22, A[1] + 14], f), f < 0.5 ? 1 : (1 - f) / 0.5, 1);
        }
      }
    }
  }
  return out;
}
const pt = (c, p = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: p });
const fc = (f) => ({ type: "FeatureCollection", features: f });

// ------------------------------------------------------------------ 日の切り替え
function loadDay() {
  const day = S.data.days[+$("day").value];
  S.rejected = 0;
  for (const g of Object.keys(S.data.districts)) {
    S.eng[g] = new District(S.data, g);
    const r = S.eng[g].replay(day.reqs[g]);
    S.base[g] = r.plan; S.plans[g] = r.plan; S.rejected += r.rejected.length; S.rej[g] = r.rejected.length;
    S.tl[g] = timeline(g, r.plan);
  }
  S.booked = null; S.me = null;
  clearResults();
  svcText();
}
function svcText() {
  const day = S.data.days[+$("day").value], g = S.g;
  const n = S.base[g].route.filter((x) => x.k === "P").length;
  $("svc").innerHTML = `埼玉県川越市のデマンド交通「かわまる」の<b>${S.data.districts[g].name}</b>。車 1 台（7 人乗り）、8:00〜18:00（11:00〜11:30・15:00〜15:30 は休み）。
    地図の車は、${day.date.slice(0, 4)}年${+day.date.slice(4, 6)}月${+day.date.slice(6)}日（${day.wd}）の<b>実績の予約 ${n} 件</b>を、配車の計算で並べ直して動かしています。` +
    (S.rej[g] ? `（計算で入らなかった ${S.rej[g]} 件は省いています）` : "");
}

// ------------------------------------------------------------------ 入力
function fillForm() {
  const d = S.data;
  S.g = (d.origins.find((x) => x.id === DEFAULT.orig) || d.origins[0]).g;
  $("dist").innerHTML = Object.entries(d.districts).map(([g, x]) =>
    `<button type="button" role="tab" data-g="${g}" style="--c:${COLORS[g]}">${esc(x.name)}</button>`).join("");
  $("dist").querySelectorAll("button").forEach((b) => b.onclick = () => setDistrict(b.dataset.g));
  fillDays();
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
  const dh = d.hospitals.find((x) => x.name === DEFAULT.hospName && x.g === d.origins.find((o) => o.id === $("orig").value).g);
  if (dh) $("hosp").value = dh.id;
  $("orig").onchange = () => { fillHosp(); clearResults(); };
  $("day").onchange = () => { loadDay(); };
  for (const id of ["hosp", "arr", "dur"]) $(id).onchange = clearResults;
}
function fillDays() {
  const v = $("day").value;
  $("day").innerHTML = S.data.days.map((x, i) => `<option value="${i}">${+x.date.slice(4, 6)}月${+x.date.slice(6)}日（${x.wd}）${x.level}・予約 ${x.reqs[S.g].length} 件</option>`).join("");
  if (v) $("day").value = v;
}
function fillOrig() {
  $("orig").innerHTML = S.data.origins.filter((x) => x.g === S.g).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
}
function markDistrict() {
  $("dist").querySelectorAll("button").forEach((b) => { const on = b.dataset.g === S.g; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
}
// 地区を切り替える: 入力の選択肢・地図の車と区域を、その地区だけにする
function setDistrict(g) {
  if (g === S.g) return;
  if (S.booked) cancel(true);
  S.g = g; S.q = null;
  markDistrict(); fillDays(); fillOrig(); fillHosp(); clearResults(); svcText(); legend();
  showDistrict(true);
}
function showDistrict(anim) {
  if (!map || !map.getLayer("stops")) return;
  const f = ["==", ["get", "g"], S.g];
  for (const id of ["hull-f", "hull-l", "stops", "stops-lbl"]) map.setFilter(id, f);
  const h = S.data.districts[S.g].hull, xs = h.map((p) => p[0]), ys = h.map((p) => p[1]);
  const pad = window.innerWidth < 820 ? 30 : 60;
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: pad, duration: anim ? 900 : 0 });
}
function fillHosp() {
  const o = S.data.origins.find((x) => x.id === $("orig").value);
  $("hosp").innerHTML = S.data.hospitals.filter((x) => x.g === o.g).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  $("hint").textContent = `${S.data.districts[o.g].name}の中だけ乗れます（地区をまたげません）。待ってもよい時間（行きは早く着いて待つ時間、帰りは診察がのびても間に合うように遅らせる時間）は、0分〜2時間の結果をまとめて出します。`;
}

// ------------------------------------------------------------------ 候補の表示
function clearResults() {
  for (const id of ["wsum", "out", "back", "confirm"]) $(id).hidden = true;
  if (!S.booked) $("booked").hidden = true;
  S.go = S.back = S.goSel = S.backSel = null;
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
  if (!o.withinW) note = `<p class="note warn">待ってもよい時間（${dur(q.W)}）より早く着きます</p>`;
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

// 待ってもよい時間ごとに結果を出す
const WS = [0, 1800, 3600, 5400, 7200];
function search(ev) {
  ev && ev.preventDefault();
  if (S.booked) cancel(true);
  const o = $("orig").value, h = $("hosp").value;
  const g = S.data.origins.find((x) => x.id === o).g;
  const q = { o, h, g, T: +$("arr").value, Dur: +$("dur").value, W: 3600 };
  S.q = q;
  const P = new Planner(S.data, S.eng[g]);
  q.P = P;
  const end = q.T + q.Dur;
  S.res = WS.map((W) => {
    const go = P.outbound(S.base[g], o, h, q.T, W);
    const back = go.none ? null : P.inbound(go.opts[0].bus.plan, o, h, end, W);
    return { W, go, back };
  });
  $("wsum").hidden = false;
  $("wsum-list").innerHTML = S.res.map((r, k) => {
    let a, b;
    if (r.go.none) { a = `<span class="ng">取れない</span>`; b = "—"; }
    else {
      const d = r.go.opts[0], arr = d.bus.td + d.bus.walkXH, gap = mins(d.gap);
      a = `${fmt(arr)} 着${gap > 10 ? `<small>（${dur(d.gap)}前）</small>` : ""}`;
      if (!r.back || r.back.none) b = `<span class="ng">取れない</span>`;
      else {
        const ts = r.back.opts.map((x) => x.bus.tp).sort((x, y) => x - y);
        b = [...new Set(ts.map(fmt))].join("・") + " 発";
      }
    }
    const nOpt = r.go.none ? 0 : r.go.opts.length + (r.back && !r.back.none ? r.back.opts.length : 0);
    return `<button class="wrow" data-k="${k}"><span class="w">${r.W ? dur(r.W) : "0分"}</span><span>行き ${a}</span><span>帰り ${b}</span><span class="n">${nOpt ? nOpt + "案" : ""}</span></button>`;
  }).join("");
  $("wsum-list").querySelectorAll(".wrow").forEach((b) => b.onclick = () => showW(+b.dataset.k));
  // はじめに開く: 1 時間（取れなければ、取れるうちでいちばん短いもの）
  let k = WS.indexOf(3600);
  if (S.res[k].go.none) { const j = S.res.findIndex((r) => !r.go.none); if (j >= 0) k = j; }
  showW(k);
  fitTo([o, h]);
}
function showW(k) {
  const q = S.q, r = S.res[k], o = q.o, h = q.h;
  q.W = r.W;
  $("wsum-list").querySelectorAll(".wrow").forEach((b) => b.classList.toggle("sel", +b.dataset.k === k));
  const go = r.go;
  S.go = go;
  $("out").hidden = false; $("back").hidden = true; $("confirm").hidden = true;
  $("out-sub").textContent = `待ってもよい時間 ${r.W ? dur(r.W) : "0分"} のとき。${S.data.stops[o].name} → ${S.data.stops[h].name}、${fmt(q.T)} までに着く便です。`;
  if (go.none) {
    const a = go.alt || {};
    $("out-list").innerHTML = `<div class="empty">${fmt(q.T)} に間に合う便は、待ってもよい時間（${r.W ? dur(r.W) : "0分"}）の中ではほかの予約で埋まっています。` +
      (a.earlier ? `<br>・<b>${fmt(a.earlier.td)} 着</b>（${dur(q.T - a.earlier.td)}前）の便なら取れます。` : "") +
      (a.later ? `<br>・<b>${fmt(a.later.td)} 着</b>の便なら取れます（病院の予約の時刻を動かせるなら）。` : "") + `</div>`;
    S.goSel = S.backSel = null;
    drawTrace(); return;
  }
  $("out-list").innerHTML = go.opts.map((x, i) => goCard(x, i, q)).join("");
  $("out-list").querySelectorAll(".opt").forEach((b) => b.onclick = () => selectGo(+b.dataset.i));
  const sp = go.opts[0].gap > 20 * 60 ? go.opts.findIndex((x) => x.kind === "spot") : -1;
  selectGo(sp > 0 ? sp : 0);
}
function selectGo(i) {
  const q = S.q;
  S.goSel = S.go.opts[i];
  $("out-list").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", +b.dataset.i === i));
  const end = q.T + q.Dur;
  const back = q.P.inbound(S.goSel.bus.plan, q.o, q.h, end, q.W);
  S.back = back;
  $("back").hidden = false;
  $("back-sub").textContent = `診察が ${fmt(end)} ごろに終わる見込みとして、` + (q.W ? `${fmt(end)}〜${fmt(end + q.W)} に出る便をさがしました。` : "終わってすぐ出る便をさがしました。");
  if (back.none) {
    $("back-list").innerHTML = `<div class="empty">この時間帯の帰りの便は、ほかの予約で埋まっています。` +
      (back.next ? `<br>次に取れるのは <b>${fmt(back.next.tp)} 発</b>です。` : `<br>この日はもう取れません。`) + `</div>`;
    $("confirm").hidden = true; S.backSel = null; drawTrace(); return;
  }
  $("back-list").innerHTML = back.opts.map((x, k) => backCard(x, k, q)).join("");
  $("back-list").querySelectorAll(".opt").forEach((b) => b.onclick = () => selectBack(+b.dataset.i));
  const safe = back.opts.findIndex((x) => x.kind === "spot" && mins(x.slack) >= 15);
  selectBack(safe >= 0 ? safe : 0);
}
function selectBack(i) {
  S.backSel = S.back.opts[i];
  $("back-list").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", +b.dataset.i === i));
  const g = S.goSel, b = S.backSel;
  $("confirm").hidden = false;
  $("confirm-text").innerHTML = `<p>行き <b>${fmt(g.bus.tp)}</b> 乗車（${sname(g.bus.r.p)}）／帰り <b>${fmt(b.bus.tp)}</b> 乗車（${sname(b.bus.y)}）。
    帰りを先に押さえるので、診察のあとに電話して待つ必要がありません。</p>`;
  drawTrace();
}

function book() {
  const q = S.q, g = q.g, b = S.backSel;
  S.plans[g] = b.bus.plan;
  S.tl[g] = timeline(g, S.plans[g]);
  const w1 = Engine.District.when(S.plans[g], S.goSel.bus.r), w2 = Engine.District.when(S.plans[g], b.bus.r);
  S.booked = { q, go: S.goSel, back: b, w1, w2 };
  S.me = meTrack(S.booked);
  $("out").hidden = $("back").hidden = $("confirm").hidden = true;
  $("booked").hidden = false;
  $("booked-text").innerHTML = `<p><b>予約しました</b>（この画面の中だけの予約です）</p>
    <p>行き ${fmt(w1.tp)} ${sname(S.goSel.bus.r.p)} で乗車 → ${fmt(w1.td)} ${sname(S.goSel.bus.x)}<br>
    帰り ${fmt(w2.tp)} ${sname(b.bus.y)} で乗車 → ${fmt(w2.td)} ${sname(b.bus.r.d)}</p>
    <p class="sub">地図では、あなたの便とあなたの動きを<span class="c-me">ピンク</span>で示します。</p>`;
  drawTrace();
  watch();
}
function watch() {
  if (!S.booked) return;
  S.t = S.booked.w1.tp - 15 * 60;
  setSpeed(60);
  S.playing = true; ppIcon();
  fitTo([S.booked.q.o, S.booked.q.h]);
}
function cancel(silent) {
  if (S.booked) {
    const g = S.booked.q.g;
    S.plans[g] = S.base[g];
    S.tl[g] = timeline(g, S.base[g]);
  }
  S.booked = null; S.me = null;
  $("booked").hidden = true;
  if (!silent) clearResults();
  drawTrace();
}

// あなたの動き（歩く・過ごす・乗る）
function meTrack(bk) {
  const st = S.data.stops, P = (id) => [st[id].lon, st[id].lat];
  const segs = [];
  const add = (t0, t1, a, b, wait) => segs.push({ t0, t1, a, b, wait });
  const go = bk.go, back = bk.back, q = bk.q;
  const H = P(q.h);
  let t = bk.w1.td + 60, cur = P(go.bus.x);
  if (go.spot) {
    const s = [go.spot.lon, go.spot.lat];
    add(t, t + walkSec(st[go.bus.x], go.spot), cur, s); t += walkSec(st[go.bus.x], go.spot);
    const w2 = walkSec(go.spot, st[q.h]);
    add(t, q.T - w2, s, s); add(q.T - w2, q.T, s, H);
  } else if (go.bus.walkXH) {
    add(t, t + go.bus.walkXH, cur, H);
  }
  const end = q.T + q.Dur;
  add(q.T, end, H, H);
  const Y = P(back.bus.y);
  if (back.spot) {
    const s = [back.spot.lon, back.spot.lat], w1 = walkSec(st[q.h], back.spot), w2 = walkSec(back.spot, st[back.bus.y]);
    add(end, end + w1, H, s); add(end + w1, bk.w2.tp - w2 - 120, s, s); add(bk.w2.tp - w2 - 120, bk.w2.tp - 120, s, Y);
  } else {
    const w = walkSec(st[q.h], st[back.bus.y]);
    add(end, bk.w2.tp - w - 120, H, H); add(bk.w2.tp - w - 120, bk.w2.tp - 120, H, Y);
  }
  return segs;
}
function meAt(t) {
  if (!S.me) return null;
  for (const s of S.me) {
    if (t >= s.t0 && t < s.t1) {
      const f = (t - s.t0) / ((s.t1 - s.t0) || 1);
      return [s.a[0] + (s.b[0] - s.a[0]) * f, s.a[1] + (s.b[1] - s.a[1]) * f];
    }
  }
  return null;
}

// ------------------------------------------------------------------ 地図
let map;
function busPath(g, plan, r) {
  // 予約 r が乗ってから降りるまでに車が通る道（相乗りの寄り道を含む）
  const E = timeline(g, plan);
  const i0 = E.findIndex((e) => e.r === r && e.k === "P"), i1 = E.findIndex((e) => e.r === r && e.k === "D");
  let pts = [];
  for (let i = i0 + 1; i <= i1; i++) pts = pts.concat(seg(g, E[i].from, E[i].to).pts);
  return pts;
}
function drawTrace() {
  if (!map || !map.getSource("trace")) return;
  const F = [], spots = [], marks = [];
  const st = S.data.stops, P = (id) => [st[id].lon, st[id].lat];
  const go = S.booked ? S.booked.go : S.goSel, back = S.booked ? S.booked.back : S.backSel, q = S.booked ? S.booked.q : S.q;
  const plan = S.booked ? S.plans[q.g] : (back ? back.bus.plan : go && go.bus.plan);
  const line = (c, kind) => c.length > 1 && F.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: { kind } });
  if (go && plan) {
    line(busPath(q.g, plan, go.bus.r), "bus");
    const X = P(go.bus.x), H = P(q.h);
    if (go.spot) { const s = [go.spot.lon, go.spot.lat]; line([X, s], "walk"); line([s, H], "walk"); spots.push(go.spot); }
    else if (go.bus.x !== q.h) line([X, H], "walk");
  }
  if (back && plan) {
    line(busPath(q.g, plan, back.bus.r), "bus");
    const Y = P(back.bus.y), H = P(q.h);
    if (back.spot) { const s = [back.spot.lon, back.spot.lat]; line([H, s], "walk"); line([s, Y], "walk"); spots.push(back.spot); }
    else if (back.bus.y !== q.h) line([H, Y], "walk");
  }
  if (q && (go || S.booked)) {
    marks.push(pt(P(q.o), { icon: "home-me", label: st[q.o].name }));
    marks.push(pt(P(q.h), { icon: "hospital-me", label: hname(q.h) }));
  }
  for (const s of spots) marks.push(pt([s.lon, s.lat], { icon: "spot-" + s.group, label: s.name || s.label }));
  map.getSource("trace").setData(fc(F));
  map.getSource("marks").setData(fc(marks));
}
function fitTo(ids) {
  const st = S.data.stops;
  const xs = ids.map((i) => st[i].lon), ys = ids.map((i) => st[i].lat);
  const pad = window.innerWidth < 820 ? 40 : 90;
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: pad, maxZoom: 14.6, duration: 800 });
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

// 人のアイコンを横に並べた絵（白いふちどり付き）
async function glyphs(colors, px = 24) {
  const svg = await (await fetch("icons/account.svg")).text();
  const img = async (c) => { const i = new Image();
    i.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace(/currentColor/g, c).replace(/width="1em" height="1em"/, `width="${px}" height="${px}"`));
    await i.decode(); return i; };
  const white = await img("#fff"), step = Math.round(px * 0.62);
  const cv = document.createElement("canvas"); cv.width = px + step * (colors.length - 1) + 4; cv.height = px + 4;
  const x = cv.getContext("2d");
  for (let k = colors.length - 1; k >= 0; k--) {
    const ox = 2 + k * step, col = await img(colors[k]);
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1.5, -1.5], [1.5, 1.5], [-1.5, 1.5], [1.5, -1.5]]) x.drawImage(white, ox + dx, 2 + dy);
    x.drawImage(col, ox, 2);
  }
  return x.getImageData(0, 0, cv.width, cv.height);
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

async function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: await baseStyle(),
    center: [139.44, 35.9], zoom: 11.6,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  await new Promise((r) => map.on("load", r));
  const d = S.data;
  for (const [g, c] of Object.entries(COLORS)) {
    map.addImage("van-" + g, await icon("van-passenger", "#fff", c));
    map.addImage("van-me-" + g, await icon("van-passenger", "#fff", c, 52, ME));
  }
  map.addImage("home-me", await icon("home-variant", "#fff", "#343a40", 40));
  map.addImage("hospital-me", await icon("hospital-building", "#fff", "#c92a2a", 44));
  for (const g of Object.keys(GROUP_ICON)) map.addImage("spot-" + g, await icon(GROUP_ICON[g], "#fff", GROUP_COLOR[g], 40));
  map.addImage("me", await icon("account", "#fff", ME, 36));
  map.addImage("person", await glyphs(["#343a40"]));
  map.addImage("person-me", await glyphs([ME]));
  for (let n = 1; n <= 7; n++) {
    map.addImage("pax-" + n, await glyphs(Array(n).fill("#343a40")));
    map.addImage("pax-me-" + n, await glyphs([ME].concat(Array(n - 1).fill("#343a40"))));
  }

  map.addSource("hull", { type: "geojson", data: fc(Object.entries(d.districts).map(([g, x]) =>
    ({ type: "Feature", geometry: { type: "Polygon", coordinates: [x.hull] }, properties: { g, color: COLORS[g], name: x.name } }))) });
  map.addLayer({ id: "hull-f", type: "fill", source: "hull", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.04 } });
  map.addLayer({ id: "hull-l", type: "line", source: "hull", paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.7 } });

  const sf = [];
  for (const [g, x] of Object.entries(d.districts)) for (const s of x.stops) sf.push(pt([d.stops[s].lon, d.stops[s].lat], { g, color: COLORS[g], name: d.stops[s].name }));
  map.addSource("stops", { type: "geojson", data: fc(sf) });
  map.addLayer({ id: "stops", type: "circle", source: "stops", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 15, 4], "circle-color": "#fff",
    "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.2, "circle-opacity": 0.9 } });
  map.addLayer({ id: "stops-lbl", type: "symbol", source: "stops", minzoom: 14.5, layout: {
    "text-field": ["get", "name"], "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#495057", "text-halo-color": "#fff", "text-halo-width": 1.2 } });

  map.addSource("route", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 15, 5], "line-opacity": 0.85 } });

  map.addSource("trace", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "trace-bus", type: "line", source: "trace", filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ME, "line-width": 4, "line-opacity": 0.75 } });
  map.addLayer({ id: "trace-walk", type: "line", source: "trace", filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "round" }, paint: { "line-color": ME, "line-width": 3, "line-dasharray": [0.6, 1.6] } });

  map.addSource("marks", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "marks", type: "symbol", source: "marks", layout: {
    "icon-image": ["get", "icon"], "icon-size": 0.7, "icon-allow-overlap": true } });

  map.addSource("buses", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "buses", type: "symbol", source: "buses", layout: {
    "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 15, 0.8],
    "icon-allow-overlap": true } });
  // 乗っている人（車の上に人のアイコンを並べる）
  map.addLayer({ id: "pax", type: "symbol", source: "buses", filter: ["has", "pax"], layout: {
    "icon-image": ["get", "pax"], "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-size": 0.9,
    "icon-offset": ["interpolate", ["linear"], ["zoom"], 11, ["literal", [0, -13]], 15, ["literal", [0, -18]]] } });
  // 乗り場で待つ人・乗り降りする人
  map.addSource("people", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "people", type: "symbol", source: "people", layout: {
    "icon-image": ["case", ["get", "me"], "person-me", "person"], "icon-size": ["get", "sz"], "icon-allow-overlap": true },
    paint: { "icon-opacity": ["get", "op"] } });

  map.addSource("me", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "me", type: "symbol", source: "me", layout: { "icon-image": "me", "icon-size": 0.75, "icon-allow-overlap": true } });
}

function frame() {
  const t = S.t, g = S.g;
  const B = [], R = [], ppl = [];
  const b = busAt(g, t);
  if (b && b.p) {
    const pr = { icon: (b.me ? "van-me-" : "van-") + g };
    if (b.on > 0) pr.pax = (b.me ? "pax-me-" : "pax-") + Math.min(7, b.on);
    B.push(pt(b.p, pr));
    if (b.line && b.line.c.length > 1) R.push({ type: "Feature", geometry: { type: "LineString", coordinates: b.line.c }, properties: { color: COLORS[g] } });
  }
  for (const x of peopleAt(g, t)) {
    const q = map.project(x.c), ll = map.unproject([q.x + x.d[0], q.y + x.d[1]]);
    ppl.push(pt([ll.lng, ll.lat], { me: x.me, op: Math.max(0, Math.min(1, x.op)), sz: x.sz }));
  }
  map.getSource("buses").setData(fc(B));
  map.getSource("route").setData(fc(R));
  map.getSource("people").setData(fc(ppl));
  const m = meAt(t);
  map.getSource("me").setData(fc(m ? [pt(m)] : []));
  $("clock").textContent = fmt(t);
  drawHist();
  syncSlider(t);
}
// 時刻のスライダーと、その上の予約の棒グラフ（30 分ごとに乗る人の数）
const BIN = 1800, T0 = 8 * 3600, T1 = 18 * 3600;
let histKey = "", dragging = false;
function drawHist() {
  const key = `${S.g}|${$("day").value}|${S.booked ? 1 : 0}`;
  if (key === histKey) return;
  histKey = key;
  const n = (T1 - T0) / BIN, cnt = Array(n).fill(0), me = Array(n).fill(false);
  const plan = S.plans[S.g];
  plan.route.forEach((x, i) => {
    if (x.k !== "P") return;
    const b = Math.floor((plan.times[i] - T0) / BIN);
    if (b >= 0 && b < n) { cnt[b] += x.r.pax; if (x.r.user) me[b] = true; }
  });
  const brk = S.data.service.breaks.map(([a, b]) => [Engine.hm(a), Engine.hm(b)]);
  const max = Math.max(4, ...cnt);
  $("tl-bars").style.setProperty("--c", COLORS[S.g]);
  $("tl-bars").innerHTML = cnt.map((c, b) => {
    const t = T0 + b * BIN, isBrk = brk.some(([x, y]) => t >= x && t < y);
    return `<i data-b="${b}" class="${isBrk ? "brk" : ""}${me[b] ? " me" : ""}" style="height:${(c / max) * 100}%" title="${fmt(t)}〜 ${isBrk ? "休憩" : c + "人"}"></i>`;
  }).join("");
  $("tl-note").innerHTML = `棒は 30 分ごとに乗る人の数（実績の予約）。しま模様は運転手の休憩${S.booked ? "、<span class=\"c-me\">●</span>はあなたの予約" : ""}。`;
}
function syncSlider(t) {
  if (!dragging) $("tl-in").value = String(t);
  const b = Math.floor((t - T0) / BIN);
  $("tl-bars").querySelectorAll("i").forEach((el) => el.classList.toggle("now", +el.dataset.b === b));
}
function initSlider() {
  const el = $("tl-in");
  el.min = DAY0; el.max = DAY1;
  const pc = (x) => ((x - DAY0) / (DAY1 - DAY0)) * 100;
  // 棒グラフを 8:00〜18:00 の位置に合わせる（つまみの幅 14px の半分を両端で考える）
  const bars = $("tl-bars");
  bars.style.left = `calc(7px + (100% - 14px) * ${pc(T0) / 100})`;
  bars.style.right = `calc(7px + (100% - 14px) * ${1 - pc(T1) / 100})`;
  $("tl-axis").innerHTML = [8, 10, 12, 14, 16, 18].map((h) =>
    `<span style="left:calc(7px + (100% - 14px) * ${pc(h * 3600) / 100})">${h}時</span>`).join("");
  el.addEventListener("pointerdown", () => dragging = true);
  window.addEventListener("pointerup", () => dragging = false);
  el.addEventListener("input", () => { S.t = +el.value; });
}

function setSpeed(v) {
  S.speed = v;
  $("speed").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v === v));
}
function ppIcon() { $("pp").innerHTML = `<span class="ic ic-${S.playing ? "pause" : "play"}"></span>`; }

function legend() {
  const d = S.data;
  $("legend").innerHTML = `<div><span class="sw" style="background:${COLORS[S.g]}"></span>${d.districts[S.g].name}の車と、これから走る道（車の上の人は乗っている人）</div>` +
    `<div><span class="sw" style="background:#343a40"></span>乗る人・降りた人（実績の予約）</div>
     <div><span class="sw" style="background:${ME}"></span>あなたの予約</div>`;
  $("credit").innerHTML = `
    <p><b>データの出典</b>：「埼玉県川越市 かわまる」のデマンド交通データ（運行情報・乗降実績）、提供 順風路株式会社、
    <a href="https://ckan.odpt.org/" target="_blank" rel="noopener">公共交通オープンデータセンター</a> で公開、
    <a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noopener">CC BY 4.0</a>（2026-09-17 取得）。
    乗降実績を配車の計算で並べ直して作成しています。</p>
    <p>本アプリケーションが利用する公共交通データは、公共交通オープンデータセンターにおいて提供されるものです。公共交通事業者により提供されたデータを元にしていますが、必ずしも正確・完全なものとは限りません。本アプリケーションの表示内容について、公共交通事業者への直接の問合せは行わないでください。</p>
    <p>便の空きは、実績の予約から計算した目安で、実際の予約の受付とは関係ありません。近くの場所と道路は © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>（ODbL）、車の所要時間は OSRM で計算。店の営業時間は確かめてください。
    背景地図は <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a>（© OpenMapTiles、© OpenStreetMap contributors）。アイコンは Material Design Icons（Iconify）。</p>`;
}

async function main() {
  S.data = await (await fetch("data/kawagoe.json")).json();
  const gs = Object.keys(S.data.districts);
  const gg = await Promise.all(gs.map((g) => fetch(`data/geom_${g}.json`).then((r) => r.ok ? r.json() : {}).catch(() => ({}))));
  gs.forEach((g, i) => S.geom[g] = gg[i]);
  fillForm();
  legend();
  await initMap();
  loadDay();
  showDistrict(false);
  initSlider();
  $("speed").innerHTML = [60, 120, 300, 600].map((v) => `<button data-v="${v}">${v}倍</button>`).join("");
  $("speed").querySelectorAll("button").forEach((b) => b.onclick = () => setSpeed(+b.dataset.v));
  setSpeed(300);
  $("pp").onclick = () => { S.playing = !S.playing; ppIcon(); };
  $("form").onsubmit = search;
  $("book").onclick = book;
  $("watch").onclick = watch;
  $("reset").onclick = () => cancel(false);
  const qs = new URLSearchParams(location.search);
  if (qs.has("t")) S.t = Engine.hm(qs.get("t"));
  if (qs.has("paused")) { S.playing = false; ppIcon(); }
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (S.playing && !dragging) { S.t += dt * S.speed; if (S.t > DAY1) S.t = DAY0; }
    frame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.S = S; window.map = map; window.READY = true;
}
main();
