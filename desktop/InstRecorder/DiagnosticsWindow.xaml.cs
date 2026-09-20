using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using InstRecorder.Audio;
using NAudio.Wave;
using Rectangle = System.Windows.Shapes.Rectangle;
using Track = InstRecorder.Audio.Track;

namespace InstRecorder;

/// <summary>
/// 音のチェック（ハンドオフの 04）。
/// 数字より先に「結論」と「次の一手」を出し、数値はその裏づけとして下に並べる。
/// </summary>
public partial class DiagnosticsWindow : Window
{
    /// <summary>実在するマイクとプリアンプで、これより静かな暗騒音はまず出ない。</summary>
    private const double ImplausiblyQuietDb = -120;

    private readonly RecorderEngine _engine;
    private readonly Session _session;
    private SignalAnalysis.ChannelReport[] _reports = Array.Empty<SignalAnalysis.ChannelReport>();

    private Action? _primary;
    private Action? _secondary;

    /// <param name="Note">そのときの結論を一言で。</param>
    private sealed record HistoryEntry(DateTime At, string What, string Note, bool Warn);

    /// <summary>この画面を開いている間の履歴。新しいものを上に、最大6件。</summary>
    private readonly List<HistoryEntry> _history = new();

    public DiagnosticsWindow(RecorderEngine engine, Session session)
    {
        InitializeComponent();
        _engine = engine;
        _session = session;

        CmbTrack.ItemsSource = _session.Tracks.ToList();
        CmbTrack.DisplayMemberPath = nameof(Track.Name);
        if (CmbTrack.Items.Count > 0) CmbTrack.SelectedIndex = 0;

        SetBusy(false);
    }

    // ---------------- 測る ----------------

    private void BtnSilence_Click(object sender, RoutedEventArgs e) =>
        _ = CaptureAndAnalyze("まわりの静けさ", isSilence: true);

    private void BtnPlaying_Click(object sender, RoutedEventArgs e) =>
        _ = CaptureAndAnalyze("弾いている間", isSilence: false);

