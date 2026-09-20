using System.ComponentModel;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

namespace InstRecorder.Audio;

/// <summary>どのホールで鳴らすか。</summary>
public enum HallKind
{
    /// <summary>小さな部屋。練習室くらい。</summary>
    Room,
    /// <summary>室内楽ホール。数百席。</summary>
    Chamber,
    /// <summary>大ホール。コンサートホール。</summary>
    Hall,
    /// <summary>石造りの教会。長く尾を引く。</summary>
    Church,
    /// <summary>読み込んだインパルス応答（実在のホールを録ったもの）。</summary>
    Custom,
}

/// <summary>
/// セッション全体にかける「ホールの響き」の設定。
///
/// **元の WAV には一切触らない。** 再生とミックスダウンのときだけ通るので、
/// 切ればその場で元の音に戻る。ハム除去やノイズゲートと同じ扱い。
///
/// トラックごとではなくセッション全体に1つだけ持つ。
/// ホールは「場所」であって、楽器ごとに別の場所にいることはないため。
/// </summary>
public sealed class HallReverb : INotifyPropertyChanged
{
    private bool _enabled;
    private HallKind _kind = HallKind.Hall;
    private double _decaySeconds;      // 0 は「そのホールの既定値」
    private double _mixPercent = 25;
    private double _preDelayMs = 30;
    private string? _impulsePath;

    /// <summary>プリディレイの下限。分割畳み込みのブロック分（44.1kHz で 23.2ms）より短くはできない。</summary>
    public const double MinPreDelayMs = 25;
    public const double MaxPreDelayMs = 150;
    public const double MinDecaySeconds = 0.2;
    public const double MaxDecaySeconds = 6.0;

    /// <summary>響きを足すか。</summary>
    public bool Enabled
    {
        get => _enabled;
        set => Set(ref _enabled, value);
    }

    public HallKind Kind
    {
        get => _kind;
        set => Set(ref _kind, value);
    }

    /// <summary>
    /// 響きの長さ（残響時間 RT60）。0 なら <see cref="Kind"/> の既定値を使う。
    /// 読み込んだインパルス応答を使うときは無視される（そのホールの長さがそのまま出る）。
    /// </summary>
    public double DecaySeconds
    {
        get => _decaySeconds;
        set => Set(ref _decaySeconds, value <= 0 ? 0 : Math.Clamp(value, MinDecaySeconds, MaxDecaySeconds));
    }

    /// <summary>響きの量。0 なら出力は元の音とサンプル単位で一致する。</summary>
    public double MixPercent
    {
        get => _mixPercent;
        set => Set(ref _mixPercent, Math.Clamp(value, 0, 100));
    }

    /// <summary>直接音が届いてから響きが始まるまで。長いほど遠くの壁＝広い場所に聞こえる。</summary>
    public double PreDelayMs
    {
        get => _preDelayMs;
        set => Set(ref _preDelayMs, Math.Clamp(value, MinPreDelayMs, MaxPreDelayMs));
    }

    /// <summary>読み込んだインパルス応答の WAV。<see cref="Kind"/> が Custom のときだけ使う。</summary>
    public string? ImpulsePath
    {
        get => _impulsePath;
        set => Set(ref _impulsePath, string.IsNullOrWhiteSpace(value) ? null : value);
    }

    /// <summary>実際に使う響きの長さ。</summary>
    [JsonIgnore]
    public double EffectiveDecaySeconds =>
        _decaySeconds > 0 ? _decaySeconds : DefaultDecaySeconds(_kind);

    /// <summary>そのホールの既定の響きの長さ。</summary>
    public static double DefaultDecaySeconds(HallKind kind) => kind switch
    {
        HallKind.Room => 0.7,
        HallKind.Chamber => 1.3,
        HallKind.Hall => 2.0,
        HallKind.Church => 3.4,
        _ => 2.0,
    };

    public static string DisplayName(HallKind kind) => kind switch
    {
        HallKind.Room => "小さな部屋",
        HallKind.Chamber => "室内楽ホール",
        HallKind.Hall => "大ホール",
        HallKind.Church => "石の教会",
        _ => "読み込んだ響き",
    };

    /// <summary>実際に鳴らせる状態か。Custom なのにファイルが無ければ鳴らせない。</summary>
    [JsonIgnore]
    public bool IsUsable => _kind != HallKind.Custom
                            || (!string.IsNullOrEmpty(_impulsePath) && File.Exists(_impulsePath));

    /// <summary>響きが鳴り終わるまでのおおよその長さ。書き出しの見積もりに使う。</summary>
    [JsonIgnore]
    public double EstimatedTailSeconds
    {
        get
        {
            if (!_enabled || !IsUsable) return 0;
            if (_kind == HallKind.Custom) return ImpulseCache.KnownSeconds(_impulsePath!) + _preDelayMs / 1000.0;
            return EffectiveDecaySeconds * ImpulseResponse.LengthFactor + _preDelayMs / 1000.0;
        }
    }

    [JsonIgnore]
    public string Summary
    {
        get
        {
            if (!_enabled) return "響きなし（元の音そのまま）";
            if (!IsUsable) return "響きのもとになるファイルが見つかりません";
            if (_kind == HallKind.Custom)
                return $"{Path.GetFileNameWithoutExtension(_impulsePath)} / 量 {_mixPercent:0}% / 間 {_preDelayMs:0}ms";
            return $"{DisplayName(_kind)} {EffectiveDecaySeconds:0.0}秒 / 量 {_mixPercent:0}% / 間 {_preDelayMs:0}ms";
        }
    }

    public HallReverb Clone() => new()
    {
        _enabled = _enabled,
        _kind = _kind,
        _decaySeconds = _decaySeconds,
        _mixPercent = _mixPercent,
        _preDelayMs = _preDelayMs,
        _impulsePath = _impulsePath,
    };

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Summary)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(EffectiveDecaySeconds)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(EstimatedTailSeconds)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsUsable)));
    }
}
