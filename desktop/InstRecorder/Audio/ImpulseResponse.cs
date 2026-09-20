using System.IO;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace InstRecorder.Audio;

/// <summary>
/// 響きのもと（インパルス応答）。左右2本の波形。
///
/// **直接音は入っていない。** ここに入っているのは壁や天井から返ってくるぶんだけで、
/// 直接音は元の録音がそのまま担う。だから響きを足しても、もとの音は二重にならない。
///
/// エネルギーは 1 に正規化してある（左右の平均で Σh² = 1）。
/// 白色雑音を通したとき、出てくる響きの実効値が元の音とだいたい同じ大きさになる。
/// 「響きの量 100%」が「直接音と同じくらいの響き」を意味するのはこのため。
/// </summary>
public sealed class ImpulseResponse
{
    /// <summary>内蔵ホールの波形の長さ ÷ 響きの長さ。−60dB まで落ちきってから少し余裕を持たせる。</summary>
    public const double LengthFactor = 1.25;

    public float[] Left { get; }
    public float[] Right { get; }
    public int SampleRate { get; }
    public string Description { get; }

    public double Seconds => Left.Length / (double)SampleRate;

    public ImpulseResponse(float[] left, float[] right, int sampleRate, string description)
    {
        if (left.Length != right.Length)
            throw new ArgumentException("左右の長さが違います。");
        Left = left;
        Right = right;
        SampleRate = sampleRate;
        Description = description;
    }

    /// <summary>左右の平均エネルギーが 1 になるようそろえる。</summary>
    public static void NormalizeEnergy(float[] left, float[] right)
    {
        double sum = 0;
        for (int i = 0; i < left.Length; i++) sum += (double)left[i] * left[i] + (double)right[i] * right[i];
        double mean = sum / 2.0;
        if (mean <= 1e-30) return;
        float g = (float)(1.0 / Math.Sqrt(mean));
        for (int i = 0; i < left.Length; i++) { left[i] *= g; right[i] *= g; }
    }
}

/// <summary>直方体のホールの寸法と、音源・聴取点の置き方。</summary>
internal readonly record struct HallShape(double Width, double Depth, double Height, double Distance)
{
    public double Volume => Width * Depth * Height;

    public double Surface => 2 * (Width * Depth + Width * Height + Depth * Height);

    public static HallShape Of(HallKind kind) => kind switch
    {
        //               幅     奥行き   高さ   音源から聴取点まで
        HallKind.Room => new(6.5, 8.5, 3.6, 3.0),
        HallKind.Chamber => new(14.0, 20.0, 9.0, 6.0),
        HallKind.Hall => new(24.0, 44.0, 16.0, 9.0),
        HallKind.Church => new(17.0, 48.0, 20.0, 10.0),
        _ => new(24.0, 44.0, 16.0, 9.0),
    };
}

/// <summary>
/// 内蔵ホールの響きを作る。
///
/// 前半（初期反射）は**鏡像法**で出す。直方体の部屋の壁を鏡に見立てて音源を映し、
/// 映った音源から聴取点までの距離をそのまま遅れと減衰にする。
/// つまり「どの壁からいつ返ってくるか」は寸法から決まっていて、でたらめには置いていない。
///
/// 後半（後部残響）は、反射が数え切れないほど混ざりあった状態なので雑音で作る。
/// 高い音ほど早く減るよう、低・中・高の3帯域に分けてそれぞれ別の速さで減衰させる。
/// 壁の吸音率はザビーンの式で響きの長さから逆算するので、
/// 「響きの長さ」つまみを動かすと初期反射の強さも一緒に変わる。
/// </summary>
public static class HallImpulse
{
    private const double C = 343.0;   // 音速 m/s

