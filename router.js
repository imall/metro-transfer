// 依時刻表配對資料（window.TT）算 A→B 最近幾班可行行程。
// TT.edges: [A, B, 線, 方向, 吻合率, 路線終點, {日別:[A發,B發,…]}, {日別:[…]}區間車在B終點]

const FILTER = 0.95; // 吻合率低於此 = 這段只有部分班次會開（分支 / 區間車）

// 凌晨 0–3 點算前一天營運日的 24–27 點
export function serviceTime(date) {
  const h = date.getHours();
  const d = new Date(date);
  if (h < 4) d.setDate(d.getDate() - 1);
  const wd = d.getDay();
  return { day: wd === 0 ? 'su' : wd === 6 ? 'sa' : 'wd', min: (h < 4 ? h + 24 : h) * 60 + date.getMinutes() };
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
    // 同一實體車站（同 id）的所有月台節點，例：東門 R07|R、O06|O
    const nodesOf = {};
    for (const [code, s] of Object.entries(TT.stations))
      for (const k of keysAt[code] || []) (nodesOf[s.id] ||= []).push(`${code}|${k}`);
    cache.set(day, { list, nodesOf });
  }
  return cache.get(day);
}

// 單次最早抵達；回傳 { dep, arr, conns:[…] } 或 null
function earliest(TT, from, to, day, t0, transfer) {
  const { list, nodesOf } = connections(TT, day);
  const sid = (c) => TT.stations[c].id;
  const best = new Map(), via = new Map();
  for (const n of nodesOf[sid(from)] || []) best.set(n, t0);
  const goal = new Set(nodesOf[sid(to)] || []);
  let end = null;
  for (const c of list) {
    if (c.dep < t0) continue;
    if (end && c.dep >= best.get(end)) break;
    const na = `${c.a}|${c.key}`, nb = `${c.b}|${c.key}`;
    if (!(best.get(na) <= c.dep) || c.arr >= (best.get(nb) ?? Infinity)) continue;
    const prev = via.get(na);
    if (prev?.term && prev.arr === c.dep) continue; // 區間車到終點就不再往前開
    best.set(nb, c.arr);
    via.set(nb, c);
    if (goal.has(nb) && (!end || c.arr < best.get(end))) end = nb;
    for (const n of nodesOf[sid(c.b)])
      if (n !== nb && c.arr + transfer < (best.get(n) ?? Infinity)) {
        best.set(n, c.arr + transfer);
        via.set(n, { walk: nb });
      }
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
    l.toward = l.term ? `往${name(l.to)}（區間車）` : l.need ? `往${name(l.need)}` : TT.labels[`${l.from}|${l.key}|${l.dir}`] || '';
  }
  return out;
}

// 最近 n 個行程（抵達時間不同者；同抵達取最晚出發）
export function plan(TT, from, to, day, now, { transfer = 3, n = 3 } = {}) {
  if (TT.stations[from].id === TT.stations[to].id) return [];
  const res = [];
  for (let t = now, guard = 0; guard < 200; guard++) {
    const j = earliest(TT, from, to, day, t, transfer);
    if (!j) break;
    if (res.length && res.at(-1).arr === j.arr) res[res.length - 1] = j;
    else if (res.length === n) break;
    else res.push(j);
    t = j.dep + 1;
  }
  return res.map((j) => ({ dep: j.dep, arr: j.arr, legs: legs(TT, j.conns) }));
}

export const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
