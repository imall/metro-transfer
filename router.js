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
    const seq = L.stations.map(([code, name]) => {
      TT.stations[code] = { name, id: TT.stations[L.same?.[code]]?.id ?? idOf[name] ?? code };
      return code;
    });
    const off = [0]; // 從 up 起點算的累計車程
    for (const [, , run] of L.stations.slice(0, -1)) off.push(off.at(-1) + run);
    const hw = Object.fromEntries(Object.entries(L.headway).map(([d, list]) => [d, list.map(([t, h]) => [toMin(t), h])]));
    return { key: L.key, seq, off, first: toMin(L.first), last: toMin(L.last), hw };
  });
  return TT;
}

// 同月台轉乘（對面就是，不用走）：TT.cross「車站 id|線|方向」→ 可直接換的「線|方向」
export function withSamePlatform(TT, list = []) {
  const idOf = Object.fromEntries(Object.values(TT.stations).map((s) => [s.name, s.id]));
  TT.cross = new Map();
  const add = (id, a, b) => TT.cross.set(`${id}|${a}`, [...(TT.cross.get(`${id}|${a}`) || []), b]);
  for (const [name, k1, d1, k2, d2] of list) {
    add(idOf[name], `${k1}|${d1}`, `${k2}|${d2}`);
    add(idOf[name], `${k2}|${d2}`, `${k1}|${d1}`);
  }
  return TT;
}
const dirOf = (TT, c) => TT.edges[c.e][3];
// 同月台轉乘也要 1 分（走到對面、等門開）；自填的分鐘更少就用自填的
const crossWalk = (transfer, id) => Math.min(1, walkAt(transfer, id));
// 在 B 站下車後，同月台可直接換的月台節點與方向：[[節點, 方向], …]
function crossAt(TT, nodesOf, c) {
  const id = TT.stations[c.b].id, to = TT.cross?.get(`${id}|${c.key}|${dirOf(TT, c)}`);
  if (!to) return [];
  return to.map((kd) => {
    const [k, d] = kd.split('|');
    return [nodesOf[id].find((n) => n.endsWith(`|${k}`)), d];
  }).filter(([n]) => n);
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
    // 同一班車的下一段：從 B 站、同線同方向、在到 B 的那一分鐘開出（區間車到終點就沒有下一段）
    const dir = (c) => TT.edges[c.e][3];
    const at = new Map(list.map((c) => [`${c.a}|${c.key}|${dir(c)}|${c.dep}`, c]));
    for (const c of list) if (!c.term) c.next = at.get(`${c.b}|${c.key}|${dir(c)}|${c.arr}`);
    const keysAt = {};
    for (const e of TT.edges) for (const c of [e[0], e[1]]) (keysAt[c] ||= new Set()).add(e[2]);
    const freqAt = {};
    for (const f of TT.freq || []) f.seq.forEach((c, i) => { (keysAt[c] ||= new Set()).add(f.key); freqAt[`${c}|${f.key}`] = [f, i]; });
    // 同一實體車站（同 id）的所有月台節點，例：東門 R07|R、O06|O
    const nodesOf = {};
    for (const [code, s] of Object.entries(TT.stations))
      for (const k of keysAt[code] || []) (nodesOf[s.id] ||= []).push(`${code}|${k}`);
    for (const c of list) { // 掃描時常用的節點字串先算好
      c.na = `${c.a}|${c.key}`;
      c.nb = `${c.b}|${c.key}`;
      c.fk = `${c.na}|${dir(c)}`;
      c.cross = crossAt(TT, nodesOf, c);
    }
    cache.set(day, { list, nodesOf, freqAt });
  }
  return cache.get(day);
}

// list 依出發時間排序：第一個 dep ≥ t 的位置
function firstAt(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].dep < t) lo = m + 1; else hi = m; }
  return lo;
}

// 轉乘步行分鐘：transfer 是固定分鐘，或「車站 id → 分鐘」的函式（各站不同）
const walkAt = (transfer, id) => (typeof transfer === 'function' ? transfer(id) : transfer);

