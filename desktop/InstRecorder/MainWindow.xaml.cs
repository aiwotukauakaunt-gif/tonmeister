using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using InstRecorder.Audio;
using Line = System.Windows.Shapes.Line;
using Path = System.Windows.Shapes.Path;

namespace InstRecorder;

public partial class MainWindow : Window
{
    private static readonly string RootDir = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyMusic), "録音");

    /// <summary>録り直しの前に何秒ぶん聴かせるか（助走）。</summary>
    private const double PrerollSeconds = 2.0;

    private readonly RecorderEngine _engine = new();
    private readonly InputSetup _setup;
    private readonly AppSettings _settings = AppSettings.Load(RootDir);
    private readonly DispatcherTimer _uiTimer = new() { Interval = TimeSpan.FromMilliseconds(33) };
    private readonly DispatcherTimer _autoSaveTimer = new() { Interval = TimeSpan.FromSeconds(20) };

    private Session _session = new();
    private bool _sessionDirty;
    private bool _monitorWarningShown;
    private bool _alignToastShown;
    private bool _outputWarningShown;
    /// <summary>再生中に出す、鳴らす側の音量についての一言。問題なければ空。</summary>
    private string _outputNote = "";
    /// <summary>再生中の出力ピーク（ホールド付き）。</summary>
    private float _outHold;
    private DateTime _outHoldAt;
    /// <summary>音が出ていない状態が続き始めた時刻。</summary>
    private DateTime _silentSince = DateTime.MinValue;

    private enum Mode { Record, Overdub }
    private Mode _mode = Mode.Record;

    private readonly List<TrackLane> _lanes = new();
    private TrackLane? _selected;

    /// <summary>録り直し中の状態。null なら普通の録音。</summary>
    private (TrackLane Lane, double At)? _punch;

    // ---- 報せの帯 ----
    private readonly DispatcherTimer _noticeTimer = new() { Interval = TimeSpan.FromSeconds(14) };
    private Action? _noticeAction;

    /// <summary>いま録っている音の最大。止めたときに一言を出すために控える。</summary>
    private float _recPeak;

    /// <summary>直前に外したトラック。1つだけ戻せる。</summary>
    private (Track Track, int Index)? _removed;

    // ---- メーター ----
    private enum Verdict { Unknown, Silent, TooQuiet, Good, TooLoud, Clipping }

    private float _hold;
    private DateTime _holdAt;
    private Verdict _verdict = Verdict.Unknown;
    private Verdict _pending = Verdict.Unknown;
    private DateTime _pendingSince;

    private static readonly double GoodFrom = MeterScale.GoodFrom;
    private static readonly double GoodTo = MeterScale.GoodTo;

    // ---- 録音中の走る波形 ----
    private const int LiveCapacity = 450;  // 33ms × 450 ≒ 15 秒
    private readonly List<float> _live = new(LiveCapacity);
    private readonly Path _livePath = new();

    // ---- 円形メーター ----
    private const double RingStart = 135;
    private const double RingSweep = 270;
    private readonly Path _ringTrack = new();
    private readonly Path _ringGood = new();
    private readonly Path _ringLevel = new();

    public MainWindow()
    {
        InitializeComponent();

        _setup = new InputSetup(_engine);
        _setup.Changed += () => Dispatcher.Invoke(UpdateInputStatus);

        BuildRing();
        BuildLiveWave();
        BuildOrnaments();

        _engine.ErrorOccurred += msg => Dispatcher.Invoke(() => ShowError(msg));
        _engine.PartStarted += path => Dispatcher.Invoke(() =>
        {
            // 4GB を超えたので次のファイルに切り替わった。録音は止めない。
            TxtRecSave.Text = $"ファイルを分けました → {System.IO.Path.GetFileName(path)}";
        });

        _uiTimer.Tick += UiTimer_Tick;
        _uiTimer.Start();

        _noticeTimer.Tick += (_, _) => HideNotice();

        _autoSaveTimer.Tick += (_, _) =>
        {
            if (!_sessionDirty || _engine.IsRecording) return;
            _sessionDirty = false;
            try { _session.Save(); } catch { /* 次回に持ち越す */ }
        };
        _autoSaveTimer.Start();

        Loaded += (_, _) =>
        {
            Directory.CreateDirectory(RootDir);
            LoadLatestOrNewSession();
            ScanAndOpen();
            SetMode(_session.Tracks.Count == 0 ? Mode.Record : Mode.Overdub);
        };
        Closing += (_, _) =>
        {
            StopAll();
            _session.Save();
            RememberSettings();
            _engine.Dispose();
        };

        PreviewKeyDown += MainWindow_PreviewKeyDown;
    }

    // ---------------- キーボードショートカット ----------------

    private void MainWindow_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        // 文字入力中はショートカットを効かせない（トラック名にスペースが打てなくなるため）
        if (Keyboard.FocusedElement is TextBox) return;

        bool ctrl = (Keyboard.Modifiers & ModifierKeys.Control) != 0;

        switch (e.Key)
        {
            case Key.Space:
                if (_engine.IsRecording || _engine.IsPlaying) StopAll();
                else if (_mode == Mode.Record) StartRecording(null);
                else if (BtnPlay.IsEnabled) BtnPlay_Click(this, new RoutedEventArgs());
                e.Handled = true;
                break;

            case Key.R when !ctrl:
                if (!_engine.IsRecording && !_engine.IsPlaying) StartRecording(null);
                e.Handled = true;
                break;

            case Key.Escape:
                if (_engine.IsRecording || _engine.IsPlaying) StopAll();
                e.Handled = true;
                break;

            case Key.S when ctrl:
                _session.Save();
                _sessionDirty = false;
                e.Handled = true;
                break;

            case Key.M when ctrl:
                if (BtnExport.IsEnabled) BtnExport_Click(this, new RoutedEventArgs());
                e.Handled = true;
                break;

            case Key.N when ctrl:
                if (!_engine.IsRecording && !_engine.IsPlaying)
                    BtnNewSession_Click(this, new RoutedEventArgs());
                e.Handled = true;
                break;
        }
    }

    // ---------------- モード ----------------

    private void TabRecord_Click(object sender, RoutedEventArgs e) => SetMode(Mode.Record);

    private void TabOverdub_Click(object sender, RoutedEventArgs e)
    {
        if (_session.Tracks.Count == 0)
        {
            // まだ重ねるものが無い。ここで叱らず、やることを示すだけにする。
            TxtVerdict.Text = "まず1本録ってください。録れたらこのタブが使えるようになります。";
            return;
        }
        SetMode(Mode.Overdub);
    }

    private void SetMode(Mode mode)
    {
        _mode = mode;
        UpdateTabs();
        UpdatePanes();
        if (mode == Mode.Overdub) EnsureLanes();
    }

    /// <summary>
    /// レーンは、並びが変わったときだけ作り直す。
    /// タブを行き来するたびに作り直すと、そのつど全トラックの波形を読み直すことになる。
    /// </summary>
    private void EnsureLanes()
    {
        if (_lanes.Count == _session.Tracks.Count)
        {
            bool same = true;
            for (int i = 0; i < _lanes.Count; i++)
            {
                if (ReferenceEquals(_lanes[i].Track, _session.Tracks[i])) continue;
                same = false;
                break;
            }
            if (same) return;
        }
        RebuildLanes();
    }

    private void UpdateTabs()
    {
        bool rec = _mode == Mode.Record;

        TabRecordText.Foreground = (Brush)FindResource(rec ? "Fg" : "FgFaint");
        TabRecordText.FontWeight = rec ? FontWeights.SemiBold : FontWeights.Medium;
        TabRecordLine.Fill = rec ? (Brush)FindResource("Good") : Brushes.Transparent;

        TabOverdubText.Foreground = (Brush)FindResource(rec ? "FgFaint" : "Fg");
        TabOverdubText.FontWeight = rec ? FontWeights.Medium : FontWeights.SemiBold;
        TabOverdubLine.Fill = rec ? Brushes.Transparent : (Brush)FindResource("Good");

        int n = _session.Tracks.Count;
        TabBadgeText.Text = n == 0 ? "まだ0本" : $"{n}本";
        TabBadge.Background = (Brush)FindResource(n == 0 ? "BtnFace" : "Info");
        TabBadgeText.Foreground = (Brush)FindResource(n == 0 ? "FgFaint" : "Ink");

        BtnCheck.Visibility = rec ? Visibility.Collapsed : Visibility.Visible;
        BtnExport.Visibility = rec ? Visibility.Collapsed : Visibility.Visible;
    }

    private void UpdatePanes()
    {
        bool recording = _engine.IsRecording;

        TabBar.Visibility = recording ? Visibility.Collapsed : Visibility.Visible;
        RecBar.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;

        RecordingPane.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;
        RecordPane.Visibility = !recording && _mode == Mode.Record
            ? Visibility.Visible : Visibility.Collapsed;
        OverdubPane.Visibility = !recording && _mode == Mode.Overdub
            ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>録音中バーとの入れ替えは 120ms のフェードだけ。</summary>
    private static void FadeIn(UIElement element)
    {
        element.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(120)));
    }

    /// <summary>1本目が録れたことに気づいてもらうため、バッジを一度だけ弾ませる。</summary>
    private void PulseBadge()
    {
        var scale = new ScaleTransform(1, 1);
        TabBadge.RenderTransform = scale;
        TabBadge.RenderTransformOrigin = new Point(0.5, 0.5);

        var anim = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromMilliseconds(200) };
        anim.KeyFrames.Add(new LinearDoubleKeyFrame(1.12, KeyTime.FromPercent(0.5)));
        anim.KeyFrames.Add(new LinearDoubleKeyFrame(1.0, KeyTime.FromPercent(1.0)));
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, anim);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, anim);
    }

    // ---------------- セッション ----------------

    private void LoadLatestOrNewSession()
    {
        var latest = Directory.GetDirectories(RootDir)
            .Where(d => File.Exists(System.IO.Path.Combine(d, Session.MetaFileName)))
            .OrderByDescending(Directory.GetLastWriteTime)
            .FirstOrDefault();

        SetSession(latest != null ? Session.Load(latest) : Session.CreateNew(RootDir));
    }

    private void SetSession(Session session)
    {
        _session = session;

        foreach (var t in _session.Tracks) t.PropertyChanged += (_, _) => _sessionDirty = true;
        _session.Tracks.CollectionChanged += (_, args) =>
        {
            foreach (Track t in args.NewItems ?? Array.Empty<object>())
                t.PropertyChanged += (_, _) => _sessionDirty = true;
            _sessionDirty = true;
            UpdateSessionUi();
        };

        WaveformCache.Clear();
        RepairBrokenFiles();
        LoadHallControls();
        UpdateSessionUi();
        RebuildLanes();
    }

    /// <summary>
    /// 前回アプリが落ちていた場合、録音中だった WAV はヘッダが古いまま残る。
    /// 音は書けているので、開くたびに直しておく。
    /// </summary>
    private void RepairBrokenFiles()
    {
        try
        {
            var repaired = WavRepair.RepairFolder(_session.Folder);
            if (repaired.Count == 0) return;

            var lines = repaired.Select(r =>
                $"・{System.IO.Path.GetFileName(r.Path)}  {r.RecoveredSeconds:0.0} 秒を復元");
            MessageBox.Show(this,
                "前回の録音が正常に終わっていませんでした。\n" +
                "ファイルを直しておきました。\n\n" +
                string.Join("\n", lines) + "\n\n" +
                "「録音一覧 → 前の続き」から開き直すと確認できます。",
                "録音ファイルの修復", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch { /* 修復に失敗しても起動は続ける */ }
    }

    private void UpdateSessionUi()
    {
        var len = TimeSpan.FromSeconds(_session.LengthSeconds);
        TxtSession.Text = _session.Tracks.Count == 0
            ? _session.Name
            : $"{_session.Name}　{(int)len.TotalMinutes:00}:{len.Seconds:00}";
        TxtSession.ToolTip = _session.Tracks.Count == 0
            ? $"{_session.Name}（まだ何も録っていません）"
            : $"{_session.Name}　{_session.Tracks.Count} トラック / " +
              $"{_session.SampleRate / 1000.0:0.#} kHz";

        UpdateTabs();
        RefreshRecordTargets();
        UpdateSteps();
        UpdateTransport();
        foreach (var lane in _lanes) lane.SetTotalSeconds(_session.LengthSeconds);
        DrawRuler();
    }

    // ---------------- 録音の名前 ----------------

    private void TxtSession_Click(object sender, MouseButtonEventArgs e)
    {
        EdtSession.Text = _session.Name;
        EdtSession.Visibility = Visibility.Visible;
        TxtSession.Visibility = Visibility.Collapsed;
        EdtSession.Focus();
        EdtSession.SelectAll();
    }

    private void EdtSession_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { CommitSessionName(); e.Handled = true; }
        else if (e.Key == Key.Escape) { CancelSessionName(); e.Handled = true; }
    }

    private void EdtSession_LostFocus(object sender, RoutedEventArgs e) => CommitSessionName();

    private void CommitSessionName()
    {
        if (EdtSession.Visibility != Visibility.Visible) return;

        var name = EdtSession.Text.Trim();
        if (name.Length > 0 && name != _session.Name)
        {
            // 名前だけを変える。フォルダ名は変えない
            // （録音中のファイルを掴んだままフォルダを動かすと、録れた音を失いかねない）
            _session.Name = name;
            _session.Save();
        }
        CancelSessionName();
        UpdateSessionUi();
    }

    private void CancelSessionName()
    {
        EdtSession.Visibility = Visibility.Collapsed;
        TxtSession.Visibility = Visibility.Visible;
    }

    private void BtnNewSession_Click(object sender, RoutedEventArgs e)
    {
        ListPopup.IsOpen = false;
        StopAll();
        _session.Save();
        SetSession(Session.CreateNew(RootDir));
        SetMode(Mode.Record);
    }

    private void BtnOpenSession_Click(object sender, RoutedEventArgs e)
    {
        ListPopup.IsOpen = false;
        StopAll();
        _session.Save();

        // .NET 7 の WPF にはフォルダ選択ダイアログが無いので、セッション情報ファイルを選んでもらう
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "開きたい録音の session.json を選んでください",
            Filter = "録音の情報|session.json",
            InitialDirectory = Directory.Exists(_session.Folder) ? _session.Folder : RootDir,
        };
        if (dlg.ShowDialog(this) != true) return;

        try
        {
            var folder = System.IO.Path.GetDirectoryName(dlg.FileName);
            if (folder == null) return;
            SetSession(Session.Load(folder));
            SetMode(_session.Tracks.Count == 0 ? Mode.Record : Mode.Overdub);
        }
        catch (Exception ex)
        {
            ShowError("開けませんでした: " + ex.Message);
        }
    }

    private void BtnOpenFolder_Click(object sender, RoutedEventArgs e)
    {
        ListPopup.IsOpen = false;
        var folder = Directory.Exists(_session.Folder) ? _session.Folder : RootDir;
        Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true });
    }

    private void BtnList_Click(object sender, RoutedEventArgs e) => ListPopup.IsOpen = !ListPopup.IsOpen;

    private void BtnSessions_Click(object sender, RoutedEventArgs e)
    {
        if (_engine.IsRecording || _engine.IsPlaying)
        {
            ShowError("録音・再生を止めてから開いてください。");
            return;
        }

        StopAll();
        _session.Save();

        var window = new SessionsWindow(RootDir, _session.Folder) { Owner = this };
        window.ShowDialog();

        if (window.NewSessionRequested)
        {
            SetSession(Session.CreateNew(RootDir));
            SetMode(Mode.Record);
            return;
        }
        if (window.ChosenFolder == null || window.ChosenFolder == _session.Folder) return;

        try
        {
            SetSession(Session.Load(window.ChosenFolder));
            SetMode(_session.Tracks.Count == 0 ? Mode.Record : Mode.Overdub);
        }
        catch (Exception ex)
        {
            ShowError("開けませんでした: " + ex.Message);
        }
    }

    // ---------------- 入力（音の入り口） ----------------

    private void ScanAndOpen()
    {
        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            _setup.Rescan(_session.SampleRate, _settings);
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }

        // 起動直後にメーターが動いていないと「音量を合わせる」ができない。
        // 失敗しても止めない（状態ピルに理由が出る）。
        // マイクを他のアプリと取り合いたくない人のために、切ることもできる。
        if (_settings.OpenInputOnStartup) _setup.EnsureOpen(_session.SampleRate);
        UpdateInputStatus();
    }

    /// <summary>選んだ機器・細かさ・ズレ合わせを次の起動のために覚える。</summary>
    private void RememberSettings()
    {
        _settings.Remember(_setup);
        _settings.Save(RootDir);
    }

    private void UpdateInputStatus()
    {
        bool open = _engine.IsOpen;
        StatusDot.Fill = (Brush)FindResource(open ? "Good" : "FgDim");
        TxtStatusLine.Text = open
            ? _setup.StatusLine
            : _setup.Device == null
                ? "音の入り口が見つかりません。「詳しい設定」から探し直してください。"
                : $"{_setup.Device.Name} をまだ使えていません。「詳しい設定」で確かめてください。";

        TxtRecordBig.Text = open ? "録音する" : "マイクを選んでください";
        TxtRecordHint.Visibility = open ? Visibility.Visible : Visibility.Collapsed;

        UpdateAlignPill();
        UpdateMonitorInfo();
        UpdateTransport();
    }

    private void BtnSettings_Click(object sender, RoutedEventArgs e)
    {
        if (_engine.IsRecording || _engine.IsPlaying)
        {
            ShowError("録音・再生を止めてから開いてください。");
            return;
        }

        new SettingsWindow(_setup, _session, RootDir, _settings) { Owner = this }.ShowDialog();
        RememberSettings();

        // 閉じたら、開けるなら開き直す（録る画面は常にメーターが動いている状態にする）
        _setup.EnsureOpen(_session.SampleRate);
        UpdateInputStatus();
    }

    // ---------------- メーターと画面更新 ----------------

    private void UiTimer_Tick(object? sender, EventArgs e)
    {
        UpdateMeters();

        if (_engine.IsRecording)
        {
            SetTime(_engine.RecordedSeconds);
            int dropped = _engine.DroppedBuffers;
            TxtRecSave.Text = $"約2秒ごとに自動保存中・取りこぼし {dropped}";
            TxtRecSave.Foreground = (Brush)FindResource(dropped > 0 ? "Warn" : "RecBarDim");
        }
        else if (_engine.IsPlaying)
        {
            SetTime(_engine.PlaybackSeconds);
            foreach (var lane in _lanes) lane.SetPlayhead(_engine.PlaybackSeconds, true);
            RefreshMiniVerdict();

            // 響きを足していると、最後の音が止まってからも尾が残る。切る前に鳴らしきる
            if (_engine.PlaybackSeconds > _session.PlaybackLengthSeconds + 0.3)
            {
                _engine.StopPlayback();
                foreach (var lane in _lanes) lane.SetPlayhead(0, false);
                RefreshMiniVerdict();
                UpdateTransport();
            }
        }
    }

    private void SetTime(double seconds)
    {
        var t = TimeSpan.FromSeconds(seconds);
        var text = $"{(int)t.TotalHours:00}:{t.Minutes:00}:{t.Seconds:00}.{t.Milliseconds / 100}";
        TxtTime.Text = text;
        TxtBigTime.Text = text;
    }

    private void UpdateMeters()
    {
        UpdateOutputMeter();

        if (!_engine.IsOpen)
        {
            SetLevel(0);
            SetVerdict(Verdict.Unknown);
            return;
        }

        // 目盛りはサンプルの間も含めた True Peak で動かす（サンプル値だけだと「割れていない」と嘘をつく）
        var peaks = _engine.ReadPeaks();
        var truePeaks = _engine.ReadTruePeaks();
        float peak = 0;
        foreach (var p in peaks) peak = Math.Max(peak, p);
        foreach (var p in truePeaks) peak = Math.Max(peak, p);

        var now = DateTime.UtcNow;
        if (peak >= _hold || (now - _holdAt).TotalSeconds > 1.5)
        {
            _hold = peak;
            _holdAt = now;
        }

        if (_engine.IsRecording && peak > _recPeak) _recPeak = peak;

        double db = _hold > 0 ? 20 * Math.Log10(_hold) : double.NegativeInfinity;
        SetLevel(MeterScale.Ratio(db));
        PushLive(peak);

        // 「いま割れているか」を見たいので、読むたびに戻す。
        // 戻さないと一度でも割れた時点で判定が張り付き、つまみを下げても直らない。
        bool clipped = _engine.ReadClipCounts().Any(c => c > 0);
        if (clipped) _engine.ResetClips();
        // 0 dBFS に届かないまま頭が平らになった波＝プリアンプや ADC の手前で歪んでいる
        int flats = _engine.ReadFlatCounts().Sum();
        if (flats > 0) { _engine.ResetFlats(); clipped = true; }
        // ほぼ無音のときに「小さすぎます」と言うと、まだ何も鳴らしていない人を叱ることになる
        var verdict = clipped || db >= -0.5 ? Verdict.Clipping
                    : db > MeterScale.GoodToDb ? Verdict.TooLoud
                    : db >= MeterScale.GoodFromDb ? Verdict.Good
                    : db > -55 ? Verdict.TooQuiet
                    : Verdict.Silent;
        SetVerdict(verdict);

        if (_engine.IsRecording)
        {
            TxtLiveLevel.Text = verdict switch
            {
                Verdict.Good => $"音量は問題ありません（ピーク {db:0.0}）",
                Verdict.TooQuiet => $"少し小さめです（ピーク {db:0.0}）",
                Verdict.TooLoud => $"やや大きめです（ピーク {db:0.0}）",
                Verdict.Clipping => "音が割れています。止めて音量を下げてください。",
                _ => "音がまだ入っていません",
            };
            TxtLiveLevel.Foreground = (Brush)FindResource(verdict switch
            {
                Verdict.Good => "Good",
                Verdict.Clipping => "Rec",
                Verdict.Unknown or Verdict.Silent => "FgDim",
                _ => "Warn",
            });
        }
    }

    /// <summary>
    /// 再生中は、トランスポート帯の目盛りを「入力の大きさ」から
    /// 「実際に出ている音の大きさ」に切り替える。
    /// これが動いていれば、聞こえない原因はアプリの外（機器の音量）だと分かる。
    /// </summary>
    private void UpdateOutputMeter()
    {
        if (!_engine.IsPlaying)
        {
            _outHold = 0;
            _silentSince = DateTime.MinValue;
            return;
        }

        float peak = _engine.ReadOutputPeak();
        var now = DateTime.UtcNow;
        if (peak >= _outHold || (now - _outHoldAt).TotalSeconds > 1.0)
        {
            _outHold = peak;
            _outHoldAt = now;
        }

        double db = _outHold > 0 ? 20 * Math.Log10(_outHold) : double.NegativeInfinity;
        SetMiniLevel(MeterScale.Ratio(db));

        // 出ていない状態が 1.5 秒続いたときだけ「出ていない」と言う（頭出しの無音で騒がない）
        if (db < -70)
        {
            if (_silentSince == DateTime.MinValue) _silentSince = now;
        }
        else
        {
            _silentSince = DateTime.MinValue;
        }
        _outputPeakDb = db;
    }

    private double _outputPeakDb = double.NegativeInfinity;

    private bool OutputLooksSilent =>
        _silentSince != DateTime.MinValue &&
        (DateTime.UtcNow - _silentSince).TotalSeconds > 1.5;

    private void SetLevel(double ratio)
    {
        // 横メーター
        double w = MeterHost.ActualWidth;
        if (w > 1)
        {
            MeterGoodBand.Margin = new Thickness(w * GoodFrom, 0, 0, 0);
            MeterGoodBand.Width = Math.Max(1, w * (GoodTo - GoodFrom));
            MeterLevel.Width = w * ratio;

            // 「ちょうどいい ✓」の文字は帯の真下に置く（真ん中に固定すると別の場所を指してしまう）
            double center = w * (GoodFrom + GoodTo) / 2 - TxtGoodLabel.ActualWidth / 2;
            TxtGoodLabel.Margin = new Thickness(Math.Max(0, center), 0, 0, 0);
        }

        if (!_engine.IsPlaying) SetMiniLevel(ratio);

        // 円形メーター
        _ringLevel.Data = ratio <= 0.001
            ? Geometry.Empty
            : ArcGeometry(RingStart, RingSweep * ratio);
    }

    /// <summary>トランスポート帯の小さな目盛り。入力にも出力にも使う。</summary>
    private void SetMiniLevel(double ratio)
    {
        double mw = MiniMeterHost.ActualWidth;
        if (mw <= 1) return;

        MiniGoodBand.Margin = new Thickness(mw * GoodFrom, 0, 0, 0);
        MiniGoodBand.Width = Math.Max(1, mw * (GoodTo - GoodFrom));
        MiniLevel.Width = mw * ratio;
    }

    /// <summary>判定文は 500ms 落ち着いてから切り替える（チラつき防止）。</summary>
    private void SetVerdict(Verdict verdict)
    {
        if (verdict != _pending)
        {
            _pending = verdict;
            _pendingSince = DateTime.UtcNow;
            return;
        }
        if (verdict == _verdict) return;
        if ((DateTime.UtcNow - _pendingSince).TotalMilliseconds < 500) return;

        _verdict = verdict;
        TxtVerdict.Text = verdict switch
        {
            Verdict.Good => "いい音量です。楽器をいちばん強く鳴らしても金の帯に収まっています。",
            Verdict.TooQuiet => "音が小さすぎます。機材側の入力つまみを上げてください。",
            Verdict.TooLoud => "音が大きすぎて割れます。機材側の入力つまみを下げてください。",
            Verdict.Clipping => "音が大きすぎて割れます。機材側の入力つまみを下げてください。",
            Verdict.Silent => "楽器を鳴らしてみてください。いちばん強く鳴らしたときに金の帯へ入るのが目安です。",
            _ => "マイクを選んでください。",
        };
        TxtVerdict.Foreground = (Brush)FindResource(
            verdict is Verdict.Unknown or Verdict.Silent ? "FgDim" : "Fg");

        RefreshMiniVerdict();
        UpdateSteps();
    }

    /// <summary>
    /// トランスポート帯の一言。鳴らしている間は入力の話をしても仕方がないので、
    /// 「再生中」と、聞こえない原因になりうる Windows 側の音量を出す。
    /// </summary>
    private void RefreshMiniVerdict()
    {
        if (_engine.IsPlaying)
        {
            if (OutputLooksSilent)
            {
                TxtMiniVerdict.Text = "音が出ていません";
                TxtMiniVerdict.Foreground = (Brush)FindResource("Warn");
            }
            else if (_outputNote.Length > 0)
            {
                TxtMiniVerdict.Text = $"音は出ています・{_outputNote}";
                TxtMiniVerdict.Foreground = (Brush)FindResource("Warn");
            }
            else
            {
                TxtMiniVerdict.Text = double.IsNegativeInfinity(_outputPeakDb)
                    ? "再生中"
                    : $"音は出ています（{_outputPeakDb:0.0}）";
                TxtMiniVerdict.Foreground = (Brush)FindResource("Good");
            }
            return;
        }

        TxtMiniVerdict.Text = _verdict switch
        {
            Verdict.Good => "ちょうどいい",
            Verdict.TooQuiet => "小さすぎ",
            Verdict.TooLoud => "大きすぎ",
            Verdict.Clipping => "割れています",
            _ => "",
        };
        TxtMiniVerdict.Foreground = (Brush)FindResource(_verdict switch
        {
            Verdict.Good => "Good",
            Verdict.Clipping => "Rec",
            Verdict.Unknown or Verdict.Silent => "FgDim",
            _ => "Warn",
        });
    }

    // ---------------- 円形メーター ----------------

    private void BuildRing()
    {
        foreach (var (path, key) in new[]
        {
            (_ringTrack, "Line"),
            (_ringGood, "Good"),
            (_ringLevel, "LevelFill"),
        })
        {
            path.StrokeThickness = 13;
            path.StrokeStartLineCap = PenLineCap.Flat;
            path.StrokeEndLineCap = PenLineCap.Flat;
            path.Stroke = (Brush)FindResource(key);
            RingCanvas.Children.Add(path);
        }

        // 「ちょうどいい」帯は固定表示。ここに収めるのが目標だと目で分かるようにする。
        _ringGood.Stroke = new SolidColorBrush(Color.FromArgb(0x99, 0xC9, 0xA2, 0x27));

        _ringTrack.Data = ArcGeometry(RingStart, RingSweep);
        _ringGood.Data = ArcGeometry(RingStart + RingSweep * GoodFrom, RingSweep * (GoodTo - GoodFrom));
    }

    // ---------------- 彫金の飾り ----------------

    /// <summary>
    /// 唐草の地紋と、足の花形を描く。
    ///
    /// どちらも19世紀の版彫り（紙幣・銘板・時計の文字盤）で使われた、旋盤で引く連続曲線。
    /// 図像だけで時代を出したいので、文字や紋章には頼らない。
    /// </summary>
    private void BuildOrnaments()
    {
        DrawGuilloche();
        DrawRosette();
    }

    private void Scale_SizeChanged(object sender, SizeChangedEventArgs e) => DrawScale();

    /// <summary>
    /// 目盛りを彫る。
    ///
    /// 「−12〜−6 に入れる」と文字で言われても、初めての人にはどこを狙うのか分からない。
    /// 計器と同じように、数字の付いた刻みを目盛りの下に並べて、狙う場所を目で示す。
    /// </summary>
    private void DrawScale()
    {
        ScaleCanvas.Children.Clear();
        double w = ScaleCanvas.ActualWidth;
        if (w < 20) return;

        var faint = (Brush)FindResource("FgFaint");
        var gold = (Brush)FindResource("Good");

        foreach (var db in new[] { -60.0, -40, -30, -18, -8, 0 })
        {
            bool target = db == MeterScale.GoodFromDb || db == MeterScale.GoodToDb;
            double x = w * MeterScale.Ratio(db);

            ScaleCanvas.Children.Add(new Line
            {
                X1 = x,
                X2 = x,
                Y1 = 0,
                Y2 = target ? 7 : 4,
                Stroke = target ? gold : faint,
                StrokeThickness = target ? 1.5 : 1,
            });

            var label = new TextBlock
            {
                Text = $"{db:0}",
                FontFamily = new FontFamily("Consolas"),
                FontSize = 10,
                FontWeight = target ? FontWeights.Bold : FontWeights.Normal,
                Foreground = target ? gold : faint,
            };
            label.Measure(new Size(100, 100));
            Canvas.SetLeft(label, Math.Clamp(x - label.DesiredSize.Width / 2,
                                             0, Math.Max(0, w - label.DesiredSize.Width)));
            Canvas.SetTop(label, 7);
            ScaleCanvas.Children.Add(label);
        }
    }

    /// <summary>
    /// いま何をする番かを1つだけ光らせる。
    /// 順に見ていけば録れる、という道筋を画面に置いておく。
    /// </summary>
    private void UpdateSteps()
    {
        // まだ1本も録っていない人にだけ出す。慣れた人の邪魔をしない。
        bool show = _session.Tracks.Count == 0;
        PnlSteps.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (!show) return;

        int active = !_engine.IsOpen ? 1 : _verdict == Verdict.Good ? 3 : 2;

        SetStep(Step1, Step1No, Step1Text, active == 1, active > 1);
        SetStep(Step2, Step2No, Step2Text, active == 2, active > 2);
        SetStep(Step3, Step3No, Step3Text, active == 3, false);
    }

    private void SetStep(Border plate, TextBlock number, TextBlock text, bool active, bool done)
    {
        plate.BorderBrush = (Brush)FindResource(active ? "Good" : "Line");
        plate.BorderThickness = new Thickness(active ? 2 : 1);
        number.Foreground = (Brush)FindResource(active ? "Good" : done ? "FgDim" : "FgFaint");
        text.Foreground = (Brush)FindResource(active ? "Fg" : done ? "FgDim" : "FgFaint");
        text.FontWeight = active ? FontWeights.Bold : FontWeights.Normal;
    }

    private void DrawGuilloche()
    {
        const double cx = 260, cy = 260;
        var brush = new SolidColorBrush(Color.FromRgb(0xC9, 0xA2, 0x27));

        // 半径のわずかに違う輪を重ねると、彫金の唐草のような編み目になる
        for (int ring = 0; ring < 5; ring++)
        {
            double baseR = 150 + ring * 22;
            double petal = 26 + ring * 3;
            int lobes = 11 + ring;

            var geometry = new StreamGeometry();
            using (var ctx = geometry.Open())
            {
                bool started = false;
                for (int i = 0; i <= 720; i++)
                {
                    double t = i * Math.PI / 360;
                    double r = baseR + petal * Math.Cos(lobes * t);
                    var p = new Point(cx + r * Math.Cos(t), cy + r * Math.Sin(t));
                    if (!started) { ctx.BeginFigure(p, false, true); started = true; }
                    else ctx.LineTo(p, true, true);
                }
            }
            geometry.Freeze();

            GuillocheCanvas.Children.Add(new Path
            {
                Data = geometry,
                Stroke = brush,
                StrokeThickness = 0.6,
                Opacity = 0.085 - ring * 0.012,
            });
        }
    }

    private void DrawRosette()
    {
        const double c = 11;
        var gold = new SolidColorBrush(Color.FromRgb(0xC9, 0xA2, 0x27));

        // 8枚の花弁を放射に置く
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            for (int k = 0; k < 8; k++)
            {
                double a = k * Math.PI / 4;
                ctx.BeginFigure(new Point(c, c), false, false);
                ctx.LineTo(new Point(c + 8 * Math.Cos(a), c + 8 * Math.Sin(a)), true, false);
            }
        }
        geometry.Freeze();

        RosetteCanvas.Children.Add(new Path
        {
            Data = geometry,
            Stroke = gold,
            StrokeThickness = 1,
            Opacity = 0.75,
        });
        RosetteCanvas.Children.Add(new System.Windows.Shapes.Ellipse
        {
            Width = 6,
            Height = 6,
            Fill = gold,
            Margin = new Thickness(c - 3, c - 3, 0, 0),
        });
    }

    private static Geometry ArcGeometry(double startDeg, double sweepDeg)
    {
        if (sweepDeg <= 0.05) return Geometry.Empty;
        sweepDeg = Math.Min(sweepDeg, 359.9);

        const double cx = 145, cy = 145;
        const double r = (290 - 13) / 2.0;

        var figure = new PathFigure
        {
            StartPoint = OnCircle(cx, cy, r, startDeg),
            IsClosed = false,
            IsFilled = false,
        };
        figure.Segments.Add(new ArcSegment(
            OnCircle(cx, cy, r, startDeg + sweepDeg), new Size(r, r), 0,
            sweepDeg > 180, SweepDirection.Clockwise, true));

        var geometry = new PathGeometry();
        geometry.Figures.Add(figure);
        geometry.Freeze();
        return geometry;
    }

    /// <summary>角度は画面座標（右が 0°、時計回り）。135°から 270°まわすと下が開く。</summary>
    private static Point OnCircle(double cx, double cy, double r, double degrees)
    {
        double t = degrees * Math.PI / 180;
        return new Point(cx + r * Math.Cos(t), cy + r * Math.Sin(t));
    }

    // ---------------- 録音中の走る波形 ----------------

    private void BuildLiveWave()
    {
        _livePath.Stroke = new SolidColorBrush(Color.FromRgb(0xA0, 0x3A, 0x2E)) { Opacity = 0.9 };
        _livePath.StrokeThickness = 2;
        LiveWave.Children.Add(_livePath);

        var head = new Line
        {
            Stroke = Brushes.White,
            StrokeThickness = 2,
            Y1 = 0,
            Y2 = 56,
        };
        LiveWave.Children.Add(head);
        LiveWave.SizeChanged += (_, _) =>
        {
            head.X1 = head.X2 = LiveWave.ActualWidth - 1;
            head.Y2 = LiveWave.ActualHeight;
            DrawLiveWave();
        };
    }

    private void PushLive(float peak)
    {
        if (!_engine.IsRecording)
        {
            if (_live.Count > 0) { _live.Clear(); DrawLiveWave(); }
            return;
        }

        _live.Add(peak);
        if (_live.Count > LiveCapacity) _live.RemoveRange(0, _live.Count - LiveCapacity);
        DrawLiveWave();
    }

    private void DrawLiveWave()
    {
        double w = LiveWave.ActualWidth, h = LiveWave.ActualHeight;
        if (w < 2 || h < 2 || _live.Count < 2)
        {
            _livePath.Data = null;
            return;
        }

        double mid = h / 2;
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            // 直近ぶんを右詰めで描く。左へ流れていくので「録れている」が動きで分かる。
            for (int i = 0; i < _live.Count; i++)
            {
                double x = w - (_live.Count - i) * (w / LiveCapacity);
                if (x < 0) continue;
                double half = Math.Clamp(_live[i], 0, 1) * mid * 0.95;
                if (half < 0.5) half = 0.5;
                ctx.BeginFigure(new Point(x, mid - half), false, false);
                ctx.LineTo(new Point(x, mid + half), true, false);
            }
        }
        geometry.Freeze();
        _livePath.Data = geometry;
    }

    // ---------------- トランスポート ----------------

    private void UpdateTransport()
    {
        bool busy = _engine.IsRecording || _engine.IsPlaying;
        bool open = _engine.IsOpen;

        BtnRecordBig.IsEnabled = open && !busy;
        BtnRecordSmall.IsEnabled = open && !busy;
        BtnAddLayer.IsEnabled = open && !busy;
        BtnPlay.IsEnabled = !busy && _session.Tracks.Count > 0 && open;
        BtnStop.IsEnabled = busy;
        BtnExport.IsEnabled = !busy && _session.Tracks.Count > 0;
        BtnList.IsEnabled = !busy;
        BtnSettings.IsEnabled = !busy;
        CmbRecordTarget.IsEnabled = !busy;
        BtnAlign.IsEnabled = !busy;
        BtnEditTrack.IsEnabled = !busy;
        BtnRemoveTrack.IsEnabled = !busy;

        foreach (var lane in _lanes) lane.SetBusy(busy);
    }

    private void BtnRecord_Click(object sender, RoutedEventArgs e) => StartRecording(null);

    private void StartRecording(Track? forceTarget)
    {
        if (_engine.IsRecording || _engine.IsPlaying) return;

        var error = _setup.EnsureOpen(_session.SampleRate);
        if (error != null)
        {
            ShowError(error);
            return;
        }

        if (_session.SampleRate > 0 && _session.SampleRate != _engine.SampleRate)
        {
            ShowError($"この録音は {_session.SampleRate / 1000.0:0.#} kHz で始まっています。\n" +
                      $"いまの入り口は {_engine.SampleRate / 1000.0:0.#} kHz です。揃えてください。");
            return;
        }

        var target = forceTarget ?? SelectedRecordTarget();
        var save = _setup.SaveFormat;
        var path = _session.NextRecordingPath(save, target);

        try
        {
            bool overdub = _engine.StartOverdub(_session, path, save, _setup.LatencyFrames, target);

            TxtRecTarget.Text = target != null
                ? $"「{target.Name}」に録り足しています"
                : overdub
                    ? $"新しいトラック（{_session.Tracks.Count + 1}本目）に録っています"
                    : "1本目を録っています";

            _live.Clear();
            _recPeak = 0;
            HideNotice();
            ShowAlignToast(overdub);
            UpdatePanes();
            FadeIn(RecBar);
            FadeIn(RecordingPane);
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
        finally
        {
            UpdateTransport();
        }
    }

    /// <summary>
    /// ズレ合わせ未測定のまま重ね録りを始めたときの一度きりの注意。
    /// 止めはしない（測らなくても録れることに変わりはない）。
    /// </summary>
    private void ShowAlignToast(bool overdub)
    {
        bool show = overdub && !_setup.LatencyMeasured && !_alignToastShown;
        AlignToast.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (show) _alignToastShown = true;
    }

    private void BtnPlay_Click(object sender, RoutedEventArgs e)
    {
        var error = _setup.EnsureOpen(_session.SampleRate);
        if (error != null)
        {
            ShowError(error);
            return;
        }

        try
        {
            if (!_engine.StartPlayback(_session))
            {
                ShowError("鳴らせるトラックがありません。");
                return;
            }
            WarnIfOutputQuiet();
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
        finally
        {
            UpdateTransport();
        }
    }

    /// <summary>
    /// 鳴らす機器が消音・小音量なら、最初の1回だけ知らせる。
    /// 「再生しても聞こえない」の原因がアプリの外にあることは多いので、黙っていない。
    /// </summary>
    private void WarnIfOutputQuiet()
    {
        var status = _setup.ReadOutputStatus();

        // 機器を名指しで固定していて、それが Windows のいまの機器と違うなら、
        // 「他のアプリでは鳴るのにここだけ鳴らない」が起きる。真っ先に知らせる。
        if (status != null && !status.IsSystemDefault && _setup.OutputExplicit)
        {
            var now = _setup.SystemDefaultOutput();
            ShowNotice(
                $"音は「{status.Name}」へ出しています。" +
                (now != null ? $"Windows がいま使っているのは「{now.Name}」です。" : ""),
                warn: true, "いま使っている機器へ", SwitchToSystemOutput);
        }

        _outputNote = status == null || !status.TooQuiet
            ? ""
            : status.Muted ? "鳴らす機器が消音です" : $"機器の音量 {status.Percent}%";
        RefreshMiniVerdict();

        if (_outputWarningShown) return;
        if (status == null || !status.TooQuiet) return;
        _outputWarningShown = true;

        var body = status.Muted
            ? $"「{status.Name}」が消音になっています。\n\nこのままでは何も聞こえません。"
            : $"「{status.Name}」の音量が {status.Percent}% まで下がっています。\n\n" +
              "小さく録れた音だと、ほとんど聞こえないことがあります。";

        MessageBox.Show(this,
            body + "\n\nWindows 側の音量を上げてから、もう一度聞いてみてください。",
            "音が聞こえないときは", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void BtnStop_Click(object sender, RoutedEventArgs e) => StopAll();

    private void StopAll()
    {
        bool wasRecording = _engine.IsRecording;
        var punch = _punch;
        var target = wasRecording && punch == null ? SelectedRecordTarget() : null;

        var files = _engine.StopRecording();
        _engine.StopPlayback();
        _punch = null;

        foreach (var lane in _lanes) lane.SetPlayhead(0, false);

        if (wasRecording)
        {
            AlignToast.Visibility = Visibility.Collapsed;
            UpdatePanes();
            if (punch != null) FinishPunch(punch.Value, files);
            else if (files.Count > 0) AddRecordedTake(files, target);
        }

        RefreshMiniVerdict();
        UpdateTransport();
    }

    private void AddRecordedTake(IReadOnlyList<string> files, Track? target)
    {
        Take take;
        try
        {
            take = Take.FromFiles(
                target != null ? $"{target.Takes.Count + 1}回目の録り" : "1回目の録り",
                files);
        }
        catch (Exception ex)
        {
            ShowError("録音ファイルを読めませんでした: " + ex.Message);
            return;
        }

        if (take.Seconds <= 0.01)
        {
            // 中身が無いテイクはセッションに入れず、ファイルも残さない
            foreach (var f in files)
            {
                try { File.Delete(f); } catch { /* 消せなくても致命的ではない */ }
            }
            return;
        }

        if (_session.SampleRate <= 0) _session.SampleRate = take.SampleRate;

        bool wasEmpty = _session.Tracks.Count == 0;
        string name = target?.Name ?? _session.NextTrackName();

        if (target != null)
        {
            target.AddTake(take);
        }
        else
        {
            var track = new Track { Name = _session.NextTrackName() };
            track.AddTake(take);
            _session.Tracks.Add(track);
        }

        _session.Save();
        UpdateSessionUi();
        RebuildLanes();
        NoticeAfterTake(name);

        // タブは勝手に切り替えない。バッジだけ光らせて次の行き先を示す。
        if (wasEmpty) PulseBadge();
    }

    // ---------------- 録る場所 ----------------

    private Track? SelectedRecordTarget() =>
        (CmbRecordTarget.SelectedItem as RecordTargetItem)?.Track;

    private sealed record RecordTargetItem(Track? Track)
    {
        public override string ToString() => Track == null
            ? "新しいトラックに録る"
            : $"{Track.Name} に録り足す";
    }

    private void RefreshRecordTargets()
    {
        var previous = SelectedRecordTarget();
        var items = new List<RecordTargetItem> { new(null) };
        items.AddRange(_session.Tracks.Select(t => new RecordTargetItem(t)));

        CmbRecordTarget.ItemsSource = items;
        int index = previous == null ? 0 : items.FindIndex(i => i.Track == previous);
        CmbRecordTarget.SelectedIndex = index >= 0 ? index : 0;
    }

    // ---------------- ズレ合わせ ----------------

    private void UpdateAlignPill()
    {
        bool measured = _setup.LatencyMeasured && _setup.LatencyFrames > 0;
        BtnAlign.Content = measured ? "ズレ合わせ 済" : "ズレ合わせ 未測定";
        BtnAlign.Foreground = (Brush)FindResource(measured ? "Good" : "Warn");
        BtnAlign.Background = new SolidColorBrush(measured
            ? Color.FromArgb(0x26, 0xC9, 0xA2, 0x27)
            : Color.FromArgb(0x22, 0xB0, 0x6A, 0x2C));
        BtnAlign.BorderBrush = new SolidColorBrush(measured
            ? Color.FromArgb(0x88, 0xC9, 0xA2, 0x27)
            : Color.FromArgb(0x77, 0xB0, 0x6A, 0x2C));
        BtnAlign.ToolTip = measured
            ? $"往復 {_setup.LatencyMs:0} ms ぶん詰めて録ります。押すと測り直します。"
            : "押すと、重ね録りのズレを測ります。";
    }

    private async void BtnAlign_Click(object sender, RoutedEventArgs e)
    {
        await LatencyMeasure.RunAsync(this, _setup, _session.SampleRate);
        UpdateAlignPill();
    }

    private async void AlignToastMeasure_Click(object sender, RoutedEventArgs e)
    {
        AlignToast.Visibility = Visibility.Collapsed;
        if (_engine.IsRecording) StopAll();
        await LatencyMeasure.RunAsync(this, _setup, _session.SampleRate);
        UpdateAlignPill();
    }

    // ---------------- モニター ----------------

    private void BtnMonitor_Click(object sender, RoutedEventArgs e)
    {
        if (!_engine.IsOpen)
        {
            var error = _setup.EnsureOpen(_session.SampleRate);
            if (error != null) { ShowError(error); return; }
        }

        if (!_engine.MonitorEnabled && !_monitorWarningShown)
        {
            _monitorWarningShown = true;
            var answer = MessageBox.Show(this,
                "自分の音をヘッドホンに返します。\n\n" +
                "⚠ 必ずヘッドホンを使ってください。\n" +
                "スピーカーだとマイク→スピーカー→マイクの輪ができて、\n" +
                "ピーという大きな音（ハウリング）になります。\n\n" +
                "続けますか？",
                "自分の音を聞く", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (answer != MessageBoxResult.OK) return;
        }

        _engine.MonitorEnabled = !_engine.MonitorEnabled;
        UpdateMonitorInfo();
    }

    private void UpdateMonitorInfo()
    {
        bool on = _engine.IsOpen && _engine.MonitorEnabled;
        BtnMonitor.Content = on ? "自分の音を聞くのをやめる" : "ヘッドホンで自分の音を聞く";

        if (!_engine.IsOpen)
        {
            TxtMonitorInfo.Text = "";
            return;
        }
        if (!on)
        {
            TxtMonitorInfo.Text = _engine.UsesSharedClock
                ? "ASIO なので遅れは小さいはずです。"
                : "この方式では音が遅れて返るので、弾きながら聞くには向きません。";
            return;
        }

        double ms = _setup.LatencyMs;
        var under = _engine.MonitorUnderruns > 0
            ? $"　⚠ 途切れ {_engine.MonitorUnderruns} 回"
            : "";
        TxtMonitorInfo.Text = ms > 0
            ? $"聞こえるまでの遅れはおよそ {ms:0} ms（実測）{under}"
            : $"遅れはまだ測っていません{under}";
    }

    // ---------------- レーン（重ねるモード） ----------------

    private void RebuildLanes()
    {
        foreach (var lane in _lanes)
        {
            lane.SelectionChanged -= Lane_SelectionChanged;
            lane.PunchRequested -= Lane_PunchRequested;
            lane.CropRequested -= Lane_CropRequested;
            lane.Edited -= Lane_Edited;
            lane.Unhook();
        }
        _lanes.Clear();
        LaneHost.Children.Clear();
        _selected = null;

        for (int i = 0; i < _session.Tracks.Count; i++)
        {
            var lane = new TrackLane(_session.Tracks[i], i);
            lane.SelectionChanged += Lane_SelectionChanged;
            lane.PunchRequested += Lane_PunchRequested;
            lane.CropRequested += Lane_CropRequested;
            lane.Edited += Lane_Edited;
            lane.SetTotalSeconds(_session.LengthSeconds);
            lane.ReloadWaveform();
            _lanes.Add(lane);
            LaneHost.Children.Add(lane);
        }

        UpdateInspector();
        UpdateTransport();
        DrawRuler();
    }

    private void Lane_Edited()
    {
        _session.Save();
        _sessionDirty = false;
        UpdateSessionUi();
    }

    private void Lane_SelectionChanged(TrackLane lane)
    {
        foreach (var other in _lanes)
            if (!ReferenceEquals(other, lane)) other.ClearSelection();

        _selected = lane;
        UpdateInspector();
    }

    private void UpdateInspector()
    {
        if (_selected == null)
        {
            PnlInspector.Visibility = Visibility.Collapsed;
            TxtNoSelection.Visibility = Visibility.Visible;
            return;
        }

        PnlInspector.Visibility = Visibility.Visible;
        TxtNoSelection.Visibility = Visibility.Collapsed;

        var track = _selected.Track;
        if (_selected.HasSelection(out double s, out double e))
        {
            TxtSelTitle.Text = $"{track.Name} の {Mmss(s)}〜{Mmss(e)}";
            TxtSelBody.Text =
                "波形をドラッグして「使いたいところ」を選びます。元の録音は書き換えません。" +
                "結果は新しい録りとして増えます。\n\n" +
                "「ここだけ録り直す」を押すと、2秒の助走のあと選んだところだけ録り直します。" +
                "継ぎ目は自動でなめらかにつながり、前の音は別の録りとして残ります。";
        }
        else
        {
            TxtSelTitle.Text = track.Name;
            TxtSelBody.Text = $"{track.Info}　録り {track.Takes.Count} 本。\n\n" +
                              "波形をドラッグすると、そこだけ録り直したり切り出したりできます。";
        }

        TxtSelBody.Text += "\n\n波形は、小さい音も見えるように音の大きさ（dB）の目盛りで" +
                           "描いています。音そのものは変わりません。";

        TglHum.IsChecked = track.Processing.HumEnabled;
        TglGate.IsChecked = track.Processing.GateEnabled;
    }

    private static string Mmss(double seconds)
    {
        var t = TimeSpan.FromSeconds(seconds);
        return t.TotalHours >= 1
            ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}"
            : $"{(int)t.TotalMinutes}:{t.Seconds:00}";
    }

    private void Processing_Changed(object sender, RoutedEventArgs e)
    {
        if (_selected == null) return;
        var p = _selected.Track.Processing;
        p.HumEnabled = TglHum.IsChecked == true;
        p.GateEnabled = TglGate.IsChecked == true;
        _session.Save();
    }

    // ---------------- 鳴らす場所（ホールの響き） ----------------

    /// <summary>
    /// つまみを画面に反映している間は、その変化を設定に書き戻さない。
    /// 画面を組み立てている最中にも立てておく。スライダーは Minimum を設定した時点で
    /// 値が丸められて ValueChanged が飛ぶが、そのときはまだ下の行の部品が存在しない。
    /// </summary>
    private bool _hallLoading = true;

    /// <summary>セッションを開いたときに、そのセッションの響きの設定を画面に載せる。</summary>
    private void LoadHallControls()
    {
        _hallLoading = true;
        try
        {
            if (CmbHall.Items.Count == 0)
            {
                foreach (HallKind kind in Enum.GetValues<HallKind>())
                    CmbHall.Items.Add(HallReverb.DisplayName(kind));
            }

            var h = _session.Hall;
            TglHall.IsChecked = h.Enabled;
            CmbHall.SelectedIndex = (int)h.Kind;
            SldHallDecay.Value = h.EffectiveDecaySeconds;
            SldHallMix.Value = h.MixPercent;
            SldHallPre.Value = h.PreDelayMs;
        }
        finally { _hallLoading = false; }

        UpdateHallUi();
    }

    private void Hall_Changed(object sender, RoutedEventArgs e) => ApplyHall();

    private void Hall_Changed(object sender, SelectionChangedEventArgs e) => ApplyHall();

    private void HallSlider_Changed(object sender, RoutedPropertyChangedEventArgs<double> e) => ApplyHall();

    private void ApplyHall()
    {
        if (_hallLoading) return;

        var h = _session.Hall;
        var kind = (HallKind)Math.Max(0, CmbHall.SelectedIndex);

        // ホールを選び直したら、響きの長さもそのホールの既定に戻す。
        // 大ホールで 3.4 秒にしたまま小さな部屋に移ると、部屋の寸法と響きが噛み合わなくなるため
        bool kindChanged = kind != h.Kind;

        h.Enabled = TglHall.IsChecked == true;
        h.Kind = kind;
        h.MixPercent = SldHallMix.Value;
        h.PreDelayMs = SldHallPre.Value;

        if (kindChanged)
        {
            h.DecaySeconds = 0;   // 既定に戻す
            _hallLoading = true;
            SldHallDecay.Value = h.EffectiveDecaySeconds;
            _hallLoading = false;
        }
        else
        {
            h.DecaySeconds = SldHallDecay.Value;
        }

        if (h.Kind == HallKind.Custom && string.IsNullOrEmpty(h.ImpulsePath) && kindChanged)
            PickImpulseFile();

        _session.Save();
        UpdateHallUi();
        UpdateSessionUi();
    }

    private void UpdateHallUi()
    {
        var h = _session.Hall;
        bool custom = h.Kind == HallKind.Custom;

        PnlHall.IsEnabled = h.Enabled;
        PnlHallDecay.Visibility = custom ? Visibility.Collapsed : Visibility.Visible;
        BtnHallFile.Visibility = custom ? Visibility.Visible : Visibility.Collapsed;
        BtnHallFile.Content = custom && !string.IsNullOrEmpty(h.ImpulsePath)
            ? System.IO.Path.GetFileName(h.ImpulsePath)
            : "響きのファイルを選ぶ";

        TxtHallDecay.Text = $"{h.EffectiveDecaySeconds:0.0} 秒";
        TxtHallMix.Text = $"{h.MixPercent:0} %";
        TxtHallPre.Text = $"{h.PreDelayMs:0} ms";

        if (!h.Enabled)
        {
            TxtHallNote.Text = "録った音そのものは変わりません。切ればすぐ元に戻ります。";
        }
        else if (!h.IsUsable)
        {
            TxtHallNote.Text = "響きのもとになるファイルが見つかりません。選び直してください。";
        }
        else
        {
            TxtHallNote.Text = $"{h.Summary}\n" +
                               $"書き出しは響きの尾のぶん約 {h.EstimatedTailSeconds:0.0} 秒長くなります。\n" +
                               "録った音そのものは変わりません。切ればすぐ元に戻ります。";
        }
    }

    private void BtnHallFile_Click(object sender, RoutedEventArgs e) => PickImpulseFile();

    /// <summary>実在のホールを録ったインパルス応答の WAV を選ぶ。</summary>
    private void PickImpulseFile()
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "響きのもと（インパルス応答）を選ぶ",
            Filter = "音のファイル|*.wav;*.aiff;*.aif;*.flac;*.mp3|すべてのファイル|*.*",
        };
        if (dlg.ShowDialog(this) != true) return;

        _session.Hall.ImpulsePath = dlg.FileName;
        _session.Save();
        UpdateHallUi();
        UpdateSessionUi();
    }

    private void BtnEditTrack_Click(object sender, RoutedEventArgs e)
    {
        if (_selected == null) return;
        if (_engine.IsRecording || _engine.IsPlaying)
        {
            ShowError("録音・再生を止めてから開いてください。");
            return;
        }

        var editor = new EditorWindow(_session, _selected.Track, _engine,
                                      () => _setup.LatencyFrames, () => _setup.SaveFormat)
        {
            Owner = this,
        };
        editor.ShowDialog();

        if (editor.Changed)
        {
            _session.Save();
            UpdateSessionUi();
            RebuildLanes();
        }
        UpdateTransport();
    }

    private void BtnRemoveTrack_Click(object sender, RoutedEventArgs e)
    {
        if (_selected == null) return;
        var track = _selected.Track;

        int fileCount = track.Takes.Sum(t => t.Files.Count);
        var answer = MessageBox.Show(this,
            $"「{track.Name}」をこの録音から外します（録り {track.Takes.Count} 本）。\n" +
            $"音のファイル {fileCount} 個はフォルダに残ります。",
            "トラックを外す", MessageBoxButton.OKCancel, MessageBoxImage.Question);
        if (answer != MessageBoxResult.OK) return;

        int index = _session.Tracks.IndexOf(track);
        int rate = _session.SampleRate;

        _session.Tracks.Remove(track);
        if (_session.Tracks.Count == 0) _session.SampleRate = 0;
        _session.Save();
        UpdateSessionUi();
        RebuildLanes();
        if (_session.Tracks.Count == 0) SetMode(Mode.Record);

        _removed = (track, index);
        ShowNotice($"「{track.Name}」を外しました。音のファイルはフォルダに残っています。",
                   warn: false, "元に戻す", () => UndoRemove(rate));
    }

    private void UndoRemove(int sampleRate)
    {
        if (_removed == null) return;

        var (track, index) = _removed.Value;
        _removed = null;

        _session.Tracks.Insert(Math.Clamp(index, 0, _session.Tracks.Count), track);
        if (_session.SampleRate <= 0) _session.SampleRate = sampleRate;
        _session.Save();

        UpdateSessionUi();
        RebuildLanes();
        SetMode(Mode.Overdub);
        ShowNotice($"「{track.Name}」を戻しました。", warn: false);
    }

    // ---------------- 切り出し・部分録り直し ----------------

    private void Lane_CropRequested(TrackLane lane)
    {
        if (!lane.HasSelection(out double s, out double e)) return;
        var take = lane.Track.ActiveTake;
        if (take == null) return;

        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            var save = _setup.SaveFormat;
            var path = _session.NextRecordingPath(save, lane.Track);
            var cropped = AudioEdit.Crop(take, s, e, path, save,
                                         $"{lane.Track.Takes.Count + 1}回目の録り（切り出し）");
            lane.Track.AddTake(cropped);
            _session.Save();

            lane.ClearSelection();
            lane.RefreshTakes();
            lane.ReloadWaveform();
            UpdateSessionUi();
            UpdateInspector();
        }
        catch (Exception ex)
        {
            ShowError("切り出せませんでした: " + ex.Message);
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }
    }

    private void Lane_PunchRequested(TrackLane lane)
    {
        if (!lane.HasSelection(out double s, out _)) return;
        if (lane.Track.ActiveTake == null) return;

        var error = _setup.EnsureOpen(_session.SampleRate);
        if (error != null)
        {
            ShowError(error);
            return;
        }

        int latency = _setup.LatencyFrames;
        var message =
            $"{Mmss(s)} から録り直します。\n\n" +
            $"・{PrerollSeconds:0} 秒の助走のあと、録音に入ります\n" +
            "・どこまで録り直すかは、止めるまでの時間で決まります\n" +
            "・このトラックは録音中は鳴りません（前の音が二重に聴こえないため）\n" +
            "・継ぎ目は自動でなめらかにつなぎます\n\n" +
            (latency > 0
                ? $"ズレ合わせ: {latency} サンプル"
                : "⚠ ズレ合わせを測っていません。ズレたまま繋がる可能性があります。") +
            "\n\n始めますか？";

        if (MessageBox.Show(this, message, "ここだけ録り直す",
                MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK)
            return;

        try
        {
            var save = _setup.SaveFormat;
            var path = _session.NextRecordingPath(save, lane.Track);

            // 助走ぶんとズレ合わせぶんを捨てれば、録音の先頭が録り直し開始位置になる
            int rate = _engine.SampleRate;
            int trim = latency + (int)(PrerollSeconds * rate);
            double playFrom = Math.Max(0, s - PrerollSeconds);
            // 曲の頭が助走に足りない場合、その分だけ捨てる量を減らす
            trim -= (int)((PrerollSeconds - (s - playFrom)) * rate);

            _punch = (lane, s);
            _recPeak = 0;
            HideNotice();
            _engine.StartOverdub(_session, path, save, Math.Max(0, trim), lane.Track, playFrom);

            TxtRecTarget.Text = $"「{lane.Track.Name}」の {Mmss(s)} から録り直しています";
            _live.Clear();
            UpdatePanes();
            FadeIn(RecBar);
            FadeIn(RecordingPane);
        }
        catch (Exception ex)
        {
            _punch = null;
            ShowError(ex.Message);
        }
        finally
        {
            UpdateTransport();
        }
    }

    private void FinishPunch((TrackLane Lane, double At) punch, IReadOnlyList<string> files)
    {
        var take = punch.Lane.Track.ActiveTake;
        if (take == null || files.Count == 0)
        {
            foreach (var f in files)
            {
                try { File.Delete(f); } catch { /* 消せなくても致命的ではない */ }
            }
            return;
        }

        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            var save = _setup.SaveFormat;
            var outPath = _session.NextRecordingPath(save, punch.Lane.Track);
            var punched = AudioEdit.PunchIn(take, files, punch.At, outPath, save,
                                            $"{punch.Lane.Track.Takes.Count + 1}回目の録り（録り直し）");

            punch.Lane.Track.AddTake(punched);
            _session.Save();

            punch.Lane.ClearSelection();
            punch.Lane.RefreshTakes();
            punch.Lane.ReloadWaveform();
            UpdateSessionUi();
            UpdateInspector();
        }
        catch (Exception ex)
        {
            ShowError("差し替えられませんでした: " + ex.Message +
                      "\n\n録り直した音はフォルダに残っています。");
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }
    }

    // ---------------- 時間ルーラー ----------------

    private void Ruler_SizeChanged(object sender, SizeChangedEventArgs e) => DrawRuler();

    private void DrawRuler()
    {
        RulerCanvas.Children.Clear();
        double w = RulerCanvas.ActualWidth;
        double total = _session.LengthSeconds;
        if (w < 20 || total <= 0) return;

        // 目盛りが 70px 以上あくものを選ぶ
        double[] steps = { 1, 2, 5, 10, 15, 30, 60, 120, 300, 600 };
        double step = steps[^1];
        foreach (var s in steps)
        {
            if (s / total * w >= 70) { step = s; break; }
        }

        for (double t = 0; t <= total; t += step)
        {
            double x = t / total * w;
            if (x > w - 20) break;

            var label = new TextBlock
            {
                Text = Mmss(t),
                FontFamily = new FontFamily("Consolas"),
                FontSize = 10.5,
                Foreground = (Brush)FindResource("FgFaint"),
            };
            Canvas.SetLeft(label, x + 2);
            Canvas.SetTop(label, 5);
            RulerCanvas.Children.Add(label);
        }
    }

    // ---------------- 診断・書き出し ----------------

    private void BtnDiagnostics_Click(object sender, RoutedEventArgs e)
    {
        if (_engine.IsRecording || _engine.IsPlaying)
        {
            ShowError("録音・再生を止めてから開いてください。");
            return;
        }

        var error = _setup.EnsureOpen(_session.SampleRate);
        if (error != null) ShowError(error);

        new DiagnosticsWindow(_engine, _session) { Owner = this }.ShowDialog();
    }

    private void BtnExport_Click(object sender, RoutedEventArgs e)
    {
        if (_session.Tracks.Count == 0)
        {
            ShowError("まだ書き出すものがありません。");
            return;
        }
        if (_engine.IsRecording || _engine.IsPlaying)
        {
            ShowError("録音・再生を止めてから書き出してください。");
            return;
        }

        new ExportWindow(_session, _setup.SaveFormat) { Owner = this }.ShowDialog();
    }

    // ---------------- 報せの帯 ----------------

    /// <summary>
    /// 画面の上に短く出す一言。叱るためではなく、次にやることを示すために出す。
    /// <paramref name="action"/> を渡すと、その場で1つだけ操作を足せる（取り消しなど）。
    /// </summary>
    private void ShowNotice(string text, bool warn, string? actionLabel = null, Action? action = null)
    {
        TxtNotice.Text = text;
        TxtNotice.Foreground = (Brush)FindResource(warn ? "WarnCardFg" : "Fg");
        NoticeDot.Fill = (Brush)FindResource(warn ? "Warn" : "Good");
        NoticeStrip.BorderBrush = (Brush)FindResource(warn ? "WarnCardLine" : "StrongLine");

        _noticeAction = action;
        BtnNoticeAction.Content = actionLabel ?? "";
        BtnNoticeAction.Visibility = action == null ? Visibility.Collapsed : Visibility.Visible;

        NoticeStrip.Visibility = Visibility.Visible;
        NoticeStrip.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(120)));

        _noticeTimer.Stop();
        _noticeTimer.Start();
    }

    private void HideNotice()
    {
        _noticeTimer.Stop();
        NoticeStrip.Visibility = Visibility.Collapsed;
        _noticeAction = null;
    }

    private void BtnNoticeClose_Click(object sender, RoutedEventArgs e) => HideNotice();

    private void BtnNoticeAction_Click(object sender, RoutedEventArgs e)
    {
        var action = _noticeAction;
        HideNotice();
        action?.Invoke();
    }

    /// <summary>
    /// 録り終わったときの一言。
    /// メーターの判定は録っている最中しか出ないので、止めたあとにもう一度言う。
    /// 気づかないまま小さすぎる録りを重ねるのを防ぐのが目的。
    /// </summary>
    private void NoticeAfterTake(string trackName)
    {
        double db = _recPeak > 0 ? 20 * Math.Log10(_recPeak) : double.NegativeInfinity;

        if (double.IsNegativeInfinity(db) || db < -55)
        {
            ShowNotice($"「{trackName}」に音がほとんど入っていません（いちばん大きいところ {Db(db)}）。" +
                       "マイクが拾えているか確かめてください。", warn: true,
                       "音のチェック", () => BtnDiagnostics_Click(this, new RoutedEventArgs()));
        }
        else if (db < -12)
        {
            ShowNotice($"「{trackName}」は小さすぎます（いちばん大きいところ {Db(db)}）。" +
                       "目安は −12〜−6 です。機材側の入力つまみを上げて録り直すと、あとが楽になります。",
                       warn: true);
        }
        else if (db >= -0.5)
        {
            ShowNotice($"「{trackName}」は音が割れています（{Db(db)}）。" +
                       "つまみを下げて録り直してください。割れた音はあとから直せません。", warn: true);
        }
        else
        {
            ShowNotice($"「{trackName}」を録りました（いちばん大きいところ {Db(db)}）。いい音量です。",
                       warn: false);
        }
    }

    /// <summary>鳴らす機器の固定をやめ、Windows がいま使っている機器へ移す。</summary>
    private void SwitchToSystemOutput()
    {
        bool wasPlaying = _engine.IsPlaying;
        StopAll();

        _setup.FollowSystemOutput();
        _setup.Close();
        var error = _setup.EnsureOpen(_session.SampleRate);
        if (error != null)
        {
            ShowError(error);
            return;
        }
        RememberSettings();

        var status = _setup.ReadOutputStatus();
        ShowNotice($"「{status?.Name ?? "いま使っている機器"}」へ出すようにしました。", warn: false);

        if (wasPlaying) BtnPlay_Click(this, new RoutedEventArgs());
    }

    private static string Db(double db) =>
        double.IsNegativeInfinity(db) ? "無音" : $"{db:0.0} dBFS";

    private void ShowError(string message) =>
        MessageBox.Show(this, message, "Tonmeister", MessageBoxButton.OK, MessageBoxImage.Warning);
}
