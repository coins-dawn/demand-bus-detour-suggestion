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
  t: 8 * 3600, speed: 60, playing: true,
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

// ------------------------------------------------------------------ 車の動き
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
  const E = S.tl[g], st = S.data.stops;
  if (!E.length) return null;
  const at = (id) => [st[id].lon, st[id].lat];
  if (t < E[0].leave) return { p: at(E[0].to), on: 0 };
  let on = 0, me = false, p = null;
  for (const e of E) if (e.start <= t) { on += e.k === "P" ? e.r.pax : -e.r.pax; }
  for (let i = 0; i < E.length; i++) {
    const e = E[i];
    if (t < e.leave) { p = at(e.from); break; }
    if (t < e.arr) { p = along(seg(g, e.from, e.to), (t - e.leave) / (e.arr - e.leave)); break; }
    const nx = E[i + 1];
    if (!nx || t < nx.leave) { p = at(e.to); break; }
  }
  for (const e of E) {
    if (e.r.user && e.k === "P" && e.start <= t) me = true;
    if (e.r.user && e.k === "D" && e.start <= t) me = false;
  }
  return { p, on, me };
}
function peopleAt(g, t) {
  const out = [], st = S.data.stops;
  for (const e of S.tl[g]) {
    const s = st[e.to];
    if (e.k === "P" && t >= e.start - 360 && t < e.start + SVC_P * 0.6) out.push(pt([s.lon, s.lat], { me: !!e.r.user, g }));
    if (e.k === "D" && t >= e.start + 30 && t < e.start + 240) out.push(pt([s.lon, s.lat], { me: !!e.r.user, g, off: 1 }));
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
    S.base[g] = r.plan; S.plans[g] = r.plan; S.rejected += r.rejected.length;
    S.tl[g] = timeline(g, r.plan);
  }
  S.booked = null; S.me = null;
  clearResults();
  const n = Object.values(S.base).reduce((a, p) => a + p.route.filter((x) => x.k === "P").length, 0);
  $("svc").innerHTML = `埼玉県川越市のデマンド交通「かわまる」。地区ごとに車 1 台（7 人乗り）、8:00〜18:00（11:00〜11:30・15:00〜15:30 は休み）。
    地図の車は、${day.date.slice(0, 4)}年${+day.date.slice(4, 6)}月${+day.date.slice(6)}日（${day.wd}）の<b>実績の予約 ${day.n} 件</b>を、配車の計算で並べ直して動かしています。` +
    (S.rejected ? `（計算で入らなかった ${S.rejected} 件は省いています）` : "");
}

// ------------------------------------------------------------------ 入力
function fillForm() {
  const d = S.data;
  $("day").innerHTML = d.days.map((x, i) => `<option value="${i}">${+x.date.slice(4, 6)}月${+x.date.slice(6)}日（${x.wd}）${x.level}・予約 ${x.n} 件</option>`).join("");
  const di = d.days.findIndex((x) => x.date === DEFAULT.date);
  $("day").value = String(di >= 0 ? di : 0);
  const byG = (arr) => Object.keys(d.districts).map((g) => `<optgroup label="${d.districts[g].name}">` +
    arr.filter((x) => x.g === g).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("") + "</optgroup>").join("");
  $("orig").innerHTML = byG(d.origins);
  $("orig").value = (d.origins.find((x) => x.id === DEFAULT.orig) || d.origins[0]).id;
  const times = [];
  for (let t = 8.5 * 3600; t <= 16.5 * 3600; t += 1800) times.push(t);
  $("arr").innerHTML = times.map((t) => `<option value="${t}">${fmt(t)}</option>`).join("");
  $("arr").value = String(DEFAULT.arr);
  $("dur").innerHTML = [[1800, "30分"], [3600, "1時間"], [5400, "1時間30分"], [7200, "2時間"], [10800, "3時間"]]
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("dur").value = "3600";
  $("wid").innerHTML = [[0, "なし"], [1800, "30分"], [3600, "1時間"], [5400, "1時間30分"], [7200, "2時間"]]
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("wid").value = "3600";
  fillHosp();
  const dh = d.hospitals.find((x) => x.name === DEFAULT.hospName && x.g === d.origins.find((o) => o.id === $("orig").value).g);
  if (dh) $("hosp").value = dh.id;
  $("orig").onchange = () => { fillHosp(); clearResults(); };
  $("day").onchange = () => { loadDay(); };
  for (const id of ["hosp", "arr", "dur", "wid"]) $(id).onchange = clearResults;
}
function fillHosp() {
  const o = S.data.origins.find((x) => x.id === $("orig").value);
  $("hosp").innerHTML = S.data.hospitals.filter((x) => x.g === o.g).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  $("hint").textContent = `${S.data.districts[o.g].name}の中だけ乗れます（地区をまたげません）。幅は、行きは早く着いて待ってもよい時間、帰りは診察がのびても間に合うように遅らせる時間です。`;
}

