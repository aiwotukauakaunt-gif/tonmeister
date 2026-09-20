"""
README.md → README.html。
既存の README.html の <head>（黒漆に金の様式）と銘板はそのまま使い、本文だけ Markdown から作り直す。
目次は h2 から自動で作る。

    python web/tools/build_readme_html.py
"""
import re, io, os, sys
import markdown

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MD = os.path.join(ROOT, 'README.md')
HTML = os.path.join(ROOT, 'README.html')

old = io.open(HTML, encoding='utf-8').read()
head_end = old.index('</header>') + len('</header>')
head = old[:head_end]                     # <head>・<body>・<div class="sheet">・銘板

md = io.open(MD, encoding='utf-8').read()
# 先頭の H1 と、直後の1行説明は銘板が担うので外す
md = re.sub(r'^# .*\n', '', md, count=1)

body = markdown.markdown(md, extensions=['tables', 'fenced_code'], output_format='html5')

# h2 に id を付け、目次を作る
toc = []
def slug(i, text):
    return f's{i}'
def add_id(m):
    i = len(toc) + 1
    text = re.sub(r'<.*?>', '', m.group(1))
    toc.append((slug(i, text), text))
    return f'<h2 id="{slug(i, text)}">{m.group(1)}</h2>'
body = re.sub(r'<h2>(.*?)</h2>', add_id, body)
nav = '<nav class="toc">\n  <b>目次</b>\n  <ol>\n' + '\n'.join(f'    <li><a href="#{s}">{t}</a></li>' for s, t in toc) + '\n  </ol>\n</nav>\n'

out = head + '\n\n<div class="doublerule"></div>\n\n' + nav + '\n' + body + '\n\n</div>\n</body>\n</html>\n'
io.open(HTML, 'w', encoding='utf-8', newline='\n').write(out)
print(f'{HTML}: {len(out.splitlines())} 行, 目次 {len(toc)} 項')
