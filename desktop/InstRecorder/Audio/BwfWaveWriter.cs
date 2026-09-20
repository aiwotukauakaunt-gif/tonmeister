using System.IO;
using System.Text;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// 書き出す WAV に付ける BWF（Broadcast Wave）の bext チャンクの中身。
/// 「この音はどう録られたか」の札。Web 版と同じ形。
/// </summary>
public sealed record BwfInfo(
    string Description,
    string OriginatorReference,
    long TimeReferenceSamples,
    string CodingHistory);

/// <summary>
/// RIFF / bext / fmt / data の順で書く WAV ライター。
/// NAudio の WaveFileWriter は bext を挟めないので自前。float32 と 16/24bit PCM に対応。
/// 書きながら定期的に Flush でき、Dispose で長さを書き直す（途中で落ちても WavRepair が直せる形）。
/// </summary>
public sealed class BwfWaveWriter : IDisposable
{
    private const int BextFixed = 602;

    private readonly FileStream _fs;
    private readonly BinaryWriter _w;
    private readonly long _riffSizePos;
    private readonly long _dataSizePos;
    private readonly long _dataStart;
    private bool _disposed;

    public WaveFormat WaveFormat { get; }
    /// <summary>data チャンクに書いたバイト数。</summary>
    public long Length { get; private set; }

    public BwfWaveWriter(string path, WaveFormat format, BwfInfo? bext)
    {
        WaveFormat = format;
        _fs = new FileStream(path, FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
        _w = new BinaryWriter(_fs, Encoding.ASCII, leaveOpen: true);

        _w.Write("RIFF".ToCharArray());
        _riffSizePos = _fs.Position;
        _w.Write(0u);
        _w.Write("WAVE".ToCharArray());

        if (bext != null) WriteBext(bext);

        // fmt：float は 16 バイトの基本形、PCM は WAVEFORMATEX（cbSize 0）
        bool isFloat = SampleConvert.IsFloatFormat(format);
        _w.Write("fmt ".ToCharArray());
        _w.Write(16u);
        _w.Write((ushort)(isFloat ? 3 : 1));
        _w.Write((ushort)format.Channels);
        _w.Write((uint)format.SampleRate);
        _w.Write((uint)format.AverageBytesPerSecond);
        _w.Write((ushort)format.BlockAlign);
        _w.Write((ushort)format.BitsPerSample);

        _w.Write("data".ToCharArray());
        _dataSizePos = _fs.Position;
        _w.Write(0u);
        _dataStart = _fs.Position;
    }

    private void WriteBext(BwfInfo b)
    {
        var history = Encoding.UTF8.GetBytes(b.CodingHistory ?? "");
        if (history.Length % 2 == 1) Array.Resize(ref history, history.Length + 1);
        uint size = (uint)(BextFixed + history.Length);
        _w.Write("bext".ToCharArray());
        _w.Write(size);
        WriteFixed(b.Description, 256);
        WriteFixed("Tonmeister", 32);
        WriteFixed(b.OriginatorReference, 32);
        var now = DateTime.Now;
        WriteFixed(now.ToString("yyyy-MM-dd"), 10);
        WriteFixed(now.ToString("HH:mm:ss"), 8);
        ulong tr = (ulong)Math.Max(0, b.TimeReferenceSamples);
        _w.Write((uint)(tr & 0xFFFFFFFF));
        _w.Write((uint)(tr >> 32));
        _w.Write((ushort)1);                 // version
        _w.Write(new byte[64]);              // UMID
        _w.Write(new byte[10 + 180]);        // loudness（v2）＋ reserved
        _w.Write(history);
    }

    private void WriteFixed(string text, int length)
    {
        var bytes = new byte[length];
        var src = Encoding.UTF8.GetBytes(text ?? "");
        Array.Copy(src, bytes, Math.Min(src.Length, length));
        _w.Write(bytes);
    }

    public void Write(byte[] buffer, int offset, int count)
    {
        if (_disposed) return;
        _fs.Write(buffer, offset, count);
        Length += count;
    }

    /// <summary>途中の長さも書いておく（落ちたときの復元を楽にする）。</summary>
    public void Flush()
    {
        if (_disposed) return;
        UpdateSizes();
        _fs.Flush(true);
    }

    private void UpdateSizes()
    {
        long end = _fs.Position;
        _fs.Position = _riffSizePos;
        _w.Write((uint)Math.Min(uint.MaxValue, _dataStart - 8 + Length));
        _fs.Position = _dataSizePos;
        _w.Write((uint)Math.Min(uint.MaxValue, Length));
        _fs.Position = end;
    }

    public void Dispose()
    {
        if (_disposed) return;
        UpdateSizes();
        _disposed = true;
        _w.Dispose();
        _fs.Dispose();
    }
}
