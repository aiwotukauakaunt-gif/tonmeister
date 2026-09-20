using System.IO;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace InstRecorder.Audio;

/// <summary>
/// テイクを（分割されていても）1本の連続した音として読む。
/// 頭出しは該当ファイルを直接シークするので、長い録音でも待たされない。
/// </summary>
public sealed class TakeReader : IDisposable
{
    private readonly List<AudioFileReader> _readers = new();

    public int SampleRate { get; }
    public int Channels { get; }
    public double TotalSeconds { get; }
    public ISampleProvider Provider { get; }

    private TakeReader(List<AudioFileReader> readers, ISampleProvider provider,
                       int rate, int channels, double totalSeconds)
    {
        _readers = readers;
        Provider = provider;
        SampleRate = rate;
        Channels = channels;
        TotalSeconds = totalSeconds;
    }

    /// <param name="startSeconds">ここから読み始める。テイクの先頭からの秒数。</param>
    public static TakeReader? Open(Take take, double startSeconds = 0)
    {
        var files = take.Files.Where(File.Exists).ToList();
        if (files.Count == 0) return null;

        // 各ファイルの長さを調べ、開始位置がどのファイルの何秒目かを求める
        var readers = new List<AudioFileReader>();
        double total = 0;
        int rate = 0, channels = 0;
        double remaining = Math.Max(0, startSeconds);
        var parts = new List<ISampleProvider>();

        foreach (var f in files)
        {
            var reader = new AudioFileReader(f);
            readers.Add(reader);
            rate = reader.WaveFormat.SampleRate;
            channels = reader.WaveFormat.Channels;
            double len = reader.TotalTime.TotalSeconds;
            total += len;

            if (remaining >= len)
            {
                remaining -= len;      // このファイルは丸ごと飛ばす
                continue;
            }

            if (remaining > 0)
            {
                reader.CurrentTime = TimeSpan.FromSeconds(remaining);
                remaining = 0;
            }
            parts.Add(reader);
        }

        if (parts.Count == 0)
        {
            foreach (var r in readers) r.Dispose();
            return null;
        }

        ISampleProvider provider = parts.Count == 1 ? parts[0] : new ConcatenatingSampleProvider(parts);
        return new TakeReader(readers, provider, rate, channels, total);
    }

    /// <summary>指定秒数ぶんを読み出す。足りない場合は読めた分だけ返す。</summary>
    public float[] ReadSeconds(double seconds)
    {
        int wanted = (int)Math.Round(seconds * SampleRate) * Channels;
        var result = new float[wanted];
        int filled = 0;
        var buffer = new float[SampleRate * Channels];

        while (filled < wanted)
        {
            int want = Math.Min(buffer.Length, wanted - filled);
            int n = Provider.Read(buffer, 0, want);
            if (n == 0) break;
            Array.Copy(buffer, 0, result, filled, n);
            filled += n;
        }

        if (filled == wanted) return result;
        Array.Resize(ref result, filled);
        return result;
    }

    public void Dispose()
    {
        foreach (var r in _readers)
        {
            try { r.Dispose(); } catch { /* 破棄は続行 */ }
        }
        _readers.Clear();
    }
}