    /// <summary>内蔵ホールの響きを組み立てる。</summary>
    public static ImpulseResponse Build(HallKind kind, double rt60, int rate)
    {
        var shape = HallShape.Of(kind);
        rt60 = Math.Clamp(rt60, HallReverb.MinDecaySeconds, HallReverb.MaxDecaySeconds);

        int length = (int)Math.Ceiling(rt60 * ImpulseResponse.LengthFactor * rate);
        var left = new float[length];
        var right = new float[length];

        // 壁の吸音率をザビーンの式から逆算する。α が大きいほど反射が弱い。
        double alpha = Math.Clamp(0.161 * shape.Volume / (shape.Surface * rt60), 0.02, 0.90);
        double beta = Math.Sqrt(1 - alpha);

        // 混ざりきるまでの時間。ここを境に、数えられる反射から雑音へ渡す。
        double tMix = Math.Clamp(0.002 * Math.Sqrt(shape.Volume), 0.02, 0.12);

        BuildEarly(left, right, shape, beta, tMix, rate);
        BuildLate(left, right, rt60, tMix, rate, seed: 20250819 + (int)kind);

        // 末尾を短く絞って、切れ目のプツッという音が出ないようにする
        int fade = Math.Min(length, (int)(0.05 * length));
        for (int i = 0; i < fade; i++)
        {
            float g = (float)(1.0 - i / (double)fade);
            left[length - fade + i] *= g;
            right[length - fade + i] *= g;
        }

        ImpulseResponse.NormalizeEnergy(left, right);

        string desc = $"{HallReverb.DisplayName(kind)} {shape.Width:0}×{shape.Depth:0}×{shape.Height:0}m " +
                      $"/ 響き {rt60:0.0}秒 / 吸音率 {alpha:0.00}";
        return new ImpulseResponse(left, right, rate, desc);
    }

    /// <summary>
    /// 鏡像法。壁ごとの反射回数だけ β を掛け、距離で割る。
    /// 反射を多く重ねた音ほど高い音が削れるので、回数で3つの束に分けて別々に鈍らせる。
    /// </summary>
    private static void BuildEarly(float[] left, float[] right, HallShape shape,
                                   double beta, double tMix, int rate)
    {
        const int Order = 3;

        // 音源は幅の真ん中から少しずらし、左右の聴取点も奥行き・高さを少しずらす。
        // 完全に対称に置くと、横壁を使わない反射（床・天井・前後の壁）が左右まったく同じ時刻に
        // 届いてしまい、響きが真ん中で団子になる。実際のホールでも対称に座ることはない。
        double sx = shape.Width * 0.42, sy = shape.Depth * 0.15, sz = 1.4;
        double baseY = sy + shape.Distance;
        double[] rxs = { shape.Width * 0.5 - 0.85, shape.Width * 0.5 + 0.85 };
        double[] rys = { baseY, baseY + 0.25 };
        double[] rzs = { 1.45, 1.58 };

        // 反射回数の少ない順に3つの束。あとでそれぞれ違う強さで高い音を削る
        var bands = new[] { 2, 5, int.MaxValue };
        double[] cutoff = { 12000, 6000, 2500 };

        double window = tMix * 1.8;
        int limit = Math.Min(left.Length, (int)Math.Ceiling(window * rate) + 2);

        for (int ch = 0; ch < 2; ch++)
        {
            double rx = rxs[ch], ry = rys[ch], rz = rzs[ch];
            var target = ch == 0 ? left : right;
            var bucket = new float[bands.Length][];
            for (int b = 0; b < bands.Length; b++) bucket[b] = new float[limit];

            double direct = Dist(sx, sy, sz, rx, ry, rz);

            for (int qx = 0; qx <= 1; qx++)
                for (int mx = -Order; mx <= Order; mx++)
                    for (int qy = 0; qy <= 1; qy++)
                        for (int my = -Order; my <= Order; my++)
                            for (int qz = 0; qz <= 1; qz++)
                                for (int mz = -Order; mz <= Order; mz++)
                                {
                                    int refl = Math.Abs(mx - qx) + Math.Abs(mx)
                                             + Math.Abs(my - qy) + Math.Abs(my)
                                             + Math.Abs(mz - qz) + Math.Abs(mz);
                                    if (refl == 0) continue;   // 直接音は入れない

                                    double ix = (1 - 2 * qx) * sx + 2 * mx * shape.Width;
                                    double iy = (1 - 2 * qy) * sy + 2 * my * shape.Depth;
                                    double iz = (1 - 2 * qz) * sz + 2 * mz * shape.Height;

                                    double d = Dist(ix, iy, iz, rx, ry, rz);
                                    double t = (d - direct) / C;
                                    if (t < 0 || t >= window) continue;

                                    double amp = Math.Pow(beta, refl) * direct / Math.Max(d, 0.5);
                                    if (Math.Abs(amp) < 1e-4) continue;

                                    // 混ざりきる手前で数えられる反射を引いていく
                                    double taper = t <= tMix * 0.6
                                        ? 1.0
                                        : Math.Max(0, 1.0 - (t - tMix * 0.6) / (window - tMix * 0.6));
                                    amp *= taper;

                                    int b = 0;
                                    while (b < bands.Length - 1 && refl > bands[b]) b++;

                                    double pos = t * rate;
                                    int i0 = (int)pos;
                                    double frac = pos - i0;
                                    if (i0 >= 0 && i0 < limit) bucket[b][i0] += (float)(amp * (1 - frac));
                                    if (i0 + 1 < limit) bucket[b][i0 + 1] += (float)(amp * frac);
                                }

            for (int b = 0; b < bands.Length; b++)
            {
                LowPass(bucket[b], cutoff[b], rate);
                for (int i = 0; i < limit; i++) target[i] += bucket[b][i];
            }
        }
    }

