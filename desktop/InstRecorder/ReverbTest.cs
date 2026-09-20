using System.Diagnostics;
using System.IO;
using System.Text;
using InstRecorder.Audio;
using NAudio.Wave;

namespace InstRecorder;

/// <summary>
/// ホールの響きを、既知の信号で検証する開発用モード。
/// 使い方: Tonmeister.exe --rtest [レポート出力先]
///
/// いちばん大事なのは「直接音を変えていないこと」。
/// 響きを足すのは加工だが、**もとの音に手を入れずに足しているだけ**であることを、
/// サンプル単位の一致で示す。
/// </summary>
internal static class ReverbTest
{
    private const int Rate = 48000;

    public static void Run(string reportPath)
    {
        var sb = new StringBuilder();
        void W(string s) => sb.AppendLine(s);

        string dir = Path.Combine(Path.GetTempPath(), "instrec_rtest");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);

        try
        {
            W("=== 畳み込みそのものの正しさ ===");
            W(ConvolutionAccuracy());
            W("");

            W("=== 直接音を変えていないこと ===");
            W(DryUntouched());
            W("");

            W("=== 内蔵ホールの響きの長さ（実測 T30） ===");
            W(DecayTimes());
            W("");

            W("=== 響きの広がり（左右の相関） ===");
            W(StereoWidth());
            W("");

            W("=== 響きの量と大きさ ===");
            W(WetLevel());
            W("");

            W("=== プリディレイ（直接音から響きが始まるまで） ===");
            W(PreDelay());
            W("");

            W("=== 書き出しに尾が入ること ===");
            W(ExportTail(dir));
            W("");

            W("=== 速さ ===");
            W(Speed());

            int ng = sb.ToString().Split('\n').Count(l => l.Contains("NG"));
            sb.Insert(0, ng == 0 ? "すべて合格\n\n" : $"{ng} 件 不合格\n\n");
        }
        catch (Exception ex)
        {
            sb.Insert(0, "エラーで中断\n\n");
            W("エラー: " + ex);
        }

