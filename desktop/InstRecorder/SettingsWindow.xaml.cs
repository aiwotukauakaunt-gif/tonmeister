using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using InstRecorder.Audio;
using NAudio.Wave;

namespace InstRecorder;

/// <summary>
/// 専門用語をここ1枚に隔離するための画面（ハンドオフの 07）。
/// 「録る」画面には、選んだ結果の1行だけが出る。
/// </summary>
public partial class SettingsWindow : Window
{
    private readonly InputSetup _setup;
    private readonly Session _session;
    private readonly string _rootFolder;
    private readonly AppSettings _settings;
    private bool _building;

    public SettingsWindow(InputSetup setup, Session session, string rootFolder, AppSettings settings)
    {
        InitializeComponent();
        _setup = setup;
        _session = session;
        _rootFolder = rootFolder;
        _settings = settings;
        TglStartup.IsChecked = settings.OpenInputOnStartup;

        TxtFolder.Text = Directory.Exists(_session.Folder) ? _session.Folder : _rootFolder;

        BuildDevices();
        BuildSaveChips();
        BuildOutputs();
        RefreshForDevice();
    }

    // ---------------- 音の入り口 ----------------

    private void BuildDevices()
    {
        _building = true;
        DeviceList.Children.Clear();

        foreach (var dev in _setup.Devices)
        {
            bool usable = dev.Api == ApiKind.Asio || _setup.FormatsFor(dev).Count > 0;

            var radio = new RadioButton
            {
                Style = (Style)FindResource("DeviceRow"),
                GroupName = "device",
                Content = dev.Name,
                Tag = InputSetup.ApiNote(dev),
                IsChecked = ReferenceEquals(dev, _setup.Device),
                // 使えない組み合わせも「存在はする」ことを見せる（消すと探し続けてしまう）
                IsEnabled = usable,
                DataContext = dev,
                Padding = new Thickness(0, 0, 92, 0),
            };
            radio.Checked += DeviceRadio_Checked;

            var badge = MakeBadge(
                InputSetup.IsClean(dev) ? "そのまま録れます" : "注意",
                InputSetup.IsClean(dev));
            badge.HorizontalAlignment = HorizontalAlignment.Right;
            badge.VerticalAlignment = VerticalAlignment.Top;
            badge.Margin = new Thickness(0, 11, 12, 0);
            badge.IsHitTestVisible = false;

            var row = new Grid { Margin = new Thickness(0, 0, 0, 6) };
            row.Children.Add(radio);
            row.Children.Add(badge);
            DeviceList.Children.Add(row);
        }

        TxtNoDevice.Visibility = _setup.Devices.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        _building = false;
    }

    private static Border MakeBadge(string text, bool good) => new()
    {
        CornerRadius = new CornerRadius(4),
        Padding = new Thickness(7, 3, 7, 3),
        Background = new SolidColorBrush(good
            ? Color.FromArgb(0x26, 0xC9, 0xA2, 0x27)
            : Color.FromRgb(0x2E, 0x1F, 0x10)),
        Child = new TextBlock
        {
            Text = text,
            FontSize = 10.5,
            Foreground = new SolidColorBrush(good
                ? Color.FromRgb(0xC9, 0xA2, 0x27)
                : Color.FromRgb(0xB0, 0x6A, 0x2C)),
        },
    };

