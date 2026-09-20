using System.IO;
using System.Text;

namespace InstRecorder.Audio;

/// <summary>
/// WAV はファイルの先頭に「データが何バイトあるか」を書く形式なので、
/// 録音中にアプリが落ちるとその数字が古いまま残り、多くのソフトが
/// 「長さ0秒」として開いてしまう。音そのものはディスクに書けているので、
/// 数字を実際のサイズに直せば救える。
/// </summary>
public static class WavRepair
{
    public sealed record Result(string Path, long DeclaredBytes, long ActualBytes)
    {
        public double RecoveredSeconds { get; init; }
    }

    /// <summary>
    /// フォルダ内の WAV を調べ、壊れたヘッダを直す。直したものだけを返す。
    /// </summary>
    public static List<Result> RepairFolder(string folder)
    {
        var repaired = new List<Result>();
        if (!Directory.Exists(folder)) return repaired;

        foreach (var path in Directory.GetFiles(folder, "*.wav"))
        {
            try
            {
                var r = Repair(path);
                if (r != null) repaired.Add(r);
            }
            catch { /* 直せないファイルは触らない */ }
        }
        return repaired;
    }

    /// <summary>直す必要があれば直して結果を返す。正常なら null。</summary>
    public static Result? Repair(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite);
        if (fs.Length < 44) return null;

        using var reader = new BinaryReader(fs, Encoding.ASCII, leaveOpen: true);
        if (new string(reader.ReadChars(4)) != "RIFF") return null;
        long riffSizePos = fs.Position;
        uint declaredRiffSize = reader.ReadUInt32();
        if (new string(reader.ReadChars(4)) != "WAVE") return null;

        // data チャンクを探す（fmt の後ろに fact などが入ることがある）
        long dataSizePos = -1;
        uint declaredDataSize = 0;
        long dataStart = -1;
        int bytesPerSecond = 0;

        while (fs.Position + 8 <= fs.Length)
        {
            var id = new string(reader.ReadChars(4));
            long sizePos = fs.Position;
            uint size = reader.ReadUInt32();
            long payload = fs.Position;

            if (id == "fmt ")
            {
                reader.ReadUInt16();                 // フォーマット種別
                reader.ReadUInt16();                 // チャンネル数
                reader.ReadUInt32();                 // サンプルレート
                bytesPerSecond = (int)reader.ReadUInt32();
            }
            else if (id == "data")
            {
                dataSizePos = sizePos;
                declaredDataSize = size;
                dataStart = payload;
                break;
            }

            // チャンクは偶数バイト境界に揃う
            long next = payload + size + (size % 2);
            if (next <= payload || next > fs.Length) break;
            fs.Position = next;
        }

        if (dataSizePos < 0 || dataStart < 0) return null;

        long actualDataSize = fs.Length - dataStart;
        if (actualDataSize < 0) return null;

        // 宣言サイズが実際と合っていれば何もしない
        if (declaredDataSize == actualDataSize && declaredRiffSize == fs.Length - 8) return null;

        // 実際より大きく宣言されている場合は、末尾が欠けている可能性があるので実サイズに合わせる
        using var writer = new BinaryWriter(fs, Encoding.ASCII, leaveOpen: true);
        fs.Position = dataSizePos;
        writer.Write((uint)actualDataSize);
        fs.Position = riffSizePos;
        writer.Write((uint)(fs.Length - 8));
        writer.Flush();

        return new Result(path, declaredDataSize, actualDataSize)
        {
            RecoveredSeconds = bytesPerSecond > 0 ? (double)actualDataSize / bytesPerSecond : 0,
        };
    }
}
