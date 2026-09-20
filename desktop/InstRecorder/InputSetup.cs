using InstRecorder.Audio;
using NAudio.CoreAudioApi;

namespace InstRecorder;

/// <summary>
/// 「音の入り口」まわりの設定をまとめて持つ。
///
/// 画面を「録る」「重ねる」の2モードに分けたことで、専門用語の並ぶ設定一式は
/// <see cref="SettingsWindow"/> へ移った。設定を触る画面と、録る画面が別になったので、
/// 両方から同じ状態を見られるようにここへ集めている。
/// エンジンそのものには手を加えず、選択と開閉の段取りだけを引き受ける。
/// </summary>
public sealed class InputSetup
{
    private readonly Dictionary<string, List<FormatOption>> _formatCache = new();

    public InputSetup(RecorderEngine engine) => Engine = engine;

    public RecorderEngine Engine { get; }

    public List<InputDeviceRef> Devices { get; private set; } = new();
    public List<OutputDeviceRef> Outputs { get; private set; } = new();

    public InputDeviceRef? Device { get; private set; }
    public FormatOption? Format { get; private set; }
    public OutputDeviceRef? Output { get; set; }

    /// <summary>
    /// 鳴らす機器を利用者が自分で選んだか。
    ///
    /// false（既定）なら、機器を固定せず Windows の既定に従う。
    /// 固定してしまうと、ヘッドホンを挿しても前の機器へ出し続けることになり、
    /// 「他のアプリでは鳴るのに、このアプリだけ鳴らない」が起きる。
    /// </summary>
    public bool OutputExplicit { get; set; }

    /// <summary>実際にエンジンへ渡す出力先。null なら「そのつど Windows の既定」。</summary>
    public string? EffectiveOutputId => OutputExplicit ? Output?.Id : null;

    /// <summary>ASIO で使う先頭入力チャンネル。</summary>
    public int AsioChannelOffset { get; set; }
    public List<string> AsioChannelNames { get; private set; } = new();

    public SaveFormat SaveFormat { get; set; } = SaveFormat.Float32;

    /// <summary>重ね録りのズレ合わせ（旧「レイテンシ補正」）。単位はサンプル。</summary>
    public int LatencyFrames { get; private set; }
    public bool LatencyMeasured { get; private set; }
    public string LatencyDetail { get; private set; } = "";

    /// <summary>設定・接続状態が変わったとき。画面はこれを購読して表示を作り直す。</summary>
    public event Action? Changed;

    public bool IsOpen => Engine.IsOpen;

    public List<FormatOption> FormatsFor(InputDeviceRef dev)
    {
        var key = CacheKey(dev);
        if (_formatCache.TryGetValue(key, out var cached)) return cached;

        List<FormatOption> formats;
        try { formats = DeviceScanner.ScanFormats(dev); }
        catch { formats = new List<FormatOption>(); }
        _formatCache[key] = formats;
        return formats;
    }

    public List<FormatOption> Formats => Device == null ? new List<FormatOption>() : FormatsFor(Device);

    private static string CacheKey(InputDeviceRef d) => $"{d.Api}|{d.Id}";

    // ---------------- 走査と選択 ----------------

    /// <summary>
    /// 機器を探し直す。開いている入力はいったん閉じる。
    /// <paramref name="remembered"/> があれば、前回と同じ機器・同じ細かさを選び直す。
    /// </summary>
    public void Rescan(int preferSampleRate = 0, AppSettings? remembered = null)
    {
        Close();
        _formatCache.Clear();

        Devices = DeviceScanner.ScanDevices();
        foreach (var d in Devices.Where(d => d.Api != ApiKind.Asio)) FormatsFor(d);

        Outputs = DeviceScanner.ScanOutputDevices();
        OutputExplicit = remembered?.OutputChosen == true;
        Output = OutputExplicit ? remembered!.FindOutput(Outputs) : null;
        // 覚えていた機器が無くなっていたら、素直に既定へ戻す
        if (OutputExplicit && Output == null) OutputExplicit = false;

        var device = remembered?.FindDevice(Devices) ?? PickBestDevice();
        SelectDevice(device, preferSampleRate);

        if (remembered == null) return;

        // 前回と同じ細かさが今も使えるなら、それに戻す
        var format = remembered.FindFormat(Formats);
        if (format != null) Format = format;

        if (Device?.Api == ApiKind.Asio && remembered.AsioChannelOffset < AsioChannelNames.Count)
            AsioChannelOffset = remembered.AsioChannelOffset;

        SaveFormat = remembered.SaveFormat;
        if (remembered.LatencyMeasured && remembered.LatencyFrames > 0)
            SetLatency(remembered.LatencyFrames, true, "前回測った値です。");
    }

