using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// トラックにかける後処理の設定。**元の WAV には一切触らない**。
/// 再生とミックスダウンのときだけ通るので、いつでも切って元の音に戻せる。
/// </summary>
public sealed class TrackProcessing : INotifyPropertyChanged
{
    private bool _humEnabled;
    private double _humFrequency = 50;
    private int _humHarmonics = 4;
    private bool _gateEnabled;
    private double _gateThresholdDb = -60;

    /// <summary>電源ハムの除去（該当周波数だけを細く削る）。</summary>
    public bool HumEnabled
    {
        get => _humEnabled;
        set => Set(ref _humEnabled, value);
    }

    /// <summary>基本周波数。日本は東日本 50Hz / 西日本 60Hz。</summary>
    public double HumFrequency
    {
        get => _humFrequency;
        set => Set(ref _humFrequency, value);
    }

    /// <summary>何倍音まで削るか。ハムは倍音も出るので通常は 4 程度。</summary>
    public int HumHarmonics
    {
        get => _humHarmonics;
        set => Set(ref _humHarmonics, Math.Clamp(value, 1, 8));
    }

    /// <summary>無音部分を静かにする（演奏していない間のノイズを抑える）。</summary>
    public bool GateEnabled
    {
        get => _gateEnabled;
        set => Set(ref _gateEnabled, value);
    }

    /// <summary>この音量を下回ったら閉じ始める。</summary>
    public double GateThresholdDb
    {
        get => _gateThresholdDb;
        set => Set(ref _gateThresholdDb, Math.Clamp(value, -100, 0));
    }

    [JsonIgnore]
    public bool AnyEnabled => _humEnabled || _gateEnabled;

    [JsonIgnore]
    public string Summary
    {
        get
        {
            if (!AnyEnabled) return "処理なし（元の音そのまま）";
            var parts = new List<string>();
            if (_humEnabled) parts.Add($"ハム除去 {_humFrequency:0}Hz×{_humHarmonics}");
            if (_gateEnabled) parts.Add($"ゲート {_gateThresholdDb:0}dB");
            return string.Join(" / ", parts);
        }
    }

    public TrackProcessing Clone() => new()
    {
        _humEnabled = _humEnabled,
        _humFrequency = _humFrequency,
        _humHarmonics = _humHarmonics,
        _gateEnabled = _gateEnabled,
        _gateThresholdDb = _gateThresholdDb,
    };

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Summary)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(AnyEnabled)));
    }
}

/// <summary>
/// 特定の周波数だけを細く削るフィルタ（ノッチ）を並べたもの。
/// 幅を狭くしてあるので、ハムの周波数から少し離れた楽器の音はほとんど影響を受けない。
/// </summary>
public sealed class HumRemover : ISampleProvider
{
    private readonly ISampleProvider _src;
    private readonly Biquad[,] _filters; // [チャンネル, 倍音]

    public HumRemover(ISampleProvider src, double frequency, int harmonics, double q = 30)
    {
        _src = src;
        int channels = src.WaveFormat.Channels;
        int rate = src.WaveFormat.SampleRate;

        var usable = new List<double>();
        for (int h = 1; h <= harmonics; h++)
        {
            double f = frequency * h;
            if (f < rate / 2.0 * 0.95) usable.Add(f);
        }

        _filters = new Biquad[channels, usable.Count];
        for (int c = 0; c < channels; c++)
            for (int h = 0; h < usable.Count; h++)
                _filters[c, h] = Biquad.Notch(rate, usable[h], q);
    }

    public WaveFormat WaveFormat => _src.WaveFormat;

    public int Read(float[] buffer, int offset, int count)
    {
        int n = _src.Read(buffer, offset, count);
        int channels = WaveFormat.Channels;
        int harmonics = _filters.GetLength(1);
        if (harmonics == 0) return n;

        for (int i = 0; i + channels <= n; i += channels)
        {
            for (int c = 0; c < channels; c++)
            {
                float v = buffer[offset + i + c];
                for (int h = 0; h < harmonics; h++) v = _filters[c, h].Process(v);
                buffer[offset + i + c] = v;
            }
        }
        return n;
    }
}

