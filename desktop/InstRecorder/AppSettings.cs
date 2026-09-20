using System.IO;
using System.Text.Json;
using InstRecorder.Audio;

namespace InstRecorder;

/// <summary>
/// 起動をまたいで覚えておく設定。録音物と同じ場所に置く（持ち運びやすさより見つけやすさ）。
///
/// これが無かった頃は、起動のたびに機器を選び直し、
/// ズレ合わせも測り直すことになっていた。
/// </summary>
public sealed class AppSettings
{
    public const string FileName = "settings.json";

    /// <summary>起動と同時にマイクを使い始めるか。</summary>
    public bool OpenInputOnStartup { get; set; } = true;

    public string? DeviceApi { get; set; }
    public string? DeviceId { get; set; }

    public int SampleRate { get; set; }
    public int BitsPerSample { get; set; }
    public bool IsFloat { get; set; }

    public string? OutputId { get; set; }

    /// <summary>
    /// 鳴らす機器を利用者が自分で選んだか。
    /// false のときは Windows の既定に従う（ヘッドホンを挿したら、そちらへ移る）。
    /// </summary>
    public bool OutputChosen { get; set; }
    public int AsioChannelOffset { get; set; }

    public SaveFormat SaveFormat { get; set; } = SaveFormat.Float32;

    /// <summary>測ったズレ合わせ。機材構成が変わったら測り直す前提で、値だけ覚える。</summary>
    public int LatencyFrames { get; set; }
    public bool LatencyMeasured { get; set; }

    // ---------------- 読み書き ----------------

    public static AppSettings Load(string rootFolder)
    {
        try
        {
            var path = Path.Combine(rootFolder, FileName);
            if (!File.Exists(path)) return new AppSettings();
            return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path)) ?? new AppSettings();
        }
        catch
        {
            // 壊れていても起動は止めない。既定値でやり直す。
            return new AppSettings();
        }
    }

    public void Save(string rootFolder)
    {
        try
        {
            Directory.CreateDirectory(rootFolder);
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions
            {
                WriteIndented = true,
                Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            });
            File.WriteAllText(Path.Combine(rootFolder, FileName), json);
        }
        catch { /* 保存できなくても動作は続ける */ }
    }

    // ---------------- 選択との橋渡し ----------------

    public void Remember(InputSetup setup)
    {
        DeviceApi = setup.Device?.Api.ToString();
        DeviceId = setup.Device?.Id;
        SampleRate = setup.Format?.SampleRate ?? 0;
        BitsPerSample = setup.Format?.BitsPerSample ?? 0;
        IsFloat = setup.Format?.IsFloat ?? false;
        OutputId = setup.OutputExplicit ? setup.Output?.Id : null;
        OutputChosen = setup.OutputExplicit;
        AsioChannelOffset = setup.AsioChannelOffset;
        SaveFormat = setup.SaveFormat;
        LatencyFrames = setup.LatencyFrames;
        LatencyMeasured = setup.LatencyMeasured;
    }

    /// <summary>前回の機器が今もあれば、それを選び直す。無ければ既定の選び方に任せる。</summary>
    public InputDeviceRef? FindDevice(IReadOnlyList<InputDeviceRef> devices)
    {
        if (string.IsNullOrEmpty(DeviceId) || string.IsNullOrEmpty(DeviceApi)) return null;
        return devices.FirstOrDefault(d => d.Id == DeviceId && d.Api.ToString() == DeviceApi);
    }

    public FormatOption? FindFormat(IReadOnlyList<FormatOption> formats)
    {
        if (SampleRate <= 0) return null;
        return formats.FirstOrDefault(f =>
            f.SampleRate == SampleRate && f.BitsPerSample == BitsPerSample && f.IsFloat == IsFloat);
    }

    public OutputDeviceRef? FindOutput(IReadOnlyList<OutputDeviceRef> outputs)
    {
        if (string.IsNullOrEmpty(OutputId)) return null;
        return outputs.FirstOrDefault(o => o.Id == OutputId);
    }
}
