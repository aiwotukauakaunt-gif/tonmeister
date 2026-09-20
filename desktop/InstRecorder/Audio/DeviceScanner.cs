using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>入力デバイスと、そのデバイスが実際に受け付けるフォーマットを列挙する。</summary>
public static class DeviceScanner
{
    private static readonly int[] Rates = { 44100, 48000, 88200, 96000, 176400, 192000 };

    public static List<InputDeviceRef> ScanDevices()
    {
        var list = new List<InputDeviceRef>();

        // --- ASIO を先頭に（音質・レイテンシとも最優先の選択肢） ---
        foreach (var name in SafeAsioDriverNames())
        {
            list.Add(new InputDeviceRef
            {
                Api = ApiKind.Asio,
                Id = name,
                Name = name,
                MaxChannels = 0, // ドライバを開くまで不明
            });
        }

        // --- WASAPI ---
        try
        {
            using var en = new MMDeviceEnumerator();
            foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
            {
                int ch = 2;
                try { ch = dev.AudioClient.MixFormat.Channels; } catch { /* 取得できなければ既定値 */ }

                list.Add(new InputDeviceRef
                {
                    Api = ApiKind.WasapiExclusive, Id = dev.ID, Name = dev.FriendlyName, MaxChannels = ch,
                });
                list.Add(new InputDeviceRef
                {
                    Api = ApiKind.WasapiShared, Id = dev.ID, Name = dev.FriendlyName, MaxChannels = ch,
                });
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("WASAPI 入力デバイスの列挙に失敗しました: " + ex.Message, ex);
        }

        return list;
    }

    /// <summary>重ね録りの再生に使う出力デバイス（WASAPI 共有）。ASIO 入力時は使わない。</summary>
    public static List<OutputDeviceRef> ScanOutputDevices()
    {
        var list = new List<OutputDeviceRef>();
        try
        {
            using var en = new MMDeviceEnumerator();
            string defaultId = "";
            try { defaultId = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID; }
            catch { /* 既定デバイスが無い場合もある */ }

            foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                list.Add(new OutputDeviceRef
                {
                    Id = dev.ID,
                    Name = dev.FriendlyName,
                    IsDefault = dev.ID == defaultId,
                });
            }
        }
        catch { /* 列挙できなければ空 */ }

        return list.OrderByDescending(d => d.IsDefault).ToList();
    }

    /// <summary>
    /// 再生先の音量とミュート状態。レイテンシ測定に失敗したとき、
    /// 「そもそも音が出ていない」のかどうかを利用者に伝えるために使う。
    /// </summary>
    public static string OutputVolumeInfo(string? deviceId)
    {
        try
        {
            using var en = new MMDeviceEnumerator();
            var dev = string.IsNullOrEmpty(deviceId)
                ? en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
                : en.GetDevice(deviceId);

            var vol = dev.AudioEndpointVolume;
            int percent = (int)Math.Round(vol.MasterVolumeLevelScalar * 100);
            return vol.Mute
                ? $"{dev.FriendlyName}：ミュート中"
                : $"{dev.FriendlyName}：音量 {percent}%";
        }
        catch (Exception ex)
        {
            return "音量を取得できませんでした: " + ex.Message;
        }
    }

    public static string[] SafeAsioDriverNames()
    {
        try { return AsioOut.GetDriverNames(); }
        catch { return Array.Empty<string>(); }
    }

    public static MMDevice GetMmDevice(string id)
    {
        using var en = new MMDeviceEnumerator();
        return en.GetDevice(id);
    }

    /// <summary>
    /// そのデバイスで開けるフォーマットを列挙する。
    /// 共有モードは Windows のミキサー形式に固定されるので、それ1つだけを返す。
    /// </summary>
    public static List<FormatOption> ScanFormats(InputDeviceRef dev)
    {
        return dev.Api switch
        {
            ApiKind.WasapiShared => SharedFormats(dev),
            ApiKind.WasapiExclusive => ExclusiveFormats(dev),
            ApiKind.Asio => AsioFormats(dev),
            _ => new List<FormatOption>(),
        };
    }

    private static List<FormatOption> SharedFormats(InputDeviceRef dev)
    {
        using var device = GetMmDevice(dev.Id);
        var mix = device.AudioClient.MixFormat;
        return new List<FormatOption>
        {
            new()
            {
                SampleRate = mix.SampleRate,
                BitsPerSample = mix.BitsPerSample,
                IsFloat = SampleConvert.IsFloatFormat(mix),
                Channels = mix.Channels,
                WaveFormat = mix,
            }
        };
    }