    private async Task CaptureAndAnalyze(string label, bool isSilence)
    {
        if (!_engine.IsOpen)
        {
            Warn("先に「録る」画面でマイクが使える状態にしてください。");
            return;
        }

        if (isSilence)
        {
            var answer = MessageBox.Show(this,
                "これから5秒間、まわりの静けさを測ります。\n\n" +
                "・楽器を鳴らさず、できるだけ静かにしてください\n" +
                "・エアコンやパソコンのファンの音も結果に入ります（それが実際の録音条件です）",
                "静かにして測る", MessageBoxButton.OKCancel, MessageBoxImage.Information);
            if (answer != MessageBoxResult.OK) return;
        }

        SetBusy(true);
        TxtTarget.Text = "測定中…";
        try
        {
            var cap = await Task.Run(() => _engine.CaptureForAnalysis(5.0));
            if (cap.Frames == 0)
            {
                Warn("音を取り込めませんでした。");
                return;
            }

            var reports = await Task.Run(() =>
                SignalAnalysis.Analyze(cap.Samples, cap.Frames, cap.Channels, cap.Rate));

            Show(reports, $"{label} ／ {_engine.FormatDescription}", isSilence);
        }
        catch (Exception ex)
        {
            TxtTarget.Text = "測れませんでした";
            Warn(ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void BtnProcessing_Click(object sender, RoutedEventArgs e)
    {
        if (!_engine.IsOpen)
        {
            Warn("先に「録る」画面でマイクが使える状態にしてください。");
            return;
        }

        var answer = MessageBox.Show(this,
            "テスト音を鳴らし、そのあと静かにしたときの音の大きさを比べます（約7秒）。\n\n" +
            "静かな間だけ大きく落ちる場合、Windows が入力を潰しています。\n" +
            "その状態では「実際に鳴っている音」は記録されません。\n\n" +
            "・スピーカーの音量を上げておいてください\n" +
            "・測定中は静かにしてください",
            "Windows が加工していないか調べる", MessageBoxButton.OKCancel, MessageBoxImage.Information);
        if (answer != MessageBoxResult.OK) return;

        SetBusy(true);
        TxtTarget.Text = "調べています…";
        try
        {
            var r = await Task.Run(() => _engine.CheckInputProcessing());
            TxtTarget.Text = $"Windows の加工を調べました ／ {_engine.FormatDescription}";

            if (r.Verdict == RecorderEngine.ProcessingVerdict.Gated)
            {
                ShowVerdict(warn: true,
                    "録れているのは、実際に鳴っている音ではありません",
                    $"静かにしていると入力が {r.DropDb:0} dB ぶん絞られ、音を出すと戻りました。" +
                    "つまり今録れているのは実際に鳴っている音そのままではありません。",
                    new[]
                    {
                        "Windows の設定 →「サウンドの拡張機能」を オフ にする",
                        "それでも直らなければ、外付けのオーディオ機器（ASIO 対応）を使う",
                    },
                    "Windows のサウンド設定を開く", OpenSoundSettings,
                    "もう一度調べる", () => BtnProcessing_Click(this, new RoutedEventArgs()));
            }
            else if (r.Verdict == RecorderEngine.ProcessingVerdict.Clean)
            {
                ShowVerdict(warn: false,
                    "そのままの音が録れています",
                    $"音を止めたときの差は {r.DropDb:0} dB でした。素の入力が届いています。" +
                    "静けさの測定値も、機材の実力として読めます。",
                    Array.Empty<string>(), null, null, null, null);
            }
            else
            {
                ShowVerdict(warn: true,
                    "判定できませんでした",
                    r.Detail,
                    new[] { "スピーカーの音量を上げる、またはマイクに近づけて、もう一度試す" },
                    "もう一度調べる", () => BtnProcessing_Click(this, new RoutedEventArgs()),
                    null, null);
            }
        }
        catch (Exception ex)
        {
            TxtTarget.Text = "調べられませんでした";
            Warn(ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void BtnTrack_Click(object sender, RoutedEventArgs e)
    {
        if (CmbTrack.SelectedItem is not Track track) return;

        // トラックの実体は「選んでいる録りのファイル」。分割録音なら先頭の断片を見る。
        var path = track.ActiveFiles.FirstOrDefault(File.Exists);
        if (path == null)
        {
            Warn("このトラックの音のファイルが見つかりません。");
            return;
        }

        SetBusy(true);
        TxtTarget.Text = "調べています…";
        try
        {
            var (reports, desc) = await Task.Run(() => AnalyzeFile(path));
            Show(reports, $"{track.Name} ／ {desc}", isSilence: false);
        }
        catch (Exception ex)
        {
            TxtTarget.Text = "調べられませんでした";
            Warn(ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    /// <summary>ファイルは長いことがあるので、先頭から最大60秒ぶんを解析する。</summary>
    private static (SignalAnalysis.ChannelReport[], string) AnalyzeFile(string path)
    {
        using var reader = new AudioFileReader(path);
        int channels = reader.WaveFormat.Channels;
        int rate = reader.WaveFormat.SampleRate;
        int maxSamples = rate * channels * 60;

        var buffer = new float[rate * channels];
        var all = new List<float>(Math.Min(maxSamples, 1 << 22));
        int read;
        while (all.Count < maxSamples && (read = reader.Read(buffer, 0, buffer.Length)) > 0)
        {
            for (int i = 0; i < read && all.Count < maxSamples; i++) all.Add(buffer[i]);
        }

        var samples = all.ToArray();
        int frames = samples.Length / channels;
        var reports = SignalAnalysis.Analyze(samples, frames, channels, rate);
        return (reports, $"{rate / 1000.0:0.#} kHz ／ {frames / (double)rate:0.0} 秒");
    }

    private void SetBusy(bool busy)
    {
        BtnSilence.IsEnabled = !busy && _engine.IsOpen;
        BtnPlay.IsEnabled = !busy && _engine.IsOpen;
        BtnProcessing.IsEnabled = !busy && _engine.IsOpen;
        BtnTrack.IsEnabled = !busy && CmbTrack.Items.Count > 0;
        CmbTrack.IsEnabled = !busy;
        Mouse.OverrideCursor = busy ? Cursors.Wait : null;
    }

    // ---------------- 結論 ----------------

    private void Show(SignalAnalysis.ChannelReport[] reports, string target, bool isSilence)
    {
        _reports = reports;
        TxtTarget.Text = target;

        BuildStats(reports, isSilence);
        BuildSpectrum();
        BuildVerdict(reports, isSilence);
    }

    private void BuildVerdict(SignalAnalysis.ChannelReport[] reports, bool isSilence)
    {
        if (reports.Length == 0) return;

        double rms = reports.Max(c => c.RmsDb);
        double bits = reports.Min(c => c.EffectiveBits);
        double maxDc = reports.Max(c => Math.Abs(c.DcOffset));
        var hum = reports.OrderByDescending(c => c.HumOverFloorDb).First();
        int clips = reports.Sum(c => c.ClipCount);

        if (isSilence && rms < ImplausiblyQuietDb)
        {
            ShowVerdict(warn: true,
                "この静けさはあり得ません",
                $"まわりの静けさが {SignalAnalysis.ChannelReport.Fmt(rms)} と出ました。" +
                "実在する機材でこの数値は出ません。加工の影響で信用できない数値です。" +
                "この状態では、測った値も録れた音も機材の実力を表しません。",
                new[]
                {
                    "「Windows が加工していないか調べる」を押して確かめる",
                    "Windows の設定 →「サウンドの拡張機能」を オフ にする",
                },
                "Windows が加工していないか調べる",
                () => BtnProcessing_Click(this, new RoutedEventArgs()),
                "Windows のサウンド設定を開く", OpenSoundSettings);
            return;
        }

        if (clips > 0)
        {
            ShowVerdict(warn: true,
                "音が割れています",
                $"{clips} か所で音が振り切れていました。この部分は後から直せません。",
                new[] { "機材側の入力つまみを下げて、もう一度録る" },
                "もう一度測る", () => _ = CaptureAndAnalyze("弾いている間", false), null, null);
            return;
        }

        if (hum.HumOverFloorDb > 12)
        {
            ShowVerdict(warn: true,
                "電源のブーンという音が入っています",
                $"{hum.HumHz:0} Hz の音が、まわりの静けさより {hum.HumOverFloorDb:0} dB 大きく出ています。" +
                "この音は録ってしまうと取り除きにくいので、録る前に減らすのが得です。",
                new[]
                {
                    "電源アダプタやディスプレイからマイクを離す",
                    "USB の挿し口を変える",
                    "どうしても残るときは、トラックごとに「電源のブーンという音を消す」を入れる",
                },
                "もう一度測る", () => _ = CaptureAndAnalyze("まわりの静けさ", true), null, null);
            return;
        }

        if (isSilence && rms > -55)
        {
            ShowVerdict(warn: true,
                "まわりが少しうるさいです",
                $"何も鳴らしていないのに {SignalAnalysis.ChannelReport.Fmt(rms)} あります。" +
                "小さい音で弾くと、この音に埋もれます。",
                new[]
                {
                    "機材側の入力つまみを下げる",
                    "パソコンのファンやエアコンからマイクを離す",
                },
                "もう一度測る", () => _ = CaptureAndAnalyze("まわりの静けさ", true), null, null);
            return;
        }

        if (maxDc > 0.001)
        {
            ShowVerdict(warn: true,
                "波形の中心がずれています",
                $"中心が {maxDc:0.0000} ずれています。そのぶん、割れずに録れる余裕が減ります。",
                new[] { "機材側の設定を確かめる", "録ったあとに低い音を削る（ハイパス）" },
                "もう一度測る", () => _ = CaptureAndAnalyze("まわりの静けさ", true), null, null);
            return;
        }

        ShowVerdict(warn: false,
            "そのままの音が録れています",
            isSilence
                ? $"まわりの静けさは {SignalAnalysis.ChannelReport.Fmt(rms)}、" +
                  $"実際に使えている細かさは約 {bits:0.0} bit。気になるところは見つかりませんでした。"
                : "気になるところは見つかりませんでした。",
            Array.Empty<string>(), null, null, null, null);
    }

    private void ShowVerdict(bool warn, string title, string body, IReadOnlyList<string> steps,
                             string? primaryLabel, Action? primary,
                             string? secondaryLabel, Action? secondary)
    {
        AddHistory(title, warn);

        CardVerdict.Background = (Brush)FindResource(warn ? "WarnCardBg" : "OkCardBg");
        CardVerdict.BorderBrush = (Brush)FindResource(warn ? "WarnCardLine" : "OkCardLine");

        var accent = (Brush)FindResource(warn ? "Warn" : "Good");
        VerdictMark.Background = accent;
        VerdictMarkText.Text = warn ? "!" : "✓";

        TxtVerdictTitle.Text = title;
        TxtVerdictTitle.Foreground = accent;
        TxtVerdictBody.Text = body;
        TxtVerdictBody.Foreground = (Brush)FindResource(warn ? "WarnCardFg" : "Fg");

        PnlSteps.Children.Clear();
        for (int i = 0; i < steps.Count; i++)
        {
            var row = new Grid { Margin = new Thickness(0, 0, 0, 7) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var mark = new Border
            {
                Width = 18,
                Height = 18,
                CornerRadius = new CornerRadius(9),
                Background = accent,
                VerticalAlignment = VerticalAlignment.Top,
                Child = new TextBlock
                {
                    Text = (i + 1).ToString(),
                    FontSize = 10.5,
                    FontWeight = FontWeights.Bold,
                    Foreground = new SolidColorBrush(Color.FromRgb(0x0C, 0x0B, 0x09)),
                    HorizontalAlignment = HorizontalAlignment.Center,
                },
            };
            Grid.SetColumn(mark, 0);

            var text = new TextBlock
            {
                Text = steps[i],
                FontSize = 12,
                LineHeight = 19,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(9, 0, 0, 0),
                Foreground = (Brush)FindResource(warn ? "WarnCardFg" : "Fg"),
            };
            Grid.SetColumn(text, 1);

            row.Children.Add(mark);
            row.Children.Add(text);
            PnlSteps.Children.Add(row);
        }

        _primary = primary;
        _secondary = secondary;

        BtnPrimary.Visibility = primary != null ? Visibility.Visible : Visibility.Collapsed;
        BtnSecondary.Visibility = secondary != null ? Visibility.Visible : Visibility.Collapsed;
        PnlVerdictButtons.Visibility = primary != null || secondary != null
            ? Visibility.Visible : Visibility.Collapsed;

        if (primary != null)
        {
            BtnPrimary.Content = primaryLabel;
            BtnPrimary.Background = accent;
            BtnPrimary.BorderBrush = accent;
            BtnPrimary.Foreground = new SolidColorBrush(Color.FromRgb(0x0C, 0x0B, 0x09));
        }
        if (secondary != null)
        {
            BtnSecondary.Content = secondaryLabel;
            BtnSecondary.Background = Brushes.Transparent;
            BtnSecondary.BorderBrush = new SolidColorBrush(Color.FromRgb(0x6B, 0x4E, 0x1C));
            BtnSecondary.Foreground = (Brush)FindResource(warn ? "WarnCardFg" : "Fg");
        }
    }

    private void AddHistory(string note, bool warn)
    {
        var what = TxtTarget.Text.Split('／')[0].Trim();
        if (what.Length == 0 || what.EndsWith("…")) what = "測定";

        _history.Insert(0, new HistoryEntry(DateTime.Now, what, note, warn));
        while (_history.Count > 6) _history.RemoveAt(_history.Count - 1);

        HistoryList.Children.Clear();
        foreach (var h in _history)
        {
            var row = new Grid { Margin = new Thickness(0, 0, 0, 5) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var time = new TextBlock
            {
                Text = h.At.ToString("HH:mm"),
                FontFamily = new FontFamily("Consolas"),
                FontSize = 11,
                Foreground = (Brush)FindResource("FgFaint"),
                Margin = new Thickness(0, 0, 10, 0),
                VerticalAlignment = VerticalAlignment.Top,
            };
            Grid.SetColumn(time, 0);

            var what2 = new TextBlock
            {
                Text = h.What,
                FontSize = 11.5,
                Foreground = (Brush)FindResource("FgDim"),
                Margin = new Thickness(0, 0, 10, 0),
                VerticalAlignment = VerticalAlignment.Top,
            };
            Grid.SetColumn(what2, 1);

            var note2 = new TextBlock
            {
                Text = h.Note,
                FontSize = 11.5,
                TextWrapping = TextWrapping.Wrap,
                Foreground = (Brush)FindResource(h.Warn ? "Warn" : "Good"),
            };
            Grid.SetColumn(note2, 2);

            row.Children.Add(time);
            row.Children.Add(what2);
            row.Children.Add(note2);
            HistoryList.Children.Add(row);
        }

        CardHistory.Visibility = _history.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void BtnPrimary_Click(object sender, RoutedEventArgs e) => _primary?.Invoke();

    private void BtnSecondary_Click(object sender, RoutedEventArgs e) => _secondary?.Invoke();

    private void OpenSoundSettings()
    {
        try
        {
            Process.Start(new ProcessStartInfo("ms-settings:sound") { UseShellExecute = true });
        }
        catch
        {
            Warn("設定を開けませんでした。スタートメニューから「サウンドの設定」を開いてください。");
        }
    }

    // ---------------- 指標カード ----------------

    private void BuildStats(SignalAnalysis.ChannelReport[] reports, bool isSilence)
    {
        StatsGrid.Children.Clear();
        StatsGrid.RowDefinitions.Clear();
        StatsGrid.ColumnDefinitions.Clear();
        if (reports.Length == 0) return;

        double rms = reports.Max(c => c.RmsDb);
        double bits = reports.Min(c => c.EffectiveBits);
        double dc = reports.Max(c => Math.Abs(c.DcOffset));
        var hum = reports.OrderByDescending(c => c.HumOverFloorDb).First();
        double peak = reports.Max(c => c.PeakDb);

        var cards = new List<(string Label, string Original, string Value, string Unit,
                              double Fill, string Note, string Color)>
        {
            MakeQuietCard(rms, isSilence),
            MakeHumCard(hum),
            MakeBitsCard(bits),
            MakeDcCard(dc),
            MakePeakCard(peak),
        };

        StatsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        StatsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (int i = 0; i < (cards.Count + 1) / 2; i++)
            StatsGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        for (int i = 0; i < cards.Count; i++)
        {
            var card = BuildStatCard(cards[i]);
            Grid.SetRow(card, i / 2);
            Grid.SetColumn(card, i % 2);
            card.Margin = new Thickness(i % 2 == 0 ? 0 : 6, 0, i % 2 == 0 ? 6 : 0, 12);
            StatsGrid.Children.Add(card);
        }
    }

    private (string, string, string, string, double, string, string) MakeQuietCard(double rms, bool isSilence)
    {
        string color = rms < ImplausiblyQuietDb ? "Warn"
                     : rms < -85 ? "Good"
                     : rms < -70 ? "Fg"
                     : "Warn";
        string note = rms < ImplausiblyQuietDb
            ? "あり得ない静けさ。加工の影響で信用できない数値です。"
            : rms < -85 ? "とても静か。マイクとプリアンプに余裕があります。"
            : rms < -70 ? "実用範囲。小さい音で弾くと少し気になるかもしれません。"
            : rms < -55 ? "やや高め。つまみを下げる、ファンから離す、で減ります。"
            : "高い。つまみが上がりすぎているか、まわりの音を拾っています。";
        if (!isSilence) note = "弾いている間の測定なので、静けさの目安にはなりません。";

        return ("まわりの静けさ", "noise floor",
                double.IsNegativeInfinity(rms) ? "-inf" : $"{rms:0.0}", "dBFS",
                MeterScale.Ratio(rms), note, color);
    }

    private static (string, string, string, string, double, string, string) MakeHumCard(
        SignalAnalysis.ChannelReport hum)
    {
        bool bad = hum.HumOverFloorDb > 12;
        bool some = hum.HumOverFloorDb > 6;
        return ("電源のブーン音", "hum",
                some ? $"+{hum.HumOverFloorDb:0}" : "なし",
                some ? $"dB @{hum.HumHz:0}Hz" : "",
                Math.Clamp(hum.HumOverFloorDb / 30.0, 0, 1),
                bad ? "対策の価値あり。電源やディスプレイからマイクを離してください。"
                    : some ? "わずかに出ています。気にならなければそのままで大丈夫です。"
                    : "目立ちません。",
                bad ? "Warn" : "Good");
    }

    private static (string, string, string, string, double, string, string) MakeBitsCard(double bits)
    {
        return ("実際に使えている細かさ", "effective bits",
                $"{bits:0.0}", "bit",
                Math.Clamp(bits / 24.0, 0, 1),
                bits > 20 ? "実在の機材ではこの値は出ません。加工が入っている可能性があります。"
                    : bits < 12 ? "24bit で録っても使えているのはこの範囲。まずノイズを下げるのが先です。"
                    : "24bit で録る意味が出る水準です。",
                bits > 20 ? "Warn" : bits < 12 ? "Warn" : "Good");
    }

    private static (string, string, string, string, double, string, string) MakeDcCard(double dc)
    {
        bool bad = dc > 0.001;
        return ("中心のズレ", "DC offset",
                $"{dc:0.00000}", "",
                Math.Clamp(dc / 0.01, 0, 1),
                bad ? "割れずに録れる余裕を無駄に食っています。機材側の設定を確かめてください。"
                    : "問題ありません。",
                bad ? "Warn" : "Good");
    }

    private static (string, string, string, string, double, string, string) MakePeakCard(double peak)
    {
        bool bad = peak >= -1;
        bool good = peak is >= -12 and <= -6;
        return ("いちばん大きいところ", "peak",
                double.IsNegativeInfinity(peak) ? "-inf" : $"{peak:0.0}", "dBFS",
                MeterScale.Ratio(peak),
                bad ? "割れる寸前です。つまみを下げてください。"
                    : good ? "ちょうどいい大きさです。"
                    : peak < -12 ? "少し小さめです。つまみを上げる余地があります。"
                    : "やや大きめですが、まだ割れてはいません。",
                bad ? "Rec" : good ? "Good" : "Fg");
    }

    private Border BuildStatCard(
        (string Label, string Original, string Value, string Unit,
         double Fill, string Note, string Color) c)
    {
        var accent = (Brush)FindResource(c.Color);
        var stack = new StackPanel();

        var head = new StackPanel { Orientation = Orientation.Horizontal };
        head.Children.Add(new TextBlock
        {
            Text = c.Label,
            FontSize = 11,
            Foreground = (Brush)FindResource("FgDim"),
        });
        head.Children.Add(new TextBlock
        {
            Text = c.Original,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 10,
            Margin = new Thickness(6, 0, 0, 0),
            Foreground = (Brush)FindResource("FgFaint"),
        });
        stack.Children.Add(head);

        var valueRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 6, 0, 0),
        };
        valueRow.Children.Add(new TextBlock
        {
            Text = c.Value,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 22,
            FontWeight = FontWeights.SemiBold,
            Foreground = accent,
        });
        if (c.Unit.Length > 0)
        {
            valueRow.Children.Add(new TextBlock
            {
                Text = c.Unit,
                FontFamily = new FontFamily("Consolas"),
                FontSize = 11,
                Margin = new Thickness(5, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Bottom,
                Foreground = (Brush)FindResource("FgDim"),
            });
        }
        stack.Children.Add(valueRow);

        var bar = new Border
        {
            Height = 6,
            CornerRadius = new CornerRadius(3),
            Background = (Brush)FindResource("Line"),
            Margin = new Thickness(0, 9, 0, 0),
            ClipToBounds = true,
            Child = new Grid
            {
                Children =
                {
                    new Rectangle
                    {
                        Fill = accent,
                        HorizontalAlignment = HorizontalAlignment.Left,
                        Width = 0,
                        Tag = c.Fill,
                    },
                },
            },
        };
        // 幅が決まってから比率を反映する
        bar.SizeChanged += (s, _) =>
        {
            if (((Border)s!).Child is Grid g && g.Children[0] is Rectangle r)
                r.Width = ((Border)s).ActualWidth * Math.Clamp(c.Fill, 0, 1);
        };
        stack.Children.Add(bar);

        stack.Children.Add(new TextBlock
        {
            Text = c.Note,
            FontSize = 11,
            LineHeight = 17,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 0),
            Foreground = accent,
        });

        return new Border
        {
            Style = (Style)FindResource("CardBorder"),
            Child = stack,
        };
    }

    // ---------------- 周波数の分布 ----------------

    private void BuildSpectrum()
    {
        SpectrumHost.Children.Clear();
        SpectrumHost.ColumnDefinitions.Clear();
        if (_reports.Length == 0) return;

        var bands = _reports[0].Bands;
        if (bands.Count == 0) return;

        // 30 本ある 1/3 オクターブ帯を 13 本にまとめる（細かすぎると読めない）
        const int columns = 13;
        var values = new double[columns];
        for (int i = 0; i < columns; i++)
        {
            int from = i * bands.Count / columns;
            int to = Math.Max(from + 1, (i + 1) * bands.Count / columns);
            double best = -200;
            for (int b = from; b < to && b < bands.Count; b++) best = Math.Max(best, bands[b].Db);
            values[i] = best;
        }

        double max = values.Max();
        CardSpectrum.Visibility = Visibility.Visible;

        for (int i = 0; i < columns; i++)
        {
            SpectrumHost.ColumnDefinitions.Add(
                new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            // -110〜-10 dBFS を高さに割り当てる
            double ratio = Math.Clamp((values[i] + 110) / 100.0, 0.02, 1);
            var bar = new Border
            {
                CornerRadius = new CornerRadius(2, 2, 0, 0),
                Background = (Brush)FindResource(Math.Abs(values[i] - max) < 0.01 ? "Good" : "Info"),
                VerticalAlignment = VerticalAlignment.Bottom,
                Height = 74 * ratio,
                Margin = new Thickness(1.5, 0, 1.5, 0),
                ToolTip = $"{bands[Math.Min(bands.Count - 1, i * bands.Count / columns)].CenterHz:0} Hz　" +
                          $"{values[i]:0.0} dBFS",
            };
            Grid.SetColumn(bar, i);
            SpectrumHost.Children.Add(bar);
        }
    }

    private void Warn(string message) =>
        MessageBox.Show(this, message, "音のチェック", MessageBoxButton.OK, MessageBoxImage.Warning);
}