    /// <summary>ASIO ＞ 使える排他モード ＞ 共有モード の順に既定を選ぶ。</summary>
    private InputDeviceRef? PickBestDevice()
    {
        if (Devices.Count == 0) return null;

        var asio = Devices.FirstOrDefault(d => d.Api == ApiKind.Asio);
        if (asio != null) return asio;

        var exclusive = Devices.FirstOrDefault(d =>
            d.Api == ApiKind.WasapiExclusive && FormatsFor(d).Count > 0);
        if (exclusive != null) return exclusive;

        var shared = Devices.FirstOrDefault(d =>
            d.Api == ApiKind.WasapiShared && FormatsFor(d).Count > 0);
        return shared ?? Devices[0];
    }

    public void SelectDevice(InputDeviceRef? dev, int preferSampleRate = 0)
    {
        Close();
        Device = dev;
        AsioChannelNames = new List<string>();
        AsioChannelOffset = 0;

        if (dev != null && dev.Api == ApiKind.Asio)
        {
            try { AsioChannelNames = DeviceScanner.AsioInputChannelNames(dev.Id); }
            catch { AsioChannelNames = new List<string>(); }
        }

        Format = PickBestFormat(preferSampleRate);
        Changed?.Invoke();
    }

    /// <summary>セッションが始まっていれば、そのサンプルレートに合うものを優先する。</summary>
    private FormatOption? PickBestFormat(int preferSampleRate)
    {
        var formats = Formats;
        if (formats.Count == 0) return null;
        if (preferSampleRate <= 0) return formats[0];
        return formats.FirstOrDefault(f => f.SampleRate == preferSampleRate) ?? formats[0];
    }

    public void SelectFormat(FormatOption? fmt)
    {
        if (ReferenceEquals(Format, fmt)) return;
        Close();
        Format = fmt;
        Changed?.Invoke();
    }

    // ---------------- 開閉 ----------------

    /// <summary>入力を開く。開けなければ例外を投げる（呼び出し側が文言を出す）。</summary>
    public void Open(int sessionSampleRate)
    {
        if (Engine.IsOpen) return;
        if (Device == null) throw new InvalidOperationException("音の入り口を選んでください。");
        if (Format == null) throw new InvalidOperationException("音の細かさを選んでください。");

        if (sessionSampleRate > 0 && Format.SampleRate != sessionSampleRate)
        {
            throw new InvalidOperationException(
                $"この録音は {sessionSampleRate / 1000.0:0.#} kHz で始まっています。\n" +
                "同じ細かさを選ぶか、「新しく始める」で録り直してください。");
        }

        int offset = Device.Api == ApiKind.Asio ? Math.Max(0, AsioChannelOffset) : 0;
        Engine.OpenInput(Device, Format, offset, EffectiveOutputId);
        Changed?.Invoke();
    }

    public void Close()
    {
        if (!Engine.IsOpen) return;
        Engine.MonitorEnabled = false;
        Engine.CloseInput();
        Changed?.Invoke();
    }

    /// <summary>入力が開いていなければ開く。開けなければ理由を返す（null なら成功）。</summary>
    public string? EnsureOpen(int sessionSampleRate)
    {
        if (Engine.IsOpen) return null;
        try
        {
            Open(sessionSampleRate);
            return null;
        }
        catch (Exception ex)
        {
            return ex.Message;
        }
    }

    // ---------------- 鳴らす側の状態 ----------------

