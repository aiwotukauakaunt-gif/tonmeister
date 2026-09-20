/*
  Tonmeister — 親アプリ（keyboard）との橋渡し。

  keyboard の中では、同一オリジンの iframe として開かれる（record/index.html?host=keyboard）。
  同一オリジンなので、親の window.KB を直接呼べる。ここ以外は親を知らない。

  親から受け取るもの
    ・言語（KB_I18N.lang）と、その切り替え（<html lang> の変化を見る）
    ・アプリ音のバス（KB.audio.recStream：鍵盤・メトロノーム・伴奏ループ・ドローン）
  親に知らせるもの
    ・録音を始めた（KB.autoStartLog → 練習記録の計測が始まる）

  単体で開いたときは host.active が false で、何もしない。
*/

export const host = {
  active: false,
  name: '',
  parent: null,     // 親の window（同一オリジンのときだけ）
};

/** 起動時に一度。親が keyboard かどうかを見る。 */
export function detectHost() {
  const wanted = new URLSearchParams(location.search).get('host');
  if (!wanted) return false;
  try {
    const p = window.parent;
    if (p && p !== window && p.KB) {
      host.active = true;
      host.name = wanted;
      host.parent = p;
      document.documentElement.classList.add('hosted', 'hosted-' + wanted);
    }
  } catch {
    // 別オリジン：触れない。単体として振る舞う
  }
  return host.active;
}

/** 親の言語（'ja' | 'en'）。分からなければ null。 */
export function hostLang() {
  try { return host.parent && host.parent.KB_I18N ? host.parent.KB_I18N.lang : null; } catch { return null; }
}

/** 親の言語が変わったら呼ばれる。 */
export function watchHostLang(onChange) {
  if (!host.active) return;
  try {
    const root = host.parent.document.documentElement;
    let last = hostLang();
    const mo = new MutationObserver(() => {
      const now = hostLang();
      if (now && now !== last) { last = now; onChange(now); }
    });
    mo.observe(root, { attributes: true, attributeFilter: ['lang'] });
  } catch { }
}

/**
 * 親のアプリ音のバス（MediaStream）。親の AudioContext がまだ無ければ、ここで作らせる。
 * （iframe の中の操作でも、同一オリジンの親には「操作があった」ことが伝わるので resume できる）
 */
export function hostStream() {
  if (!host.active) return null;
  try {
    const KB = host.parent.KB;
    if (typeof KB.ensureCtx === 'function') KB.ensureCtx();
    const s = KB.audio && KB.audio.recStream;
    return s && s.getAudioTracks && s.getAudioTracks().length ? s : null;
  } catch { return null; }
}

/** 親の AudioContext のサンプルレート（アプリ音の元のレート）。 */
export function hostRate() {
  try { return host.parent.KB.audio.ctx ? host.parent.KB.audio.ctx.sampleRate : 0; } catch { return 0; }
}

/** 録音を始めたことを親に知らせる（練習記録の計測が始まる）。 */
export function hostRecordingStarted() {
  if (!host.active) return;
  try { const KB = host.parent.KB; if (typeof KB.autoStartLog === 'function') KB.autoStartLog(); } catch { }
}

/** 親に一言（トースト）。親に無ければ黙る。 */
export function hostToast(text) {
  if (!host.active) return;
  try { const KB = host.parent.KB; if (typeof KB.goalToast === 'function') KB.goalToast(text); } catch { }
}
