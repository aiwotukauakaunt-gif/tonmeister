using NAudio.Dsp;

namespace InstRecorder.Audio;

/// <summary>
/// 録音経路の素性を数値で出す。マイクとプリアンプの質、部屋の暗騒音、電源ハムは
/// どれも「実際の音に寄せる」の邪魔をするが、耳だけでは判断しにくいので測る。
/// </summary>
public static class SignalAnalysis
{
    private const int FftSize = 8192;
    private const int FftOrder = 13; // 2^13 = 8192

    public sealed record BandLevel(double CenterHz, double Db);

    public sealed record ChannelReport(
        int Index,
        double PeakDb,
        double RmsDb,
        double DcOffset,
        int ClipCount,
        double EffectiveBits,
        double HumHz,
        double HumDb,
        double HumOverFloorDb,
        IReadOnlyList<BandLevel> Bands,
        int ArrivedBits = 0,
        double UltrasonicOverFloorDb = 0,
        bool UltrasonicAvailable = false)
    {
        public string PeakText => Fmt(PeakDb);
        public string RmsText => Fmt(RmsDb);

        public static string Fmt(double db) =>
            double.IsNegativeInfinity(db) || db < -200 ? "-inf" : $"{db:0.0} dBFS";
    }

    /// <summary>
    /// フルスケール正弦波の RMS を基準にしたときの SN 比から実効ビット数を出す。
    /// 16bit の理想 ADC ならノイズフロア -101 dBFS ＝ 16.0 bit になる。
    /// </summary>
    private static double EffectiveBitsFromNoise(double noiseRmsDb)
    {
        if (double.IsNegativeInfinity(noiseRmsDb)) return 32;
        double snr = -3.01 - noiseRmsDb; // フルスケール正弦波の RMS は -3.01 dBFS
        return Math.Max(0, (snr - 1.76) / 6.02);
    }

    public static ChannelReport[] Analyze(float[] interleaved, int frames, int channels, int rate)
    {
        var reports = new ChannelReport[channels];
        for (int c = 0; c < channels; c++)
        {
            var x = new float[frames];
            for (int i = 0; i < frames; i++) x[i] = interleaved[i * channels + c];
            reports[c] = AnalyzeChannel(x, c, rate);
        }
        return reports;
    }

    public static ChannelReport AnalyzeChannel(float[] x, int index, int rate)
    {
        int n = x.Length;
        if (n == 0)
            return new ChannelReport(index, double.NegativeInfinity, double.NegativeInfinity,
                                     0, 0, 0, 0, double.NegativeInfinity, 0, Array.Empty<BandLevel>(), 0, 0, false);

        double sum = 0, sumSq = 0;
        float peak = 0;
        int clips = 0;
        for (int i = 0; i < n; i++)
        {
            float v = x[i];
            sum += v;
            float a = MathF.Abs(v);
            if (a > peak) peak = a;
            if (a >= 1.0f) clips++;
        }
        double dc = sum / n;

        // 直流成分は音ではないので取り除いてから RMS を出す
        for (int i = 0; i < n; i++)
        {
            double v = x[i] - dc;
            sumSq += v * v;
        }
        double rms = Math.Sqrt(sumSq / n);

        var spectrum = PowerSpectrum(x, (float)dc, rate, out double binHz);
        var bands = ToThirdOctaveBands(spectrum, binHz);
        var (humHz, humDb, humOverFloor) = FindHum(spectrum, binHz);

        double rmsDb = rms > 0 ? 20 * Math.Log10(rms) : double.NegativeInfinity;

        var us = FindUltrasonic(spectrum, binHz);
        return new ChannelReport(
            index,
            peak > 0 ? 20 * Math.Log10(peak) : double.NegativeInfinity,
            rmsDb,
            dc,
            clips,
            EffectiveBitsFromNoise(rmsDb),
            humHz,
            humDb,
            humOverFloor,
            bands,
            DetectBitDepth(x),
            us.overFloor,
            us.available);
    }

