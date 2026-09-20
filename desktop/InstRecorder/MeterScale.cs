namespace InstRecorder;

/// <summary>
/// メーターの目盛り。dBFS を 0〜1 の位置に直す。
///
/// 素直に −60〜0 を線形に取ると「ちょうどいい」帯（−12〜−6）が右端 10% に潰れて、
/// いちばん合わせたい範囲がいちばん狭くなる。
/// そこで −12 dBFS を 62% の位置に固定し、そこから上を引き伸ばす2段の目盛りにしている。
/// こうすると帯の幅が 19% になり、目で狙える大きさになる。
/// </summary>
public static class MeterScale
{
    public const double FloorDb = -60;
    /// <summary>ここから上を引き伸ばす。</summary>
    public const double KneeDb = -18;
    /// <summary>引き伸ばしの起点（＝「ちょうどいい」帯の下端）。</summary>
    public const double KneeRatio = 0.62;

    public static double Ratio(double db)
    {
        if (double.IsNegativeInfinity(db) || db <= FloorDb) return 0;
        if (db >= 0) return 1;
        return db <= KneeDb
            ? (db - FloorDb) / (KneeDb - FloorDb) * KneeRatio
            : KneeRatio + (db - KneeDb) / -KneeDb * (1 - KneeRatio);
    }

    /*
      「ちょうどいい」帯は −18〜−8 dBTP。
      32bit float で録るなら熱く録る意味は無く、質を落とす唯一の場所は ADC やプリアンプの手前で歪むこと。
      だから余裕を取る方が質が上がる（Web 版と同じ）。
    */
    public const double GoodFromDb = -18;
    public const double GoodToDb = -8;
    public static readonly double GoodFrom = Ratio(GoodFromDb);
    public static readonly double GoodTo = Ratio(GoodToDb);
}