    private void DeviceRadio_Checked(object sender, RoutedEventArgs e)
    {
        if (_building) return;
        if (sender is not RadioButton rb || rb.DataContext is not InputDeviceRef dev) return;

        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            _setup.SelectDevice(dev, _session.SampleRate);
        }
        catch (Exception ex)
        {
            Warn(ex.Message);
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }
        RefreshForDevice();
    }

    private void BtnRescan_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            _setup.Rescan(_session.SampleRate, _settings);
        }
        catch (Exception ex)
        {
            Warn(ex.Message);
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }

        BuildDevices();
        BuildOutputs();
        RefreshForDevice();
    }

    // ---------------- 音の細かさ ----------------

    private void RefreshForDevice()
    {
        BuildFormatChips();
        BuildAsio();
        UpdateLatency();
        UpdateExplain();
        UpdateOpenButton();

        PnlOutput.Visibility = _setup.Device?.Api == ApiKind.Asio
            ? Visibility.Collapsed
            : Visibility.Visible;
    }

    private void BuildFormatChips()
    {
        _building = true;
        FormatChips.Children.Clear();

        var formats = _setup.Formats;
        for (int i = 0; i < formats.Count; i++)
        {
            var f = formats[i];
            var chip = new ToggleButton
            {
                Style = (Style)FindResource("Chip"),
                Content = InputSetup.FormatFriendly(f, i == 0),
                Tag = InputSetup.FormatOriginal(f),
                IsChecked = ReferenceEquals(f, _setup.Format),
                DataContext = f,
            };
            chip.Checked += FormatChip_Checked;
            chip.Unchecked += (_, _) => { if (!_building) chip.IsChecked = true; };
            FormatChips.Children.Add(chip);
        }

        TxtNoFormat.Visibility = formats.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        TxtFormatOriginal.Text = _setup.Format != null ? InputSetup.FormatOriginal(_setup.Format) : "";
        _building = false;
    }

    private void FormatChip_Checked(object sender, RoutedEventArgs e)
    {
        if (_building) return;
        if (sender is not ToggleButton tb || tb.DataContext is not FormatOption fmt) return;

        _setup.SelectFormat(fmt);

        _building = true;
        foreach (var child in FormatChips.Children)
            if (child is ToggleButton other && !ReferenceEquals(other, tb)) other.IsChecked = false;
        _building = false;

        TxtFormatOriginal.Text = InputSetup.FormatOriginal(fmt);
        UpdateExplain();
        UpdateOpenButton();
        UpdateLatency();
    }

    // ---------------- 音の残し方 ----------------

    private void BuildSaveChips()
    {
        _building = true;
        SaveChips.Children.Clear();

        foreach (var (value, friendly, original) in new[]
        {
            (SaveFormat.Float32, "そのままの音で残す", "32bit float WAV"),
            (SaveFormat.Pcm24, "容量ひかえめで残す", "24bit WAV"),
        })
        {
            var chip = new ToggleButton
            {
                Style = (Style)FindResource("Chip"),
                Content = friendly,
                Tag = original,
                IsChecked = _setup.SaveFormat == value,
                DataContext = value,
            };
            chip.Checked += SaveChip_Checked;
            chip.Unchecked += (_, _) => { if (!_building) chip.IsChecked = true; };
            SaveChips.Children.Add(chip);
        }
        _building = false;
    }

    private void SaveChip_Checked(object sender, RoutedEventArgs e)
    {
        if (_building) return;
        if (sender is not ToggleButton tb || tb.DataContext is not SaveFormat save) return;

        _setup.SaveFormat = save;

        _building = true;
        foreach (var child in SaveChips.Children)
            if (child is ToggleButton other && !ReferenceEquals(other, tb)) other.IsChecked = false;
        _building = false;

        UpdateExplain();
    }

    // ---------------- 聞く側・ASIO ----------------

    /// <summary>
    /// 「自動」を先頭に置く。既定はこちらで、ヘッドホンを挿せばそちらへ移る。
    /// 機器を名指しすると、以後そこへ固定される。
    /// </summary>
    private sealed record OutputChoice(OutputDeviceRef? Device)
    {
        public override string ToString() => Device == null
            ? "自動（Windows がいま使っている機器）"
            : Device.ToString();
    }

    private void BuildOutputs()
    {
        _building = true;

        var items = new List<OutputChoice> { new(null) };
        items.AddRange(_setup.Outputs.Select(o => new OutputChoice(o)));
        CmbOutput.ItemsSource = items;

        int index = 0;
        if (_setup.OutputExplicit && _setup.Output != null)
        {
            int found = items.FindIndex(i => i.Device?.Id == _setup.Output.Id);
            if (found > 0) index = found;
        }
        CmbOutput.SelectedIndex = index;

        _building = false;
        UpdateOutputNote();
    }

    private void CmbOutput_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_building) return;
        if (CmbOutput.SelectedItem is not OutputChoice choice) return;

        if (choice.Device == null) _setup.FollowSystemOutput();
        else
        {
            _setup.Output = choice.Device;
            _setup.OutputExplicit = true;
        }

        _settings.Remember(_setup);
        _settings.Save(_rootFolder);

        // エンジンは開いたときの出力先を掴んだままなので、開き直して反映させる
        if (_setup.IsOpen)
        {
            _setup.Close();
            var error = _setup.EnsureOpen(_session.SampleRate);
            if (error != null) Warn(error);
        }
        UpdateOutputNote();
    }

    private void UpdateOutputNote()
    {
        var status = _setup.ReadOutputStatus();
        if (status == null)
        {
            TxtOutputNote.Text = "";
            return;
        }

        TxtOutputNote.Text = _setup.OutputExplicit
            ? $"「{status.Name}」に固定しています。" +
              (status.IsSystemDefault ? "" : "　※ Windows がいま使っている機器とは違います。")
            : $"いまは「{status.Name}」へ出ます。";
        TxtOutputNote.Foreground = (Brush)FindResource(
            _setup.OutputExplicit && !status.IsSystemDefault ? "Warn" : "FgDim");
    }

    private void BuildAsio()
    {
        bool isAsio = _setup.Device?.Api == ApiKind.Asio;
        PnlAsio.Visibility = isAsio ? Visibility.Visible : Visibility.Collapsed;
        if (!isAsio) return;

        _building = true;
        CmbAsioCh.ItemsSource = _setup.AsioChannelNames;
        CmbAsioCh.SelectedIndex = _setup.AsioChannelNames.Count > 0
            ? Math.Clamp(_setup.AsioChannelOffset, 0, _setup.AsioChannelNames.Count - 1)
            : -1;
        _building = false;
    }

    private void CmbAsioCh_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_building) return;
        _setup.AsioChannelOffset = Math.Max(0, CmbAsioCh.SelectedIndex);
    }

    private void BtnAsioPanel_Click(object sender, RoutedEventArgs e)
    {
        if (_setup.Device is not { Api: ApiKind.Asio } dev) return;
        try
        {
            using var asio = new AsioOut(dev.Id);
            asio.ShowControlPanel();
        }
        catch (Exception ex)
        {
            Warn("ASIO の設定画面を開けませんでした: " + ex.Message);
        }
    }

    // ---------------- ズレ合わせ ----------------

    private void UpdateLatency()
    {
        bool measured = _setup.LatencyMeasured && _setup.LatencyFrames > 0;
        TxtLatencyValue.Text = measured
            ? $"{_setup.LatencyMs:0} ms"
            : "未測定";
        TxtLatencyValue.Foreground = (Brush)FindResource(measured ? "Good" : "Warn");
        BtnMeasure.Content = measured ? "測り直す" : "測る";

        TxtLatencyNote.Text = measured
            ? $"3回測って一致しました（{_setup.LatencyFrames} サンプル）。{_setup.LatencyDetail}"
            : _setup.Engine.UsesSharedClock
                ? "ASIO は録音と再生の時計が同じなので、ズレは小さいはずです。測るとさらに正確に揃います。"
                : "測っておくと、重ねて録った音が前の音とぴったり揃います。";
    }

    private async void BtnMeasure_Click(object sender, RoutedEventArgs e)
    {
        BtnMeasure.IsEnabled = false;
        TxtLatencyValue.Text = "測定中…";
        TxtLatencyNote.Text = "テスト音を3回鳴らしています。";

        await LatencyMeasure.RunAsync(this, _setup, _session.SampleRate);

        BtnMeasure.IsEnabled = true;
        UpdateLatency();
        UpdateOpenButton();
    }

    // ---------------- 右カラム ----------------

    private void UpdateExplain()
    {
        var dev = _setup.Device;
        string head = dev == null
            ? "音の入り口がまだ決まっていません。上の一覧から機器を選んでください。"
            : dev.Api switch
            {
                ApiKind.Asio =>
                    "ASIO は、機器のドライバから直接、音を受け取る方法です。Windows のミキサーを通らないので、" +
                    "鳴っている音がそのまま録れます。録音と再生の時計も同じなので、重ね録りのズレも小さくなります。",
                ApiKind.WasapiExclusive =>
                    "排他モードは、このアプリが機器を独り占めして、Windows のミキサーを通さずに受け取る方法です。" +
                    "音量の自動調整やノイズ除去は働かないので、鳴っている音がそのまま録れます。" +
                    "そのあいだ、他のアプリはこの機器を使えません。",
                _ =>
                    "共有モードとは、Windows のミキサーを通って音が届く状態のことです。" +
                    "音量の自動調整やノイズ除去が勝手に働くことがあり、実際に鳴っている音と違うものが録れる可能性があります。\n\n" +
                    "いちばん確実なのは、ASIO 対応のオーディオ機器を使うこと。次善は「排他モード」を許可することです。",
            };

        string fine = _setup.Format == null
            ? ""
            : $"\n\n音の細かさ：{InputSetup.FormatOriginal(_setup.Format)}。" +
              "数字が大きいほど細かく録れますが、その代わりファイルは大きくなります。";

        string save = _setup.SaveFormat == SaveFormat.Float32
            ? "\n\n音の残し方：そのままの音で残します。音が割れるほど大きく録れてしまっても、あとから下げれば救えます。"
            : "\n\n音の残し方：容量ひかえめで残します。ファイルは 3/4 になりますが、0 を超えた音は救えません。";

        TxtExplain.Text = head + fine + save;
    }

    private void UpdateOpenButton()
    {
        BtnOpenInput.Content = _setup.IsOpen ? "音を聞くのをやめる" : "音を聞く準備をする";
        BtnOpenInput.IsEnabled = _setup.Format != null || _setup.IsOpen;
    }

    private void BtnOpenInput_Click(object sender, RoutedEventArgs e)
    {
        if (_setup.IsOpen)
        {
            _setup.Close();
        }
        else
        {
            var error = _setup.EnsureOpen(_session.SampleRate);
            if (error != null) Warn(error);
        }
        UpdateOpenButton();
        UpdateLatency();
    }

    private void BtnOpenFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = Directory.Exists(_session.Folder) ? _session.Folder : _rootFolder;
        Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true });
    }

    private void Startup_Changed(object sender, RoutedEventArgs e)
    {
        if (_settings == null) return;
        _settings.OpenInputOnStartup = TglStartup.IsChecked == true;
        _settings.Save(_rootFolder);
    }

    private void BtnClose_Click(object sender, RoutedEventArgs e) => Close();

    private void Warn(string message) =>
        MessageBox.Show(this, message, "詳しい設定", MessageBoxButton.OK, MessageBoxImage.Warning);
}