    private static List<FormatOption> ExclusiveFormats(InputDeviceRef dev)
    {
        var result = new List<FormatOption>();
        using var device = GetMmDevice(dev.Id);
        var client = device.AudioClient;
        int maxCh = Math.Max(1, dev.MaxChannels);

        var seen = new HashSet<(int, int, bool, int)>();
        foreach (var rate in Rates)
        {
            for (int ch = maxCh; ch >= 1; ch--)
            {
                foreach (var fmt in CandidateFormats(rate, ch))
                {
                    try
                    {
                        if (!client.IsFormatSupported(AudioClientShareMode.Exclusive, fmt)) continue;
                    }
                    catch { continue; }

                    int bits = WaveFormatHelper.ValidBits(fmt);
                    bool isFloat = SampleConvert.IsFloatFormat(fmt);
                    // 24bit パック / 24in32 のように中身が同じものは1つにまとめる
                    if (!seen.Add((rate, bits, isFloat, ch))) continue;

                    result.Add(new FormatOption
                    {
                        SampleRate = rate,
                        BitsPerSample = bits,
                        IsFloat = isFloat,
                        Channels = ch,
                        WaveFormat = fmt,
                    });
                }
            }
        }

        // レート降順 → ビット深度降順（＝高品質順）に並べる
        return result
            .OrderByDescending(f => f.SampleRate)
            .ThenByDescending(f => f.BitsPerSample)
            .ThenByDescending(f => f.Channels)
            .ToList();
    }

    private static IEnumerable<WaveFormat> CandidateFormats(int rate, int channels)
    {
        // 高品質な順に試す。オーディオI/Fの排他モードは「24bit を 32bit コンテナ」が最も一般的。
        var pcm24in32 = WaveFormatHelper.Pcm24In32(rate, channels);
        if (pcm24in32 != null) yield return pcm24in32;

        var pcm32 = WaveFormatHelper.Pcm32(rate, channels);
        if (pcm32 != null) yield return pcm32;

        yield return new WaveFormatExtensible(rate, 24, channels); // 24bit パック
        yield return new WaveFormat(rate, 24, channels);
        yield return WaveFormat.CreateIeeeFloatWaveFormat(rate, channels);
        yield return new WaveFormatExtensible(rate, 16, channels);
        yield return new WaveFormat(rate, 16, channels);
    }

    /// <summary>
    /// 排他モードで何も通らなかったときの理由。ミックス形式すら拒否される場合は
    /// デバイス側で排他モードが禁止されている（Windows の設定かドライバの仕様）。
    /// </summary>
    public static string ExclusiveUnavailableMessage(InputDeviceRef dev)
    {
        return $"「{dev.Name}」は排他モードを受け付けませんでした。\n" +
               "Windows の設定 → システム → サウンド → 「このデバイスのプロパティ」→ 詳細設定 で\n" +
               "『アプリケーションによるこのデバイスの排他制御を許可する』を有効にすると使える場合があります。\n" +
               "内蔵マイクなど、そもそも排他モードに対応しないデバイスもあります。その場合は共有モードを選んでください。";
    }

    private static List<FormatOption> AsioFormats(InputDeviceRef dev)
    {
        var result = new List<FormatOption>();
        AsioOut? asio = null;
        try
        {
            asio = new AsioOut(dev.Id);
            int maxIn = asio.DriverInputChannelCount;
            foreach (var rate in Rates)
            {
                bool ok;
                try { ok = asio.IsSampleRateSupported(rate); } catch { ok = false; }
                if (!ok) continue;

                if (maxIn >= 2)
                {
                    result.Add(new FormatOption
                    { SampleRate = rate, BitsPerSample = 32, IsFloat = true, Channels = 2 });
                }
                if (maxIn >= 1)
                {
                    result.Add(new FormatOption
                    { SampleRate = rate, BitsPerSample = 32, IsFloat = true, Channels = 1 });
                }
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"ASIO ドライバ「{dev.Name}」を開けませんでした。\n" +
                "他のアプリ（DAW など）が使用中でないか確認してください。\n\n" + ex.Message, ex);
        }
        finally
        {
            asio?.Dispose();
        }

        return result.OrderByDescending(f => f.SampleRate).ThenByDescending(f => f.Channels).ToList();
    }

    /// <summary>ASIO の入力チャンネル名一覧（チャンネル選択UI用）。</summary>
    public static List<string> AsioInputChannelNames(string driverName)
    {
        var names = new List<string>();
        AsioOut? asio = null;
        try
        {
            asio = new AsioOut(driverName);
            for (int i = 0; i < asio.DriverInputChannelCount; i++)
            {
                try { names.Add($"{i + 1}: {asio.AsioInputChannelName(i)}"); }
                catch { names.Add($"{i + 1}"); }
            }
        }
        catch { /* 開けない場合は空 */ }
        finally { asio?.Dispose(); }
        return names;
    }
}
