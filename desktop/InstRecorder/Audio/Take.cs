using System.IO;
using System.Text.Json.Serialization;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// 1回の録音（テイク）。長時間録音で WAV の 4GB 制限を超えた場合は複数ファイルに分かれるが、
/// 再生時は繋げて1本として扱うので、利用者からは分割されたことが見えない。
/// </summary>
public sealed class Take
{
    public string Name { get; set; } = "";
    public List<string> Files { get; set; } = new();
    public double Seconds { get; set; }
    public int SampleRate { get; set; }
    public int Channels { get; set; }
    public DateTime RecordedAt { get; set; } = DateTime.Now;

    [JsonIgnore]
    public bool IsSplit => Files.Count > 1;

    [JsonIgnore]
    public string Label
    {
        get
        {
            var t = TimeSpan.FromSeconds(Seconds);
            var len = t.TotalHours >= 1
                ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}"
                : $"{(int)t.TotalMinutes:00}:{t.Seconds:00}";
            return $"{Name}  {len}" + (IsSplit ? $"（{Files.Count}分割）" : "");
        }
    }

    // 一覧では短く出したいので名前だけ。詳しい情報は Label をツールチップに出す。
    public override string ToString() => Name;

    /// <summary>録音済みファイルからテイクを組み立てる。長さは実ファイルから取る。</summary>
    public static Take FromFiles(string name, IEnumerable<string> files)
    {
        var take = new Take { Name = name, Files = files.Where(File.Exists).ToList() };
        foreach (var f in take.Files)
        {
            using var r = new WaveFileReader(f);
            take.Seconds += r.TotalTime.TotalSeconds;
            take.SampleRate = r.WaveFormat.SampleRate;
            take.Channels = r.WaveFormat.Channels;
        }
        return take;
    }
}