    /// <summary>
    /// 後部残響。雑音を3帯域に分け、低い音ほどゆっくり、高い音ほど早く減らす。
    /// 左右は別の雑音から作るので相関がなく、響きが左右に広がって聞こえる。
    /// </summary>
    private static void BuildLate(float[] left, float[] right, double rt60, double tMix, int rate, int seed)
    {
        int n = left.Length;
        var rng = new Random(seed);

        // 初期反射が受け渡す高さに合わせて後部残響の音量を決める。
        // 継ぎ目で段差ができないよう、渡す時点の実効値をそろえる。
        double handover = tMix;
        double earlyLevel = Rms(left, right, (int)(handover * 0.7 * rate), (int)(handover * 0.35 * rate));

        for (int ch = 0; ch < 2; ch++)
        {
            var target = ch == 0 ? left : right;
            var noise = new double[n];
            for (int i = 0; i < n; i++) noise[i] = rng.NextDouble() * 2 - 1;

            var low = new double[n];
            var lowMid = new double[n];
            OnePole(noise, low, 400, rate);
            OnePole(noise, lowMid, 3500, rate);

            var tail = new double[n];
            double kLow = Decay(rt60 * 1.15, rate);
            double kMid = Decay(rt60, rate);
            double kHigh = Decay(rt60 * 0.60, rate);
            double eLow = 1, eMid = 1, eHigh = 1;

            for (int i = 0; i < n; i++)
            {
                double lo = low[i];
                double hi = noise[i] - lowMid[i];
                double mid = noise[i] - lo - hi;

                double t = i / (double)rate;
                // 立ち上がり：初期反射から受け取る形で入り、それより前には出さない
                double rise = 1.0 - Math.Exp(-t / (handover * 0.5));

                tail[i] = rise * (0.55 * lo * eLow + 1.00 * mid * eMid + 0.45 * hi * eHigh);

                eLow *= kLow; eMid *= kMid; eHigh *= kHigh;
            }

            double tailLevel = RmsOne(tail, (int)(handover * 0.7 * rate), (int)(handover * 0.35 * rate));
            double gain = tailLevel > 1e-12 ? earlyLevel / tailLevel : 0;
            for (int i = 0; i < n; i++) target[i] += (float)(tail[i] * gain);
        }
    }

    /// <summary>1サンプルあたりの減衰係数。RT60 秒で 60dB（＝1/1000）落ちる。</summary>
    private static double Decay(double rt60, int rate) =>
        Math.Pow(10, -3.0 / Math.Max(1e-6, rt60 * rate));

