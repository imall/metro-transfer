// node scripts/test_router.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { plan, hhmm, serviceTime, withFreq } from '../router.js';

const ctx = { window: {} };
for (const f of ['timetables.js', 'freq.js']) vm.runInNewContext(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'), ctx);
const TT = withFreq(ctx.window.TT, ctx.window.FREQ);
const show = (r) => r.map((j) => `${hhmm(j.dep)}→${hhmm(j.arr)} ` + j.legs.map((l) => `[${l.from}→${l.to} ${l.toward} ${hhmm(l.dep)}-${hhmm(l.arr)}]`).join(' ')).join('\n');

// 信義安和 → 新莊：紅線往淡水方向，東門轉橘線，搭往迴龍的車
let r = plan(TT, 'R04', 'O18', 'wd', 8 * 60).filter((j) => !j.same);
console.log(show(r));
assert.equal(r.length, 3);
assert.ok(r[0].dep >= 8 * 60 && r[0].dep < r[1].dep && r[1].arr < r[2].arr);
assert.deepEqual(r[0].legs.map((l) => [l.from, l.key, l.to]), [['R04', 'R', 'R07'], ['O06', 'O', 'O18']]);
assert.match(r[0].legs[1].toward, /迴龍/);
assert.ok(r[0].legs[1].dep >= r[0].legs[0].arr + 3, '轉乘至少 3 分');

// 較早出發但同時到的也列出：轉乘 1 分時 18:11 和 18:14 都接 18:21 往迴龍
r = plan(TT, 'R04', 'O18', 'wd', 18 * 60 + 1, { transfer: 1 });
console.log(show(r));
const early = r.find((j) => j.dep === 18 * 60 + 11);
assert.ok(early && early.same === 18 * 60 + 14 && early.arr === r.find((j) => j.dep === early.same).arr);
assert.equal(new Set(r.map((j) => j.arr)).size, 3);
assert.ok(r.every((j, i) => !j.same || r[i + 1]?.arr === j.arr), '同時到的較早班次後面緊接較晚那班');
assert.deepEqual(early.legs.map((l) => [l.from, l.to, hhmm(l.dep)]), [['R04', 'R07', '18:11'], ['O06', 'O18', '18:21']], '在東門多等，不繞大橋頭');

// 東門 → 蘆洲：要搭往蘆洲的車
r = plan(TT, 'O06', 'O54', 'wd', 17 * 60);
console.log(show(r));
assert.ok(r.every((j) => j.legs.length === 1 && /蘆洲/.test(j.legs[0].toward)));

// 跨午夜：23:50 之後還有班次，時間 > 24h
r = plan(TT, 'R04', 'R10', 'wd', 23 * 60 + 50);
console.log(show(r));
assert.ok(r.length > 0 && r.at(-1).dep >= 24 * 60);

// 往大安的區間車也算（R06 → R05）
r = plan(TT, 'R07', 'R05', 'wd', 10 * 60, { n: 6 });
console.log(show(r));
assert.ok(r.some((j) => /區間車/.test(j.legs[0].toward)));

// 文湖線（班距估算）：平日 08:00 尖峰班距 3 分 → 等 2 分上車，之後每班間隔一個班距
r = plan(TT, 'BR01', 'BR08', 'wd', 8 * 60);
console.log(show(r));
assert.deepEqual(r.map((j) => j.dep), [8 * 60 + 2, 8 * 60 + 5, 8 * 60 + 8]);
assert.equal(r[0].arr - r[0].dep, 14);
assert.match(r[0].legs[0].toward, /南港展覽館.*3 分一班/);

// 首班前等 06:00 首班；末班過後沒車
assert.equal(plan(TT, 'BR24', 'BR19', 'wd', 5 * 60 + 30)[0].dep, 6 * 60);
assert.deepEqual(plan(TT, 'BR01', 'BR02', 'wd', 24 * 60 + 30), []);

// 文湖線轉高運量：動物園 → 台北車站，在大安或忠孝復興轉乘，轉乘時間要夠
r = plan(TT, 'BR01', 'R10', 'wd', 10 * 60);
console.log(show(r));
assert.ok(r.length === 3 && r.every((j) => j.legs[0].key === 'BR' && j.legs.length === 2));
assert.ok(r.every((j) => ['BR09', 'BR10'].includes(j.legs[0].to) && j.legs[1].dep >= j.legs[0].arr + 3));

// 高運量轉文湖線：新莊 → 內湖
r = plan(TT, 'O18', 'BR19', 'wd', 17 * 60);
console.log(show(r));
assert.ok(r.length > 0 && r.every((j) => j.legs.at(-1).key === 'BR' && j.legs.at(-1).to === 'BR19'));

// 環狀線（班距估算）：台北車站 → 中和，在板橋轉環狀線往大坪林
r = plan(TT, 'R10', 'Y12', 'wd', 8 * 60);
console.log(show(r));
assert.ok(r.length === 3 && r.every((j) => j.legs.at(-1).key === 'Y' && j.legs.at(-1).from === 'Y16' && /大坪林.*5 分一班/.test(j.legs.at(-1).toward)));
assert.ok(r.every((j) => j.legs.at(-1).dep >= j.legs.at(-2).arr + 3 + 3), '轉乘 3 分 + 等班距一半');

// 環狀線各轉乘站都接得上
for (const [y, other] of [['Y07', 'G04'], ['Y11', 'O02'], ['Y16', 'BL07'], ['Y18', 'O17']]) assert.equal(TT.stations[y].id, TT.stations[other].id, y);

assert.deepEqual(serviceTime(new Date(2026, 9, 26, 0, 30)), { day: 'su', min: 24 * 60 + 30 }); // 週一凌晨 → 週日營運日
console.log('OK');