    /// <summary>
    /// 届いている値の刻みから、途中で何ビットに丸められたかを見抜く。
    /// 16bit を通った音は、すべての値が 1/32768 の整数倍になる（そのあとに音量が掛かっていなければ）。
    /// 返り値：16 / 24 / 32（整数の刻みに乗っていない＝float のまま、または音量が掛かっている）/ 0（判断できる量がない）。
    /// Web 版 analysis.js の detectBitDepth と同じ。
    /// </summary>
    public static int DetectBitDepth(float[] x)
    {
        int nonzero = 0, fits16 = 0, fits24 = 0;
        var distinct = new HashSet<float>();
        for (int i = 0; i < x.Length; i++)
        {
            float v = x[i];
            if (v == 0) continue;
            nonzero++;
            if (distinct.Count < 64) distinct.Add(v);
            double s16 = v * 32768.0;
            if (Math.Abs(s16 - Math.Round(s16)) < 1e-4) fits16++;
            double s24 = v * 8388608.0;
            if (Math.Abs(s24 - Math.Round(s24)) < 1e-3) fits24++;
        }
        if (nonzero < 1000 || distinct.Count < 32) return 0;
        if (fits16 / (double)nonzero > 0.999) return 16;
        if (fits24 / (double)nonzero > 0.999) return 24;
        return 32;
    }

    /// <summary>
    /// 超音波（20 kHz〜ナイキスト）の雑音。耳には聞こえないが録音には入り、
    /// スイッチング電源・ディスプレイ・USB の高周波雑音がここに出る。1〜10 kHz の床と比べる。
    /// </summary>
    private static (double db, double overFloor, bool available) FindUltrasonic(double[] spectrum, double binHz)
    {
        double nyquist = spectrum.Length * binHz;
        if (nyquist <= 20500) return (double.NegativeInfinity, 0, false);
        int k0 = (int)Math.Ceiling(20000 / binHz), k1 = spectrum.Length - 1;
        double power = 0; int bins = 0;
        for (int k = k0; k <= k1; k++) { power += spectrum[k] * spectrum[k]; bins++; }
        if (bins == 0) return (double.NegativeInfinity, 0, false);
        double amp = Math.Sqrt(power / HannEnbwBins);
        int f0 = (int)Math.Ceiling(1000 / binHz), f1 = (int)Math.Floor(10000 / binHz);
        var mid = new List<double>();
        for (int k = f0; k < f1 && k < spectrum.Length; k++) mid.Add(spectrum[k]);
        mid.Sort();
        double floor = mid.Count > 0 ? mid[mid.Count / 2] * Math.Sqrt(bins / HannEnbwBins) : 0;
        double db = amp > 0 ? 20 * Math.Log10(amp) : -200;
        double floorDb = floor > 0 ? 20 * Math.Log10(floor) : -200;
        return (db, db - floorDb, true);
    }

    /// <summary>Welch 法（ハン窓・50%重ね）で振幅スペクトルを出す。単位は「正弦波振幅」。</summary>
    private static double[] PowerSpectrum(float[] x, float dc, int rate, out double binHz)
    {
        binHz = (double)rate / FftSize;
        int half = FftSize / 2;
        var acc = new double[half];

        int step = FftSize / 2;
        int blocks = 0;
        var buf = new Complex[FftSize];

        for (int start = 0; start + FftSize <= x.Length; start += step)
        {
            for (int i = 0; i < FftSize; i++)
            {
                float w = (float)FastFourierTransform.HannWindow(i, FftSize);
                buf[i].X = (x[start + i] - dc) * w;
                buf[i].Y = 0;
            }

            FastFourierTransform.FFT(true, FftOrder, buf);

            for (int k = 0; k < half; k++)
            {
                double re = buf[k].X, im = buf[k].Y;
                acc[k] += re * re + im * im;
            }
            blocks++;
        }

        if (blocks == 0)
        {
            // 解析できる長さが無い場合は無音として扱う
            for (int k = 0; k < half; k++) acc[k] = 0;
            return acc;
        }

        // NAudio の FFT は 1/N 済みなので、ハン窓のコヒーレントゲイン 0.5 を戻して
        // 「その周波数にある正弦波の振幅」に換算する
        for (int k = 0; k < half; k++)
        {
            double mag = Math.Sqrt(acc[k] / blocks);
            acc[k] = mag * 2 / 0.5;
        }
        return acc;
    }

