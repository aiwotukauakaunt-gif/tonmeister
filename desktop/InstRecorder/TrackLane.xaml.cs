using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using InstRecorder.Audio;
using Line = System.Windows.Shapes.Line;
using Path = System.Windows.Shapes.Path;
using Rectangle = System.Windows.Shapes.Rectangle;
using Track = InstRecorder.Audio.Track;

namespace InstRecorder;

/// <summary>
/// 「重ねる」モードの1トラック分のレーン。
/// 波形・テイクの選び直し・部分録り直し・切り出しを、その行の中だけで完結させる。
/// </summary>
public partial class TrackLane : UserControl
{
    /// <summary>トラックごとに波形の色を巡回させる。</summary>
    private static readonly Color[] WaveColors =
    {
        Color.FromRgb(0xC9, 0xA2, 0x27),  // 金
        Color.FromRgb(0x4E, 0x7C, 0xB5),  // ベルリン藍
        Color.FromRgb(0xB3, 0xA9, 0x8F),  // 象牙
        Color.FromRgb(0xB0, 0x6A, 0x2C),  // 赤銅
    };

    private readonly Path _wavePath = new();
    private readonly Rectangle _selRect = new();
    private readonly Line _playhead = new();

    private WaveformData? _waveform;
    private Take? _waveformTake;
    private double _totalSeconds = 1;

    private bool _building;
    private bool _dragging;
    private double _dragOrigin;

    public Track Track { get; }

    public double? SelStart { get; private set; }
    public double? SelEnd { get; private set; }

    /// <summary>このレーンで範囲が選ばれた／解除された。</summary>
    public event Action<TrackLane>? SelectionChanged;
    /// <summary>「ここだけ録り直す」が押された。</summary>
    public event Action<TrackLane>? PunchRequested;
    /// <summary>「選んだところを切り出す」が押された。</summary>
    public event Action<TrackLane>? CropRequested;
    /// <summary>セッションに保存すべき変更があった。</summary>
    public event Action? Edited;

    public TrackLane(Track track, int colorIndex)
    {
        InitializeComponent();
        Track = track;

        var color = WaveColors[colorIndex % WaveColors.Length];
        _wavePath.Stroke = new SolidColorBrush(color) { Opacity = 0.8 };
        _wavePath.StrokeThickness = 1;

        _selRect.Fill = new SolidColorBrush(Color.FromArgb(0x55, 0x4E, 0x7C, 0xB5));
        _selRect.Stroke = new SolidColorBrush(Color.FromRgb(0x4E, 0x7C, 0xB5));
        _selRect.StrokeThickness = 1;
        _selRect.Visibility = Visibility.Collapsed;

        _playhead.Stroke = new SolidColorBrush(Color.FromRgb(0xA0, 0x3A, 0x2E));
        _playhead.StrokeThickness = 2;
        _playhead.Visibility = Visibility.Collapsed;

        WaveCanvas.Children.Add(_selRect);
        WaveCanvas.Children.Add(_wavePath);
        WaveCanvas.Children.Add(_playhead);

        Track.PropertyChanged += Track_PropertyChanged;
        RefreshFromTrack();
        RefreshTakes();
    }

    private void Track_PropertyChanged(object? sender, PropertyChangedEventArgs e) =>
        Dispatcher.Invoke(RefreshFromTrack);

    /// <summary>レーンを作り直すとき、古いレーンがトラックを掴んだままにならないよう外す。</summary>
    public void Unhook() => Track.PropertyChanged -= Track_PropertyChanged;

    // ---------------- トラックの状態を映す ----------------

    public void RefreshFromTrack()
    {
        _building = true;
        TxtName.Text = Track.Name;
        TglMute.IsChecked = Track.Muted;
        TglSolo.IsChecked = Track.Soloed;
        BtnVolume.Content = Track.VolumeLabel.Replace(" dB", "dB");
        SldVolume.Value = Track.Volume;
        _building = false;
    }

    public void RefreshTakes()
    {
        _building = true;
        TakePills.Children.Clear();

        for (int i = 0; i < Track.Takes.Count; i++)
        {
            int index = i;
            bool active = i == Track.ActiveTakeIndex;
            var pill = new Button
            {
                Content = $"{i + 1}回目",
                Height = 22,
                Padding = new Thickness(9, 0, 9, 0),
                FontSize = 10.5,
                FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal,
                Margin = new Thickness(0, 0, 5, 0),
                Background = new SolidColorBrush(active
                    ? Color.FromRgb(0xC9, 0xA2, 0x27)
                    : Color.FromRgb(0x1E, 0x1B, 0x14)),
                BorderBrush = new SolidColorBrush(active
                    ? Color.FromRgb(0xE3, 0xC7, 0x66)
                    : Color.FromRgb(0x33, 0x2D, 0x20)),
                Foreground = new SolidColorBrush(active
                    ? Color.FromRgb(0x0C, 0x0B, 0x09)
                    : Color.FromRgb(0xB3, 0xA9, 0x8F)),
                ToolTip = Track.Takes[i].Label,
            };
            pill.Click += (_, _) =>
            {
                if (Track.ActiveTakeIndex == index) return;
                Track.ActiveTakeIndex = index;
                RefreshTakes();
                ReloadWaveform();
                Edited?.Invoke();
            };
            TakePills.Children.Add(pill);
        }

        // 1本しか無いなら選びようがないので、行ごと畳む
        PnlTakes.Visibility = Track.Takes.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        _building = false;
    }

