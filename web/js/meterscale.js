/*
  メーターの目盛り。dBFS を 0〜1 の位置に直す。

  素直に −60〜0 を線形に取ると「ちょうどいい」帯（−12〜−6）が右端 10% に潰れて、
  いちばん合わせたい範囲がいちばん狭くなる。
  そこで −12 dBFS を 62% の位置に固定し、そこから上を引き伸ばす2段の目盛りにしている。
  こうすると帯の幅が 19% になり、目で狙える大きさになる。
*/

export const FloorDb = -60;
export const KneeDb = -12;
export const KneeRatio = 0.62;

export function ratio(db) {
  if (!isFinite(db) || db <= FloorDb) return 0;
  if (db >= 0) return 1;
  return db <= KneeDb
    ? (db - FloorDb) / (KneeDb - FloorDb) * KneeRatio
    : KneeRatio + (db - KneeDb) / -KneeDb * (1 - KneeRatio);
}

/** 「ちょうどいい」帯（−12〜−6 dBFS）の位置。 */
/*
  「ちょうどいい」帯は −18〜−8 dBTP。
  32bit float で録るなら熱く録る意味は無く、質を落とす唯一の場所は ADC やプリアンプの手前で歪むこと。
  だから余裕を取る方が質が上がる。上限 −8 は True Peak（サンプルの間も含めた最大）で見る。
*/
export const GoodFromDb = -18;
export const GoodToDb = -8;
export const GoodFrom = ratio(GoodFromDb);
export const GoodTo = ratio(GoodToDb);

export function toDb(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

export function fmtDb(db) {
  return !isFinite(db) || db < -200 ? '-inf' : `${db.toFixed(1)} dBFS`;
}

export function mmss(seconds) {
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = Math.floor(seconds) % 60;
  return h >= 1
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function hmsT(seconds) {
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = Math.floor(seconds) % 60;
  const t = Math.floor((seconds % 1) * 10);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t}`;
}
