"""
Web 版（録音/web）を keyboard のリポジトリへ「本格録音」として写す。

    python web/tools/sync_keyboard.py [keyboard のフォルダ]

・録音/web → Keyboard/record/ を丸ごと同期（record/ にしか無いファイルは消す）
・keyboard の sw.js の資源一覧に record/ の中身を載せ、CACHE 名を中身のハッシュで刻む
  （何かが変われば名前が変わり、古いキャッシュが確実に捨てられる）
開発の本拠は 録音/web。keyboard 側の record/ は触らない（このスクリプトが上書きする）。
"""
import hashlib, io, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)                                   # 録音/web
ROOT = os.path.dirname(WEB)                                   # 録音
KB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), 'keyboard', 'Keyboard')
DEST = os.path.join(KB, 'record')

# 写さないもの（開発用・配信に不要）
SKIP_DIRS = {'tools', '__pycache__', '.git'}
SKIP_FILES = {'serve.js', '.nojekyll', 'README.md', 'README.html'}
# keyboard の SW に載せないもの（record/ の中で。単体で開いたときにしか要らない）
NOT_CACHED = {'sw.js', 'manifest.json', 'selftest.html', 'js/selftest.js', 'README.md'}

if not os.path.isdir(KB):
    sys.exit(f'keyboard のフォルダが見つかりません: {KB}')

def walk(base):
    out = []
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            if f in SKIP_FILES: continue
            rel = os.path.relpath(os.path.join(dp, f), base).replace('\\', '/')
            out.append(rel)
    return sorted(out)

# ---- 同期 ----
src_files = walk(WEB)
os.makedirs(DEST, exist_ok=True)
copied = 0
for rel in src_files:
    s = os.path.join(WEB, rel); d = os.path.join(DEST, rel)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    if not os.path.exists(d) or open(s, 'rb').read() != open(d, 'rb').read():
        shutil.copy2(s, d); copied += 1
removed = 0
for rel in walk(DEST):
    if rel not in src_files:
        os.remove(os.path.join(DEST, rel)); removed += 1
for dp, dns, fns in os.walk(DEST, topdown=False):
    if not dns and not fns and dp != DEST: os.rmdir(dp)

# ---- keyboard の sw.js ----
sw_path = os.path.join(KB, 'sw.js')
sw = io.open(sw_path, encoding='utf-8').read()
m = re.search(r'const ASSETS = \[(.*?)\];', sw, re.S)
assert m, 'sw.js に ASSETS が見つかりません'
own = [a for a in re.findall(r'"([^"]+)"', m.group(1)) if not a.startswith('./record/')]
record_assets = ['./record/' + rel for rel in src_files if rel not in NOT_CACHED and not rel.endswith('.py')]
assets = own + record_assets

# 中身のハッシュで CACHE 名を刻む（keyboard 自身のファイルも含める）
h = hashlib.sha1()
for a in assets:
    p = os.path.join(KB, a[2:]) if a != './' else os.path.join(KB, 'index.html')
    if os.path.isfile(p): h.update(a.encode()); h.update(open(p, 'rb').read())
cache = 'keyboard-' + h.hexdigest()[:10]

def fmt(items, indent='                '):
    lines, cur = [], ''
    for a in items:
        piece = f'"{a}", '
        if len(cur) + len(piece) > 100 and cur:
            lines.append(cur.rstrip()); cur = indent
        cur += piece
    lines.append(cur.rstrip().rstrip(','))
    return '\n'.join(lines)

sw = sw[:m.start()] + 'const ASSETS = [' + fmt(assets) + '];' + sw[m.end():]   # 位置を使う置換を先に
sw = re.sub(r'const CACHE = "[^"]*";', f'const CACHE = "{cache}";', sw, count=1)
io.open(sw_path, 'w', encoding='utf-8', newline='\n').write(sw)

print(f'record/: {len(src_files)} ファイル（写した {copied}・消した {removed}）')
print(f'sw.js: 資源 {len(assets)}（record/ {len(record_assets)}）, CACHE = {cache}')
