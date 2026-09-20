using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace InstRecorder.Audio;

/// <summary>
/// 多重録音の1セッション。全トラックは同じサンプルレートで、必ず先頭（0秒）から始まる。
/// フォルダ1つ = セッション1つ。中身は WAV と session.json だけなので、
/// フォルダごとコピーすれば持ち運べる。
/// </summary>
public sealed class Session
{
    public const string MetaFileName = "session.json";

    public string Name { get; set; } = "";
    public int SampleRate { get; set; }
    public ObservableCollection<Track> Tracks { get; set; } = new();

    /// <summary>セッション全体にかけるホールの響き。非破壊で、切れば元の音に戻る。</summary>
    public HallReverb Hall { get; set; } = new();

    [JsonIgnore]
    public string Folder { get; set; } = "";

    [JsonIgnore]
    public bool AnySoloed => Tracks.Any(t => t.Soloed);

    [JsonIgnore]
    public double LengthSeconds => Tracks.Count == 0 ? 0 : Tracks.Max(t => t.Seconds);

    /// <summary>
    /// 鳴らし終わるまでの長さ。響きを足していると、最後の音が止まってからも尾が残る。
    /// 波形の目盛りは <see cref="LengthSeconds"/> のままにしておく（響きは録音の中身ではないため）。
    /// </summary>
    [JsonIgnore]
    public double PlaybackLengthSeconds => LengthSeconds + Hall.EstimatedTailSeconds;

    /// <summary>ミュート・ソロを考慮した実効ゲイン。</summary>
    public float EffectiveGain(Track t)
    {
        if (AnySoloed) return t.Soloed ? t.Volume : 0f;
        return t.Muted ? 0f : t.Volume;
    }

    public static Session CreateNew(string rootFolder)
    {
        var name = $"セッション_{DateTime.Now:yyyyMMdd_HHmm}";
        var folder = Path.Combine(rootFolder, name);
        int n = 2;
        while (Directory.Exists(folder))
        {
            folder = Path.Combine(rootFolder, $"{name}_{n++}");
        }
        Directory.CreateDirectory(folder);
        var s = new Session { Name = Path.GetFileName(folder), Folder = folder };
        s.Save();
        return s;
    }

    public static Session Load(string folder)
    {
        var metaPath = Path.Combine(folder, MetaFileName);
        Session s;
        if (File.Exists(metaPath))
        {
            s = JsonSerializer.Deserialize<Session>(File.ReadAllText(metaPath)) ?? new Session();
        }
        else
        {
            s = new Session();
        }
        s.Folder = folder;
        if (string.IsNullOrEmpty(s.Name)) s.Name = Path.GetFileName(folder);

        foreach (var track in s.Tracks.ToList())
        {
            MigrateLegacyTrack(track, folder);

            // ファイルの実体はフォルダ内を見る（フォルダごと移動しても開けるように）
            foreach (var take in track.Takes)
            {
                take.Files = take.Files
                    .Select(f => Path.Combine(folder, Path.GetFileName(f)))
                    .Where(File.Exists)
                    .ToList();
            }

            // 中身の無いテイクは落とす
            for (int i = track.Takes.Count - 1; i >= 0; i--)
                if (track.Takes[i].Files.Count == 0) track.Takes.RemoveAt(i);

            if (track.Takes.Count == 0) s.Tracks.Remove(track);
            else track.NotifyTakeChanged();
        }

        if (s.SampleRate <= 0 && s.Tracks.Count > 0)
            s.SampleRate = s.Tracks[0].ActiveTake?.SampleRate ?? 0;

        return s;
    }

    /// <summary>テイクの概念が無かった頃の session.json を読めるようにする。</summary>
    private static void MigrateLegacyTrack(Track track, string folder)
    {
        if (track.Takes.Count > 0 || string.IsNullOrEmpty(track.FilePath)) return;

        var path = Path.Combine(folder, Path.GetFileName(track.FilePath));
        if (File.Exists(path))
        {
            try { track.Takes.Add(Take.FromFiles("テイク 1", new[] { path })); }
            catch { /* 読めないファイルは諦める */ }
        }
        track.FilePath = null;
    }

    public void Save()
    {
        if (string.IsNullOrEmpty(Folder)) return;
        Directory.CreateDirectory(Folder);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        File.WriteAllText(Path.Combine(Folder, MetaFileName), json);
    }

    /// <summary>次の録音の書き出し先。既存ファイルとぶつからない名前を選ぶ。</summary>
    public string NextRecordingPath(SaveFormat save, Track? target)
    {
        string prefix = target == null
            ? $"track{Tracks.Count + 1:00}"
            : $"track{Tracks.IndexOf(target) + 1:00}_take{target.Takes.Count + 1:00}";

        string suffix = save == SaveFormat.Float32 ? "32f" : "24";
        string path = Path.Combine(Folder, $"{prefix}_{suffix}.wav");
        int n = 2;
        while (File.Exists(path))
        {
            path = Path.Combine(Folder, $"{prefix}_{suffix}_{n++}.wav");
        }
        return path;
    }

    public string NextTrackName() => $"トラック {Tracks.Count + 1}";
}