    /// <summary>
    /// ハン窓のエネルギー等価帯域幅（ビン数）。窓をかけると1本の正弦波が隣のビンにも漏れるので、
    /// 複数ビンの電力を足したときはこの値で割らないと実際より大きく出る（ハン窓では +1.76 dB）。
    /// </summary>
    private const double HannEnbwBins = 1.5;

    /// <summary>指定ビンの周辺の電力をまとめて、そこにある正弦波の振幅に換算する。</summary>
    private static double AmplitudeAround(double[] spectrum, int center, int spread)
    {
        double power = 0;
        for (int k = center - spread; k <= center + spread; k++)
        {
            if (k >= 0 && k < spectrum.Length) power += spectrum[k] * spectrum[k];
        }
        return Math.Sqrt(power / HannEnbwBins);
    }

    private static readonly double[] ThirdOctaveCenters =
    {
        25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
        1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
    };

    /// <summary>1/3オクターブ帯域が実際に覆っている周波数範囲（テストと表示の説明用）。</summary>
    public static (double Lo, double Hi) BandCoverage(IReadOnlyList<BandLevel> bands, int rate)
    {
        if (bands.Count == 0) return (0, 0);
        double lo = bands[0].CenterHz / Math.Pow(2, 1.0 / 6);
        double hi = Math.Min(bands[^1].CenterHz * Math.Pow(2, 1.0 / 6), rate / 2.0);
        return (lo, hi);
    }

    private static List<BandLevel> ToThirdOctaveBands(double[] spectrum, double binHz)
    {
        var result = new List<BandLevel>();
        double nyquist = spectrum.Length * binHz;

        foreach (var center in ThirdOctaveCenters)
        {
            double lo = center / Math.Pow(2, 1.0 / 6);
            double hi = center * Math.Pow(2, 1.0 / 6);
            if (lo >= nyquist) break;

            int k0 = (int)Math.Floor(lo / binHz);
            int k1 = (int)Math.Ceiling(hi / binHz);
            k0 = Math.Max(0, k0);
            k1 = Math.Min(spectrum.Length - 1, k1);
            if (k1 < k0) continue;

            double power = 0;
            for (int k = k0; k <= k1; k++) power += spectrum[k] * spectrum[k];
            double amp = Math.Sqrt(power / HannEnbwBins);
            result.Add(new BandLevel(center, amp > 0 ? 20 * Math.Log10(amp) : -200));
        }
        return result;
    }

    /// <summary>
    /// 電源ハム（50/60Hz とその倍音）を探す。マイク録音で最も多い混入ノイズで、
    /// 出てしまうと後から消すのが難しいので録る前に気づきたい。
    /// </summary>
    private static (double Hz, double Db, double OverFloor) FindHum(double[] spectrum, double binHz)
    {
        var sorted = (double[])spectrum.Clone();
        Array.Sort(sorted);
        double floor = sorted[sorted.Length / 2];
        double floorDb = floor > 0 ? 20 * Math.Log10(floor) : -200;

        double bestHz = 0, bestDb = double.NegativeInfinity;
        foreach (var f0 in new[] { 50.0, 60.0 })
        {
            for (int h = 1; h <= 4; h++)
            {
                double f = f0 * h;
                int k = (int)Math.Round(f / binHz);
                if (k <= 0 || k >= spectrum.Length) continue;

                // ハムの周波数はビンの中心とはずれるので、周辺の電力をまとめて振幅に戻す
                // （最大値だけ見ると最悪 1.4 dB 低く出る）
                double amp = AmplitudeAround(spectrum, k, 2);
                double db = amp > 0 ? 20 * Math.Log10(amp) : -200;
                if (db > bestDb) { bestDb = db; bestHz = f; }
            }
        }

        return (bestHz, bestDb, bestDb - floorDb);
    }

