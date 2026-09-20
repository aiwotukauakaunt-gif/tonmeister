using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// ASIO 入力。オーディオI/Fのドライバに直結するため、Windows のミキサーを一切通らず
/// 24bit/32bit のまま最短経路で届く。多チャンネルI/Fの任意の入力ペアを選べる。
/// </summary>
public sealed class AsioInput : IAudioInput
{
    private readonly AsioOut _asio;
    private float[] _buf = Array.Empty<float>();

    public int SampleRate { get; }
    public int Channels { get; }
    public string FormatDescription { get; }

    public event Action<float[], int>? BufferReady;
    public event Action<Exception>? Failed;

    /// <param name="output">
    /// 重ね録り用の再生経路。ASIO ドライバは同時に1インスタンスしか開けないので、
    /// 録音と再生は必ずこの1つのインスタンスで行う。
    /// </param>
    public AsioInput(string driverName, int channelOffset, int channels, int sampleRate,
                     IWaveProvider? output = null)
    {
        _asio = new AsioOut(driverName)
        {
            InputChannelOffset = channelOffset,
        };
        SampleRate = sampleRate;
        Channels = channels;

        _asio.InitRecordAndPlayback(output, channels, sampleRate);
        _asio.AudioAvailable += OnAudio;

        var chNames = new List<string>();
        for (int i = 0; i < channels; i++)
        {
            try { chNames.Add(_asio.AsioInputChannelName(channelOffset + i)); }
            catch { chNames.Add($"in {channelOffset + i + 1}"); }
        }
        FormatDescription = $"{sampleRate / 1000.0:0.#} kHz / 32bit float / {channels}ch " +
                            $"（ASIO 直結）入力: {string.Join(", ", chNames)} / " +
                            $"バッファ {_asio.FramesPerBuffer} サンプル";
    }

    private void OnAudio(object? sender, AsioAudioAvailableEventArgs e)
    {
        try
        {
            int needed = e.SamplesPerBuffer * Channels;
            if (_buf.Length < needed) _buf = new float[needed];
            int n = e.GetAsInterleavedSamples(_buf);
            BufferReady?.Invoke(_buf, n);
        }
        catch (Exception ex)
        {
            Failed?.Invoke(ex);
        }
    }

    public void Start() => _asio.Play();

    public void Stop()
    {
        try { _asio.Stop(); } catch { /* 既に停止済み */ }
    }

    public void ShowControlPanel() => _asio.ShowControlPanel();

    public void Dispose()
    {
        _asio.AudioAvailable -= OnAudio;
        Stop();
        _asio.Dispose();
    }
}
