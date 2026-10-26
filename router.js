// 依時刻表配對資料（window.TT）算 A→B 最近幾班可行行程。
// TT.edges: [A, B, 線, 方向, 吻合率, 路線終點, {日別:[A發,B發,…]}, {日別:[…]}區間車在B終點]
// TT.freq: 沒有逐班時刻表、依班距估算的路線（文湖線、環狀線，見 data/freq.js 與 withFreq）

const FILTER = 0.95; // 吻合率低於此 = 這段只有部分班次會開（分支 / 區間車）

// 凌晨 0–3 點算前一天營運日的 24–27 點
export function serviceTime(date) {
  const h = date.getHours();
  const d = new Date(date);
  if (h < 4) d.setDate(d.getDate() - 1);
  const wd = d.getDay();
  return { day: wd === 0 ? 'su' : wd === 6 ? 'sa' : 'wd', min: (h < 4 ? h + 24 : h) * 60 + date.getMinutes() };
}

const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// 把班距估算的路線併進 TT；同名車站共用 id 才能轉乘（大安、忠孝復興、南京復興、南港展覽館）
export function withFreq(TT, lines = []) {
  const idOf = Object.fromEntries(Object.values(TT.stations).map((s) => [s.name, s.id]));
  TT.freq = lines.map((L) => {
    const seq = L.stations.map(([code, name]) => { TT.stations[code] = { name, id: idOf[name] ?? code }; return code; });
    const off = [0]; // 從 up 起點算的累計車程
    for (const [, , run] of L.stations.slice(0, -1)) off.push(off.at(-1) + run);
    const hw = Object.fromEntries(Object.entries(L.headway).map(([d, list]) => [d, list.map(([t, h]) => [toMin(t), h])]));
    return { key: L.key, seq, off, first: toMin(L.first), last: toMin(L.last), hw };
  });
  return TT;
}

// t 到月台、往 dir 方向：首班前等首班，之後等班距一半，末班過了就沒車
function board(f, i, dir, day, t) {
  const lastAt = f.last + (dir === 'up' ? f.off[i] : f.off.at(-1) - f.off[i]);
  if (t > lastAt) return null;
  const hw = f.hw[day];
  const h = (hw.findLast(([s]) => s <= Math.max(t, f.first)) || hw[0])[1];
  return { dep: Math.min(t < f.first ? f.first : t + Math.ceil(h / 2), lastAt), h };
}

const cache = new Map();
function connections(TT, day) {
  if (!cache.has(day)) {
    const list = [];
    TT.edges.forEach((e, i) => {
      for (const [arr, term] of [[e[6][day], false], [e[7][day] || [], true]])
        for (let k = 0; k < arr.length; k += 2) list.push({ e: i, a: e[0], b: e[1], key: e[2], dep: arr[k], arr: arr[k + 1], term });
    });
    list.sort((x, y) => x.dep - y.dep);
    const keysAt = {};
    for (const e of TT.edges) for (const c of [e[0], e[1]]) (keysAt[c] ||= new Set()).add(e[2]);
    const freqAt = {};
    for (const f of TT.freq || []) f.seq.forEach((c, i) => { (keysAt[c] ||= new Set()).add(f.key); freqAt[`${c}|${f.key}`] = [f, i]; });
    // 同一實體車站（同 id）的所有月台節點，例：東門 R07|R、O06|O
    const nodesOf = {};
    for (const [code, s] of Object.entries(TT.stations))
      for (const k of keysAt[code] || []) (nodesOf[s.id] ||= []).push(`${code}|${k}`);
    cache.set(day, { list, nodesOf, freqAt });
  }
  return cache.get(day);
}

// 單次最早抵達；回傳 { dep, arr, conns:[…] } 或 null
function earliest(TT, from, to, day, t0, transfer) {
  const { list, nodesOf, freqAt } = connections(TT, day);
  const sid = (c) => TT.stations[c].id;
  const best = new Map(), via = new Map();
  const goal = new Set(nodesOf[sid(to)] || []);
  let end = null;
  const reach = (n, t, v) => {
    best.set(n, t);
    via.set(n, v);
    if (goal.has(n) && (!end || t < best.get(end))) end = n;
  };
  const walk = (code, nb, t) => {
    for (const n of nodesOf[sid(code)])
      if (n !== nb && t + transfer < (best.get(n) ?? Infinity)) {
        reach(n, t + transfer, { walk: nb });
        ride(n, t + transfer);
      }
  };
  // 班距估算路線不在 list 裡：一到月台就直接推算同線各站的抵達時間
  const ride = (n, t) => {
    if (!freqAt[n]) return;
    const [f, i] = freqAt[n];
    for (const [dir, step] of [['up', 1], ['down', -1]]) {
      const b = board(f, i, dir, day, t);
      if (!b) continue;
      for (let j = i + step; j >= 0 && j < f.seq.length; j += step) {
        const code = f.seq[j], nb = `${code}|${f.key}`, arr = b.dep + Math.abs(f.off[j] - f.off[i]);
        if (arr >= (best.get(nb) ?? Infinity)) continue;
        reach(nb, arr, { freq: true, a: f.seq[i], b: code, key: f.key, dir, dep: b.dep, arr, h: b.h, stops: Math.abs(j - i),
          end: f.seq[step > 0 ? f.seq.length - 1 : 0] });
        walk(code, nb, arr);
      }
    }
  };
  const start = nodesOf[sid(from)] || [];
  for (const n of start) best.set(n, t0);
  for (const n of start) ride(n, t0);
  for (const c of list) {
    if (c.dep < t0) continue;
    if (end && c.dep >= best.get(end)) break;
    const na = `${c.a}|${c.key}`, nb = `${c.b}|${c.key}`;
    if (!(best.get(na) <= c.dep) || c.arr >= (best.get(nb) ?? Infinity)) continue;
    const prev = via.get(na);
    if (prev?.term && prev.arr === c.dep) continue; // 區間車到終點就不再往前開
    reach(nb, c.arr, c);
    walk(c.b, nb, c.arr);
  }
  if (!end) return null;
  const conns = [];
  for (let n = end; via.has(n); ) {
    const v = via.get(n);
    if (v.walk) n = v.walk;
    else { conns.unshift(v); n = `${v.a}|${v.key}`; }
  }
  return { dep: conns[0].dep, arr: best.get(end), conns };
}