    private static double Dist(double ax, double ay, double az, double bx, double by, double bz)
    {
        double dx = ax - bx, dy = ay - by, dz = az - bz;
        return Math.Sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static void OnePole(double[] src, double[] dst, double cutoff, int rate)
    {
        double a = Math.Exp(-2.0 * Math.PI * cutoff / rate);
        double y = 0;
        for (int i = 0; i < src.Length; i++)
        {
            y = y * a + src[i] * (1 - a);
            dst[i] = y;
        }
    }

    private static void LowPass(float[] buf, double cutoff, int rate)
    {
        if (cutoff >= rate * 0.45) return;
        double a = Math.Exp(-2.0 * Math.PI * cutoff / rate);
        double y = 0;
        for (int i = 0; i < buf.Length; i++)
        {
            y = y * a + buf[i] * (1 - a);
            buf[i] = (float)y;
        }
    }

    private static double Rms(float[] a, float[] b, int start, int count)
    {
        if (count <= 0 || start >= a.Length) return 0;
        count = Math.Min(count, a.Length - start);
        double s = 0;
        for (int i = start; i < start + count; i++) s += (double)a[i] * a[i] + (double)b[i] * b[i];
        return Math.Sqrt(s / (2.0 * count));
    }

    private static double RmsOne(double[] a, int start, int count)
    {
        if (count <= 0 || start >= a.Length) return 0;
        count = Math.Min(count, a.Length - start);
        double s = 0;
        for (int i = start; i < start + count; i++) s += a[i] * a[i];
        return Math.Sqrt(s / count);
    }
}

/// <summary>
/// 実在のホールを録ったインパルス応答 WAV を読む。
/// セッションのサンプルレートに合わせ、先頭の直接音は取り除く（直接音は元の録音が担うため）。
/// </summary>
public static class ImpulseFile
{
    /// <summary>これより長いぶんは切り捨てる。</summary>
    public const double MaxSeconds = 10.0;

    public static ImpulseResponse Load(string path, int rate)
    {
        using var reader = new AudioFileReader(path);
        ISampleProvider src = reader;
        if (reader.WaveFormat.SampleRate != rate)
            src = new WdlResamplingSampleProvider(reader, rate);

        int channels = src.WaveFormat.Channels;
        int cap = (int)(MaxSeconds * rate) * channels;

        var acc = new List<float>(Math.Min(cap, 1 << 20));
        var buf = new float[rate * channels / 4];
        int n;
        while (acc.Count < cap && (n = src.Read(buf, 0, buf.Length)) > 0)
        {
            for (int i = 0; i < n && acc.Count < cap; i++) acc.Add(buf[i]);
        }

        int frames = acc.Count / channels;
        if (frames < 16) throw new InvalidDataException("響きのもとにするには短すぎます。");

        var left = new float[frames];
        var right = new float[frames];
        for (int i = 0; i < frames; i++)
        {
            left[i] = acc[i * channels];
            right[i] = channels >= 2 ? acc[i * channels + 1] : left[i];
        }

        (left, right) = TrimDirect(left, right, rate);
        ImpulseResponse.NormalizeEnergy(left, right);

        return new ImpulseResponse(left, right, rate,
            $"{Path.GetFileNameWithoutExtension(path)} / {left.Length / (double)rate:0.00}秒");
    }

