"""
web/sw.js の資源一覧と CACHE 名を、web/ の中身から作り直す。

    python web/tools/build_sw.py

・資源一覧：web/ 配下の配信するファイル全部（開発用・README・自己検証・sw.js 自身は除く）
・CACHE 名：資源の中身の SHA-1 の先頭 10 桁。何かが変われば名前が変わり、古いキャッシュが確実に捨てられる
GitHub Pages への配信（.github/workflows/pages.yml）でも走るので、手で上げ忘れることがない。
sync_keyboard.py もこれを先に呼ぶ。
"""
import hashlib, io, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

SKIP_DIRS = {'tools', '__pycache__', '.git'}
SKIP_FILES = {'serve.js', '.nojekyll', 'README.md', 'README.html', 'sw.js', 'selftest.html'}
SKIP_REL = {'js/selftest.js'}


def assets():
    out = []
    for dp, dns, fns in os.walk(WEB):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            if f in SKIP_FILES or f.endswith('.py'): continue
            rel = os.path.relpath(os.path.join(dp, f), WEB).replace('\\', '/')
            if rel in SKIP_REL: continue
            out.append(rel)
    return sorted(out)


def build():
    rels = assets()
    h = hashlib.sha1()
    for rel in rels:
        h.update(rel.encode()); h.update(open(os.path.join(WEB, rel), 'rb').read())
    cache = 'tonmeister-' + h.hexdigest()[:10]
    items = ['./'] + ['./' + r for r in rels]

    lines, cur = [], '  '
    for a in items:
        piece = f"'{a}', "
        if len(cur) + len(piece) > 118 and cur.strip():
            lines.append(cur.rstrip()); cur = '  '
        cur += piece
    lines.append(cur.rstrip().rstrip(','))
    body = 'const ASSETS = [\n' + '\n'.join(lines) + '\n];'

    p = os.path.join(WEB, 'sw.js')
    sw = io.open(p, encoding='utf-8').read()
    m = re.search(r'const ASSETS = \[.*?\];', sw, re.S)
    assert m, 'sw.js に ASSETS が見つかりません'
    sw = sw[:m.start()] + body + sw[m.end():]
    sw = re.sub(r"const CACHE = '[^']*';", f"const CACHE = '{cache}';", sw, count=1)
    io.open(p, 'w', encoding='utf-8', newline='\n').write(sw)
    return len(items), cache


if __name__ == '__main__':
    n, cache = build()
    print(f'sw.js: 資源 {n}, CACHE = {cache}')