// 把連續同一班車的站間段合併成一段乘車
function legs(TT, conns) {
  const out = [];
  for (const c of conns) {
    if (c.freq) {
      out.push({ from: c.a, to: c.b, key: c.key, dir: c.dir, dep: c.dep, arr: c.arr, stops: c.stops, term: false, need: null, est: c.h, end: c.end });
      continue;
    }
    const e = TT.edges[c.e], last = out.at(-1);
    if (last && last.key === c.key && last.dir === e[3] && last.arr === c.dep && !last.term) {
      Object.assign(last, { to: c.b, arr: c.arr, stops: last.stops + 1, term: c.term });
    } else out.push({ from: c.a, to: c.b, key: c.key, dir: e[3], dep: c.dep, arr: c.arr, stops: 1, term: c.term, need: null });
    const leg = out.at(-1);
    if (e[4] < FILTER && !c.term) Object.assign(leg, { need: e[5], needAt: c.b, short: Object.keys(e[7]).length > 0 }); // 要搭往這個終點的車
  }
  for (const l of out) {
    if (l.short && l.to === l.needAt) l.need = null; // 剛好在區間車終點下車：哪種車都行
    const name = (c) => TT.stations[c].name;
    l.toward = l.est ? `往${name(l.end)}・約 ${l.est} 分一班` : l.term ? `往${name(l.to)}（區間車）` : l.need ? `往${name(l.need)}` : TT.labels[`${l.from}|${l.key}|${l.dir}`] || '';
  }
  return out;
}

// 同時到的較早班次 → 搭較早那班到 late 的第一個轉乘站，在那裡多等、接同一班車；寫不成這樣（例：繞去別站轉車）回傳 null
function waitLonger(TT, early, late) {
  const cont = (x, y) => !x.freq && !y.freq && x.key === y.key && TT.edges[x.e][3] === TT.edges[y.e][3] && x.arr === y.dep && !x.term;
  let m = 0;
  while (late.conns[m + 1] && cont(late.conns[m], late.conns[m + 1])) m++;
  const at = late.conns[m].b, rest = late.conns.slice(m + 1);
  const e0 = early.conns[0], l0 = late.conns[0];
  if (!rest.length || e0.freq || l0.freq || e0.a !== l0.a || e0.key !== l0.key || TT.edges[e0.e][3] !== TT.edges[l0.e][3]) return null;
  for (let p = 0; p < early.conns.length; p++) {
    if (p && !cont(early.conns[p - 1], early.conns[p])) return null;
    if (early.conns[p].b === at) return { dep: early.dep, arr: late.arr, conns: [...early.conns.slice(0, p + 1), ...rest] };
  }
  return null;
}

// 最近 n 種抵達時間的行程；較早出發但和較晚那班同時到的也列出，same＝較晚那班的出發時間
export function plan(TT, from, to, day, now, { transfer = 3, n = 3 } = {}) {
  if (TT.stations[from].id === TT.stations[to].id) return [];
  const res = [];
  for (let t = now, guard = 0, arrs = 0; guard < 200; guard++) {
    const j = earliest(TT, from, to, day, t, transfer);
    if (!j) break;
    if (res.at(-1)?.arr !== j.arr && arrs++ === n) break;
    res.push(j);
    const c0 = j.conns[0]; // 班距估算的第一段：下一個選項是晚一個班距的車
    t = c0.freq ? c0.dep + Math.max(1, Math.floor(c0.h / 2)) : j.dep + 1;
  }
  const out = [];
  for (const j of res) {
    const late = res.findLast((k) => k.arr === j.arr);
    if (late === j) out.push(j);
    else {
      const alt = waitLonger(TT, j, late);
      if (alt) out.push({ ...alt, same: late.dep });
    }
  }
  return out.map((j) => ({ dep: j.dep, arr: j.arr, same: j.same ?? null, legs: legs(TT, j.conns) }));
}

export const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
