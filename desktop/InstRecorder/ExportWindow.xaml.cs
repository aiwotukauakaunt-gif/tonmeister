using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using InstRecorder.Audio;

namespace InstRecorder;

/// <summary>
/// 書き出しの選択画面（ハンドオフの 06）。
/// 形式をラジオで選ばせず、「何に使うか」で2枚のカードから選ばせる。
/// 書き出す前に「音が割れるかどうか」を先に見せるのが要点。
/// </summary>
public partial class ExportWindow : Window
{
    /// <summary>FLAC の圧縮率のめやす（実測 69% 前後）。</summary>
    private const double FlacRatio = 0.69;

    private readonly Session _session;
    private readonly SaveFormat _save;
    private bool _wavSelected = true;
    private bool _peakScanned;
    private float _peak = -1;

    public ExportWindow(Session session, SaveFormat save)
    {
        InitializeComponent();
        _session = session;
        _save = save;

        var len = TimeSpan.FromSeconds(_session.PlaybackLengthSeconds);
        TxtSummary.Text = $"{_session.Tracks.Count} トラック・" +
                          $"{(int)len.TotalMinutes}分{len.Seconds:00}秒を1本にまとめます。" +
                          (_session.Hall.Enabled && _session.Hall.IsUsable && _session.Hall.MixPercent > 0
                              ? $"\n{HallReverb.DisplayName(_session.Hall.Kind)}の響きごと書き出します（尾のぶん少し長くなります）。"
                              : "");

        UpdateSizes();
        UpdateCards();
        // 幅が決まってからでないとバーを描けないので、決まり直すたびに描き直す
        PeakHost.SizeChanged += (_, _) => ShowPeak();
        Loaded += (_, _) => _ = ScanPeakAsync();
    }

    // ---------------- 選択 ----------------

    private void CardWav_Click(object sender, MouseButtonEventArgs e)
    {
        _wavSelected = true;
        UpdateCards();
    }

    private void CardFlac_Click(object sender, MouseButtonEventArgs e)
    {
        _wavSelected = false;
        UpdateCards();
    }

    private void UpdateCards()
    {
        CardWav.BorderBrush = (Brush)FindResource(_wavSelected ? "StrongLine" : "Line");
        CardFlac.BorderBrush = (Brush)FindResource(_wavSelected ? "Line" : "StrongLine");
    }

    private void UpdateSizes()
    {
        double seconds = _session.PlaybackLengthSeconds;
        // 書き出しは常にステレオ2ch（SessionMix がそう作る）
        long wavBytes = (long)(seconds * MixSampleRate() * 2 * _save.BytesPerSample()) + 44;
        long flacBytes = (long)((long)(seconds * MixSampleRate() * 2 * 3) * FlacRatio);

        TxtWavMeta.Text = $"{(_save == SaveFormat.Float32 ? "32bit float" : "24bit")} WAV ／ 約 {Mb(wavBytes)}";
        TxtFlacMeta.Text = $"24bit FLAC ／ 約 {Mb(flacBytes)}";
    }

    private int MixSampleRate() => _session.SampleRate > 0
        ? _session.SampleRate
        : _session.Tracks.FirstOrDefault()?.ActiveTake?.SampleRate ?? 48000;

    private static string Mb(long bytes) => $"{bytes / 1024.0 / 1024.0:0.#} MB";

    // ---------------- クリップ予告 ----------------

    /// <summary>
    /// 書き出す前に、まとめた音のいちばん大きいところを調べる。
    /// 「書き出したら割れていた」を後から知るより、ここで一度読み切るほうが親切。
    /// </summary>
    private async Task ScanPeakAsync()
    {
        try
        {
            _peak = await Task.Run(() =>
            {
                using var mix = SessionMix.Build(_session);
                if (mix == null) return 0f;

                long total = (long)Math.Ceiling(mix.LengthSeconds * mix.SampleRate) * 2;
                var buf = new float[mix.SampleRate * 2 / 10];
                long read = 0;
                float peak = 0;

                while (read < total)
                {
                    int want = (int)Math.Min(buf.Length, total - read);
                    int n = mix.Provider.Read(buf, 0, want);
                    if (n == 0) break;
                    for (int i = 0; i < n; i++)
                    {
                        float a = MathF.Abs(buf[i]);
                        if (a > peak) peak = a;
                    }
                    read += n;
                }
                return peak;
            });
        }
        catch
        {
            _peak = -1;
        }

        _peakScanned = true;
        ShowPeak();
    }

