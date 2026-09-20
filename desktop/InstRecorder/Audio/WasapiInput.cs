using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// WASAPI 入力。排他モードでは Windows のミキサー（サンプルレート変換・APO・音声補正）を
/// 完全にバイパスするため、ADC が吐いたビットがそのまま届く。
/// </summary>
public sealed class WasapiInput : IAudioInput
{
    private readonly MMDevice _device;
    private readonly WaveFormat _format;
    private readonly bool _exclusive;
    private WasapiCapture? _capture;
    private float[] _buf = new float[16384];

    public int SampleRate => _format.SampleRate;
    public int Channels => _format.Channels;
    public string FormatDescription { get; private set; }

    public event Action<float[], int>? BufferReady;
    public event Action<Exception>? Failed;

    public WasapiInput(MMDevice device, WaveFormat format, bool exclusive)
    {
        _device = device;
        _format = format;
        _exclusive = exclusive;
        FormatDescription = SampleConvert.Describe(format)
            + (exclusive ? "（排他 / OSミキサー非経由）" : "（共有 / OSミキサー経由）");
    }

    /// <summary>
    /// 排他モードはバッファ長をデバイスの周期の整数倍にしないと初期化に失敗するため、
    /// 実際に開けるまで候補を順に試す。
    /// </summary>
    private IEnumerable<int> BufferCandidates()
    {
        if (!_exclusive)
        {
            yield return 50;
            yield return 100;
            yield break;
        }

        double periodMs = _device.AudioClient.DefaultDevicePeriod / 10000.0;
        int baseMs = Math.Max(3, (int)Math.Ceiling(periodMs));
        foreach (var mul in new[] { 2, 4, 1, 8, 16 }) yield return baseMs * mul;
        yield return 10;
        yield return 20;
        yield return 50;
    }

    public void Start()
    {
        if (_capture != null) return;

        Exception? last = null;
        foreach (var ms in BufferCandidates().Distinct())
        {
            foreach (var eventSync in new[] { true, false })
            {
                WasapiCapture? capture = null;
                try
                {
                    capture = new WasapiCapture(_device, eventSync, ms);
                    if (_exclusive) capture.ShareMode = AudioClientShareMode.Exclusive;
                    capture.WaveFormat = _format;
                    capture.DataAvailable += OnData;
                    capture.RecordingStopped += OnStopped;
                    capture.StartRecording(); // 初期化はここで同期的に行われ、非対応なら例外になる
                    _capture = capture;
                    FormatDescription = SampleConvert.Describe(_format)
                        + (_exclusive ? "（排他 / OSミキサー非経由）" : "（共有 / OSミキサー経由）")
                        + $" バッファ {ms}ms";
                    return;
                }
                catch (Exception ex)
                {
                    last = ex;
                    if (capture != null)
                    {
                        capture.DataAvailable -= OnData;
                        capture.RecordingStopped -= OnStopped;
                        capture.Dispose();
                    }
                }
            }
        }

        throw new InvalidOperationException(
            "このフォーマット／モードでデバイスを開けませんでした。\n" +
            "他のアプリが排他使用中か、デバイス側が非対応の可能性があります。\n\n" +
            last?.Message, last);
    }

    private void OnStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception != null) Failed?.Invoke(e.Exception);
    }

    private void OnData(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded <= 0) return;
        try
        {
            int n = SampleConvert.ToFloat(e.Buffer, e.BytesRecorded, _format, ref _buf);
            BufferReady?.Invoke(_buf, n);
        }
        catch (Exception ex)
        {
            Failed?.Invoke(ex);
        }
    }

    public void Stop()
    {
        var capture = _capture;
        _capture = null;
        if (capture == null) return;
        capture.DataAvailable -= OnData;
        capture.RecordingStopped -= OnStopped;
        try { capture.StopRecording(); } catch { /* 既に停止済み */ }
        capture.Dispose();
    }

    public void Dispose() => Stop();
}