    /// <param name="Percent">Windows 側の音量（0〜100）。</param>
    public sealed record OutputStatus(string Name, bool Muted, int Percent, bool IsSystemDefault)
    {
        /// <summary>これ以下だと、小さく録れた音はまず聞こえない。</summary>
        public bool TooQuiet => Muted || Percent < 20;
    }

    /// <summary>
    /// 鳴らす機器が消音・小音量になっていないかを見る。
    /// 「再生しても聞こえない」の原因はアプリの外にあることが多く、
    /// 黙っていると利用者はアプリが壊れたと考えてしまう。
    /// </summary>
    public OutputStatus? ReadOutputStatus()
    {
        try
        {
            using var en = new MMDeviceEnumerator();

            string defaultId = "";
            try { defaultId = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID; }
            catch { /* 既定が無いこともある */ }

            var id = EffectiveOutputId;
            var dev = string.IsNullOrEmpty(id)
                ? en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
                : en.GetDevice(id);

            var vol = dev.AudioEndpointVolume;
            return new OutputStatus(dev.FriendlyName, vol.Mute,
                                    (int)Math.Round(vol.MasterVolumeLevelScalar * 100),
                                    dev.ID == defaultId);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Windows がいま使っている再生機器。分からなければ null。</summary>
    public OutputDeviceRef? SystemDefaultOutput()
    {
        try
        {
            using var en = new MMDeviceEnumerator();
            var dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            return new OutputDeviceRef { Id = dev.ID, Name = dev.FriendlyName, IsDefault = true };
        }
        catch
        {
            return null;
        }
    }

    /// <summary>鳴らす機器の固定をやめ、Windows の既定に従うようにする。</summary>
    public void FollowSystemOutput()
    {
        OutputExplicit = false;
        Output = null;
        Changed?.Invoke();
    }

    // ---------------- ズレ合わせ ----------------

    public void SetLatency(int frames, bool measured, string detail = "")
    {
        LatencyFrames = Math.Max(0, frames);
        LatencyMeasured = measured;
        LatencyDetail = detail;
        Changed?.Invoke();
    }

    public double LatencyMs => Engine.SampleRate > 0
        ? 1000.0 * LatencyFrames / Engine.SampleRate
        : 0;

    // ---------------- 表示用の言い換え ----------------

    /// <summary>デバイスの短い名前（機器名だけ。API 名は副文に回す）。</summary>
    public string DeviceName => Device?.Name ?? "（まだ選んでいません）";

    /// <summary>「共有モード ／ Windows が音を加工する可能性あり」のような副文。</summary>
    public static string ApiNote(InputDeviceRef dev) => dev.Api switch
    {
        ApiKind.Asio => "ASIO ／ Windows を通らず、そのまま録れます",
        ApiKind.WasapiExclusive => "排他モード ／ Windows を通らず、そのまま録れます",
        _ => "共有モード ／ Windows が音を加工する可能性あり",
    };

    public static bool IsClean(InputDeviceRef dev) => dev.Api != ApiKind.WasapiShared;

    /// <summary>保存形式のやさしい名前。</summary>
    public string SaveFormatFriendly => SaveFormat == SaveFormat.Float32
        ? "いちばん高音質"
        : "容量ひかえめ";

    /// <summary>状態ピルの1行。「内蔵マイクから、いちばん高音質で録ります」。</summary>
    public string StatusLine => Device == null
        ? "音の入り口が見つかりません。「詳しい設定」から探し直してください。"
        : $"{Device.Name} から、{SaveFormatFriendly}で録ります";

    /// <summary>音の細かさのやさしい名前。上ほど細かい。</summary>
    public static string FormatFriendly(FormatOption f, bool isBest) => isBest
        ? "いちばん細かく"
        : f.SampleRate >= 88200 ? "とても細かく"
        : f.IsFloat || f.BitsPerSample >= 24 ? "細かく"
        : "ふつう";

    public static string FormatOriginal(FormatOption f) =>
        $"{f.SampleRate / 1000.0:0.#}kHz / {f.BitLabel}";
}
