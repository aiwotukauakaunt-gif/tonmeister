using System.IO;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// WAV(RIFF) は 4GB を超えられないので、その手前で次のファイルに切り替えながら書き続ける。
/// 切り替えはバッファの境目で行うため、サンプルは1つも落ちない。
/// 分割された断片は再生時に繋げて1本として扱う。
/// </summary>
public sealed class PartWavWriter : IDisposable
{
    /// <summary>RIFF の 4GB 制限に対する余裕を見た切り替え点。</summary>
    public const long DefaultSplitBytes = 3_900_000_000;

    private readonly string _basePath;
    private readonly WaveFormat _format;
    private readonly long _splitBytes;
    private readonly BwfInfo? _bext;
    private readonly List<string> _files = new();
    private BwfWaveWriter? _writer;
    private int _partIndex;
    private long _sinceFlush;

    /// <summary>これだけ書いたらディスクへ吐き出す（48kHz/32bit float ステレオで約2秒ぶん）。</summary>
    private const long FlushEveryBytes = 750_000;

    public IReadOnlyList<string> Files => _files;
    public long TotalBytes { get; private set; }

    /// <summary>分割が起きたときに通知する（画面に出すため）。</summary>
    public event Action<string>? PartStarted;

    /// <param name="bext">BWF の札。null なら付けない。分割した断片には TimeReference に開始位置が入る。</param>
    public PartWavWriter(string basePath, WaveFormat format, long splitBytes = DefaultSplitBytes, BwfInfo? bext = null)
    {
        _basePath = basePath;
        _format = format;
        _splitBytes = Math.Max(100_000, splitBytes);
        _bext = bext;
        OpenNext();
    }

    private void OpenNext()
    {
        _writer?.Dispose();
        _partIndex++;

        var path = _partIndex == 1 ? _basePath : PartPath(_partIndex);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // 断片の TimeReference：ここまでに書いたフレーム数（続きの断片を DAW に置くと正しい位置に並ぶ）
        var bext = _bext == null ? null : _bext with
        {
            TimeReferenceSamples = _bext.TimeReferenceSamples + TotalBytes / Math.Max(1, _format.BlockAlign),
            Description = _partIndex == 1 ? _bext.Description : $"{_bext.Description} (part {_partIndex})",
        };
        _writer = new BwfWaveWriter(path, _format, bext);
        _files.Add(path);
        if (_partIndex > 1) PartStarted?.Invoke(path);
    }

    private string PartPath(int index)
    {
        var dir = Path.GetDirectoryName(_basePath)!;
        var name = Path.GetFileNameWithoutExtension(_basePath);
        return Path.Combine(dir, $"{name}_p{index:00}.wav");
    }

    public void Write(byte[] buffer, int count)
    {
        if (_writer == null) return;

        if (_writer.Length + count > _splitBytes) OpenNext();

        _writer!.Write(buffer, 0, count);
        TotalBytes += count;

        // 定期的にディスクへ吐き出す。落ちても、ここまでの音は残る
        // （ヘッダの数字は古いままになるが、起動時に WavRepair が直す）。
        _sinceFlush += count;
        if (_sinceFlush >= FlushEveryBytes)
        {
            _sinceFlush = 0;
            try { _writer.Flush(); } catch { /* 書けなければ次の機会に */ }
        }
    }

    public void Flush() => _writer?.Flush();

    public void Dispose()
    {
        _writer?.Dispose();
        _writer = null;

        // 中身が無いまま作られた断片は残さない
        for (int i = _files.Count - 1; i >= 0; i--)
        {
            try
            {
                var info = new FileInfo(_files[i]);
                if (info.Exists && info.Length <= 46) // ヘッダだけ
                {
                    info.Delete();
                    _files.RemoveAt(i);
                }
            }
            catch { /* 消せなくても致命的ではない */ }
        }
    }
}
