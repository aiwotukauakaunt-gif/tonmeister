using NAudio.Wave;

namespace InstRecorder.Audio;

public static class Mixdown
{
    public sealed record Result(string Path, double Seconds, float Peak, bool Clipped);

    /// <summary>
    /// セッションを1本の WAV に書き出す。音量・ミュート・ソロは画面の状態がそのまま反映される。
    /// 32bit float 保存ならピークが 1.0 を超えても情報は失われない。
    /// </summary>
    public static Result Export(Session session, string outputPath, SaveFormat save)
    {
        using var mix = SessionMix.Build(session)
            ?? throw new InvalidOperationException("書き出せるトラックがありません。");

        int rate = mix.SampleRate;
        long totalSamples = (long)Math.Ceiling(mix.LengthSeconds * rate) * 2;

        using var writer = new WaveFileWriter(outputPath, save.ToWaveFormat(rate, 2));
        var buf = new float[rate * 2 / 10]; // 0.1秒ぶん
        var bytes = Array.Empty<byte>();
        long written = 0;
        float peak = 0;

        while (written < totalSamples)
        {
            int want = (int)Math.Min(buf.Length, totalSamples - written);
            int n = mix.Provider.Read(buf, 0, want);
            if (n == 0) break;

            for (int i = 0; i < n; i++)
            {
                float a = MathF.Abs(buf[i]);
                if (a > peak) peak = a;
            }

            int b = SampleConvert.FromFloat(buf, n, save, ref bytes);
            writer.Write(bytes, 0, b);
            written += n;
        }

        writer.Flush();
        return new Result(outputPath, written / 2.0 / rate, peak, peak > 1.0f);
    }
}