// 單次最早抵達；回傳 { dep, arr, conns:[…] } 或 null
function earliest(TT, from, to, day, t0, transfer) {
  const { list, nodesOf, freqAt } = connections(TT, day);
  const sid = (c) => TT.stations[c].id;
  // 每個月台節點記最早抵達時間，同時間再比搭了幾段車（少轉乘優先）
  const best = new Map(), legsAt = new Map(), via = new Map();
  const onTrain = new Map(), rode = new Map(); // 已搭上的班車：下一段 → { prev 這一段, k 段數 }；每段 → 同一班車的前一段
  const fast = new Map(), boardFrom = new Map(); // 同月台轉乘：「節點|方向」→ { t, k, nb 下車節點 }；上車段 → 下車節點
  const goal = new Set(nodesOf[sid(to)] || []);
  let end = null;
  const better = (n, t, k) => t < (best.get(n) ?? Infinity) || (t === best.get(n) && k < legsAt.get(n));
  const reach = (n, t, v, k) => {
    best.set(n, t);
    legsAt.set(n, k);
    via.set(n, v);
    if (goal.has(n) && (!end || t < best.get(end) || (t === best.get(end) && k < legsAt.get(end)))) end = n;
  };
  const walk = (code, nb, t, k) => {
    const w = t + walkAt(transfer, sid(code));
    for (const n of nodesOf[sid(code)])
      if (n !== nb && better(n, w, k)) {
        reach(n, w, { walk: nb }, k);
        ride(n, w, k);
      }
  };
  // 班距估算路線不在 list 裡：一到月台就直接推算同線各站的抵達時間
  const ride = (n, t, k) => {
    if (!freqAt[n]) return;
    const [f, i] = freqAt[n];
    for (const [dir, step] of [['up', 1], ['down', -1]]) {
      const b = board(f, i, dir, day, t);
      if (!b) continue;
      for (let j = i + step; j >= 0 && j < f.seq.length; j += step) {
        const code = f.seq[j], nb = `${code}|${f.key}`, arr = b.dep + Math.abs(f.off[j] - f.off[i]);
        if (!better(nb, arr, k + 1)) continue;
        reach(nb, arr, { freq: true, a: f.seq[i], b: code, key: f.key, dir, dep: b.dep, arr, h: b.h, stops: Math.abs(j - i),
          end: f.seq[step > 0 ? f.seq.length - 1 : 0] }, k + 1);
        walk(code, nb, arr, k + 1);
      }
    }
  };
  const start = nodesOf[sid(from)] || [];
  for (const n of start) best.set(n, t0), legsAt.set(n, 0);
  for (const n of start) ride(n, t0, 0);
  for (let x = firstAt(list, t0); x < list.length; x++) {
    const c = list[x], { na, nb } = c;
    if (end && c.dep >= best.get(end)) break;
    // 已經在這班車上就繼續坐（即使別條路比這班車早到 A 站）；在 A 站上車段數更少才改成從 A 上車
    const stay = onTrain.get(c);
    let k = stay ? stay.k : Infinity, prev = stay?.prev;
    const v = via.get(na);
    let from;
    if (best.get(na) <= c.dep && !(v?.term && v.arr === c.dep) && legsAt.get(na) + 1 < k) { // 區間車到終點就不再往前開
      k = legsAt.get(na) + 1;
      prev = undefined;
    }
    const f = fast.size ? fast.get(c.fk) : undefined;
    if (f && f.t <= c.dep && f.k + 1 < k) [k, prev, from] = [f.k + 1, undefined, f.nb];
    if (k === Infinity) continue;
    rode.set(c, prev);
    if (from) boardFrom.set(c, from);
    if (c.next) onTrain.set(c.next, { prev: c, k });
    for (const [n, d] of c.cross) {
      const t = c.arr + crossWalk(transfer, sid(c.b)), g = fast.get(`${n}|${d}`);
      if (!g || t < g.t || (t === g.t && k < g.k)) fast.set(`${n}|${d}`, { t, k, nb });
    }
    if (!better(nb, c.arr, k)) continue;
    reach(nb, c.arr, c, k);
    walk(c.b, nb, c.arr, k);
  }
  if (!end) return null;
  const conns = [];
  for (let n = end; via.has(n); ) {
    let v = via.get(n);
    if (v.walk) n = v.walk;
    else if (v.freq) { conns.unshift(v); n = `${v.a}|${v.key}`; }
    else for (; v; v = rode.get(v)) { conns.unshift(v); n = boardFrom.get(v) ?? `${v.a}|${v.key}`; } // 沿同一班車往回找到上車站
  }
  return { dep: conns[0].dep, arr: best.get(end), conns };
}

