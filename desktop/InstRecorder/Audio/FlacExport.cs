using System.IO;
using CUETools.Codecs.FLAKE;

namespace InstRecorder.Audio;

/// <summary>
/// FLAC 書き出し。FLAC は整数 PCM しか扱えない仕様なので、24bit で書き出す。
///
/// 24bit で録った音は完全に無劣化（ビット単位で元に戻せる）。
/// 32bit float で録った音は 24bit への変換が入るので、
/// 0 dBFS を超えた部分は失われる。書き出す前に音量を下げること。
/// </summary>
public static class FlacExport
{
    public sealed record Result(string Path, double Seconds, float Peak, bool Clipped,
                                long Bytes, long WavBytes)
    {
        public double CompressionRatio => WavBytes > 0 ? (double)Bytes / WavBytes : 1;
    }

    public static Result Export(Session session, string outputPath)
    {
        using var mix = SessionMix.Build(session)
            ?? throw new InvalidOperationException("書き出せるトラックがありません。");

        int rate = mix.SampleRate;
        const int channels = 2;
        const int bits = 24;
        const int maxValue = 8388607;
        const int minValue = -8388608;

        long totalFrames = (long)Math.Ceiling(mix.LengthSeconds * rate);
        var pcm = new AudioPCMConfig(bits, channels, rate);
        // 圧縮率 0〜8。既定の 7 で、速度と圧縮率のつり合いが良い。
        // DoVerify は書いた直後に自前でデコードし直して照合する設定（可逆であることの保険）。
        var settings = new FlakeWriterSettings { PCM = pcm, EncoderMode = "7", DoVerify = true };

        float peak = 0;
        long written = 0;

        var writer = new FlakeWriter(outputPath, settings);
        try
        {
            // 総サンプル数はあえて宣言しない。宣言すると1サンプルでもズレたときに
            // エンコーダが例外を投げるが、長さは書き終えてから確定させたい。
            const int blockFrames = 4096;
            var floats = new float[blockFrames * channels];
            var ints = new int[blockFrames, channels];
            var buffer = new AudioBuffer(pcm, blockFrames);

            while (written < totalFrames)
            {
                int wantFrames = (int)Math.Min(blockFrames, totalFrames - written);
                int got = mix.Provider.Read(floats, 0, wantFrames * channels);
                if (got == 0) break;

                int frames = got / channels;
                for (int f = 0; f < frames; f++)
                {
                    for (int c = 0; c < channels; c++)
                    {
                        float v = floats[f * channels + c];
                        float a = Math.Abs(v);
                        if (a > peak) peak = a;

                        int s = (int)MathF.Round(v * 8388608f);
                        ints[f, c] = Math.Clamp(s, minValue, maxValue);
                    }
                }

                buffer.Prepare(ints, frames);
                writer.Write(buffer);
                written += frames;
            }
        }
        finally
        {
            writer.Close();
        }

        long flacBytes = new FileInfo(outputPath).Length;
        long wavBytes = written * channels * 3 + 44;

        return new Result(outputPath, (double)written / rate, peak, peak > 1.0f, flacBytes, wavBytes);
    }
}
