using System.IO;
using System.Text;
using System.Windows;
using InstRecorder.Audio;
using NAudio.Wave;

namespace InstRecorder;

public partial class App : System.Windows.Application
{
    /// <summary>不具合が起きたときの記録先。録音物と同じ場所に置いて見つけやすくする。</summary>
    public static string LogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyMusic), "録音", "errors.log");

    protected override void OnStartup(StartupEventArgs e)
    {
        // 予期しない例外でも、原因を残してから終わる。
        // UI スレッドの例外は握って動き続ける（録音中に落ちると録れた音を失うため）。
        DispatcherUnhandledException += (_, args) =>
        {
            Log("UIスレッド", args.Exception);
            MessageBox.Show(
                "問題が起きましたが、アプリは動作を続けます。\n\n" +
                args.Exception.Message + "\n\n記録: " + LogPath,
                "Tonmeister", MessageBoxButton.OK, MessageBoxImage.Warning);
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            Log("その他のスレッド", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Log("バックグラウンド処理", args.Exception);
            args.SetObserved();
        };

        if (e.Args.Contains("--captest"))
        {
            CaptureTest.Run(e.Args.Length > 1 ? e.Args[1] : Path.Combine(Path.GetTempPath(), "captest.txt"));
            Shutdown();
            return;
        }
        if (e.Args.Contains("--etest"))
        {
            EditTest.Run(e.Args.Length > 1 ? e.Args[1] : Path.Combine(Path.GetTempPath(), "etest.txt"));
            Shutdown();
            return;
        }
        if (e.Args.Contains("--atest"))
        {
            AnalysisTest.Run(e.Args.Length > 1 ? e.Args[1] : Path.Combine(Path.GetTempPath(), "atest.txt"));
            Shutdown();
            return;
        }
        if (e.Args.Contains("--rtest"))
        {
            ReverbTest.Run(e.Args.Length > 1 ? e.Args[1] : Path.Combine(Path.GetTempPath(), "rtest.txt"));
            Shutdown();
            return;
        }
        if (e.Args.Contains("--mtest"))
        {
            MultiTest.Run(e.Args.Length > 1 ? e.Args[1] : Path.Combine(Path.GetTempPath(), "mtest.txt"));
            Shutdown();
            return;
        }
        if (e.Args.Contains("--probe"))
        {
            Probe.Run(e.Args.Length > 1 ? e.Args[1] : Path.Combine(Path.GetTempPath(), "probe.txt"));
            Shutdown();
            return;
        }
        if (e.Args.Contains("--selftest"))
        {
            SelfTest.Run(e.Args);
            Shutdown();
            return;
        }
        base.OnStartup(e);
    }

    public static void Log(string where, Exception? ex)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath,
                $"===== {DateTime.Now:yyyy-MM-dd HH:mm:ss} [{where}] ====={Environment.NewLine}" +
                (ex?.ToString() ?? "詳細不明") + Environment.NewLine + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { /* 記録できなくても本体は続ける */ }
    }
}