// ------------------------------------------------------------------ 候補の表示
function clearResults() {
  for (const id of ["out", "back", "confirm"]) $(id).hidden = true;
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

function search(ev) {
  ev && ev.preventDefault();
  if (S.booked) cancel(true);
  const o = $("orig").value, h = $("hosp").value;
  const g = S.data.origins.find((x) => x.id === o).g;
  const q = { o, h, g, T: +$("arr").value, Dur: +$("dur").value, W: +$("wid").value };
  S.q = q;
  const P = new Planner(S.data, S.eng[g]);
  q.P = P;
  const go = P.outbound(S.base[g], o, h, q.T, q.W);
  S.go = go;
  $("out").hidden = false; $("back").hidden = true; $("confirm").hidden = true;
  $("out-sub").textContent = `${S.data.stops[o].name} → ${S.data.stops[h].name}。${fmt(q.T)} までに着く便です。`;
  if (go.none) {
    const a = go.alt || {};
    $("out-list").innerHTML = `<div class="empty">${fmt(q.T)} に間に合う便は、待ってもよい時間（${dur(q.W)}）の中ではほかの予約で埋まっています。` +
      (a.earlier ? `<br>・<b>${fmt(a.earlier.td)} 着</b>（${dur(q.T - a.earlier.td)}前）の便なら取れます。幅を広げると候補に出ます。` : "") +
      (a.later ? `<br>・<b>${fmt(a.later.td)} 着</b>の便なら取れます（病院の予約の時刻を動かせるなら）。` : "") + `</div>`;
    drawTrace(); return;
  }
  $("out-list").innerHTML = go.opts.map((x, i) => goCard(x, i, q)).join("");
  $("out-list").querySelectorAll(".opt").forEach((b) => b.onclick = () => selectGo(+b.dataset.i));
  const sp = go.opts[0].gap > 20 * 60 ? go.opts.findIndex((x) => x.kind === "spot") : -1;
  selectGo(sp > 0 ? sp : 0);
  fitTo([o, h]);
}
function selectGo(i) {
  const q = S.q;
  S.goSel = S.go.opts[i];
  $("out-list").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", +b.dataset.i === i));
  const end = q.T + q.Dur;
  const back = q.P.inbound(S.goSel.bus.plan, q.o, q.h, end, q.W);
  S.back = back;
  $("back").hidden = false;
  $("back-sub").textContent = `診察が ${fmt(end)} ごろに終わる見込みとして、${fmt(end)}〜${fmt(end + q.W)} に出る便をさがしました。`;
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
  const add = (t0, t1, a, b) => segs.push({ t0, t1, a, b });
  const go = bk.go, back = bk.back, q = bk.q;
  const H = P(q.h);
  add(bk.w1.tp - 360, bk.w1.tp, P(go.bus.r.p), P(go.bus.r.p));
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
    add(bk.w2.tp - 120, bk.w2.tp, Y, Y);
  } else {
    const w = walkSec(st[q.h], st[back.bus.y]);
    add(end, bk.w2.tp - w, H, H); add(bk.w2.tp - w, bk.w2.tp, H, Y);
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

  map.addSource("trace", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "trace-bus", type: "line", source: "trace", filter: ["==", ["get", "kind"], "bus"],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ME, "line-width": 4, "line-opacity": 0.75 } });
  map.addLayer({ id: "trace-walk", type: "line", source: "trace", filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "round" }, paint: { "line-color": ME, "line-width": 3, "line-dasharray": [0.6, 1.6] } });

  map.addSource("people", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "people", type: "circle", source: "people", paint: {
    "circle-radius": ["case", ["get", "me"], 6, 4.5], "circle-color": ["case", ["get", "me"], ME, "#343a40"],
    "circle-stroke-color": "#fff", "circle-stroke-width": 1.5, "circle-opacity": ["case", ["has", "off"], 0.55, 1] } });

  map.addSource("marks", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "marks", type: "symbol", source: "marks", layout: {
    "icon-image": ["get", "icon"], "icon-size": 0.7, "icon-allow-overlap": true } });

  map.addSource("buses", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "buses", type: "symbol", source: "buses", layout: {
    "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 15, 0.8],
    "icon-allow-overlap": true, "text-allow-overlap": true,
    "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.7], "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": ["get", "color"], "text-halo-color": "#fff", "text-halo-width": 1.6 } });

  map.addSource("me", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "me", type: "symbol", source: "me", layout: { "icon-image": "me", "icon-size": 0.75, "icon-allow-overlap": true } });
}

function frame() {
  const t = S.t;
  const B = [], ppl = [];
  for (const g of Object.keys(S.tl)) {
    const b = busAt(g, t);
    if (b && b.p) B.push(pt(b.p, { icon: (b.me ? "van-me-" : "van-") + g, color: COLORS[g], label: b.on > 0 ? `${b.on}人` : "" }));
    ppl.push(...peopleAt(g, t));
  }
  map.getSource("buses").setData(fc(B));
  map.getSource("people").setData(fc(ppl));
  const m = meAt(t);
  map.getSource("me").setData(fc(m ? [pt(m)] : []));
  $("clock").textContent = fmt(t);
}
function setSpeed(v) {
  S.speed = v;
  $("speed").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v === v));
}
function ppIcon() { $("pp").innerHTML = `<span class="ic ic-${S.playing ? "pause" : "play"}"></span>`; }

function legend() {
  const d = S.data;
  $("legend").innerHTML = Object.entries(d.districts).map(([g, x]) => `<div><span class="sw" style="background:${COLORS[g]}"></span>${x.name}の車（数字は乗っている人）</div>`).join("") +
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
    if (S.playing) { S.t += dt * S.speed; if (S.t > DAY1) S.t = DAY0; }
    frame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.S = S; window.map = map; window.READY = true;
}
main();
