using InstRecorder.Audio;

namespace InstRecorder;

/// <summary>
/// 一度読んだ波形を覚えておく。
///
/// 「重ねる」タブに切り替えるたびにレーンを作り直すので、
/// 素直に書くとそのたびに全トラックのファイルを読み直すことになる。
/// 波形は録りごとに決まっていて途中で変わらないので、覚えておいてよい。
/// </summary>
internal static class WaveformCache
{
    /// <summary>覚えておく本数。長い録りでも1本あたり数MBに収まる。</summary>
    private const int Capacity = 32;

    private static readonly Dictionary<Take, WaveformData?> Map = new();
    private static readonly List<Take> Order = new();

    /// <summary>読めなければ null。読み込みはすべて呼び出し側のスレッド外で行う。</summary>
    public static async Task<WaveformData?> GetAsync(Take take)
    {
        if (Map.TryGetValue(take, out var cached))
        {
            Touch(take);
            return cached;
        }

        WaveformData? built;
        try
        {
            built = await Task.Run(() => WaveformData.Build(take));
        }
        catch
        {
            built = null;
        }

        Map[take] = built;
        Touch(take);
        Trim();
        return built;
    }

    /// <summary>中身が変わった録りを忘れる（切り出し・録り直しで新しい録りができたとき用）。</summary>
    public static void Forget(Take take)
    {
        Map.Remove(take);
        Order.Remove(take);
    }

    public static void Clear()
    {
        Map.Clear();
        Order.Clear();
    }

    private static void Touch(Take take)
    {
        Order.Remove(take);
        Order.Add(take);
    }

    private static void Trim()
    {
        while (Order.Count > Capacity)
        {
            var oldest = Order[0];
            Order.RemoveAt(0);
            Map.Remove(oldest);
        }
    }
}
