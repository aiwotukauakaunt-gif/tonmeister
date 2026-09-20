using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

namespace InstRecorder.Audio;

/// <summary>
/// 1本のトラック。同じパートを何度も録れるよう、複数のテイクを持ち、
/// そのうち1つだけが再生・書き出しに使われる。捨てずに残せるので後から選び直せる。
/// </summary>
public sealed class Track : INotifyPropertyChanged
{
    private string _name = "";
    private float _volume = 1f;
    private bool _muted;
    private bool _soloed;
    private int _activeTakeIndex;

    public string Name
    {
        get => _name;
        set => Set(ref _name, value);
    }

    public ObservableCollection<Take> Takes { get; set; } = new();

    public int ActiveTakeIndex
    {
        get => _activeTakeIndex;
        set
        {
            if (value < 0 || value >= Takes.Count) return;
            if (Set(ref _activeTakeIndex, value)) NotifyTakeChanged();
        }
    }

    /// <summary>0.0〜2.0 の線形ゲイン。</summary>
    public float Volume
    {
        get => _volume;
        set => Set(ref _volume, value);
    }

    public bool Muted
    {
        get => _muted;
        set => Set(ref _muted, value);
    }

    public bool Soloed
    {
        get => _soloed;
        set => Set(ref _soloed, value);
    }

    /// <summary>非破壊の後処理設定。元の WAV は変わらない。</summary>
    public TrackProcessing Processing { get; set; } = new();

    /// <summary>旧形式の session.json を読み込むためだけに残している。</summary>
    public string? FilePath { get; set; }

    [JsonIgnore]
    public Take? ActiveTake => _activeTakeIndex >= 0 && _activeTakeIndex < Takes.Count
        ? Takes[_activeTakeIndex]
        : Takes.FirstOrDefault();

    [JsonIgnore]
    public double Seconds => ActiveTake?.Seconds ?? 0;

    [JsonIgnore]
    public IReadOnlyList<string> ActiveFiles => ActiveTake?.Files ?? (IReadOnlyList<string>)Array.Empty<string>();

    [JsonIgnore]
    public bool HasMultipleTakes => Takes.Count > 1;

    [JsonIgnore]
    public string Info
    {
        get
        {
            var take = ActiveTake;
            if (take == null) return "（テイクなし）";
            var t = TimeSpan.FromSeconds(take.Seconds);
            var len = t.TotalHours >= 1
                ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}"
                : $"{(int)t.TotalMinutes:00}:{t.Seconds:00}.{t.Milliseconds / 100}";
            // テイク数は隣のテイク選択に出るので、ここでは繰り返さない
            return $"{len}  {take.SampleRate / 1000.0:0.#}k / {take.Channels}ch" +
                   (take.IsSplit ? $"  {take.Files.Count}分割" : "");
        }
    }

    [JsonIgnore]
    public string VolumeLabel => _volume <= 0.0001f
        ? "-inf"
        : $"{20 * Math.Log10(_volume):+0.0;-0.0;0.0} dB";

    // 一覧やコンボボックスに素で並べても名前が出るようにしておく。
    // 表示のたびに DisplayMemberPath を設定して回らずに済む。
    public override string ToString() => string.IsNullOrEmpty(_name) ? "（無名トラック）" : _name;

    public void AddTake(Take take)
    {
        Takes.Add(take);
        ActiveTakeIndex = Takes.Count - 1;
        NotifyTakeChanged();
    }

    public void NotifyTakeChanged()
    {
        Raise(nameof(ActiveTake));
        Raise(nameof(Seconds));
        Raise(nameof(Info));
        Raise(nameof(HasMultipleTakes));
        Raise(nameof(ActiveFiles));
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Raise(name);
        if (name == nameof(Volume)) Raise(nameof(VolumeLabel));
        return true;
    }

    private void Raise(string? name) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
