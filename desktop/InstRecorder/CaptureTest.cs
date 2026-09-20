using System.IO;
using System.Text;
using InstRecorder.Audio;

namespace InstRecorder;

/// <summary>
/// 「普通に録音した音」と「解析用に取り込んだ音」が同じものかを、同一プロセスで突き合わせる。
/// 診断の数値が録音結果とかけ離れていたときの切り分け用。
/// 使い方: InstRecorder.exe --captest [レポート出力先]
/// </summary>
internal static class CaptureTest
{
    public static void Run(string reportPath)
    {
        var sb = new StringBuilder();
        void W(string s) => sb.AppendLine(s);

        try
        {
            var dev = DeviceScanner.ScanDevices()
                .Where(d => d.Api != ApiKind.Asio)
                .FirstOrDefault(d => DeviceScanner.ScanFormats(d).Count > 0);
            if (dev == null) { W("使える入力がありません。"); return; }

            var fmt = DeviceScanner.ScanFormats(dev)[0];
            using var engine = new RecorderEngine();
            engine.OpenInput(dev, fmt, 0);
            W($"入力: {engine.FormatDescription}");
            W("");

            // ---- ① 解析用の取り込み ----
            var cap = engine.CaptureForAnalysis(3.0);
            W($"① CaptureForAnalysis: {cap.Frames} フレーム / {cap.Channels}ch / {cap.Rate}Hz");
            W("   " + Describe(cap.Samples, cap.Samples.Length));

            // ---- ② 普通の録音 ----
            var path = Path.Combine(Path.GetTempPath(), "captest.wav");
            engine.StartRecording(path, SaveFormat.Float32);
            Thread.Sleep(3000);
            var files = engine.StopRecording();
            W("");
            W($"② StartRecording: {files.Count} ファイル");
            if (files.Count > 0)
            {
                var take = Take.FromFiles("t", files);
                using var reader = TakeReader.Open(take)!;
                var samples = reader.ReadSeconds(3.0);
                W("   " + Describe(samples, samples.Length));
            }

            // ---- ③ もう一度 解析用の取り込み ----
            var cap2 = engine.CaptureForAnalysis(3.0);
            W("");
            W($"③ CaptureForAnalysis（2回目）: {cap2.Frames} フレーム");
            W("   " + Describe(cap2.Samples, cap2.Samples.Length));

            // ---- ④ 音を出しながら取り込む ----
            // ここで level が戻るなら、静かな間だけ絞られている＝OS 側の音声補正（ノイズ抑制）。
            // 戻らないなら取り込み経路そのものの不具合。
            var gen = new NAudio.Wave.SampleProviders.SignalGenerator(48000, 2)
            {
                Gain = 0.5,
                Frequency = 1000,
                Type = NAudio.Wave.SampleProviders.SignalGeneratorType.Sin,
            };
            using (var speaker = new NAudio.Wave.WasapiOut(NAudio.CoreAudioApi.AudioClientShareMode.Shared, 80))
            {
                speaker.Init(new NAudio.Wave.SampleProviders.SampleToWaveProvider(gen));
                speaker.Play();
                Thread.Sleep(500);
                var cap3 = engine.CaptureForAnalysis(2.0);
                speaker.Stop();
                W("");
                W("④ 1kHz を鳴らしながら取り込み");
                W("   " + Describe(cap3.Samples, cap3.Samples.Length));
            }

            // ---- ⑤ 音を止めて、しばらく待ってから取り込む ----
            Thread.Sleep(3000);
            var cap4 = engine.CaptureForAnalysis(3.0);
            W("");
            W("⑤ 音を止めて3秒待ってから取り込み");
            W("   " + Describe(cap4.Samples, cap4.Samples.Length));

            engine.CloseInput();

            W("");
            W("④で戻り⑤で再び下がるなら、静かな間だけ絞る仕組み（OSの音声補正）が働いている。");
        }
        catch (Exception ex)
        {
            W("エラー: " + ex);
        }

        File.WriteAllText(reportPath, sb.ToString(), new UTF8Encoding(false));
    }

    private static string Describe(float[] x, int count)
    {
        if (count == 0) return "サンプルなし";

        float peak = 0;
        double sumSq = 0;
        int zeros = 0;
        for (int i = 0; i < count; i++)
        {
            float a = MathF.Abs(x[i]);
            if (a > peak) peak = a;
            if (x[i] == 0f) zeros++;
            sumSq += (double)x[i] * x[i];
        }
        double rms = Math.Sqrt(sumSq / count);

        return $"ピーク {Db(peak)} / RMS {Db(rms)} / 完全なゼロ {100.0 * zeros / count:0.0}%";
    }

    private static string Db(double v) => v > 0 ? $"{20 * Math.Log10(v):0.0} dBFS" : "-inf";
}