// 依搭乘段數分輪（RAPTOR 的做法）：第 k 輪＝最多搭 k 段車；回傳每個 k 比少搭一段更早到的行程
function byRides(TT, from, to, day, t0, transfer, maxK, limit) {
  const { list, nodesOf, freqAt } = connections(TT, day);
  const sid = (c) => TT.stations[c].id;
  const goal = nodesOf[sid(to)] || [], start = nodesOf[sid(from)] || [];
  const vias = [new Map()], rodes = [null], boards = [null], out = [];
  let prev = new Map(start.map((n) => [n, t0])), fresh = start, prevFast = new Map(), bound = limit + 1;
  const viaOf = (r, n) => { for (; r >= 1; r--) if (vias[r].has(n)) return [r, vias[r].get(n)]; return [0, null]; };
  for (let k = 1; k <= maxK && (fresh.length || prevFast.size); k++) {
    const best = new Map(prev), via = new Map(), rode = new Map(), onTrain = new Map(), boarded = new Map(), fast = new Map();
    const reach = (n, t, v) => { best.set(n, t); via.set(n, v); };
    const walk = (code, nb, t) => {
      const w = t + walkAt(transfer, sid(code));
      for (const n of nodesOf[sid(code)]) if (n !== nb && w < (best.get(n) ?? Infinity)) reach(n, w, { walk: nb });
    };
    for (const n of fresh) { // 班距估算路線：從上一輪新到的月台上車
      if (!freqAt[n]) continue;
      const [f, i] = freqAt[n];
      for (const [dir, step] of [['up', 1], ['down', -1]]) {
        const b = board(f, i, dir, day, prev.get(n));
        if (!b) continue;
        for (let j = i + step; j >= 0 && j < f.seq.length; j += step) {
          const code = f.seq[j], nb = `${code}|${f.key}`, arr = b.dep + Math.abs(f.off[j] - f.off[i]);
          if (arr >= (best.get(nb) ?? Infinity)) continue;
          reach(nb, arr, { freq: true, a: f.seq[i], b: code, key: f.key, dir, dep: b.dep, arr, h: b.h, stops: Math.abs(j - i),
            end: f.seq[step > 0 ? f.seq.length - 1 : 0] });
          walk(code, nb, arr);
        }
      }
    }
    // 只從上一輪新到的月台上車（更早到的月台，上一輪就搭過了）；從其中最早的時間開始掃
    const fromSet = new Set(fresh);
    const t1 = Math.min(...fresh.map((n) => prev.get(n)), ...[...prevFast.values()].map((f) => f.t));
    for (let x = firstAt(list, t1); x < list.length; x++) {
      const c = list[x], { na, nb } = c;
      if (c.dep >= bound) break;
      let p = onTrain.get(c) ?? null, from = null; // 這一輪已在這班車上
      if (!p) {
        let ok = fromSet.has(na) && prev.get(na) <= c.dep;
        if (ok) { const v = viaOf(k - 1, na)[1]; ok = !(v?.term && v.arr === c.dep); } // 區間車到終點就不再往前開
        if (!ok) {
          const f = prevFast.size ? prevFast.get(c.fk) : undefined;
          if (!(f && f.t <= c.dep)) continue;
          from = f.nb; // 上一輪下車後同月台直接換
        }
      }
      rode.set(c, p);
      if (from) boarded.set(c, from);
      if (c.next) onTrain.set(c.next, c);
      const tc = c.arr + crossWalk(transfer, sid(c.b));
      for (const [n, d] of c.cross) if (!(fast.get(`${n}|${d}`)?.t <= tc)) fast.set(`${n}|${d}`, { t: tc, nb });
      if (c.arr < (best.get(nb) ?? Infinity)) { reach(nb, c.arr, c); walk(c.b, nb, c.arr); }
    }
    vias.push(via); rodes.push(rode); boards.push(boarded);
    let end = null;
    for (const g of goal) if (via.has(g) && best.get(g) < bound && (!end || best.get(g) < best.get(end))) end = g;
    if (end) {
      bound = best.get(end);
      const conns = [];
      for (let r = k, n = end; ; ) {
        const [rr, v] = viaOf(r, n);
        if (!v) break;
        r = rr;
        if (v.walk) { n = v.walk; continue; }
        if (v.freq) conns.unshift(v), (n = `${v.a}|${v.key}`);
        else for (let c = v; c; c = rodes[r].get(c)) conns.unshift(c), (n = boards[r].get(c) ?? `${c.a}|${c.key}`);
        r--;
      }
      out.push({ k, dep: conns[0].dep, arr: bound, conns });
    }
    fresh = [...via.keys()];
    prev = best;
    prevFast = fast;
  }
  return out;
}

// 最快與少轉乘取捨：每多搭一段車要早到 penalty 分以上才選它。
// 先算最快的（搭 k 段、arr 到）：少搭的只要不晚於 arr + penalty×(k−1) 都可能被選，多搭的不可能更快
function balanced(TT, from, to, day, t0, transfer, penalty) {
  const fast = earliest(TT, from, to, day, t0, transfer);
  if (!fast) return null;
  const k = legs(TT, fast.conns).length;
  let pick = { ...fast, k };
  if (k > 1) for (const j of byRides(TT, from, to, day, t0, transfer, k - 1, fast.arr + penalty * (k - 1)))
    if (j.arr + penalty * j.k < pick.arr + penalty * pick.k) pick = j;
  return pick;
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
// penalty：每多轉一次車要快幾分才推薦（null＝只看最快）
export function plan(TT, from, to, day, now, { transfer = 3, n = 3, penalty = 5 } = {}) {
  if (TT.stations[from].id === TT.stations[to].id) return [];
  const res = [];
  for (let t = now, guard = 0, arrs = 0; guard < 200; guard++) {
    const j = penalty == null ? earliest(TT, from, to, day, t, transfer) : balanced(TT, from, to, day, t, transfer, penalty);
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
  return out.map((j) => {
    const ls = legs(TT, j.conns);
    ls.forEach((l, k) => { // 換月台（不同站碼或不同路線）才要走路
      const p = ls[k - 1];
      if (!p || (l.from === p.to && l.key === p.key)) return;
      const id = TT.stations[l.from].id;
      l.cross = !!TT.cross?.get(`${id}|${p.key}|${p.dir}`)?.includes(`${l.key}|${l.dir}`); // 同月台轉乘
      l.walk = (l.cross ? crossWalk : walkAt)(transfer, id);
    });
    return { dep: j.dep, arr: j.arr, same: j.same ?? null, legs: ls };
  });
}

export const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