    private void TxtName_Click(object sender, MouseButtonEventArgs e)
    {
        EdtName.Text = Track.Name;
        EdtName.Visibility = Visibility.Visible;
        TxtName.Visibility = Visibility.Collapsed;
        EdtName.Focus();
        EdtName.SelectAll();
    }

    private void EdtName_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { CommitName(); e.Handled = true; }
        else if (e.Key == Key.Escape) { CancelName(); e.Handled = true; }
    }

    private void EdtName_LostFocus(object sender, RoutedEventArgs e) => CommitName();

    private void CommitName()
    {
        if (EdtName.Visibility != Visibility.Visible) return;
        var name = EdtName.Text.Trim();
        if (name.Length > 0 && name != Track.Name)
        {
            Track.Name = name;
            Edited?.Invoke();
        }
        CancelName();
    }

    private void CancelName()
    {
        EdtName.Visibility = Visibility.Collapsed;
        TxtName.Visibility = Visibility.Visible;
        TxtName.Text = Track.Name;
    }

    private void Mute_Changed(object sender, RoutedEventArgs e)
    {
        if (_building) return;
        Track.Muted = TglMute.IsChecked == true;
        Edited?.Invoke();
    }

    private void Solo_Changed(object sender, RoutedEventArgs e)
    {
        if (_building) return;
        Track.Soloed = TglSolo.IsChecked == true;
        Edited?.Invoke();
    }

    private void BtnVolume_Click(object sender, RoutedEventArgs e) =>
        VolumePopup.IsOpen = !VolumePopup.IsOpen;

    private void SldVolume_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_building) return;
        Track.Volume = (float)SldVolume.Value;
        BtnVolume.Content = Track.VolumeLabel.Replace(" dB", "dB");
        Edited?.Invoke();
    }

    // ---------------- 波形 ----------------

    /// <summary>全レーンで同じ時間軸を使う（縦に並べたときに位置が揃う）。</summary>
    public void SetTotalSeconds(double seconds)
    {
        _totalSeconds = Math.Max(0.01, seconds);
        Redraw();
    }

    public async void ReloadWaveform()
    {
        var take = Track.ActiveTake;
        if (take == null)
        {
            _waveform = null;
            _waveformTake = null;
            Redraw();
            return;
        }
        if (ReferenceEquals(take, _waveformTake) && _waveform != null) return;

        _waveformTake = take;
        var built = await WaveformCache.GetAsync(take);

        // 読んでいる間に録りが切り替わっていたら、その結果は捨てる
        if (!ReferenceEquals(_waveformTake, take)) return;

        _waveform = built;
        Redraw();
    }

    /// <summary>
    /// 振幅を「音の大きさ（dB）」の目盛りで高さに直す。
    ///
    /// 素の振幅のまま描くと、−36 dBFS の音は枠の 1.6% にしかならず線1本に見える。
    /// かといってトラックごとに倍率を変えると、大きさを目で比べられなくなる。
    /// dB の目盛りなら、小さい音も見えて、大きいトラックはちゃんと大きく見える。
    /// −60 dBFS で中心、0 dBFS で枠いっぱい。
    /// </summary>
    private static double ToScale(double amplitude)
    {
        double a = Math.Abs(amplitude);
        if (a <= 0.000001) return 0;
        double db = 20 * Math.Log10(a);
        double h = Math.Clamp((db + 60) / 60.0, 0, 1);
        return amplitude < 0 ? -h : h;
    }

    private void Wave_SizeChanged(object sender, SizeChangedEventArgs e) => Redraw();

    private double SecondsToX(double seconds) => seconds / _totalSeconds * WaveCanvas.ActualWidth;

    private double XToSeconds(double x) =>
        Math.Clamp(x / Math.Max(1, WaveCanvas.ActualWidth) * _totalSeconds, 0, _totalSeconds);

    private void Redraw()
    {
        double w = WaveCanvas.ActualWidth;
        double h = WaveCanvas.ActualHeight;
        if (w < 2 || h < 2) return;

        if (_waveform == null || _waveform.BucketCount == 0)
        {
            _wavePath.Data = null;
            UpdateSelectionRect();
            return;
        }

        double mid = h / 2;
        double secPerBucket = _waveform.SecondsPerBucket;

        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            for (int x = 0; x < (int)w; x++)
            {
                double t0 = x / w * _totalSeconds;
                double t1 = (x + 1) / w * _totalSeconds;
                int b0 = (int)(t0 / secPerBucket);
                int b1 = (int)Math.Ceiling(t1 / secPerBucket);
                if (b1 <= b0) b1 = b0 + 1;
                if (b0 >= _waveform.BucketCount) break;
                if (b1 > _waveform.BucketCount) b1 = _waveform.BucketCount;

                float lo = float.MaxValue, hi = float.MinValue;
                for (int b = b0; b < b1; b++)
                {
                    if (_waveform.Min[b] < lo) lo = _waveform.Min[b];
                    if (_waveform.Max[b] > hi) hi = _waveform.Max[b];
                }
                if (lo > hi) continue;

                double yTop = mid - ToScale(hi) * mid;
                double yBottom = mid - ToScale(lo) * mid;
                if (yBottom - yTop < 1) yBottom = yTop + 1;

                ctx.BeginFigure(new Point(x + 0.5, yTop), false, false);
                ctx.LineTo(new Point(x + 0.5, yBottom), true, false);
            }
        }
        geometry.Freeze();
        _wavePath.Data = geometry;

        UpdateSelectionRect();
    }

    public void SetPlayhead(double seconds, bool visible)
    {
        if (!visible || WaveCanvas.ActualWidth < 2)
        {
            _playhead.Visibility = Visibility.Collapsed;
            return;
        }
        double x = SecondsToX(seconds);
        if (x < 0 || x > WaveCanvas.ActualWidth)
        {
            _playhead.Visibility = Visibility.Collapsed;
            return;
        }
        _playhead.Visibility = Visibility.Visible;
        _playhead.X1 = _playhead.X2 = x;
        _playhead.Y1 = 0;
        _playhead.Y2 = WaveCanvas.ActualHeight;
    }

    // ---------------- 範囲選択 ----------------

    public bool HasSelection(out double start, out double end)
    {
        start = end = 0;
        if (SelStart == null || SelEnd == null) return false;
        start = Math.Min(SelStart.Value, SelEnd.Value);
        end = Math.Max(SelStart.Value, SelEnd.Value);
        return end - start > 0.02;
    }

    public void ClearSelection()
    {
        SelStart = SelEnd = null;
        UpdateSelectionRect();
        UpdateBottomRow();
    }

    private void Wave_MouseDown(object sender, MouseButtonEventArgs e)
    {
        _dragging = true;
        _dragOrigin = XToSeconds(e.GetPosition(WaveCanvas).X);
        SelStart = SelEnd = _dragOrigin;
        WaveCanvas.CaptureMouse();
        UpdateSelectionRect();
        SelectionChanged?.Invoke(this);
    }

    private void Wave_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        SelStart = _dragOrigin;
        SelEnd = XToSeconds(e.GetPosition(WaveCanvas).X);
        UpdateSelectionRect();
    }

    private void Wave_MouseUp(object sender, MouseButtonEventArgs e)
    {
        if (!_dragging) return;
        _dragging = false;
        WaveCanvas.ReleaseMouseCapture();

        // 掴んだだけ（動かしていない）なら、範囲ではなくトラックを選んだものとして扱う
        if (!HasSelection(out _, out _)) SelStart = SelEnd = null;

        UpdateSelectionRect();
        UpdateBottomRow();
        SelectionChanged?.Invoke(this);
    }

    private void UpdateSelectionRect()
    {
        if (!HasSelection(out double s, out double e) || WaveCanvas.ActualWidth < 2)
        {
            _selRect.Visibility = Visibility.Collapsed;
            return;
        }

        double left = Math.Max(0, SecondsToX(s));
        double right = Math.Min(WaveCanvas.ActualWidth, SecondsToX(e));
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

    private void UpdateBottomRow()
    {
        bool has = HasSelection(out _, out _);
        PnlSelection.Visibility = has ? Visibility.Visible : Visibility.Collapsed;
        PnlTakes.Visibility = has || Track.Takes.Count <= 1
            ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>録音・再生の最中は、行の中の編集操作を止める。</summary>
    public void SetBusy(bool busy)
    {
        BtnPunch.IsEnabled = !busy;
        BtnCrop.IsEnabled = !busy;
        BtnVolume.IsEnabled = true;
    }

    private void BtnPunch_Click(object sender, RoutedEventArgs e) => PunchRequested?.Invoke(this);

    private void BtnCrop_Click(object sender, RoutedEventArgs e) => CropRequested?.Invoke(this);
}