        File.WriteAllText(reportPath, sb.ToString(), new UTF8Encoding(false));
    }

    // ---------------- 畳み込み ----------------

    /// <summary>
    /// 分割 FFT 畳み込みが、素直な時間領域の畳み込みと同じ答えを出すか。
    /// ここがずれていると、以降の測定はすべて意味を失う。
    /// </summary>
    private static string ConvolutionAccuracy()
    {
        var rnd = new Random(7);
        int irLen = 3000, xLen = 20000;
        var h = new float[irLen];
        for (int i = 0; i < irLen; i++) h[i] = (float)((rnd.NextDouble() * 2 - 1) * Math.Exp(-i / 900.0));
        var x = new float[xLen];
        for (int i = 0; i < xLen; i++) x[i] = (float)(rnd.NextDouble() * 2 - 1);

        // 素直な畳み込み
        var direct = new double[xLen];
        for (int n = 0; n < xLen; n++)
        {
            double s = 0;
            int k0 = Math.Max(0, n - irLen + 1);
            for (int k = k0; k <= n; k++) s += x[k] * h[n - k];
            direct[n] = s;
        }

        int b = ConvolutionReverb.BlockSize;
        var conv = new PartitionedConvolver(h, b);
        var got = new double[xLen];
        for (int i = 0; i < xLen; i++) got[i] = conv.Process(x[i]);

        // 出てくるのは1ブロックぶん遅れた結果
        double maxErr = 0, scale = 0;
        for (int n = 0; n + b < xLen; n++)
        {
            maxErr = Math.Max(maxErr, Math.Abs(got[n + b] - direct[n]));
            scale = Math.Max(scale, Math.Abs(direct[n]));
        }
        double rel = maxErr / Math.Max(scale, 1e-30);

        var lines = new List<string>
        {
            $"    IR {irLen} サンプル・入力 {xLen} サンプル・分割 {b}",
            $"    最大誤差 {maxErr:0.###e+00}（信号の最大値比 {rel:0.###e+00}）",
            Verdict("素直な畳み込みと一致", rel < 1e-6),
        };

        // 遅れがちょうど1ブロックであること（プリディレイの計算がこれに依存している）
        bool zeroHead = true;
        for (int i = 0; i < b; i++) if (Math.Abs(got[i]) > 1e-12) zeroHead = false;
        lines.Add(Verdict($"遅れがちょうど {b} サンプル", zeroHead));
        return string.Join("\n", lines);
    }

    // ---------------- 直接音 ----------------

    /// <summary>
    /// 響きの量 0% で元の音とサンプル単位で一致すること、
    /// および量を上げても響きが届くまでの間は元の音そのままであること。
    /// </summary>
    private static string DryUntouched()
    {
        var ir = HallImpulse.Build(HallKind.Hall, 2.0, Rate);
        var src = Noise(Rate, seed: 3);

        var zero = Process(src, ir, mix: 0, preDelay: 0.030);
        int mismatch = 0;
        for (int i = 0; i < src.Length; i++) if (src[i] != zero[i]) mismatch++;

        var full = Process(src, ir, mix: 1.0, preDelay: 0.030);
        int preSamples = (int)Math.Round(0.030 * Rate);
        int headMismatch = 0;
        for (int i = 0; i < preSamples * 2; i++) if (src[i] != full[i]) headMismatch++;

        return string.Join("\n", new[]
        {
            $"    響きの量 0%   : 不一致サンプル {mismatch} 個 / {src.Length} 個",
            Verdict("切れば元の音そのまま", mismatch == 0),
            $"    響きの量 100% : 響きが届く前（先頭 30ms）の不一致 {headMismatch} 個 / {preSamples * 2} 個",
            Verdict("直接音は加工していない", headMismatch == 0),
        });
    }

    // ---------------- 響きの長さ ----------------

    private static string DecayTimes()
    {
        var lines = new List<string>();
        foreach (var kind in new[] { HallKind.Room, HallKind.Chamber, HallKind.Hall, HallKind.Church })
        {
            double want = HallReverb.DefaultDecaySeconds(kind);
            var ir = HallImpulse.Build(kind, want, Rate);
            double got = MeasureT30(ir.Left, Rate);
            double err = Math.Abs(got - want) / want * 100;
            lines.Add($"    {HallReverb.DisplayName(kind),-6} 指定 {want:0.0}秒 → 実測 {got:0.00}秒（ずれ {err:0.#}%）"
                      + (err <= 15 ? "  OK" : "  NG"));
        }

        // つまみを動かしたぶんだけ響きが伸びること
        var s1 = MeasureT30(HallImpulse.Build(HallKind.Hall, 1.0, Rate).Left, Rate);
        var s3 = MeasureT30(HallImpulse.Build(HallKind.Hall, 3.0, Rate).Left, Rate);
        lines.Add($"    大ホール 1.0秒 → {s1:0.00}秒 / 3.0秒 → {s3:0.00}秒");
        lines.Add(Verdict("つまみに追従する", s3 > s1 * 2.4 && s3 < s1 * 3.6));
        return string.Join("\n", lines);
    }

    /// <summary>
    /// シュレーダーの逆積分で残響時間を測る。
    /// −5dB から −35dB まで落ちる時間を2倍して 60dB ぶんに換算する（T30）。
    /// </summary>
    private static double MeasureT30(float[] h, int rate)
    {
        var e = new double[h.Length];
        double acc = 0;
        for (int i = h.Length - 1; i >= 0; i--) { acc += (double)h[i] * h[i]; e[i] = acc; }
        if (e[0] <= 0) return 0;

        int i5 = -1, i35 = -1;
        for (int i = 0; i < h.Length; i++)
        {
            double db = 10 * Math.Log10(e[i] / e[0]);
            if (i5 < 0 && db <= -5) i5 = i;
            if (db <= -35) { i35 = i; break; }
        }
        if (i5 < 0 || i35 < 0 || i35 <= i5) return 0;
        return (i35 - i5) / (double)rate * 2.0;
    }

    // ---------------- 広がり ----------------

    private static string StereoWidth()
    {
        var lines = new List<string>();
        foreach (var kind in new[] { HallKind.Chamber, HallKind.Hall, HallKind.Church })
        {
            var ir = HallImpulse.Build(kind, HallReverb.DefaultDecaySeconds(kind), Rate);
            double r = Correlation(ir.Left, ir.Right);
            lines.Add($"    {HallReverb.DisplayName(kind),-6} 左右の相関 {r:+0.000;-0.000; 0.000}"
                      + (Math.Abs(r) < 0.3 ? "  OK" : "  NG"));
        }
        lines.Add("    相関が低いほど響きが左右に広がって聞こえる（1.000 なら真ん中で団子になる）");
        return string.Join("\n", lines);
    }

    private static double Correlation(float[] a, float[] b)
    {
        double sa = 0, sb = 0, sab = 0;
        for (int i = 0; i < a.Length; i++)
        {
            sa += (double)a[i] * a[i];
            sb += (double)b[i] * b[i];
            sab += (double)a[i] * b[i];
        }
        double d = Math.Sqrt(sa * sb);
        return d > 0 ? sab / d : 0;
    }

    // ---------------- 響きの量 ----------------

    /// <summary>
    /// 「量 100%」が「直接音と同じくらいの響き」になっているか。
    /// インパルス応答のエネルギーを 1 に正規化してあるので、そうなるはず。
    /// </summary>
    private static string WetLevel()
    {
        var ir = HallImpulse.Build(HallKind.Hall, 2.0, Rate);
        var src = Noise(Rate * 3, seed: 5);
        var mixed = Process(src, ir, mix: 1.0, preDelay: 0.030);

        // 立ち上がりを避けて後半だけ見る
        int from = src.Length / 2;
        double dry = 0, wet = 0;
        for (int i = from; i < src.Length; i++)
        {
            double w = mixed[i] - src[i];
            dry += (double)src[i] * src[i];
            wet += w * w;
        }
        double ratio = Math.Sqrt(wet / dry);
        double db = 20 * Math.Log10(ratio);

        var half = Process(src, ir, mix: 0.5, preDelay: 0.030);
        double wet2 = 0;
        for (int i = from; i < src.Length; i++) { double w = half[i] - src[i]; wet2 += w * w; }
        double ratio2 = Math.Sqrt(wet2 / dry);

        return string.Join("\n", new[]
        {
            $"    白色雑音を通す。量 100% で 響き/直接音 = {ratio:0.000}（{db:+0.0;-0.0} dB）",
            Verdict("量 100% で直接音と同じくらい", ratio > 0.7 && ratio < 1.4),
            $"    量 50% で {ratio2:0.000} — 100%のときの {ratio2 / ratio * 100:0}%",
            Verdict("量つまみに比例する", Math.Abs(ratio2 / ratio - 0.5) < 0.02),
        });
    }

    // ---------------- プリディレイ ----------------

    private static string PreDelay()
    {
        var ir = HallImpulse.Build(HallKind.Hall, 2.0, Rate);
        var lines = new List<string>();

        foreach (double ms in new[] { 25.0, 30.0, 80.0 })
        {
            // 単発のインパルスを入れて、響きが出てくる位置を見る
            var src = new float[Rate];
            src[0] = 1; src[1] = 1;
            var outp = Process(src, ir, mix: 1.0, preDelay: ms / 1000.0);

            float peak = 0;
            for (int i = 2; i < outp.Length; i++) peak = Math.Max(peak, Math.Abs(outp[i]));

            int first = -1;
            for (int i = 2; i < outp.Length; i += 2)
            {
                if (Math.Abs(outp[i]) > peak * 1e-4) { first = i / 2; break; }
            }

            double gotMs = first < 0 ? -1 : first * 1000.0 / Rate;
            lines.Add($"    設定 {ms:0}ms → 実測 {gotMs:0.0}ms"
                      + (first >= 0 && Math.Abs(gotMs - ms) < 2.0 ? "  OK" : "  NG"));
        }

        lines.Add($"    分割畳み込みのブロック {ConvolutionReverb.BlockSize} サンプル "
                  + $"= {ConvolutionReverb.BlockSize * 1000.0 / Rate:0.0}ms をプリディレイに畳んでいる");
        lines.Add($"    （このため設定できる下限は {HallReverb.MinPreDelayMs:0}ms）");
        return string.Join("\n", lines);
    }

    // ---------------- 書き出し ----------------

    private static string ExportTail(string dir)
    {
        var lines = new List<string>();

        var srcPath = Path.Combine(dir, "tone.wav");
        WriteTone(srcPath, 440, 1.0);

        var session = new Session { SampleRate = Rate, Folder = dir };
        var track = new Track();
        track.AddTake(Take.FromFiles("素材", new[] { srcPath }));
        session.Tracks.Add(track);

        var plain = Path.Combine(dir, "plain.wav");
        var a = Mixdown.Export(session, plain, SaveFormat.Float32);
        lines.Add($"    響きなし: {a.Seconds:0.000} 秒");

        session.Hall.Enabled = true;
        session.Hall.Kind = HallKind.Hall;
        session.Hall.DecaySeconds = 2.0;
        session.Hall.MixPercent = 40;
        session.Hall.PreDelayMs = 30;

        var withHall = Path.Combine(dir, "hall.wav");
        var b = Mixdown.Export(session, withHall, SaveFormat.Float32);
        double tail = b.Seconds - a.Seconds;
        lines.Add($"    大ホール2.0秒: {b.Seconds:0.000} 秒（尾 {tail:0.000} 秒）");
        lines.Add(Verdict("尾のぶん長くなっている", tail > 2.0 && tail < 3.2));

        // 素材が止まったあとにちゃんと音が残り、しかも減っていること
        var samples = ReadFloatWav(withHall);
        double atSource = LevelDb(samples, 0.5, 0.2);
        double after = LevelDb(samples, 1.2, 0.2);
        double later = LevelDb(samples, 2.4, 0.2);
        lines.Add($"    0.5秒（演奏中） {atSource:0.0} dBFS / 1.2秒（止まった後） {after:0.0} dBFS / 2.4秒 {later:0.0} dBFS");
        lines.Add(Verdict("止まった後も響きが残る", after > -60));
        lines.Add(Verdict("時間とともに減っていく", later < after - 6));

        // 元の WAV は無傷
        lines.Add(Verdict("素材の WAV は書き換えていない", new FileInfo(srcPath).Length > 0
                                                            && Take.FromFiles("確認", new[] { srcPath }).Seconds > 0.99));
        return string.Join("\n", lines);
    }

    // ---------------- 速さ ----------------

    private static string Speed()
    {
        var sw = Stopwatch.StartNew();
        var ir = HallImpulse.Build(HallKind.Church, 3.4, Rate);
        sw.Stop();
        double buildMs = sw.Elapsed.TotalMilliseconds;

        var src = Noise(Rate * 10, seed: 9);
        sw.Restart();
        Process(src, ir, mix: 0.3, preDelay: 0.030);
        sw.Stop();
        double ratio = 10.0 / sw.Elapsed.TotalSeconds;

        return string.Join("\n", new[]
        {
            $"    石の教会 3.4秒の響きを組み立てる: {buildMs:0} ms（作ったものは覚えておくので毎回は起きない）",
            $"    10秒ぶんを通す: {sw.Elapsed.TotalMilliseconds:0} ms = 実時間の {ratio:0} 倍速",
            Verdict("再生に十分間に合う", ratio > 10),
        });
    }

    // ---------------- 道具 ----------------

    /// <summary>ステレオの信号を <see cref="ConvolutionReverb"/> に通して返す。</summary>
    private static float[] Process(float[] stereo, ImpulseResponse ir, double mix, double preDelay)
    {
        var copy = (float[])stereo.Clone();
        var reverb = new ConvolutionReverb(new ArrayProvider(copy, Rate), ir, mix, preDelay);
        var outp = new float[stereo.Length];
        int done = 0;
        var buf = new float[4096];
        while (done < outp.Length)
        {
            int want = Math.Min(buf.Length, outp.Length - done);
            int n = reverb.Read(buf, 0, want);
            if (n == 0) break;
            Array.Copy(buf, 0, outp, done, n);
            done += n;
        }
        return outp;
    }

    /// <summary>ステレオの白色雑音。frames フレーム＝ frames*2 サンプル。</summary>
    private static float[] Noise(int frames, int seed)
    {
        var rnd = new Random(seed);
        var s = new float[frames * 2];
        for (int i = 0; i < s.Length; i++) s[i] = (float)((rnd.NextDouble() * 2 - 1) * 0.2);
        return s;
    }

    private static void WriteTone(string path, double hz, double seconds)
    {
        int frames = (int)(seconds * Rate);
        using var w = new WaveFileWriter(path, WaveFormat.CreateIeeeFloatWaveFormat(Rate, 1));
        var buf = new float[frames];
        for (int i = 0; i < frames; i++) buf[i] = 0.5f * MathF.Sin(2 * MathF.PI * (float)hz * i / Rate);
        w.WriteSamples(buf, 0, buf.Length);
    }

    private static float[] ReadFloatWav(string path)
    {
        using var r = new AudioFileReader(path);
        var all = new List<float>((int)(r.Length / 4));
        var buf = new float[8192];
        int n;
        while ((n = r.Read(buf, 0, buf.Length)) > 0)
            for (int i = 0; i < n; i++) all.Add(buf[i]);
        return all.ToArray();
    }

    /// <summary>ステレオ信号の at 秒から length 秒ぶんの実効値。</summary>
    private static double LevelDb(float[] stereo, double at, double length)
    {
        int from = (int)(at * Rate) * 2;
        int count = (int)(length * Rate) * 2;
        if (from >= stereo.Length) return -200;
        count = Math.Min(count, stereo.Length - from);
        double s = 0;
        for (int i = from; i < from + count; i++) s += (double)stereo[i] * stereo[i];
        double rms = Math.Sqrt(s / count);
        return rms > 0 ? 20 * Math.Log10(rms) : -200;
    }

    private static string Verdict(string label, bool ok) => $"    [{(ok ? "OK" : "NG")}] {label}";

    /// <summary>配列をそのまま読ませるための入れ物。</summary>
    private sealed class ArrayProvider : ISampleProvider
    {
        private readonly float[] _data;
        private int _pos;

        public ArrayProvider(float[] data, int rate)
        {
            _data = data;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(rate, 2);
        }

        public WaveFormat WaveFormat { get; }

        public int Read(float[] buffer, int offset, int count)
        {
            int n = Math.Min(count, _data.Length - _pos);
            if (n <= 0) return 0;
            Array.Copy(_data, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }
    }
}
