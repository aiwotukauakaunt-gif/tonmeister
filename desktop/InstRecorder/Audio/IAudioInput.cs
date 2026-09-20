namespace InstRecorder.Audio;

/// <summary>
/// 録音入力の共通インターフェイス。実装は必ずインターリーブされた float サンプルを
/// 「一切加工せず」に渡すこと（ゲイン・フィルタ・リサンプルを挟まない）。
/// </summary>
public interface IAudioInput : IDisposable
{
    int SampleRate { get; }
    int Channels { get; }
    /// <summary>実際に開けたフォーマットの説明。UI に必ず表示する。</summary>
    string FormatDescription { get; }

    /// <summary>(interleaved samples, valid sample count) をオーディオスレッドから通知する。</summary>
    event Action<float[], int>? BufferReady;

    /// <summary>回復不能なエラー（デバイス切断など）。</summary>
    event Action<Exception>? Failed;

    void Start();
    void Stop();
}
