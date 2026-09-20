using System.Runtime.InteropServices;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// 中身を差し替えられる出力元。ASIO は入力と出力を1つのドライバインスタンスで扱う必要があり、
/// デバイスを開く時点では「何を再生するか」がまだ決まっていないため、
/// 常にこれを繋いでおいて再生のたびに中身だけ入れ替える。ソースが無いときは無音を出す。
/// </summary>
public sealed class SwitchableWaveProvider : IWaveProvider
{
    private volatile ISampleProvider? _source;
    private float[] _buf = Array.Empty<float>();

    public SwitchableWaveProvider(int sampleRate, int channels)
    {
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, channels);
    }

    public WaveFormat WaveFormat { get; }

    public void SetSource(ISampleProvider? source) => _source = source;

    public int Read(byte[] buffer, int offset, int count)
    {
        int samples = count / 4;
        if (_buf.Length < samples) _buf = new float[samples];

        var src = _source;
        int read = 0;
        if (src != null)
        {
            try { read = src.Read(_buf, 0, samples); }
            catch { read = 0; }
        }
        for (int i = read; i < samples; i++) _buf[i] = 0f;

        MemoryMarshal.Cast<float, byte>(_buf.AsSpan(0, samples))
                     .CopyTo(buffer.AsSpan(offset, count));
        return count;
    }
}
