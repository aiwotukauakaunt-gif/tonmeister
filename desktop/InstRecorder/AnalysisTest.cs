using System.IO;
using System.Text;
using InstRecorder.Audio;

namespace InstRecorder;

/// <summary>
/// 解析の数値が正しいかを既知の信号で確かめる開発用モード。
/// 測定機能は「値が合っていること」が全てなので、合成信号で校正する。
/// 使い方: InstRecorder.exe --atest [レポート出力先]
/// </summary>
internal static class AnalysisTest
{
    private const int Rate = 48000;
    private const int Seconds = 4;

    public static void Run(string reportPath)
    {
        var sb = new StringBuilder();
        void W(string s) => sb.AppendLine(s);

        int n = Rate * Seconds;

        // --- ① フルスケール 1kHz 正弦波 ---
        var sine = new float[n];
        for (int i = 0; i < n; i++) sine[i] = MathF.Sin(2 * MathF.PI * 1000 * i / Rate);
        var r = SignalAnalysis.AnalyzeChannel(sine, 0, Rate);
        W("① フルスケール 1kHz 正弦波");
        W(Check("ピーク", r.PeakDb, 0.0, 0.1, "dBFS"));
        W(Check("RMS", r.RmsDb, -3.01, 0.1, "dBFS"));
        W(Check("1kHz バンド", BandAt(r, 1000), 0.0, 0.5, "dBFS"));
        W("");

        // --- ② -60 dBFS の 1kHz 正弦波 ---
        var quiet = new float[n];
        for (int i = 0; i < n; i++) quiet[i] = 0.001f * MathF.Sin(2 * MathF.PI * 1000 * i / Rate);
        r = SignalAnalysis.AnalyzeChannel(quiet, 0, Rate);
        W("② −60 dBFS の 1kHz 正弦波");
        W(Check("ピーク", r.PeakDb, -60.0, 0.1, "dBFS"));
        W(Check("RMS", r.RmsDb, -63.01, 0.1, "dBFS"));
        W(Check("1kHz バンド", BandAt(r, 1000), -60.0, 0.5, "dBFS"));
        W("");

        // --- ③ 16bit 相当の量子化ノイズ（実効ビット深度の校正） ---
        var rnd = new Random(1234);
        double q = 2.0 / 65536;
        var qnoise = new float[n];
        for (int i = 0; i < n; i++) qnoise[i] = (float)((rnd.NextDouble() - 0.5) * q);
        r = SignalAnalysis.AnalyzeChannel(qnoise, 0, Rate);
        W("③ 16bit 相当の量子化ノイズだけ");
        W(Check("RMS", r.RmsDb, -101.1, 0.5, "dBFS"));
        W(Check("実効ビット深度", r.EffectiveBits, 16.0, 0.15, "bit"));
        W("");

        // --- ④ 24bit 相当 ---
        double q24 = 2.0 / 16777216;
        var q24noise = new float[n];
        for (int i = 0; i < n; i++) q24noise[i] = (float)((rnd.NextDouble() - 0.5) * q24);
        r = SignalAnalysis.AnalyzeChannel(q24noise, 0, Rate);
        W("④ 24bit 相当の量子化ノイズだけ");
        W(Check("実効ビット深度", r.EffectiveBits, 24.0, 0.15, "bit"));
        W("");

        // --- ⑤ 電源ハムと直流オフセット ---
        var mixed = new float[n];
        for (int i = 0; i < n; i++)
        {
            mixed[i] = 0.01f                                                   // 直流
                     + 0.5f * MathF.Sin(2 * MathF.PI * 1000 * i / Rate)        // 楽音
                     + 0.002f * MathF.Sin(2 * MathF.PI * 50 * i / Rate);       // 50Hz ハム
        }
        r = SignalAnalysis.AnalyzeChannel(mixed, 0, Rate);
        W("⑤ 直流 0.01 ＋ 1kHz(−6dB) ＋ 50Hz ハム(−54dB)");
        W(Check("直流オフセット", r.DcOffset, 0.01, 0.0005, ""));
        W(Check("検出したハム周波数", r.HumHz, 50.0, 0.1, "Hz"));
        W(Check("ハムのレベル", r.HumDb, -54.0, 1.0, "dBFS"));
        W(Check("1kHz バンド", BandAt(r, 1000), -6.02, 0.5, "dBFS"));
        W("");

        // --- ⑥ クリップ検出 ---
        var clipped = new float[n];
        for (int i = 0; i < n; i++) clipped[i] = 1.4f * MathF.Sin(2 * MathF.PI * 200 * i / Rate);
        for (int i = 0; i < n; i++) clipped[i] = Math.Clamp(clipped[i], -1f, 1f);
        r = SignalAnalysis.AnalyzeChannel(clipped, 0, Rate);
        int expectedClips = clipped.Count(v => Math.Abs(v) >= 1f);
        W("⑥ クリップ検出");
        W(Check("クリップ数", r.ClipCount, expectedClips, 0, "サンプル"));
        W("");

        // --- ⑦ 60Hz 環境でのハム検出 ---
        var hum60 = new float[n];
        for (int i = 0; i < n; i++)
            hum60[i] = 0.003f * MathF.Sin(2 * MathF.PI * 120 * i / Rate)
                     + 0.00001f * (float)(rnd.NextDouble() - 0.5);
        r = SignalAnalysis.AnalyzeChannel(hum60, 0, Rate);
        W("⑦ 120Hz（60Hz の2倍音）のハム");
        W(Check("検出したハム周波数", r.HumHz, 120.0, 0.1, "Hz"));
        W("");

        // --- ⑧ ステレオのチャンネル分離 ---
        var stereo = new float[n * 2];
        for (int i = 0; i < n; i++)
        {
            stereo[i * 2] = 0.5f * MathF.Sin(2 * MathF.PI * 1000 * i / Rate);
            stereo[i * 2 + 1] = 0.05f * MathF.Sin(2 * MathF.PI * 4000 * i / Rate);
        }
        var rr = SignalAnalysis.Analyze(stereo, n, 2, Rate);
        W("⑧ L=1kHz(−6dB) / R=4kHz(−26dB) のステレオ");
        W(Check("L ピーク", rr[0].PeakDb, -6.02, 0.1, "dBFS"));
        W(Check("R ピーク", rr[1].PeakDb, -26.02, 0.1, "dBFS"));
        W(Check("L の 1kHz", BandAt(rr[0], 1000), -6.02, 0.5, "dBFS"));
        W(Check("R の 4kHz", BandAt(rr[1], 4000), -26.02, 0.5, "dBFS"));

        W("");

        // --- ⑨ 広帯域ノイズ：全バンドの電力和と RMS の関係 ---
        // バンド表示は「等価な正弦波の振幅」なので、雑音では RMS より 3.01 dB 高く出るのが正しい
        var noise = new float[n];
        for (int i = 0; i < n; i++)
        {
            double u = 0;
            for (int k = 0; k < 12; k++) u += rnd.NextDouble();
            noise[i] = (float)((u - 6) * 0.01); // 標準偏差 0.01 ≒ −40 dBFS
        }
        r = SignalAnalysis.AnalyzeChannel(noise, 0, Rate);
        double bandPower = r.Bands.Sum(b => Math.Pow(10, b.Db / 20) * Math.Pow(10, b.Db / 20));
        double bandDb = 20 * Math.Log10(Math.Sqrt(bandPower));
        // バンドはナイキストまで全部を覆ってはいないので、覆っている帯域幅の割合を勘定に入れる
        var (lo, hi) = SignalAnalysis.BandCoverage(r.Bands, Rate);
        double coverageDb = 10 * Math.Log10((hi - lo) / (Rate / 2.0));
        W("⑨ 広帯域ノイズ（RMS ≒ −40 dBFS）");
        W($"    1/3オクターブ帯域の被覆: {lo:0} 〜 {hi:0} Hz（ナイキスト {Rate / 2} Hz の {coverageDb:0.00} dB 分）");
        W(Check("RMS", r.RmsDb, -40.0, 0.2, "dBFS"));
        W(Check("全バンド合計 − RMS", bandDb - r.RmsDb, 3.01 + coverageDb, 0.3, "dB"));

        int ng = sb.ToString().Split('\n').Count(l => l.Contains("NG"));
        sb.Insert(0, ng == 0 ? "すべて合格\n\n" : $"{ng} 件 不合格\n\n");

        File.WriteAllText(reportPath, sb.ToString(), new UTF8Encoding(false));
    }

    private static double BandAt(SignalAnalysis.ChannelReport r, double hz) =>
        r.Bands.OrderBy(b => Math.Abs(b.CenterHz - hz)).First().Db;

    private static string Check(string name, double actual, double expected, double tolerance, string unit)
    {
        bool ok = Math.Abs(actual - expected) <= tolerance;
        return $"    [{(ok ? "OK" : "NG")}] {name,-20} 実測 {actual,10:0.000} {unit}  " +
               $"期待 {expected:0.000} ±{tolerance}";
    }
}
