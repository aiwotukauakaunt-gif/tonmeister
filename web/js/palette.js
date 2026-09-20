/*
  Tonmeister — canvas で使う色を CSS 変数から引く。

  波形・メーター・目盛りは canvas に描くので CSS が届かない。ここで theme.css の変数を読んで渡す。
  keyboard の中では host-keyboard.css が変数を差し替えるので、canvas も同じ配色になる。
  読むのは高くつくので控えておき、配色が変わったら resetPalette() で捨てる。
*/

const cache = new Map();

/** `--good` のような変数名から色を返す。無ければ fallback。 */
export function color(name, fallback = '#000') {
  let v = cache.get(name);
  if (v === undefined) {
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { v = ''; }
    if (!v) v = fallback;
    cache.set(name, v);
  }
  return v;
}

/** 色に不透明度を掛ける（#RRGGBB / rgb() / rgba() を rgba() に）。 */
export function alpha(c, a) {
  const m6 = /^#([0-9a-f]{6})$/i.exec(c);
  if (m6) { const n = parseInt(m6[1], 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
  const m3 = /^#([0-9a-f]{3})$/i.exec(c);
  if (m3) { const h = m3[1]; return `rgba(${parseInt(h[0] + h[0], 16)},${parseInt(h[1] + h[1], 16)},${parseInt(h[2] + h[2], 16)},${a})`; }
  const mr = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (mr) { const p = mr[1].split(',').map(x => x.trim()); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; }
  return c;
}

/** 配色が変わったとき（keyboard のライト／ダーク切替）。 */
export function resetPalette() { cache.clear(); }

// よく使う色に名前を付けておく
export const P = {
  good: () => color('--good', '#C9A227'),
  goodBand: () => color('--good-band', 'rgba(201,162,39,.6)'),
  levelFrom: () => color('--level-from', '#7A6119'),
  ringTrack: () => color('--ring-track', '#4A4130'),
  faint: () => color('--fg-faint', '#9E937A'),
  waveLine: () => color('--wave-line', '#5A4E33'),
  waveDim: () => color('--wave-dim', '#B3A98F'),
  rec: () => color('--rec-bright', '#A03A2E'),
  blue: () => color('--cmp-b', '#4E7CB5'),
  copper: () => color('--cmp-c', '#B06A2C'),
  mono: () => color('--mono', 'Consolas, monospace'),
};
