using System.IO;
using System.Reflection;
using System.Text;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace InstRecorder;

/// <summary>排他モードで何が通るかを実機で調べるための診断モード（開発用）。</summary>
internal static class Probe
{
    public static void Run(string reportPath)
    {
        var sb = new StringBuilder();
        void W(string s) => sb.AppendLine(s);

        using var en = new MMDeviceEnumerator();
        foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        {
            W($"### {dev.FriendlyName}");
            var client = dev.AudioClient;
            W("MixFormat: " + Dump(client.MixFormat));
            W($"DefaultDevicePeriod: {client.DefaultDevicePeriod / 10000.0:0.###} ms  " +
              $"MinimumDevicePeriod: {client.MinimumDevicePeriod / 10000.0:0.###} ms");

            foreach (var (name, fmt) in Candidates())
            {
                bool ok;
                string extra = "";
                try
                {
                    ok = client.IsFormatSupported(AudioClientShareMode.Exclusive, fmt);
                }
                catch (Exception ex)
                {
                    ok = false;
                    extra = " ex:" + ex.GetType().Name;
                }
                W($"  [{(ok ? "OK" : "--")}] {name,-26} {Dump(fmt)}{extra}");
            }
            W("");
        }

        File.WriteAllText(reportPath, sb.ToString(), new UTF8Encoding(false));
    }

    private static IEnumerable<(string, WaveFormat)> Candidates()
    {
        foreach (var rate in new[] { 48000, 44100 })
        {
            foreach (var ch in new[] { 2, 1 })
            {
                yield return ($"PCM16 plain {rate}/{ch}", new WaveFormat(rate, 16, ch));
                yield return ($"PCM24 plain {rate}/{ch}", new WaveFormat(rate, 24, ch));
                yield return ($"Ext {rate}/16/{ch}", new WaveFormatExtensible(rate, 16, ch));
                yield return ($"Ext {rate}/24/{ch}", new WaveFormatExtensible(rate, 24, ch));
                yield return ($"Ext {rate}/32/{ch}", new WaveFormatExtensible(rate, 32, ch));
                yield return ($"Float32 {rate}/{ch}", WaveFormat.CreateIeeeFloatWaveFormat(rate, ch));
                yield return ($"Ext24in32 {rate}/{ch}", Ext24In32(rate, ch));
            }
        }
    }

    /// <summary>24bit を 32bit コンテナに入れた WaveFormatExtensible（排他モードで最も一般的）。</summary>
    public static WaveFormatExtensible Ext24In32(int rate, int channels)
    {
        var f = new WaveFormatExtensible(rate, 32, channels);
        SetField(f, "validBitsPerSample", (short)24);
        SetField(f, "subFormat", new Guid("00000001-0000-0010-8000-00aa00389b71")); // PCM
        SetField(f, "channelMask", channels == 1 ? 4 : 3);
        return f;
    }

    private static void SetField(object target, string name, object value)
    {
        var t = target.GetType();
        while (t != null)
        {
            var f = t.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            if (f != null) { f.SetValue(target, value); return; }
            t = t.BaseType;
        }
    }

    public static string Dump(WaveFormat f)
    {
        var s = $"tag={f.Encoding} rate={f.SampleRate} bits={f.BitsPerSample} ch={f.Channels} " +
                $"block={f.BlockAlign} avg={f.AverageBytesPerSecond} extra={f.ExtraSize}";
        if (f is WaveFormatExtensible e)
        {
            var vb = GetField(e, "validBitsPerSample");
            var cm = GetField(e, "channelMask");
            s += $" valid={vb} mask={cm} sub={e.SubFormat}";
        }
        return s;
    }

    private static object? GetField(object target, string name)
    {
        var t = target.GetType();
        while (t != null)
        {
            var f = t.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            if (f != null) return f.GetValue(target);
            t = t.BaseType;
        }
        return null;
    }
}
