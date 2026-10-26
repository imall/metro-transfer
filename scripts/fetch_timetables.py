"""抓北捷各站 PDF 時刻表 → data/timetables.js（window.TT）。

用法：python -I scripts/fetch_timetables.py [--refresh]
  PDF / HTML 快取在 raw/，加 --refresh 才重新下載（時刻表改版時用）。
"""
import json, re, sys, time, urllib.request
from pathlib import Path

import pypdf

BASE = 'https://web.metro.taipei'
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'raw'
REFRESH = '--refresh' in sys.argv
DAYS = ('wd', 'sa', 'su')  # 平日 / 週六 / 週日及國定假日（PDF 三欄順序）


def get(url, name):
    f = RAW / name
    if REFRESH or not f.exists():
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            f.write_bytes(r.read())
        time.sleep(0.2)
    return f


def num(code):
    return int(re.search(r'\d+', code).group())


def parse_pdf(path):
    """回傳 {wd:[分鐘], sa:[...], su:[...]}，00–03 時算成隔天（+24h）。"""
    text = pypdf.PdfReader(path).pages[0].extract_text(extraction_mode='layout')
    lines = text.splitlines()
    head = next(i for i, l in enumerate(lines) if l.count('Hour') == 3)
    cols = [m.start() for m in re.finditer('Hour', lines[head])]
    out = {d: [] for d in DAYS}
    hour = [None] * 3
    for line in lines[head + 1:]:
        if not line.strip():
            continue
        if not re.fullmatch(r'[\d\s]+', line):
            break  # 進入附註區
        for m in re.finditer(r'\d+', line):
            c = sum(m.start() >= x - 2 for x in cols) - 1
            v = int(m.group())
            if m.start() < cols[c] + 3:  # 欄首＝小時
                hour[c] = v + 24 if v < 4 else v
            else:
                out[DAYS[c]].append(hour[c] * 60 + v)
    for d in DAYS:
        out[d].sort()
        assert len(out[d]) >= 30 and 5 * 60 <= out[d][0] < 8 * 60, (path.name, d, out[d][:3])
    return out


# 路線站序；OL＝橘線蘆洲支線，共用 O 的時刻表方向（往蘆洲/迴龍都算 up）
def build_routes(codes):
    def seq(p):
        return sorted((c for c in codes if re.fullmatch(p + r'\d+', c)), key=num)
    o = seq('O')
    return {
        'R': ('R', seq('R')), 'RA': ('RA', ['R22', 'R22A']),
        'G': ('G', seq('G')), 'GA': ('GA', ['G03', 'G03A']),
        'O': ('O', [c for c in o if num(c) < 50]),
        'OL': ('O', ['O12'] + [c for c in o if num(c) >= 50]),
        'BL': ('BL', seq('BL')),
    }


def pair(a, b, delta):
    """依序配對：A 站 t 發車 ↔ B 站 t+Δ±1 發車（PDF 分鐘四捨五入會有 ±1 誤差）。"""
    out, j = [], 0
    for t in a:
        while j < len(b) and b[j] < t + delta - 1:
            j += 1
        if j < len(b) and b[j] <= t + delta + 1:
            out += [t, b[j]]
            j += 1
    return out


def align(a, b):
    """取配對數最多的 Δ（同分取小）。回傳 ({日別: [發,到,發,到…]}, Δ, 吻合率)。"""
    delta = max(range(11), key=lambda x: (sum(len(pair(a[d], b[d], x)) for d in DAYS), -x))
    conns = {d: pair(a[d], b[d], delta) for d in DAYS}
    return conns, delta, round(sum(map(len, conns.values())) / 2 / sum(map(len, a.values())), 3)