/// <summary>
/// 小さい音のときだけ音量を下げる。演奏中は開きっぱなしになるので、
/// 音の入り口を削ってしまわないよう、開くのは速く、閉じるのはゆっくりにしている。
/// </summary>
public sealed class NoiseGate : ISampleProvider
{
    private readonly ISampleProvider _src;
    private readonly float _threshold;
    private readonly float _detectorCoef;
    private readonly float _attackCoef;
    private readonly float _releaseCoef;
    private readonly int _holdSamples;

    private float _envelope;
    private float _gain = 1f;
    private int _holdCounter;

    /// <param name="detectorMs">音が止まったと判断するまでの速さ。ここを遅くすると閉じ始めが遅れる。</param>
    /// <param name="holdMs">しきい値を割ってもこの間は開けておく（細かく開閉して震えるのを防ぐ）。</param>
    /// <param name="releaseMs">閉じきるまでの時間。短すぎると余韻がぶつ切りになる。</param>
    public NoiseGate(ISampleProvider src, double thresholdDb,
                     double attackMs = 2, double detectorMs = 30,
                     double holdMs = 80, double releaseMs = 120)
    {
        _src = src;
        _threshold = (float)Math.Pow(10, thresholdDb / 20);
        int rate = src.WaveFormat.SampleRate;

        // 検出用の包絡線と、音量そのものの動きは別々の速さにする。
        // 同じ時定数にすると「止まったと気づくのが遅い」＋「閉じるのも遅い」で二重に遅れる。
        _detectorCoef = (float)Math.Exp(-1.0 / (rate * detectorMs / 1000.0));
        _attackCoef = (float)Math.Exp(-1.0 / (rate * attackMs / 1000.0));
        _releaseCoef = (float)Math.Exp(-1.0 / (rate * releaseMs / 1000.0));
        _holdSamples = (int)(rate * holdMs / 1000.0);
    }

    public WaveFormat WaveFormat => _src.WaveFormat;

    public int Read(float[] buffer, int offset, int count)
    {
        int n = _src.Read(buffer, offset, count);
        int channels = WaveFormat.Channels;

        for (int i = 0; i + channels <= n; i += channels)
        {
            float peak = 0;
            for (int c = 0; c < channels; c++) peak = Math.Max(peak, Math.Abs(buffer[offset + i + c]));

            // 包絡線は瞬時に上がり、検出用の速さで下がる
            _envelope = peak > _envelope
                ? peak
                : _envelope * _detectorCoef + peak * (1 - _detectorCoef);

            bool open;
            if (_envelope >= _threshold)
            {
                _holdCounter = _holdSamples;
                open = true;
            }
            else
            {
                if (_holdCounter > 0) _holdCounter--;
                open = _holdCounter > 0;
            }

            float target = open ? 1f : 0f;
            float coef = target > _gain ? _attackCoef : _releaseCoef;
            _gain = _gain * coef + target * (1 - coef);

            for (int c = 0; c < channels; c++) buffer[offset + i + c] *= _gain;
        }
        return n;
    }
}

/// <summary>双二次フィルタ。ここではノッチ（特定の周波数だけを削る）にだけ使う。</summary>
public sealed class Biquad
{
    private readonly float _a0, _a1, _a2, _b1, _b2;
    private float _x1, _x2, _y1, _y2;

    private Biquad(double a0, double a1, double a2, double b1, double b2)
    {
        _a0 = (float)a0; _a1 = (float)a1; _a2 = (float)a2;
        _b1 = (float)b1; _b2 = (float)b2;
    }

    public static Biquad Notch(int sampleRate, double frequency, double q)
    {
        double w0 = 2 * Math.PI * frequency / sampleRate;
        double alpha = Math.Sin(w0) / (2 * q);
        double cos = Math.Cos(w0);

        double b0 = 1, b1 = -2 * cos, b2 = 1;
        double a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;

        return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
    }

    public float Process(float x)
    {
        float y = _a0 * x + _a1 * _x1 + _a2 * _x2 - _b1 * _y1 - _b2 * _y2;
        _x2 = _x1; _x1 = x;
        _y2 = _y1; _y1 = y;
        return y;
    }
}
