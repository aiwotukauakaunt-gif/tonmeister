using System.Runtime.InteropServices;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// 生バイト列 ⇔ float の変換。整数 PCM ↔ float は 2^(bits-1) でスケールするだけで、
/// 24bit 以下なら float32 の仮数部（24bit）に完全に収まるため往復で情報が落ちない。
/// </summary>
public static class SampleConvert
{
    public static bool IsFloatFormat(WaveFormat f)
    {
        if (f.Encoding == WaveFormatEncoding.IeeeFloat) return true;
        if (f is WaveFormatExtensible ext) return ext.SubFormat == WaveFormatHelper.SubtypeIeeeFloat;
        return false;
    }

    public static string Describe(WaveFormat f)
    {
        var kind = IsFloatFormat(f) ? "float" : "PCM";
        int valid = WaveFormatHelper.ValidBits(f);
        var bits = valid == f.BitsPerSample
            ? $"{f.BitsPerSample}bit"
            : $"{valid}bit（{f.BitsPerSample}bitコンテナ）";
        return $"{f.SampleRate / 1000.0:0.#} kHz / {bits} {kind} / {f.Channels}ch";
    }

    /// <summary>キャプチャしたバイト列を float[] に展開する。戻り値は書き込んだサンプル数。</summary>
    public static int ToFloat(byte[] src, int byteCount, WaveFormat format, ref float[] dst)
    {
        int bytesPerSample = format.BitsPerSample / 8;
        if (bytesPerSample == 0) return 0;
        int samples = byteCount / bytesPerSample;
        if (dst.Length < samples) dst = new float[samples];

        bool isFloat = IsFloatFormat(format);
        var span = src.AsSpan(0, byteCount);

        if (isFloat && format.BitsPerSample == 32)
        {
            MemoryMarshal.Cast<byte, float>(span).CopyTo(dst.AsSpan(0, samples));
            return samples;
        }

        switch (format.BitsPerSample)
        {
            case 16:
            {
                var s16 = MemoryMarshal.Cast<byte, short>(span);
                for (int i = 0; i < samples; i++) dst[i] = s16[i] / 32768f;
                return samples;
            }
            case 24:
            {
                for (int i = 0; i < samples; i++)
                {
                    int o = i * 3;
                    int v = (span[o] | (span[o + 1] << 8) | ((sbyte)span[o + 2] << 16));
                    dst[i] = v / 8388608f;
                }
                return samples;
            }
            case 32:
            {
                var s32 = MemoryMarshal.Cast<byte, int>(span);
                for (int i = 0; i < samples; i++) dst[i] = s32[i] / 2147483648f;
                return samples;
            }
            default:
                throw new NotSupportedException($"{format.BitsPerSample}bit の入力には未対応です。");
        }
    }

    /// <summary>float[] を保存形式のバイト列に変換する。戻り値は書き込んだバイト数。</summary>
    public static int FromFloat(float[] src, int sampleCount, SaveFormat save, ref byte[] dst)
    {
        int bps = save.BytesPerSample();
        int bytes = sampleCount * bps;
        if (dst.Length < bytes) dst = new byte[bytes];

        if (save == SaveFormat.Float32)
        {
            // 32bit float はクリップさせない。1.0 を超えた値もそのまま保存し、後で下げれば救える。
            MemoryMarshal.Cast<float, byte>(src.AsSpan(0, sampleCount))
                         .CopyTo(dst.AsSpan(0, bytes));
            return bytes;
        }

        for (int i = 0; i < sampleCount; i++)
        {
            int v = (int)MathF.Round(src[i] * 8388608f);
            if (v > 8388607) v = 8388607;
            else if (v < -8388608) v = -8388608;
            int o = i * 3;
            dst[o] = (byte)v;
            dst[o + 1] = (byte)(v >> 8);
            dst[o + 2] = (byte)(v >> 16);
        }
        return bytes;
    }
}
