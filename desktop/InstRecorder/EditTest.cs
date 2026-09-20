using System.IO;
using System.Text;
using InstRecorder.Audio;
using NAudio.Wave;

namespace InstRecorder;

/// <summary>
/// 編集と後処理を、既知の合成音で検証する開発用モード。
/// 使い方: InstRecorder.exe --etest [レポート出力先]
/// </summary>
internal static class EditTest
{
    private const int Rate = 48000;

    public static void Run(string reportPath)
    {
        var sb = new StringBuilder();
        void W(string s) => sb.AppendLine(s);

        string dir = Path.Combine(Path.GetTempPath(), "instrec_etest");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);

        try
        {
            // ---- 素材：0〜1秒 440Hz、1〜2秒 880Hz、2〜3秒 220Hz ----
            var source = Path.Combine(dir, "source.wav");
            WriteTone(source, new[] { (440.0, 1.0), (880.0, 1.0), (220.0, 1.0) });
            var take = Take.FromFiles("元テイク", new[] { source });
            W($"素材: {take.Seconds:0.000} 秒 / {take.SampleRate / 1000.0:0.#}kHz / {take.Channels}ch");
            W("  0〜1秒 440Hz / 1〜2秒 880Hz / 2〜3秒 220Hz");
            W("");

            // ---- 頭出し（シーク） ----
            W("=== 頭出し ===");
            using (var r = TakeReader.Open(take, 1.0)!)
            {
                var chunk = r.ReadSeconds(0.5);
                double f = DominantFrequency(chunk, r.Channels);
                W(Check("1.0秒地点の周波数", f, 880, 5, "Hz"));
            }
            using (var r = TakeReader.Open(take, 2.5)!)
            {
                var chunk = r.ReadSeconds(0.3);
                double f = DominantFrequency(chunk, r.Channels);
                W(Check("2.5秒地点の周波数", f, 220, 5, "Hz"));
            }
            W("");

            // ---- 切り出し ----
            W("=== 切り出し（1.0〜2.0秒だけ取り出す） ===");
            var cropped = AudioEdit.Crop(take, 1.0, 2.0,
                Path.Combine(dir, "crop.wav"), SaveFormat.Float32, "切り出し");
            W(Check("長さ", cropped.Seconds, 1.0, 0.01, "秒"));
            using (var r = TakeReader.Open(cropped)!)
            {
                var chunk = r.ReadSeconds(0.5);
                W(Check("中身の周波数", DominantFrequency(chunk, r.Channels), 880, 5, "Hz"));
            }
            W($"    元ファイルは無傷: {(File.Exists(source) ? "OK" : "NG")}");
            W("");

            // ---- パンチイン ----
            W("=== パンチイン（1.0秒から 1秒ぶんを 1234Hz で差し替え） ===");
            var punchSource = Path.Combine(dir, "punch.wav");
            WriteTone(punchSource, new[] { (1234.0, 1.0) });
            var punched = AudioEdit.PunchIn(take, new[] { punchSource }, 1.0,
                Path.Combine(dir, "punched.wav"), SaveFormat.Float32, "差し替え後");
            W(Check("全体の長さ", punched.Seconds, 3.0, 0.02, "秒"));
            W("    " + FreqAt(punched, 0.3, 440, "差し替え前（0.3秒）"));
            W("    " + FreqAt(punched, 1.5, 1234, "差し替え部（1.5秒）"));
            W("    " + FreqAt(punched, 2.5, 220, "差し替え後（2.5秒）"));
            W($"    継ぎ目の不連続: {SeamCheck(punched, 1.0)} / {SeamCheck(punched, 2.0)}");
            W("");

            // ---- 波形データ ----
            W("=== 波形データ ===");
            var wf = WaveformData.Build(take)!;
            W(Check("バケット数", wf.BucketCount, take.Seconds * Rate / WaveformData.FramesPerBucket, 2, "個"));
            W(Check("表す長さ", wf.BucketCount * wf.SecondsPerBucket, 3.0, 0.02, "秒"));
            double peak = wf.Max.Max();
            W(Check("最大値", peak, 0.5, 0.02, ""));
            W("");

            // ---- ハム除去 ----
            W("=== ハム除去 ===");
            var humFile = Path.Combine(dir, "hum.wav");
            WriteHum(humFile);
            var humTake = Take.FromFiles("ハム入り", new[] { humFile });

            var before = AnalyzeTake(humTake, null);
            var after = AnalyzeTake(humTake, new TrackProcessing
            {
                HumEnabled = true, HumFrequency = 50, HumHarmonics = 4,
            });
            W($"    処理前: 50Hz {before.hum:0.0} dBFS / 1kHz {before.tone:0.0} dBFS");
            W($"    処理後: 50Hz {after.hum:0.0} dBFS / 1kHz {after.tone:0.0} dBFS");
            W(CheckMin("ハムの減衰", before.hum - after.hum, 25, "dB"));
            W(Check("楽音への影響", Math.Abs(before.tone - after.tone), 0, 0.5, "dB"));
            W("");

            // ---- ノイズゲート ----
            W("=== ノイズゲート ===");
            var gateFile = Path.Combine(dir, "gate.wav");
            WriteGateTest(gateFile);
            var gateTake = Take.FromFiles("ゲート試験", new[] { gateFile });
            double loudBefore = LevelAt(gateTake, null, 0.3, 0.4);
            double quietBefore = LevelAt(gateTake, null, 1.7, 0.25);
            var gate = new TrackProcessing { GateEnabled = true, GateThresholdDb = -40 };
            double loudAfter = LevelAt(gateTake, gate, 0.3, 0.4);
            double quietAfter = LevelAt(gateTake, gate, 1.7, 0.25);
            // 閉じ始めの過渡を避けるため、音が止まってから 0.7 秒後を見る
            W($"    演奏部（0.3秒）: {loudBefore:0.0} → {loudAfter:0.0} dBFS");
            W($"    無音部（1.7秒）: {quietBefore:0.0} → {quietAfter:0.0} dBFS");
            W(Check("演奏部を保つ", Math.Abs(loudBefore - loudAfter), 0, 0.5, "dB"));
            W(CheckMin("無音部を下げる", quietBefore - quietAfter, 25, "dB"));

            W("");

            // ---- FLAC 書き出しの可逆性 ----
            W("=== FLAC 書き出し ===");
            W(FlacRoundTrip(dir));

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

    /// <summary>
    /// 24bit の素材を FLAC にして戻し、1サンプルも変わっていないことを確かめる。
    /// 「可逆圧縮」を名乗る以上、ここが合わなければ使ってはいけない。
    /// </summary>
    private static string FlacRoundTrip(string dir)
    {
        var lines = new List<string>();
        try
        {
            // 楽音とノイズを混ぜた素材（圧縮しにくい成分も入れる）
            var rnd = new Random(11);
            int frames = Rate * 2;
            var samples = new float[frames * 2];
            for (int i = 0; i < frames; i++)
            {
                float tone = 0.4f * MathF.Sin(2 * MathF.PI * 440f * i / Rate)
                           + 0.2f * MathF.Sin(2 * MathF.PI * 1310f * i / Rate);
                float noise = (float)((rnd.NextDouble() - 0.5) * 0.05);
                samples[i * 2] = tone + noise;
                samples[i * 2 + 1] = tone - noise;
            }

            // 24bit PCM の WAV として保存（これが比較の基準）
            var wavPath = Path.Combine(dir, "flac_src.wav");
            using (var w = new WaveFileWriter(wavPath, new WaveFormat(Rate, 24, 2)))
            {
                var bytes = Array.Empty<byte>();
                int b = SampleConvert.FromFloat(samples, samples.Length, SaveFormat.Pcm24, ref bytes);
                w.Write(bytes, 0, b);
            }

            var take = Take.FromFiles("FLAC試験", new[] { wavPath });
            var session = new Session { SampleRate = Rate };
            var track = new Track();
            track.AddTake(take);
            session.Tracks.Add(track);

            var flacPath = Path.Combine(dir, "out.flac");
            var result = FlacExport.Export(session, flacPath);
            lines.Add($"    書き出し: {result.Seconds:0.00} 秒 / " +
                      $"{result.Bytes / 1024.0:0} KB（WAV 24bit なら {result.WavBytes / 1024.0:0} KB） " +
                      $"圧縮率 {result.CompressionRatio * 100:0}%");

            // FLAC を読み戻して、元の 24bit サンプルと突き合わせる
            var decoded = DecodeFlac(flacPath, out int decodedRate, out int decodedChannels);
            var original = ReadPcm24(wavPath);

            lines.Add($"    形式: {decodedRate / 1000.0:0.#}kHz / {decodedChannels}ch " +
                      (decodedRate == Rate && decodedChannels == 2 ? "OK" : "NG"));

            int compare = Math.Min(decoded.Length, original.Length);
            int mismatches = 0;
            for (int i = 0; i < compare; i++)
                if (decoded[i] != original[i]) mismatches++;

            lines.Add($"    サンプル数: 元 {original.Length} / 復元 {decoded.Length} " +
                      (decoded.Length == original.Length ? "OK" : "NG"));
            lines.Add($"    [{(mismatches == 0 ? "OK" : "NG")}] 不一致サンプル {mismatches} 個" +
                      (mismatches == 0 ? "（完全に可逆）" : ""));
        }
        catch (Exception ex)
        {
            lines.Add("    NG 例外: " + ex.Message);
        }
        return string.Join("\n", lines);
    }

    private static int[] DecodeFlac(string path, out int rate, out int channels)
    {
        var reader = new CUETools.Codecs.FLAKE.FlakeReader(path, null);
        try
        {
            rate = reader.PCM.SampleRate;
            channels = reader.PCM.ChannelCount;

            var buffer = new CUETools.Codecs.FLAKE.AudioBuffer(reader.PCM, 4096);
            var output = new List<int>();
            int n;
            while ((n = reader.Read(buffer, 4096)) > 0)
            {
                for (int f = 0; f < n; f++)
                    for (int c = 0; c < channels; c++)
                        output.Add(buffer.Samples[f, c]);
            }
            return output.ToArray();
        }
        finally
        {
            reader.Close();
        }
    }

    private static int[] ReadPcm24(string path)
    {
        // ヘッダの長さは書き手によって変わる（NAudio は 46 バイト）ので、
        // 決め打ちせず data チャンクの位置を読み手に任せる。
        using var reader = new WaveFileReader(path);
        var bytes = new byte[reader.Length];
        int read = reader.Read(bytes, 0, bytes.Length);

        int count = read / 3;
        var result = new int[count];
        for (int i = 0; i < count; i++)
        {
            int o = i * 3;
            result[i] = bytes[o] | (bytes[o + 1] << 8) | ((sbyte)bytes[o + 2] << 16);
        }
        return result;
    }

    // ---------- 素材づくり ----------

    private static void WriteTone(string path, (double Hz, double Seconds)[] segments)
    {
        using var w = new WaveFileWriter(path, WaveFormat.CreateIeeeFloatWaveFormat(Rate, 2));
        foreach (var (hz, sec) in segments)
        {
            int n = (int)(Rate * sec);
            var buf = new float[n * 2];
            for (int i = 0; i < n; i++)
            {
                float v = 0.5f * MathF.Sin(2 * MathF.PI * (float)hz * i / Rate);
                buf[i * 2] = v;
                buf[i * 2 + 1] = v;
            }
            var bytes = Array.Empty<byte>();
            int b = SampleConvert.FromFloat(buf, buf.Length, SaveFormat.Float32, ref bytes);
            w.Write(bytes, 0, b);
        }
    }

    /// <summary>1kHz の楽音に 50Hz とその倍音のハムを混ぜたもの。</summary>
    private static void WriteHum(string path)
    {
        int n = Rate * 2;
        var buf = new float[n * 2];
        for (int i = 0; i < n; i++)
        {
            float tone = 0.3f * MathF.Sin(2 * MathF.PI * 1000f * i / Rate);
            float hum = 0.05f * MathF.Sin(2 * MathF.PI * 50f * i / Rate)
                      + 0.02f * MathF.Sin(2 * MathF.PI * 100f * i / Rate);
            buf[i * 2] = buf[i * 2 + 1] = tone + hum;
        }
        using var w = new WaveFileWriter(path, WaveFormat.CreateIeeeFloatWaveFormat(Rate, 2));
        var bytes = Array.Empty<byte>();
        int b = SampleConvert.FromFloat(buf, buf.Length, SaveFormat.Float32, ref bytes);
        w.Write(bytes, 0, b);
    }

    /// <summary>0〜1秒は大きな音、1〜2秒は小さなノイズだけ。</summary>
    private static void WriteGateTest(string path)
    {
        var rnd = new Random(7);
        int n = Rate * 2;
        var buf = new float[n * 2];
        for (int i = 0; i < n; i++)
        {
            float v = i < Rate
                ? 0.5f * MathF.Sin(2 * MathF.PI * 440f * i / Rate)
                : (float)((rnd.NextDouble() - 0.5) * 0.002); // −60dBFS 程度
            buf[i * 2] = buf[i * 2 + 1] = v;
        }
        using var w = new WaveFileWriter(path, WaveFormat.CreateIeeeFloatWaveFormat(Rate, 2));
        var bytes = Array.Empty<byte>();
        int b = SampleConvert.FromFloat(buf, buf.Length, SaveFormat.Float32, ref bytes);
        w.Write(bytes, 0, b);
    }

    // ---------- 測る ----------

    private static string FreqAt(Take take, double at, double expected, string label)
    {
        using var r = TakeReader.Open(take, at)!;
        var chunk = r.ReadSeconds(0.2);
        double f = DominantFrequency(chunk, r.Channels);
        bool ok = Math.Abs(f - expected) <= 8;
        return $"[{(ok ? "OK" : "NG")}] {label}: {f:0} Hz（期待 {expected:0} Hz）";
    }

    /// <summary>継ぎ目でサンプルが飛んでいないか（隣り合う値の差が異常に大きくないか）を見る。</summary>
    private static string SeamCheck(Take take, double at)
    {
        using var r = TakeReader.Open(take, at - 0.02)!;
        var chunk = r.ReadSeconds(0.04);
        float maxJump = 0;
        for (int i = r.Channels; i < chunk.Length; i += r.Channels)
            maxJump = Math.Max(maxJump, Math.Abs(chunk[i] - chunk[i - r.Channels]));
        // 0.5 振幅・1234Hz なら1サンプルあたりの変化は最大でも 0.09 程度
        return $"{at:0.0}秒 最大跳躍 {maxJump:0.000}" + (maxJump < 0.15 ? " OK" : " NG");
    }

    private static (double hum, double tone) AnalyzeTake(Take take, TrackProcessing? processing)
    {
        var session = new Session { SampleRate = Rate };
        var track = new Track();
        track.AddTake(take);
        if (processing != null) track.Processing = processing;
        session.Tracks.Add(track);

        using var mix = SessionMix.Build(session)!;
        var buf = new float[Rate * 2 * 2];
        int total = 0;
        while (total < buf.Length)
        {
            int n = mix.Provider.Read(buf, total, buf.Length - total);
            if (n == 0) break;
            total += n;
        }

        // フィルタの立ち上がりを避けるため後半だけ見る
        var half = new float[total / 2];
        Array.Copy(buf, total / 2, half, 0, half.Length);
        var mono = ToMono(half, 2);
        var report = SignalAnalysis.AnalyzeChannel(mono, 0, Rate);
        return (BandAt(report, 50), BandAt(report, 1000));
    }

    private static double LevelAt(Take take, TrackProcessing? processing, double at, double length)
    {
        var session = new Session { SampleRate = Rate };
        var track = new Track();
        track.AddTake(take);
        if (processing != null) track.Processing = processing;
        session.Tracks.Add(track);

        // ゲートの状態を正しく作るため、必ず頭から通して読む
        using var mix = SessionMix.Build(session)!;
        int skip = (int)(at * Rate) * 2;
        int want = (int)(length * Rate) * 2;
        var scratch = new float[8192];
        int done = 0;
        while (done < skip)
        {
            int n = mix.Provider.Read(scratch, 0, Math.Min(scratch.Length, skip - done));
            if (n == 0) break;
            done += n;
        }

        var buf = new float[want];
        int got = 0;
        while (got < want)
        {
            int n = mix.Provider.Read(buf, got, want - got);
            if (n == 0) break;
            got += n;
        }

        double sum = 0;
        for (int i = 0; i < got; i++) sum += buf[i] * buf[i];
        double rms = got > 0 ? Math.Sqrt(sum / got) : 0;
        return rms > 0 ? 20 * Math.Log10(rms) : -200;
    }

    private static double BandAt(SignalAnalysis.ChannelReport r, double hz) =>
        r.Bands.OrderBy(b => Math.Abs(b.CenterHz - hz)).First().Db;

    private static float[] ToMono(float[] interleaved, int channels)
    {
        var mono = new float[interleaved.Length / channels];
        for (int i = 0; i < mono.Length; i++)
        {
            float v = 0;
            for (int c = 0; c < channels; c++) v += interleaved[i * channels + c];
            mono[i] = v / channels;
        }
        return mono;
    }

    /// <summary>ゼロ交差の間隔から基本周波数を求める。合成した純音なのでこれで足りる。</summary>
    private static double DominantFrequency(float[] interleaved, int channels)
    {
        var mono = ToMono(interleaved, channels);
        int crossings = 0;
        int first = -1, last = -1;
        for (int i = 1; i < mono.Length; i++)
        {
            if (mono[i - 1] < 0 && mono[i] >= 0)
            {
                if (first < 0) first = i;
                last = i;
                crossings++;
            }
        }
        if (crossings < 2 || last <= first) return 0;
        double periods = crossings - 1;
        double samples = last - first;
        return periods * Rate / samples;
    }

    private static string Check(string name, double actual, double expected, double tolerance, string unit)
    {
        bool ok = Math.Abs(actual - expected) <= tolerance;
        return $"    [{(ok ? "OK" : "NG")}] {name,-18} 実測 {actual,9:0.000} {unit}  期待 {expected:0.000} ±{tolerance}";
    }

    /// <summary>「これ以上あること」を確かめる。減衰量のように上限を決めたくない項目に使う。</summary>
    private static string CheckMin(string name, double actual, double minimum, string unit)
    {
        bool ok = actual >= minimum;
        return $"    [{(ok ? "OK" : "NG")}] {name,-18} 実測 {actual,9:0.000} {unit}  期待 {minimum:0.000} 以上";
    }
}