    private void ShowPeak()
    {
        if (!_peakScanned) return; // まだ調べ終わっていない

        if (_peak < 0)
        {
            TxtClip.Text = "いちばん大きいところを調べられませんでした。";
            TxtClip.Foreground = (Brush)FindResource("FgDim");
            TxtPeak.Text = "";
            return;
        }

        double db = _peak > 0 ? 20 * Math.Log10(_peak) : double.NegativeInfinity;
        bool over = _peak > 1.0f;

        ClipDot.Fill = (Brush)FindResource(over ? "Rec" : "Good");
        TxtClip.Text = over
            ? "このままだと音が割れます。トラックの音量を下げてください。"
            : "音が割れる心配はありません";
        TxtClip.Foreground = (Brush)FindResource(over ? "Rec" : "Fg");

        TxtPeak.Text = double.IsNegativeInfinity(db)
            ? "いちばん大きいところ： -inf"
            : $"いちばん大きいところ： {db:0.0} dBFS";

        double w = PeakHost.ActualWidth;
        if (w > 1)
        {
            // 右端 8% を危険域として先に見せておく
            PeakDanger.Width = w * 0.08;
            PeakFill.Width = w * MeterScale.Ratio(db);
        }
    }

    // ---------------- 書き出し ----------------

    private void BtnExport_Click(object sender, RoutedEventArgs e)
    {
        BtnExport.IsEnabled = false;
        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            if (_wavSelected) ExportWav();
            else ExportFlac();
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "書き出せませんでした: " + ex.Message,
                            "書き出す", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            Mouse.OverrideCursor = null;
            BtnExport.IsEnabled = true;
        }
    }

    private void ExportWav()
    {
        var path = Path.Combine(_session.Folder,
            $"mixdown_{DateTime.Now:yyyyMMdd_HHmmss}_{(_save == SaveFormat.Float32 ? "32f" : "24")}.wav");
        var r = Mixdown.Export(_session, path, _save);

        var warn = r.Clipped
            ? _save == SaveFormat.Float32
                ? "\n\n※ 0 を超えた音がありますが、そのままの音で残したので情報は消えていません。\n" +
                  "　 各トラックの音量を下げて書き出し直すのが安全です。"
                : "\n\n※ 0 を超えた音が歪んでいます。音量を下げて書き出し直してください。"
            : "";

        Done(path, r.Seconds, r.Peak, warn);
    }

    private void ExportFlac()
    {
        var path = Path.Combine(_session.Folder, $"mixdown_{DateTime.Now:yyyyMMdd_HHmmss}.flac");
        var r = FlacExport.Export(_session, path);

        var warn = r.Clipped
            ? "\n\n※ 0 を超えた部分は 24bit に収まらず歪みます。音量を下げて書き出し直してください。"
            : "";

        Done(path, r.Seconds, r.Peak,
             $"\n容量 {r.Bytes / 1024.0 / 1024.0:0.0} MB" +
             $"（24bit WAV なら {r.WavBytes / 1024.0 / 1024.0:0.0} MB）\n\n" +
             "音は一切変わっていません。" + warn);
    }

    private void Done(string path, double seconds, float peak, string extra)
    {
        var peakDb = peak > 0 ? $"{20 * Math.Log10(peak):0.0} dBFS" : "-inf";
        MessageBox.Show(this,
            $"書き出しました。\n\n{Path.GetFileName(path)}\n" +
            $"長さ {seconds:0.0} 秒 ／ いちばん大きいところ {peakDb}{extra}",
            "書き出す", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void BtnCancel_Click(object sender, RoutedEventArgs e) => Close();
}