/// <summary>
/// GUI を出さずに録音経路を検証するモード。
/// 使い方: InstRecorder.exe --selftest [録音秒数] [出力レポートパス]
/// </summary>
internal static class SelfTest
{
    public static void Run(string[] args)
    {
        double seconds = 2.0;
        if (args.Length > 1 && double.TryParse(args[1], out var s)) seconds = s;
        string reportPath = args.Length > 2
            ? args[2]
            : Path.Combine(Path.GetTempPath(), "instrecorder_selftest.txt");

        var log = new StringBuilder();
        void W(string line) => log.AppendLine(line);

        try
        {
            W("=== 変換の無劣化検証 ===");
            W(ConversionCheck());
            W("");

            W("=== デバイス一覧 ===");
            var devices = DeviceScanner.ScanDevices();
            for (int i = 0; i < devices.Count; i++)
                W($"[{i}] {devices[i]}  (最大 {devices[i].MaxChannels}ch)");

            W("");
            W("=== 各デバイスの対応フォーマット ===");
            foreach (var d in devices)
            {
                try
                {
                    var fmts = DeviceScanner.ScanFormats(d);
                    W($"{d}: {fmts.Count} 通り");
                    foreach (var f in fmts.Take(12)) W($"    {f}");
                    if (fmts.Count > 12) W($"    ... 他 {fmts.Count - 12} 通り");
                }
                catch (Exception ex)
                {
                    W($"{d}: スキャン失敗 — {ex.Message.Split('\n')[0]}");
                }
            }

            // 実際に録れるか試す（排他モードを優先し、駄目なら共有モードへ）
            W("");
            W("=== 録音テスト ===");
            var ordered = devices
                .Where(d => d.Api != ApiKind.Asio)
                .OrderBy(d => d.Api == ApiKind.WasapiExclusive ? 0 : 1)
                .ToList();

            bool recorded = false;
            foreach (var dev in ordered)
            {
                List<FormatOption> fmts;
                try { fmts = DeviceScanner.ScanFormats(dev); }
                catch { continue; }
                if (fmts.Count == 0) continue;

                var fmt = fmts[0];
                using var engine = new RecorderEngine();
                try
                {
                    engine.OpenInput(dev, fmt, 0);
                    var outPath = Path.Combine(Path.GetTempPath(),
                        $"selftest_{DateTime.Now:HHmmss}.wav");
                    engine.StartRecording(outPath, SaveFormat.Float32);

                    float maxPeak = 0;
                    var until = DateTime.UtcNow.AddSeconds(seconds);
                    while (DateTime.UtcNow < until)
                    {
                        Thread.Sleep(50);
                        foreach (var p in engine.ReadPeaks()) maxPeak = Math.Max(maxPeak, p);
                    }

                    double secs = engine.RecordedSeconds;
                    int dropped = engine.DroppedBuffers;
                    string route = engine.FormatDescription;
                    engine.StopRecording();
                    engine.CloseInput();

                    var len = new FileInfo(outPath).Length;
                    W($"OK  {dev}");
                    W($"    経路: {route}");
                    W($"    フォーマット: {fmt}");
                    W($"    録音長: {secs:0.00} 秒 / ファイル {len:N0} バイト / 取りこぼし {dropped}");
                    W($"    最大ピーク: {(maxPeak > 0 ? (20 * Math.Log10(maxPeak)).ToString("0.0") + " dBFS" : "-inf（完全な無音）")}");
                    W($"    出力: {outPath}");

                    long expected = (long)(secs * fmt.SampleRate * fmt.Channels * 4);
                    W($"    サイズ検証: 期待 {expected:N0} バイト（ヘッダ除く）→ " +
                      (Math.Abs(len - 44 - expected) < fmt.SampleRate * fmt.Channels * 4 ? "一致" : "不一致"));
                    recorded = true;
                    break;
                }
                catch (Exception ex)
                {
                    W($"NG  {dev} — {ex.Message.Split('\n')[0]}");
                }
            }

            if (!recorded) W("録音できるデバイスがありませんでした。");
        }
        catch (Exception ex)
        {
            W("致命的エラー: " + ex);
        }

        File.WriteAllText(reportPath, log.ToString(), new UTF8Encoding(false));
    }

    /// <summary>
    /// 入力の整数PCM → float → 保存 の経路で値が変わらないことを確認する。
    /// 24bit までは float32 の仮数部に収まるので、往復誤差はゼロでなければならない。
    /// </summary>
    private static string ConversionCheck()
    {
        var sb = new StringBuilder();

        // 24bit の全ビットパターンから代表値を取り、float 経由で戻して一致するか見る
        int[] testValues =
        {
            0, 1, -1, 12345, -12345, 8388607, -8388608, 4194304, -4194304, 8388606, -8388607,
        };
        var src = new byte[testValues.Length * 3];
        for (int i = 0; i < testValues.Length; i++)
        {
            int v = testValues[i];
            src[i * 3] = (byte)v;
            src[i * 3 + 1] = (byte)(v >> 8);
            src[i * 3 + 2] = (byte)(v >> 16);
        }

        var floats = new float[testValues.Length];
        int n = SampleConvert.ToFloat(src, src.Length, new WaveFormat(48000, 24, 1), ref floats);

        var outBytes = Array.Empty<byte>();
        SampleConvert.FromFloat(floats, n, SaveFormat.Pcm24, ref outBytes);

        int mismatches = 0;
        for (int i = 0; i < src.Length; i++) if (src[i] != outBytes[i]) mismatches++;
        sb.AppendLine($"24bit PCM → float32 → 24bit PCM : 不一致バイト {mismatches} / {src.Length}"
                      + (mismatches == 0 ? "（完全一致）" : "（要調査）"));

        // float32 保存はバイト列がそのまま通ることを確認
        var f = new float[] { 0f, 1f, -1f, 1.5f, -1.5f, 1e-9f, float.Epsilon };
        var fb = Array.Empty<byte>();
        int bytes = SampleConvert.FromFloat(f, f.Length, SaveFormat.Float32, ref fb);
        var back = new float[f.Length];
        SampleConvert.ToFloat(fb, bytes, WaveFormat.CreateIeeeFloatWaveFormat(48000, 1), ref back);
        bool same = f.SequenceEqual(back);
        sb.AppendLine($"float32 → WAV(float32) → float32 : {(same ? "完全一致（1.0超も保持）" : "不一致")}");

        return sb.ToString().TrimEnd();
    }
}