    /// <summary>測定結果から、次に何をすべきかの短い所見を組み立てる。</summary>
    public static List<string> Advise(ChannelReport[] channels, bool isSilenceTest)
    {
        var notes = new List<string>();
        if (channels.Length == 0) return notes;

        double worstRms = channels.Max(c => c.RmsDb);
        double bits = channels.Min(c => c.EffectiveBits);
        double maxDc = channels.Max(c => Math.Abs(c.DcOffset));
        var hum = channels.OrderByDescending(c => c.HumOverFloorDb).First();

        // 実在するマイクとプリアンプで、これより静かな暗騒音はまず出ない。
        // 下回っている＝入力が届いていないか、静かな間だけ何かが絞っている。
        const double ImplausiblyQuietDb = -120;

        if (worstRms < ImplausiblyQuietDb)
        {
            notes.Add($"⚠ 暗騒音 {ChannelReport.Fmt(worstRms)} は、実在の機材では出ない静けさです。" +
                      "この数値は機材の性能ではありません。");
            notes.Add("考えられる原因：Windows の音声補正（ノイズ抑制）が静かな間だけ入力を潰している／" +
                      "マイクがミュートされている／別のアプリが入力を占有している。");
            notes.Add("「④ OSの音声補正を検査」で、静かな間に絞られていないかを確かめられます。" +
                      "絞られている場合、この測定値も録音した音も信用できません。");
            return notes; // これ以上の所見は意味を持たないので出さない
        }

        if (isSilenceTest)
        {
            notes.Add(worstRms switch
            {
                < -85 => $"ノイズフロア {ChannelReport.Fmt(worstRms)}：とても静か。マイクとプリアンプに余裕がある。",
                < -70 => $"ノイズフロア {ChannelReport.Fmt(worstRms)}：実用範囲。静かな楽器を小さく録ると気になるかもしれない。",
                < -55 => $"ノイズフロア {ChannelReport.Fmt(worstRms)}：やや高い。入力ゲインを下げる、PCのファンから離す、で改善する余地がある。",
                _ => $"ノイズフロア {ChannelReport.Fmt(worstRms)}：高い。ゲインが上がりすぎているか、環境音を拾っている。",
            });

            // 民生用の AD 変換で 20bit を超える実効分解能はまず出ない
            notes.Add(bits > 20
                ? $"この暗騒音から計算した実効ビット深度は {bits:0.0} bit ですが、" +
                  "実在の機材でこの値は出ません。入力に何らかの処理が入っている可能性があります。"
                : $"この暗騒音での実効ビット深度は約 {bits:0.0} bit。" +
                  (bits < 12
                      ? "24bit で録っても実際に使えているのはこの範囲なので、まずノイズを下げるのが先。"
                      : "24bit 録音の意味が出る水準。"));
        }

        // 届いた値の刻み：16bit なら、Windows の既定の形式（または共有モード）で落ちている
        var arrived = channels.Where(c => c.ArrivedBits > 0).Select(c => c.ArrivedBits).ToList();
        if (arrived.Count > 0 && arrived.Min() == 16)
        {
            notes.Add("⚠ 届いている値は 16bit の刻みに乗っています。24bit の機材でも、WASAPI 共有や Windows の「既定の形式」が 16bit だとここで落ちます。" +
                      "排他モードか ASIO を選ぶか、サウンド設定の既定の形式を 24bit に。");
        }

        var us = channels.Where(c => c.UltrasonicAvailable).OrderByDescending(c => c.UltrasonicOverFloorDb).FirstOrDefault();
        if (us != null && us.UltrasonicOverFloorDb > 12)
        {
            notes.Add($"20 kHz より上に、床より {us.UltrasonicOverFloorDb:0} dB 高い雑音がある。耳には聞こえないが録音には入る。" +
                      "スイッチング電源のアダプタ・ディスプレイ・USB ハブが近いと出やすい。離す、別のポートにする、ノート PC ならバッテリー駆動で試す。");
        }

        if (hum.HumOverFloorDb > 12)
        {
            notes.Add($"{hum.HumHz:0} Hz の電源ハムが暗騒音より {hum.HumOverFloorDb:0} dB 高い。" +
                      "電源アダプタやディスプレイからマイクを離す、USBポートを変える、で減ることが多い。");
        }

        if (maxDc > 0.001)
        {
            notes.Add($"直流オフセットが {maxDc:0.0000} ある。ヘッドルームを無駄に食うので、" +
                      "録音後にハイパスをかけるか、機材側の設定を確認したい。");
        }

        int clips = channels.Sum(c => c.ClipCount);
        if (clips > 0)
        {
            notes.Add($"測定中に {clips} サンプルがクリップした。入力ゲインを下げること。");
        }

        return notes;
    }
}
