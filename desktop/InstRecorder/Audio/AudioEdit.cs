using System.IO;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// テイクの編集。元のファイルには一切触らず、常に新しいファイルを作る。
/// 失敗しても、気に入らなくても、前のテイクを選び直せば戻せる。
/// </summary>
public static class AudioEdit
{
    /// <summary>継ぎ目のプチッという音を避けるためのクロスフェード長。</summary>
    public const double CrossfadeSeconds = 0.005;

    /// <summary>選択範囲だけを取り出して新しいテイクにする。</summary>
    public static Take Crop(Take take, double startSeconds, double endSeconds,
                            string outputBasePath, SaveFormat save, string name)
    {
        if (endSeconds <= startSeconds)
            throw new ArgumentException("範囲の長さが 0 です。");

        using var reader = TakeReader.Open(take, startSeconds)
            ?? throw new InvalidOperationException("音声ファイルを開けませんでした。");

        var format = save.ToWaveFormat(reader.SampleRate, reader.Channels);
        using var writer = new PartWavWriter(outputBasePath, format);

        double wanted = endSeconds - startSeconds;
        CopyStream(reader.Provider, writer, save, (long)Math.Round(wanted * reader.SampleRate) * reader.Channels);
        writer.Flush();
        writer.Dispose();

        return Take.FromFiles(name, writer.Files);
    }

    /// <summary>
    /// 録り直した音を元のテイクの途中に差し替える（パンチイン）。
    /// 差し替えの前後は短くクロスフェードして、継ぎ目が聴こえないようにする。
    /// </summary>
    public static Take PunchIn(Take original, IReadOnlyList<string> recordedFiles, double punchInSeconds,
                               string outputBasePath, SaveFormat save, string name)
    {
        var recorded = Take.FromFiles("録り直し", recordedFiles);
        if (recorded.Files.Count == 0) throw new InvalidOperationException("録り直した音がありません。");

        using var originalHead = TakeReader.Open(original)
            ?? throw new InvalidOperationException("元のテイクを開けませんでした。");

        int rate = originalHead.SampleRate;
        int channels = originalHead.Channels;
        if (recorded.SampleRate != rate || recorded.Channels != channels)
            throw new InvalidOperationException(
                $"録り直した音の形式が違います（元 {rate / 1000.0:0.#}kHz {channels}ch / " +
                $"録り直し {recorded.SampleRate / 1000.0:0.#}kHz {recorded.Channels}ch）。");

        double punchOut = punchInSeconds + recorded.Seconds;
        int fade = (int)Math.Round(CrossfadeSeconds * rate);

        var format = save.ToWaveFormat(rate, channels);
        using var writer = new PartWavWriter(outputBasePath, format);

        // ① 差し替え開始位置まで、元の音をそのまま
        long headSamples = (long)Math.Round(punchInSeconds * rate) * channels;
        CopyStream(originalHead.Provider, writer, save, headSamples);

        // ② 元の音と録り直した音をクロスフェードで繋ぐ
        var originalFadeOut = originalHead.ReadSeconds(CrossfadeSeconds);
        using var recordedReader = TakeReader.Open(recorded)
            ?? throw new InvalidOperationException("録り直した音を開けませんでした。");
        var recordedFadeIn = recordedReader.ReadSeconds(CrossfadeSeconds);
        WriteCrossfade(writer, save, originalFadeOut, recordedFadeIn, channels);

        // ③ 録り直した音の本体
        long recordedRest = (long)Math.Round((recorded.Seconds - CrossfadeSeconds * 2) * rate) * channels;
        CopyStream(recordedReader.Provider, writer, save, Math.Max(0, recordedRest));

        // ④ 録り直しの終わりと元の音を、もう一度クロスフェードで繋ぐ
        using var originalTail = TakeReader.Open(original, punchOut - CrossfadeSeconds);
        if (originalTail != null)
        {
            var recordedFadeOut = recordedReader.ReadSeconds(CrossfadeSeconds);
            var originalFadeIn = originalTail.ReadSeconds(CrossfadeSeconds);
            WriteCrossfade(writer, save, recordedFadeOut, originalFadeIn, channels);

            // ⑤ 残りの元の音
            CopyStream(originalTail.Provider, writer, save, long.MaxValue);
        }
        else
        {
            // 元のテイクより長く録り直した場合は、そのまま最後まで書く
            CopyStream(recordedReader.Provider, writer, save, long.MaxValue);
        }

        writer.Flush();
        writer.Dispose();
        return Take.FromFiles(name, writer.Files);
    }

    /// <summary>2つの断片を重ねながら書く。合計のエネルギーが一定になる形（等パワー）にする。</summary>
    private static void WriteCrossfade(PartWavWriter writer, SaveFormat save,
                                       float[] fadeOut, float[] fadeIn, int channels)
    {
        int frames = Math.Min(fadeOut.Length, fadeIn.Length) / channels;
        if (frames <= 0) return;

        var mixed = new float[frames * channels];
        for (int f = 0; f < frames; f++)
        {
            double t = (double)f / frames;
            float a = (float)Math.Cos(t * Math.PI / 2); // 出ていく側
            float b = (float)Math.Sin(t * Math.PI / 2); // 入ってくる側
            for (int c = 0; c < channels; c++)
            {
                int i = f * channels + c;
                mixed[i] = fadeOut[i] * a + fadeIn[i] * b;
            }
        }

        var bytes = Array.Empty<byte>();
        int n = SampleConvert.FromFloat(mixed, mixed.Length, save, ref bytes);
        writer.Write(bytes, n);
    }

    /// <summary>最大 maxSamples サンプルまでコピーする。</summary>
    private static void CopyStream(ISampleProvider source, PartWavWriter writer, SaveFormat save,
                                   long maxSamples)
    {
        if (maxSamples <= 0) return;

        var buffer = new float[65536];
        var bytes = Array.Empty<byte>();
        long written = 0;

        while (written < maxSamples)
        {
            int want = (int)Math.Min(buffer.Length, maxSamples - written);
            int n = source.Read(buffer, 0, want);
            if (n == 0) break;
            int b = SampleConvert.FromFloat(buffer, n, save, ref bytes);
            writer.Write(bytes, b);
            written += n;
        }
    }
}