def main():
    RAW.mkdir(exist_ok=True)
    js = get(f'{BASE}/pages2026/js/webstation.js', 'webstation.js').read_text('utf-8')
    stations = {}
    for code, name, sid in re.findall(r'\["(\w+) ([^"]+)", "(\d+)"\]', js):
        if re.fullmatch(r'(BL|R|G|O)\d+A?', code):
            stations[code] = {'name': name, 'id': sid}
    by_id = {}
    for code, s in stations.items():
        by_id.setdefault(s['id'], []).append(code)

    tt, labels, skipped = {}, {}, []
    for sid, codes in sorted(by_id.items()):
        html = get(f'{BASE}/pages2026/WebStation/{sid}/7', f'page_{sid}.html').read_text('utf-8')
        for pdf, label in re.findall(r'timetables/([\w.]+?)\?[^"]*" title ="\S+ \S+ (往[^"]+?)時刻表"', html):
            m = re.match(r'往(BL|BR|R|G|O|Y)(\d+)(A?)', label)
            letter, target = m.group(1), m.group(1) + m.group(2) + m.group(3)
            own = next((c for c in codes if re.fullmatch(letter + r'\d+A?', c)), None)
            if own is None:
                continue  # 文湖線、環狀線改用 data/freq.js 依班距估算
            if target.endswith('A') or own.endswith('A'):
                key, d = letter + 'A', 'up' if target.endswith('A') else 'down'
            else:
                key, d = letter, 'up' if num(target) > num(own) else 'down'
            k = f'{own}|{key}|{d}'
            assert k not in tt, (k, pdf)
            try:
                tt[k] = parse_pdf(get(f'{BASE}/img/ALL/timetables/{pdf}', pdf))
            except (StopIteration, AssertionError, TypeError) as e:
                skipped.append(f'{pdf} {label} ({type(e).__name__})')  # 非標準版面，如小碧潭接駁
                continue
            labels[k] = label

    edges = []
    for route, (key, seq) in build_routes(stations).items():
        for d, s in (('up', seq), ('down', seq[::-1])):
            prev = 2  # ponytail: 終點站沒有同方向時刻表，用前一段 Δ 估，最初預設 2 分
            for a, b in zip(s, s[1:]):
                ka, kb = f'{a}|{key}|{d}', f'{b}|{key}|{d}'
                if ka not in tt:
                    continue
                term = {}
                if kb in tt:
                    conns, delta, ratio = align(tt[ka], tt[kb])
                    if b in labels[ka]:  # 標籤寫「往B站」→ 沒配對到的是在 B 站終點的區間車
                        term = {x: [v for t in sorted(set(tt[ka][x]) - set(conns[x][::2])) for v in (t, t + delta)]
                                for x in DAYS}
                else:
                    delta, ratio = prev, 1.0
                    conns = {x: [v for t in tt[ka][x] for v in (t, t + delta)] for x in DAYS}
                prev = delta
                edges.append([a, b, key, d, ratio, s[-1], conns, term])

    # 自我檢查：東門往蘆洲/迴龍平日第一班 06:03；信義安和→大安森林公園對得上
    assert tt['O06|O|up']['wd'][0] == 6 * 60 + 3
    e = next(e for e in edges if e[:2] == ['R04', 'R05'] or e[:2] == ['R05', 'R06'])
    assert e[4] > 0.95, e
    weak = [e for e in edges if e[4] < 0.95]
    print(f'stations={len(stations)} timetables={len(tt)} edges={len(edges)}')
    print('跳過（版面非標準）:', skipped)
    print('區間車終點段:', [(e[0], e[1], e[3], len(e[7]['wd']) // 2) for e in edges if e[7]])
    print('低吻合率（分支/區間車過濾點）:', [(e[0], e[1], e[3], e[4]) for e in weak])

    data = {'stations': stations, 'labels': labels, 'edges': edges}
    (ROOT / 'data').mkdir(exist_ok=True)
    (ROOT / 'data' / 'timetables.js').write_text(
        'window.TT=' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', 'utf-8')


if __name__ == '__main__':
    main()
