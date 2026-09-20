using System.IO;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace InstRecorder.Audio;

/// <summary>
/// セッションの全トラックを1つのステレオ信号にまとめたもの。
/// 音量・ミュート・ソロは Read のたびに読み直すので、再生中の操作がそのまま反映される。
/// </summary>
public sealed class SessionMix : IDisposable
{
    private readonly List<IDisposable> _disposables;

    public ISampleProvider Provider { get; }
    public int SampleRate { get; }
    /// <summary>鳴らす長さ。響きを足していると尾のぶん伸びる。</summary>
    public double LengthSeconds { get; }
    /// <summary>実際にミックスに入ったトラック数。</summary>
    public int TrackCount { get; }
    /// <summary>最後の音が止まってから響きが消えるまで。足していなければ 0。</summary>
    public double TailSeconds { get; }
    /// <summary>使ったホールの説明。響きを足していなければ null。</summary>
    public string? HallDescription { get; }

    private SessionMix(ISampleProvider provider, int sampleRate, double lengthSeconds,
                       int trackCount, double tailSeconds, string? hallDescription,
                       List<IDisposable> disposables)
    {
        Provider = provider;
        SampleRate = sampleRate;
        LengthSeconds = lengthSeconds;
        TrackCount = trackCount;
        TailSeconds = tailSeconds;
        HallDescription = hallDescription;
        _disposables = disposables;
    }

    /// <param name="exclude">
    /// 再生から外すトラック。既存トラックのテイクを録り直すときに、
    /// 前のテイクが耳に返ってくると重なって聴こえるので外す。
    /// </param>
    /// <param name="startSeconds">頭出し位置。パンチインでは録り直す少し手前から鳴らす。</param>
    public static SessionMix? Build(Session session, Track? exclude = null, double startSeconds = 0)
    {
        var playable = session.Tracks
            .Where(t => t != exclude && t.ActiveFiles.Count > 0)
            .ToList();
        if (playable.Count == 0) return null;

        int rate = session.SampleRate > 0
            ? session.SampleRate
            : playable[0].ActiveTake?.SampleRate ?? 48000;

        var disposables = new List<IDisposable>();
        var inputs = new List<ISampleProvider>();

        foreach (var track in playable)
        {
            var take = track.ActiveTake;
            if (take == null) continue;

            var reader = TakeReader.Open(take, startSeconds);
            if (reader == null) continue; // 頭出し位置がテイクの終わりより後なら鳴らすものが無い
            disposables.Add(reader);

            ISampleProvider src = ToStereo(reader.Provider);

            // 後処理は再生経路にだけ挟む。元のファイルは変わらない。
            var p = track.Processing;
            if (p.HumEnabled) src = new HumRemover(src, p.HumFrequency, p.HumHarmonics);
            if (p.GateEnabled) src = new NoiseGate(src, p.GateThresholdDb);

            inputs.Add(new TrackGainProvider(session, track, src));
        }

        if (inputs.Count == 0)
        {
            foreach (var d in disposables) d.Dispose();
            return null;
        }

        var mixer = new MixingSampleProvider(WaveFormat.CreateIeeeFloatWaveFormat(rate, 2))
        {
            ReadFully = true, // 短いトラックが終わっても無音を出し続ける
        };
        foreach (var i in inputs) mixer.AddMixerInput(i);

        double length = Math.Max(0, playable.Max(t => t.Seconds) - startSeconds);

        // ホールの響きはトラックごとではなくまとめた音に一度だけかける。
        // ホールは場所であって、楽器ごとに別の場所にいることはないため。
        ISampleProvider output = mixer;
        double tail = 0;
        string? hallDescription = null;
        var ir = ImpulseCache.Resolve(session.Hall, rate);
        if (ir != null && session.Hall.MixPercent > 0)
        {
            var reverb = new ConvolutionReverb(mixer, ir,
                session.Hall.MixPercent / 100.0, session.Hall.PreDelayMs / 1000.0);
            output = reverb;
            tail = reverb.TailSeconds;
            hallDescription = ir.Description;
            length += tail;   // 最後の音が止まってからも尾が残る
        }

        return new SessionMix(output, rate, length, inputs.Count, tail, hallDescription, disposables);
    }

    private static ISampleProvider ToStereo(ISampleProvider src)
    {
        if (src.WaveFormat.Channels == 1) return new MonoToStereoSampleProvider(src);
        if (src.WaveFormat.Channels > 2) return new MonoToStereoSampleProvider(new StereoToMonoSampleProvider(src));
        return src;
    }

    public void Dispose()
    {
        foreach (var d in _disposables)
        {
            try { d.Dispose(); } catch { /* 破棄は続行 */ }
        }
        _disposables.Clear();
    }

    private sealed class TrackGainProvider : ISampleProvider
    {
        private readonly Session _session;
        private readonly Track _track;
        private readonly ISampleProvider _src;

        public TrackGainProvider(Session session, Track track, ISampleProvider src)
        {
            _session = session;
            _track = track;
            _src = src;
        }

        public WaveFormat WaveFormat => _src.WaveFormat;

        public int Read(float[] buffer, int offset, int count)
        {
            int n = _src.Read(buffer, offset, count);
            float g = _session.EffectiveGain(_track);
            if (g != 1f)
            {
                for (int i = 0; i < n; i++) buffer[offset + i] *= g;
            }
            return n;
        }
    }
}