    /// <summary>
    /// 先頭の無音を落とし、そこに孤立した山（＝直接音）があればそれも落とす。
    ///
    /// 判定は「音が届いた瞬間から 20ms 以内に山があり、その山が直後 20ms の実効値より
    /// 6dB 以上大きい」とき。ホールの響きだけを録った IR は山が突き出ないので、そのまま残る。
    /// </summary>
    private static (float[], float[]) TrimDirect(float[] left, float[] right, int rate)
    {
        int n = left.Length;
        float peak = 0;
        for (int i = 0; i < n; i++) peak = Math.Max(peak, Math.Max(Math.Abs(left[i]), Math.Abs(right[i])));
        if (peak <= 0) return (left, right);

        float floor = peak * 0.001f;   // −60dB
        int arrival = 0;
        while (arrival < n && Math.Abs(left[arrival]) < floor && Math.Abs(right[arrival]) < floor) arrival++;
        if (arrival >= n) return (left, right);

        int window = (int)(0.020 * rate);
        int peakAt = arrival;
        float peakVal = 0;
        for (int i = arrival; i < Math.Min(n, arrival + window); i++)
        {
            float v = Math.Max(Math.Abs(left[i]), Math.Abs(right[i]));
            if (v > peakVal) { peakVal = v; peakAt = i; }
        }

        int start = arrival;
        int after = Math.Min(n, peakAt + 1 + window);
        double s = 0; int c = 0;
        for (int i = peakAt + 1; i < after; i++)
        {
            s += (double)left[i] * left[i] + (double)right[i] * right[i];
            c += 2;
        }
        double followRms = c > 0 ? Math.Sqrt(s / c) : 0;

        if (peakVal > followRms * 2.0 && followRms > 0)
            start = Math.Min(n - 1, peakAt + (int)(0.003 * rate));

        int len = n - start;
        var l = new float[len];
        var r = new float[len];
        Array.Copy(left, start, l, 0, len);
        Array.Copy(right, start, r, 0, len);

        // 切った先頭に段差を作らないよう 3ms かけて立ち上げる
        int fade = Math.Min(len, (int)(0.003 * rate));
        for (int i = 0; i < fade; i++)
        {
            float g = i / (float)fade;
            l[i] *= g; r[i] *= g;
        }
        return (l, r);
    }
}

/// <summary>
/// 作った響きのもとを覚えておく。設定を触るたびに作り直すと、再生の頭が引っかかるため。
/// </summary>
public static class ImpulseCache
{
    private const int MaxEntries = 4;

    private static readonly object Gate = new();
    private static readonly Dictionary<string, ImpulseResponse> Cache = new();
    private static readonly List<string> Order = new();
    private static readonly Dictionary<string, double> FileSeconds = new();

    /// <summary>設定から響きのもとを用意する。使えないときは null（響きは足さない）。</summary>
    public static ImpulseResponse? Resolve(HallReverb hall, int rate)
    {
        if (!hall.Enabled || !hall.IsUsable || rate <= 0) return null;

        string key;
        if (hall.Kind == HallKind.Custom)
        {
            var info = new FileInfo(hall.ImpulsePath!);
            key = $"file|{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}|{rate}";
        }
        else
        {
            key = $"hall|{hall.Kind}|{hall.EffectiveDecaySeconds:0.###}|{rate}";
        }

        lock (Gate)
        {
            if (Cache.TryGetValue(key, out var hit)) return hit;
        }

        ImpulseResponse ir;
        try
        {
            ir = hall.Kind == HallKind.Custom
                ? ImpulseFile.Load(hall.ImpulsePath!, rate)
                : HallImpulse.Build(hall.Kind, hall.EffectiveDecaySeconds, rate);
        }
        catch
        {
            return null;   // 読めないファイルなら響きなしで鳴らす。再生が止まるよりよい
        }

        lock (Gate)
        {
            Cache[key] = ir;
            Order.Add(key);
            if (hall.Kind == HallKind.Custom) FileSeconds[hall.ImpulsePath!] = ir.Seconds;
            while (Order.Count > MaxEntries)
            {
                Cache.Remove(Order[0]);
                Order.RemoveAt(0);
            }
        }
        return ir;
    }

    /// <summary>読み込んだ響きの長さ。書き出しの見積もりに使うだけなので、分からなければ概算を返す。</summary>
    public static double KnownSeconds(string path)
    {
        lock (Gate)
        {
            if (FileSeconds.TryGetValue(path, out var s)) return s;
        }
        try
        {
            using var reader = new AudioFileReader(path);
            double s = Math.Min(reader.TotalTime.TotalSeconds, ImpulseFile.MaxSeconds);
            lock (Gate) FileSeconds[path] = s;
            return s;
        }
        catch { return 2.0; }
    }
}
