using System.Reflection;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// NAudio の WaveFormatExtensible には「24bit を 32bit コンテナに入れる」形式を作る手段が無いが、
/// 排他モードのオーディオI/Fはこの形式しか受け付けないことが多いので、内部フィールドを直接組み立てる。
/// </summary>
public static class WaveFormatHelper
{
    public static readonly Guid SubtypePcm = new("00000001-0000-0010-8000-00aa00389b71");
    public static readonly Guid SubtypeIeeeFloat = new("00000003-0000-0010-8000-00aa00389b71");

    private static readonly FieldInfo? ValidBitsField =
        typeof(WaveFormatExtensible).GetField("wValidBitsPerSample", BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly FieldInfo? ChannelMaskField =
        typeof(WaveFormatExtensible).GetField("dwChannelMask", BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly FieldInfo? SubFormatField =
        typeof(WaveFormatExtensible).GetField("subFormat", BindingFlags.Instance | BindingFlags.NonPublic);

    public static bool Available => ValidBitsField != null && ChannelMaskField != null && SubFormatField != null;

    /// <summary>24bit PCM を 32bit コンテナに入れた WaveFormatExtensible。</summary>
    public static WaveFormatExtensible? Pcm24In32(int rate, int channels)
    {
        if (!Available) return null;
        var f = new WaveFormatExtensible(rate, 32, channels);
        ValidBitsField!.SetValue(f, (short)24);
        ChannelMaskField!.SetValue(f, DefaultChannelMask(channels));
        SubFormatField!.SetValue(f, SubtypePcm);
        return f;
    }

    /// <summary>32bit 整数 PCM の WaveFormatExtensible（既定は float 扱いになるため作り直す）。</summary>
    public static WaveFormatExtensible? Pcm32(int rate, int channels)
    {
        if (!Available) return null;
        var f = new WaveFormatExtensible(rate, 32, channels);
        ValidBitsField!.SetValue(f, (short)32);
        ChannelMaskField!.SetValue(f, DefaultChannelMask(channels));
        SubFormatField!.SetValue(f, SubtypePcm);
        return f;
    }

    private static int DefaultChannelMask(int channels) => channels switch
    {
        1 => 0x4,   // FRONT_CENTER
        2 => 0x3,   // FRONT_LEFT | FRONT_RIGHT
        _ => 0,
    };

    /// <summary>実際に意味を持つビット数。Extensible でなければ BitsPerSample と同じ。</summary>
    public static int ValidBits(WaveFormat f)
    {
        if (f is WaveFormatExtensible ext && ValidBitsField != null)
        {
            var v = (short)(ValidBitsField.GetValue(ext) ?? (short)0);
            if (v > 0) return v;
        }
        return f.BitsPerSample;
    }
}
