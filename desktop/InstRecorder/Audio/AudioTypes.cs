using NAudio.Wave;

namespace InstRecorder.Audio;

public enum ApiKind
{
    WasapiShared,
    WasapiExclusive,
    Asio,
}

/// <summary>入力デバイス1つ分の識別情報。WASAPI は同じ物理デバイスを共有/排他の2エントリで持つ。</summary>
public sealed class InputDeviceRef
{
    public ApiKind Api { get; init; }
    /// <summary>WASAPI は MMDevice.ID、ASIO はドライバ名。</summary>
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public int MaxChannels { get; init; }

    public string ApiLabel => Api switch
    {
        ApiKind.WasapiShared => "WASAPI 共有",
        ApiKind.WasapiExclusive => "WASAPI 排他",
        ApiKind.Asio => "ASIO",
        _ => "?",
    };

    public override string ToString() => $"[{ApiLabel}] {Name}";
}

/// <summary>重ね録りの再生先。</summary>
public sealed class OutputDeviceRef
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public bool IsDefault { get; init; }

    public override string ToString() => IsDefault ? $"{Name}（既定）" : Name;
}

/// <summary>そのデバイスで実際に開けることを確認済みの録音フォーマット。</summary>
public sealed class FormatOption
{
    public int SampleRate { get; init; }
    public int BitsPerSample { get; init; }
    public bool IsFloat { get; init; }
    public int Channels { get; init; }
    /// <summary>WASAPI 用。ASIO の場合は null。</summary>
    public WaveFormat? WaveFormat { get; init; }

    public string BitLabel => IsFloat ? $"{BitsPerSample}bit float" : $"{BitsPerSample}bit";

    public override string ToString() =>
        $"{SampleRate / 1000.0:0.#} kHz / {BitLabel} / {Channels}ch";
}

/// <summary>ファイルに書き出す形式。入力ビット深度とは独立。</summary>
public enum SaveFormat
{
    /// <summary>32bit float WAV。24bit までの入力を完全に無劣化で保持でき、0dBFS 超も記録できる。</summary>
    Float32,
    /// <summary>24bit PCM WAV。容量が 3/4 になり互換性が高い。</summary>
    Pcm24,
}

public static class SaveFormatExt
{
    public static string Label(this SaveFormat f) => f switch
    {
        SaveFormat.Float32 => "32bit float WAV（推奨・無劣化）",
        SaveFormat.Pcm24 => "24bit PCM WAV（容量小・互換性重視）",
        _ => f.ToString(),
    };

    public static int BytesPerSample(this SaveFormat f) => f == SaveFormat.Float32 ? 4 : 3;

    public static WaveFormat ToWaveFormat(this SaveFormat f, int rate, int channels) =>
        f == SaveFormat.Float32
            ? WaveFormat.CreateIeeeFloatWaveFormat(rate, channels)
            : new WaveFormat(rate, 24, channels);
}
