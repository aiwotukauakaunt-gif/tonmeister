using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using InstRecorder.Audio;
using Line = System.Windows.Shapes.Line;
using Path = System.Windows.Shapes.Path;
using Rectangle = System.Windows.Shapes.Rectangle;

namespace InstRecorder;

/// <summary>
/// 1トラックの波形を見ながら、切り出し・部分録り直し・後処理を行う。
/// どの操作も元の WAV には触らず、常に新しいテイクを作る。
/// </summary>
public partial class EditorWindow : Window
{
    /// <summary>録り直しの前に何秒ぶん聴かせるか（助走）。</summary>
    private const double PrerollSeconds = 2.0;

    private readonly Session _session;
    private readonly Track _track;
    private readonly RecorderEngine _engine;
    private readonly Func<int> _getLatencyFrames;
    private readonly Func<SaveFormat> _getSaveFormat;

    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(33) };

    private WaveformData? _waveform;
    private double _viewStart;      // 表示の左端（秒）
    private double _viewLength = 1; // 表示している長さ（秒）

    private double? _selStart, _selEnd;
    private bool _dragging;
    private double _dragOrigin;

    // Slider の ValueChanged は XAML の解析中（他のコントロールがまだ無い時点）にも飛んでくるので、
    // 初期化が済むまでイベントを止めておく。フィールド初期化子は InitializeComponent より先に走る。
    private bool _suppressEvents = true;

    // 録り直し中の状態
    private bool _punching;
    private double _punchAt;

    private readonly Path _wavePath = new();
    private readonly Rectangle _selRect = new();
    private readonly Line _playhead = new();
    private readonly Line _centerLine = new();

    public bool Changed { get; private set; }

    public EditorWindow(Session session, Track track, RecorderEngine engine,
                        Func<int> getLatencyFrames, Func<SaveFormat> getSaveFormat)
    {
        InitializeComponent();

        _session = session;
        _track = track;
        _engine = engine;
        _getLatencyFrames = getLatencyFrames;
        _getSaveFormat = getSaveFormat;

        BuildCanvasChildren();
        InitZoomControls();
        InitProcessingControls();

        Title = $"波形を見て直す — {track.Name}";
        TxtTrackName.Text = track.Name;

        _timer.Tick += Timer_Tick;
        _timer.Start();

        Loaded += (_, _) =>
        {
            RefreshTakes();
            LoadWaveform();
        };
        Closing += (_, _) =>
        {
            _timer.Stop();
            if (_engine.IsRecording) StopPunch(cancel: true);
            _engine.StopPlayback();
        };
    }

    // ---------------- 初期化 ----------------

    private void BuildCanvasChildren()
    {
        _wavePath.Stroke = new SolidColorBrush(Color.FromRgb(0xC9, 0xA2, 0x27));
        _wavePath.StrokeThickness = 1;

        _centerLine.Stroke = new SolidColorBrush(Color.FromRgb(0x33, 0x2D, 0x20));
        _centerLine.StrokeThickness = 1;

        _selRect.Fill = new SolidColorBrush(Color.FromArgb(0x55, 0x4E, 0x7C, 0xB5));
        _selRect.Stroke = new SolidColorBrush(Color.FromRgb(0x4E, 0x7C, 0xB5));
        _selRect.StrokeThickness = 2;
        _selRect.Visibility = Visibility.Collapsed;

        _playhead.Stroke = new SolidColorBrush(Color.FromRgb(0xA0, 0x3A, 0x2E));
        _playhead.StrokeThickness = 2;
        _playhead.Visibility = Visibility.Collapsed;

        WaveCanvas.Children.Add(_centerLine);
        WaveCanvas.Children.Add(_selRect);
        WaveCanvas.Children.Add(_wavePath);
        WaveCanvas.Children.Add(_playhead);
    }

    /// <summary>
    /// 波形の縦方向の倍率。小さい音を目で確認するためだけのもので、音そのものには影響しない。
    /// 「自動」は、そのテイクの最大値が画面いっぱいになるように合わせる。
    /// </summary>
    private double _verticalZoom = 1;
    private bool _autoVerticalZoom = true;

    private void InitZoomControls()
    {
        CmbVerticalZoom.ItemsSource = new[]
        {
            "自動", "×1", "×2", "×4", "×8", "×16", "×32", "×64", "×128", "×256", "×512", "×1024",
        };
        CmbVerticalZoom.SelectedIndex = 0;
    }

    private void CmbVerticalZoom_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressEvents) return;

        _autoVerticalZoom = CmbVerticalZoom.SelectedIndex <= 0;
        if (!_autoVerticalZoom)
            _verticalZoom = Math.Pow(2, CmbVerticalZoom.SelectedIndex - 1);
        else
            _verticalZoom = ComputeAutoVerticalZoom();

        Redraw();
    }

    private double ComputeAutoVerticalZoom()
    {
        if (_waveform == null || _waveform.BucketCount == 0) return 1;

        float peak = 0;
        for (int i = 0; i < _waveform.BucketCount; i++)
        {
            peak = Math.Max(peak, Math.Abs(_waveform.Max[i]));
            peak = Math.Max(peak, Math.Abs(_waveform.Min[i]));
        }
        // 暗騒音しか入っていない録音でも「何も無い」ではなく「小さい音がある」と見えるようにする
        if (peak <= 0.0000001f) return 1;
        return Math.Clamp(0.95 / peak, 1, 4096);
    }

    private void InitProcessingControls()
    {
        _suppressEvents = true;

        CmbHumFreq.ItemsSource = new[] { "50 Hz（東日本）", "60 Hz（西日本）" };
        CmbHumHarmonics.ItemsSource = new[] { 1, 2, 3, 4, 5, 6 };

        var p = _track.Processing;
        ChkHum.IsChecked = p.HumEnabled;
        CmbHumFreq.SelectedIndex = Math.Abs(p.HumFrequency - 60) < 1 ? 1 : 0;
        CmbHumHarmonics.SelectedItem = Math.Clamp(p.HumHarmonics, 1, 6);
        ChkGate.IsChecked = p.GateEnabled;
        SldGate.Value = p.GateThresholdDb;
        TxtGate.Text = $"{p.GateThresholdDb:0} dB";
        TxtProcSummary.Text = p.Summary;

        _suppressEvents = false;
    }

    private void RefreshTakes()
    {
        _suppressEvents = true;
        CmbTake.ItemsSource = _track.Takes.ToList();
        CmbTake.SelectedIndex = _track.ActiveTakeIndex;
        _suppressEvents = false;
        UpdateTakeInfo();
    }

    private void UpdateTakeInfo()
    {
        var take = _track.ActiveTake;
        TxtTakeInfo.Text = take == null
            ? "まだ録りがありません"
            : $"{take.Label}  {take.SampleRate / 1000.0:0.#}kHz / {take.Channels}ch";
    }

    // ---------------- 波形 ----------------

    private async void LoadWaveform()
    {
        var take = _track.ActiveTake;
        if (take == null) return;

        TxtEditInfo.Text = "波形を読み込んでいます…";
        Mouse.OverrideCursor = Cursors.Wait;
        try
        {
            _waveform = await Task.Run(() => WaveformData.Build(take));
            _viewStart = 0;
            _viewLength = Math.Max(0.01, _waveform?.TotalSeconds ?? 1);
            _selStart = _selEnd = null;
            if (_autoVerticalZoom) _verticalZoom = ComputeAutoVerticalZoom();
            TxtEditInfo.Text = _verticalZoom > 1.5
                ? $"元の録音は書き換えません。／小さい音なので、波形を縦に ×{_verticalZoom:0} して見せています。"
                : "元の録音は書き換えません。結果は新しい録りとして増えます。";
        }
        catch (Exception ex)
        {
            TxtEditInfo.Text = "波形を読めませんでした: " + ex.Message;
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }

        UpdateScrollBar();
        Redraw();
        UpdateSelectionUi();
    }

    private double TotalSeconds => _waveform?.TotalSeconds ?? 0;

    private double SecondsToX(double seconds) =>
        (seconds - _viewStart) / _viewLength * WaveCanvas.ActualWidth;

    private double XToSeconds(double x) =>
        _viewStart + x / Math.Max(1, WaveCanvas.ActualWidth) * _viewLength;

    private void Redraw()
    {
        double w = WaveCanvas.ActualWidth;
        double h = WaveCanvas.ActualHeight;
        if (w < 2 || h < 2 || _waveform == null) return;

        double mid = h / 2;
        _centerLine.X1 = 0; _centerLine.X2 = w;
        _centerLine.Y1 = mid; _centerLine.Y2 = mid;

        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            double secPerBucket = _waveform.SecondsPerBucket;
            for (int x = 0; x < (int)w; x++)
            {
                double t0 = XToSeconds(x);
                double t1 = XToSeconds(x + 1);
                int b0 = (int)(t0 / secPerBucket);
                int b1 = (int)Math.Ceiling(t1 / secPerBucket);
                if (b1 <= b0) b1 = b0 + 1;
                if (b0 < 0) b0 = 0;
                if (b0 >= _waveform.BucketCount) break;
                if (b1 > _waveform.BucketCount) b1 = _waveform.BucketCount;

                float lo = float.MaxValue, hi = float.MinValue;
                for (int b = b0; b < b1; b++)
                {
                    if (_waveform.Min[b] < lo) lo = _waveform.Min[b];
                    if (_waveform.Max[b] > hi) hi = _waveform.Max[b];
                }
                if (lo > hi) continue;

                double yTop = mid - Math.Clamp(hi * _verticalZoom, -1, 1) * mid;
                double yBottom = mid - Math.Clamp(lo * _verticalZoom, -1, 1) * mid;
                if (yBottom - yTop < 1) yBottom = yTop + 1;

                ctx.BeginFigure(new Point(x + 0.5, yTop), false, false);
                ctx.LineTo(new Point(x + 0.5, yBottom), true, false);
            }
        }
        geometry.Freeze();
        _wavePath.Data = geometry;

        DrawRuler();
        UpdateSelectionRect();
    }

    private void DrawRuler()
    {
        RulerCanvas.Children.Clear();
        double w = WaveCanvas.ActualWidth;
        if (w < 2) return;

        // 目盛りの間隔は、目盛りが 60〜140px おきになるものを選ぶ
        double[] steps = { 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600 };
        double step = steps[^1];
        foreach (var s in steps)
        {
            if (s / _viewLength * w >= 60) { step = s; break; }
        }

        var brush = new SolidColorBrush(Color.FromRgb(0x84, 0x7A, 0x64));
        for (double t = Math.Ceiling(_viewStart / step) * step; t <= _viewStart + _viewLength; t += step)
        {
            double x = SecondsToX(t);
            if (x < 0 || x > w) continue;

            RulerCanvas.Children.Add(new Line
            {
                X1 = x, X2 = x, Y1 = 0, Y2 = 5,
                Stroke = new SolidColorBrush(Color.FromRgb(0x33, 0x2D, 0x20)),
                StrokeThickness = 1,
            });

            var label = new TextBlock
            {
                Text = FormatTime(t, step),
                Foreground = brush,
                FontFamily = new FontFamily("Consolas"),
                FontSize = 9.5,
            };
            Canvas.SetLeft(label, x + 3);
            Canvas.SetTop(label, 4);
            RulerCanvas.Children.Add(label);
        }
    }

    private static string FormatTime(double seconds, double step)
    {
        var t = TimeSpan.FromSeconds(seconds);
        if (step < 1) return $"{(int)t.TotalMinutes:00}:{t.Seconds:00}.{t.Milliseconds / 100}";
        if (t.TotalHours >= 1) return $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}";
        return $"{(int)t.TotalMinutes:00}:{t.Seconds:00}";
    }

    private void UpdateSelectionRect()
    {
        if (_selStart == null || _selEnd == null)
        {
            _selRect.Visibility = Visibility.Collapsed;
            return;
        }

        double a = SecondsToX(Math.Min(_selStart.Value, _selEnd.Value));
        double b = SecondsToX(Math.Max(_selStart.Value, _selEnd.Value));
        double left = Math.Max(0, a);
        double right = Math.Min(WaveCanvas.ActualWidth, b);
        if (right <= left)
        {
            _selRect.Visibility = Visibility.Collapsed;
            return;
        }

        _selRect.Visibility = Visibility.Visible;
        _selRect.Width = right - left;
        _selRect.Height = Math.Max(0, WaveCanvas.ActualHeight);
        Canvas.SetLeft(_selRect, left);
        Canvas.SetTop(_selRect, 0);
    }

    private void UpdateSelectionUi()
    {
        bool has = HasSelection(out double s, out double e);
        SelBadge.Visibility = has ? Visibility.Visible : Visibility.Collapsed;
        if (has)
        {
            TxtSelRange.Text = $"{FormatTime(s, 0.1)} → {FormatTime(e, 0.1)}";
            TxtSelection.Text = $"　長さ {e - s:0.00} 秒";
        }
        else
        {
            TxtSelection.Text = "波形をドラッグして「使いたいところ」を選びます";
        }

        bool idle = !_engine.IsRecording && !_engine.IsPlaying;
        BtnCrop.IsEnabled = has && idle;
        BtnPunch.IsEnabled = has && idle && _engine.IsOpen;
        BtnZoomSel.IsEnabled = has;
    }

    private bool HasSelection(out double start, out double end)
    {
        start = end = 0;
        if (_selStart == null || _selEnd == null) return false;
        start = Math.Max(0, Math.Min(_selStart.Value, _selEnd.Value));
        end = Math.Min(TotalSeconds, Math.Max(_selStart.Value, _selEnd.Value));
        return end - start > 0.005;
    }

    // ---------------- マウス操作 ----------------

    private void Wave_SizeChanged(object sender, SizeChangedEventArgs e) => Redraw();

    private void Wave_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (_waveform == null) return;
        _dragging = true;
        _dragOrigin = XToSeconds(e.GetPosition(WaveCanvas).X);
        _selStart = _dragOrigin;
        _selEnd = _dragOrigin;
        WaveCanvas.CaptureMouse();
        UpdateSelectionRect();
        UpdateSelectionUi();
    }

    private void Wave_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        _selStart = _dragOrigin;
        _selEnd = Math.Clamp(XToSeconds(e.GetPosition(WaveCanvas).X), 0, TotalSeconds);
        UpdateSelectionRect();
        UpdateSelectionUi();
    }

    private void Wave_MouseUp(object sender, MouseButtonEventArgs e)
    {
        if (!_dragging) return;
        _dragging = false;
        WaveCanvas.ReleaseMouseCapture();

        // ドラッグせずクリックしただけなら選択を解除する
        if (!HasSelection(out _, out _))
        {
            _selStart = _selEnd = null;
            UpdateSelectionRect();
        }
        UpdateSelectionUi();
    }

    private void Wave_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (_waveform == null) return;
        double focus = XToSeconds(e.GetPosition(WaveCanvas).X);
        Zoom(e.Delta > 0 ? 0.7 : 1 / 0.7, focus);
    }

    private void Zoom(double factor, double focusSeconds)
    {
        double total = Math.Max(0.01, TotalSeconds);
        double newLength = Math.Clamp(_viewLength * factor, 0.02, total);
        double ratio = (focusSeconds - _viewStart) / _viewLength;
        _viewStart = Math.Clamp(focusSeconds - ratio * newLength, 0, Math.Max(0, total - newLength));
        _viewLength = newLength;
        UpdateScrollBar();
        Redraw();
    }

    private void UpdateScrollBar()
    {
        double total = Math.Max(0.01, TotalSeconds);
        _suppressEvents = true;
        ScrollH.Minimum = 0;
        ScrollH.Maximum = Math.Max(0, total - _viewLength);
        ScrollH.ViewportSize = _viewLength;
        ScrollH.Value = Math.Clamp(_viewStart, 0, ScrollH.Maximum);
        ScrollH.IsEnabled = ScrollH.Maximum > 0;
        _suppressEvents = false;
    }

    private void ScrollH_Scroll(object sender, System.Windows.Controls.Primitives.ScrollEventArgs e)
    {
        if (_suppressEvents) return;
        _viewStart = ScrollH.Value;
        Redraw();
    }

    private void BtnZoomIn_Click(object sender, RoutedEventArgs e) =>
        Zoom(0.6, _viewStart + _viewLength / 2);

    private void BtnZoomOut_Click(object sender, RoutedEventArgs e) =>
        Zoom(1 / 0.6, _viewStart + _viewLength / 2);

    private void BtnZoomFit_Click(object sender, RoutedEventArgs e)
    {
        _viewStart = 0;
        _viewLength = Math.Max(0.01, TotalSeconds);
        UpdateScrollBar();
        Redraw();
    }

    private void BtnZoomSel_Click(object sender, RoutedEventArgs e)
    {
        if (!HasSelection(out double s, out double en)) return;
        double margin = (en - s) * 0.1;
        _viewStart = Math.Max(0, s - margin);
        _viewLength = Math.Min(Math.Max(0.02, en - s + margin * 2), Math.Max(0.02, TotalSeconds));
        UpdateScrollBar();
        Redraw();
    }

    // ---------------- 再生 ----------------

    private void BtnPlay_Click(object sender, RoutedEventArgs e)
    {
        if (!_engine.IsOpen)
        {
            Warn("聞くには、「録る」画面でマイクが使える状態にしてください。");
            return;
        }

        double start = HasSelection(out double s, out _) ? s : 0;
        try
        {
            if (!_engine.StartPlayback(_session, null, start))
                Warn("鳴らせるトラックがありません。");
        }
        catch (Exception ex)
        {
            Warn(ex.Message);
        }
        UpdateButtons();
    }

    private void BtnStop_Click(object sender, RoutedEventArgs e)
    {
        if (_punching) StopPunch(cancel: false);
        else _engine.StopPlayback();
        UpdateButtons();
    }

    private void Timer_Tick(object? sender, EventArgs e)
    {
        if (_engine.IsPlaying || _engine.IsRecording)
        {
            double baseTime = _punching ? _punchAt - PrerollSeconds
                            : HasSelection(out double s, out _) ? s : 0;
            double t = baseTime + _engine.PlaybackSeconds;
            double x = SecondsToX(t);

            if (x >= 0 && x <= WaveCanvas.ActualWidth)
            {
                _playhead.Visibility = Visibility.Visible;
                _playhead.X1 = _playhead.X2 = x;
                _playhead.Y1 = 0;
                _playhead.Y2 = WaveCanvas.ActualHeight;
            }
            else
            {
                _playhead.Visibility = Visibility.Collapsed;
            }

            if (_punching)
            {
                TxtEditInfo.Text = t < _punchAt
                    ? $"助走中… あと {_punchAt - t:0.0} 秒で録音区間に入ります"
                    : $"録り直し中 {t - _punchAt:0.0} 秒";
            }
        }
        else if (_playhead.Visibility == Visibility.Visible)
        {
            _playhead.Visibility = Visibility.Collapsed;
            UpdateButtons();
        }
    }

    private void UpdateButtons()
    {
        bool busy = _engine.IsPlaying || _engine.IsRecording;
        BtnStop.IsEnabled = busy;
        BtnPlay.IsEnabled = !busy;
        CmbTake.IsEnabled = !busy;
        UpdateSelectionUi();
    }

    // ---------------- 切り出し ----------------

    private void BtnCrop_Click(object sender, RoutedEventArgs e)
    {
        if (!HasSelection(out double s, out double en)) return;
        var take = _track.ActiveTake;
        if (take == null) return;

        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            var save = _getSaveFormat();
            var path = _session.NextRecordingPath(save, _track);
            var cropped = AudioEdit.Crop(take, s, en, path, save, $"{_track.Takes.Count + 1}回目の録り（切り出し）");

            _track.AddTake(cropped);
            _session.Save();
            Changed = true;

            RefreshTakes();
            _selStart = _selEnd = null;
            LoadWaveform();
        }
        catch (Exception ex)
        {
            Warn("切り出せませんでした: " + ex.Message);
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }
    }

    // ---------------- 部分録り直し（パンチイン） ----------------

    private void BtnPunch_Click(object sender, RoutedEventArgs e)
    {
        if (!HasSelection(out double s, out _)) return;
        if (!_engine.IsOpen)
        {
            Warn("録り直すには、「録る」画面でマイクが使える状態にしてください。");
            return;
        }

        var take = _track.ActiveTake;
        if (take == null) return;

        int latency = _getLatencyFrames();
        var message =
            $"{FormatTime(s, 0.1)} から録り直します。\n\n" +
            $"・{PrerollSeconds:0} 秒の助走のあと、録音に入ります\n" +
            "・どこまで録り直すかは、止めるまでの時間で決まります\n" +
            "・このトラックは録音中は鳴りません（前の音が二重に聴こえないため）\n" +
            $"・継ぎ目は {AudioEdit.CrossfadeSeconds * 1000:0} ms で自動的になめらかにつなぎます\n\n" +
            (latency > 0
                ? $"ズレ合わせ: {latency} サンプル"
                : "⚠ ズレ合わせを測っていません。ズレたまま繋がる可能性があります。") +
            "\n\n始めますか？";

        if (MessageBox.Show(this, message, "ここだけ録り直す",
                MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK)
            return;

        try
        {
            var save = _getSaveFormat();
            var path = _session.NextRecordingPath(save, _track);

            // 助走ぶんとレイテンシぶんを捨てれば、録音の先頭が録り直し開始位置になる
            int rate = _engine.SampleRate;
            int trim = latency + (int)(PrerollSeconds * rate);
            double playFrom = Math.Max(0, s - PrerollSeconds);
            // 曲の頭が助走に足りない場合、その分だけ捨てる量を減らす
            trim -= (int)((PrerollSeconds - (s - playFrom)) * rate);

            _punchAt = s;
            _punching = true;
            _engine.StartOverdub(_session, path, save, Math.Max(0, trim), _track, playFrom);
        }
        catch (Exception ex)
        {
            _punching = false;
            Warn(ex.Message);
        }
        UpdateButtons();
    }

    private void StopPunch(bool cancel)
    {
        var files = _engine.StopRecording();
        _engine.StopPlayback();
        _punching = false;

        if (cancel || files.Count == 0)
        {
            foreach (var f in files)
            {
                try { File.Delete(f); } catch { /* 消せなくても致命的ではない */ }
            }
            return;
        }

        var take = _track.ActiveTake;
        if (take == null) return;

        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            var save = _getSaveFormat();
            var outPath = _session.NextRecordingPath(save, _track);
            var punched = AudioEdit.PunchIn(take, files, _punchAt, outPath, save,
                                            $"{_track.Takes.Count + 1}回目の録り（録り直し）");

            _track.AddTake(punched);
            _session.Save();
            Changed = true;

            RefreshTakes();
            LoadWaveform();
            TxtEditInfo.Text = $"{FormatTime(_punchAt, 0.1)} から差し替えた新しいテイクを作りました。";
        }
        catch (Exception ex)
        {
            Warn("差し替えられませんでした: " + ex.Message + "\n\n録り直した音はフォルダに残っています。");
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }
    }

    // ---------------- テイク切り替え・後処理 ----------------

    private void CmbTake_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressEvents) return;
        if (CmbTake.SelectedIndex < 0) return;

        _track.ActiveTakeIndex = CmbTake.SelectedIndex;
        _session.Save();
        Changed = true;
        UpdateTakeInfo();
        LoadWaveform();
    }

    private void Processing_Changed(object sender, RoutedEventArgs e) => ApplyProcessing();

    private void Processing_Changed(object sender, SelectionChangedEventArgs e) => ApplyProcessing();

    private void GateSlider_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (TxtGate != null) TxtGate.Text = $"{SldGate.Value:0} dB";
        ApplyProcessing();
    }

    private void ApplyProcessing()
    {
        if (_suppressEvents || ChkHum == null || SldGate == null) return;

        var p = _track.Processing;
        p.HumEnabled = ChkHum.IsChecked == true;
        p.HumFrequency = CmbHumFreq.SelectedIndex == 1 ? 60 : 50;
        p.HumHarmonics = CmbHumHarmonics.SelectedItem is int h ? h : 4;
        p.GateEnabled = ChkGate.IsChecked == true;
        p.GateThresholdDb = SldGate.Value;

        TxtProcSummary.Text = p.Summary;
        _session.Save();
        Changed = true;
    }

    private void Warn(string message) =>
        MessageBox.Show(this, message, "波形を見て直す", MessageBoxButton.OK, MessageBoxImage.Warning);
}
