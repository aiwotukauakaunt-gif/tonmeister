using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace InstRecorder.Audio;

/// <summary>
/// 入力デバイス →（加工なし）→ ディスク の流れと、重ね録り用の再生を管理する。
/// オーディオスレッドではファイルI/Oを一切行わず、専用スレッドに渡す。
/// </summary>
public sealed class RecorderEngine : IDisposable
{
    private readonly ConcurrentQueue<(float[] buf, int count)> _queue = new();
    private readonly AutoResetEvent _dataReady = new(false);
    private Thread? _writerThread;
    private volatile bool _writerRunning;

    private IAudioInput? _input;
    private PartWavWriter? _writer;
    private SaveFormat _saveFormat = SaveFormat.Float32;
    private byte[] _byteBuf = Array.Empty<byte>();

    // 再生（重ね録り用）
    private SwitchableWaveProvider? _asioOutput; // ASIO は入出力が同じインスタンス
    private WasapiOut? _wasapiOut;
    // MMDevice は COM オブジェクトで、作ったスレッドの外から使うと
    // E_NOINTERFACE で落ちる。ID だけ持っておき、使う直前に、使うスレッドで作り直す。
    private string? _outputDeviceId;
    private MixingSampleProvider? _outputMixer;
    /// <summary>出力へ流す直前に挟む測定点。「音が出ているか」を画面に出すため。</summary>
    private OutputMeter? _outputMeter;
    private ISampleProvider? _mixInput;
    private bool _monitorInMixer;
    private SessionMix? _mix;
    private readonly Stopwatch _playClock = new();

    private float[] _peaks = Array.Empty<float>();
    private int[] _clips = Array.Empty<int>();
    private float[] _truePeaks = Array.Empty<float>();
    private int[] _flats = Array.Empty<int>();
    private int[] _flatBase = Array.Empty<int>();
    private int[] _flatRun = Array.Empty<int>();
    private float[] _flatMin = Array.Empty<float>(), _flatMax = Array.Empty<float>();
    private float[][] _tpHist = Array.Empty<float[]>();
    private int[] _tpWarm = Array.Empty<int>();

    /* True Peak（ITU-R BS.1770 の考え方）：12 タップの窓付き sinc で 4 倍に補間し、サンプルの間の最大を見る。
       Web 版 capture-core.js と同じ係数。 */
    private const int TpTaps = 12;
    private static readonly float[][] TpPhases = BuildTpPhases();
    private static float[][] BuildTpPhases()
    {
        var phases = new float[3][];
        double[] fr = { 0.25, 0.5, 0.75 };
        for (int p = 0; p < 3; p++)
        {
            var c = new float[TpTaps];
            double sum = 0;
            for (int k = -TpTaps / 2 + 1; k <= TpTaps / 2; k++)
            {
                double x = k - fr[p];
                double sinc = x == 0 ? 1 : Math.Sin(Math.PI * x) / (Math.PI * x);
                double w = 0.5 * (1 + Math.Cos(Math.PI * x / (TpTaps / 2)));
                c[k + TpTaps / 2 - 1] = (float)(sinc * w);
                sum += sinc * w;
            }
            for (int i = 0; i < TpTaps; i++) c[i] = (float)(c[i] / sum);
            phases[p] = c;
        }
        return phases;
    }
    /* 頭が平らになった波：0.97 以上で、揺れ 0.002 以下が 4 サンプル続いたら 1 回。プリアンプや ADC の手前の歪み */
    private const float FlatLevel = 0.97f, FlatSpread = 0.002f;
    private const int FlatRun = 4;
    private long _samplesWritten;
    private long _trimRemaining;
    private int _droppedBuffers;

    /// <summary>オーディオスレッドから生バッファを覗くための穴（レイテンシ測定用）。</summary>
    private volatile Action<float[], int>? _tap;

    private readonly MonitorBuffer _monitor = new();
    private bool _monitorEnabled;

    /// <summary>自分の生音をヘッドホンに返すか。返す音は録音される信号には一切影響しない。</summary>
    public bool MonitorEnabled
    {
        get => _monitorEnabled;
        set
        {
            _monitorEnabled = value;
            if (!value) _monitor.Clear();
            RefreshOutput();
        }
    }

    /// <summary>モニターの音量（0.0〜2.0）。</summary>
    public float MonitorVolume
    {
        get => _monitor.Volume;
        set => _monitor.Volume = value;
    }

    /// <summary>モニターが取りこぼした回数。バッファが枯れると音が途切れる。</summary>
    public int MonitorUnderruns => _monitor.Underruns;

    /// <summary>出力デバイスが今動いているか（配線が正しいかの確認用）。</summary>
    public bool IsOutputRunning => _asioOutput != null || _wasapiOut != null;

    public bool IsOpen => _input != null;
    public bool IsRecording { get; private set; }
    public bool IsPlaying { get; private set; }
    public int Channels => _input?.Channels ?? 0;
    public int SampleRate => _input?.SampleRate ?? 0;
    public string FormatDescription => _input?.FormatDescription ?? "-";
    public string? CurrentFilePath { get; private set; }
    public int DroppedBuffers => _droppedBuffers;

    /// <summary>WAV を切り替えるサイズ。テスト用に小さくできる。</summary>
    public long SplitBytes { get; set; } = PartWavWriter.DefaultSplitBytes;

    /// <summary>今の録音が何ファイルに分かれたか。</summary>
    public int PartCount => _writer?.Files.Count ?? 0;
    public bool UsesSharedClock => _asioOutput != null;

    public double PlaybackSeconds => _playClock.Elapsed.TotalSeconds;

    public double RecordedSeconds =>
        (_input == null || _input.Channels == 0 || _input.SampleRate == 0)
            ? 0
            : (double)_samplesWritten / _input.Channels / _input.SampleRate;

    public long RecordedBytes => _samplesWritten * _saveFormat.BytesPerSample();

    public event Action<string>? ErrorOccurred;
    /// <summary>4GB を超えて次のファイルに切り替わったとき。</summary>
    public event Action<string>? PartStarted;

    // ---------- 入力の開閉 ----------

    /// <param name="outputDeviceId">WASAPI 再生に使う出力デバイス。null なら既定のデバイス。</param>
    public void OpenInput(InputDeviceRef dev, FormatOption fmt, int asioChannelOffset,
                          string? outputDeviceId = null)
    {
        CloseInput();

        IAudioInput input;
        if (dev.Api == ApiKind.Asio)
        {
            // ASIO は録音と再生を1つのドライバインスタンスで行う（クロックも共有される）
            _asioOutput = new SwitchableWaveProvider(fmt.SampleRate, 2);
            input = new AsioInput(dev.Id, asioChannelOffset, fmt.Channels, fmt.SampleRate, _asioOutput);
        }
        else
        {
            _asioOutput = null;
            _outputDeviceId = outputDeviceId;
            input = new WasapiInput(
                DeviceScanner.GetMmDevice(dev.Id),
                fmt.WaveFormat ?? throw new InvalidOperationException("WASAPI のフォーマット情報がありません。"),
                dev.Api == ApiKind.WasapiExclusive);
        }

        _peaks = new float[input.Channels];
        _clips = new int[input.Channels];
        _truePeaks = new float[input.Channels];
        _flats = new int[input.Channels];
        _flatBase = new int[input.Channels];
        _flatRun = new int[input.Channels];
        _flatMin = new float[input.Channels];
        _flatMax = new float[input.Channels];
        _tpHist = new float[input.Channels][];
        _tpWarm = new int[input.Channels];
        for (int c = 0; c < input.Channels; c++) { _tpHist[c] = new float[TpTaps]; _tpWarm[c] = TpTaps; }
        input.BufferReady += OnBuffer;
        input.Failed += ex => ErrorOccurred?.Invoke(ex.Message);

        try
        {
            input.Start();
        }
        catch
        {
            input.Dispose();
            _asioOutput = null;
            throw;
        }

        _input = input;

        // 再生とモニターを1つのミキサーにまとめ、出力へはこれだけを流す
        _outputMixer = new MixingSampleProvider(
            WaveFormat.CreateIeeeFloatWaveFormat(input.SampleRate, 2))
        {
            ReadFully = true,
        };
        _outputMeter = new OutputMeter(_outputMixer);
        _monitorInMixer = false;
        _monitor.Configure(input.SampleRate, input.Channels, input.SampleRate / 50); // 20ms ぶん
        _asioOutput?.SetSource(_outputMeter);
        if (_monitorEnabled) RefreshOutput();
    }

    private static MMDevice? ResolveOutputDevice(string? id)
    {
        try
        {
            using var en = new MMDeviceEnumerator();
            return string.IsNullOrEmpty(id)
                ? en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
                : en.GetDevice(id);
        }
        catch { return null; }
    }

    public void CloseInput()
    {
        if (IsRecording) StopRecording();
        StopPlayback();

        _monitorInMixer = false;
        _monitor.Clear();
        StopOutputDevice();

        var input = _input;
        _input = null;
        if (input != null)
        {
            input.BufferReady -= OnBuffer;
            input.Dispose();
        }
        _asioOutput = null;
        _outputMixer = null;
        _outputMeter = null;
        _outputDeviceId = null;
    }

    // ---------- 出力（再生とモニターを1つのミキサーにまとめる） ----------

    /// <summary>
    /// WASAPI の出力は一度作ると数十msぶんのバッファを抱えるので、
    /// 再生を始めるときは必ず作り直す。そうしないと「再生が始まった瞬間」が
    /// レイテンシ測定時とズレて、重ね録りの頭が合わなくなる。
    /// </summary>
    private void StartOutputDevice()
    {
        if (_asioOutput != null) return; // ASIO は常時動いている
        if (_outputMixer == null) return;

        StopOutputDevice();

        // デバイスはここで、この呼び出しと同じスレッドで作る
        var device = ResolveOutputDevice(_outputDeviceId);
        var output = device != null
            ? new WasapiOut(device, AudioClientShareMode.Shared, true, 80)
            : new WasapiOut(AudioClientShareMode.Shared, 80);
        output.Init(new SampleToWaveProvider((ISampleProvider?)_outputMeter ?? _outputMixer));
        output.Play();
        _wasapiOut = output;
    }

    private void StopOutputDevice()
    {
        var output = _wasapiOut;
        _wasapiOut = null;
        if (output == null) return;
        // 別スレッドで作られた COM を掴んでいることがあるので、破棄まで含めて守る
        try { output.Stop(); } catch { /* 停止済み */ }
        try { output.Dispose(); } catch { /* 破棄できなくても続行 */ }
    }

    /// <summary>出す音が無くなったら出力デバイスを解放する（他アプリの邪魔をしない）。</summary>
    private void StopOutputDeviceIfIdle()
    {
        if (_asioOutput != null) return;
        if (_monitorInMixer || _mixInput != null) return;
        StopOutputDevice();
    }

    private void RefreshOutput()
    {
        if (_outputMixer == null) return;

        if (_monitorEnabled && !_monitorInMixer)
        {
            _outputMixer.AddMixerInput(_monitor);
            _monitorInMixer = true;
            StartOutputDevice();
        }
        else if (!_monitorEnabled && _monitorInMixer)
        {
            _outputMixer.RemoveMixerInput(_monitor);
            _monitorInMixer = false;
            StopOutputDeviceIfIdle();
        }
    }

    // ---------- 再生 ----------

    /// <summary>セッションを再生する。鳴らせるトラックが無ければ false。</summary>
    public bool StartPlayback(Session session, Track? exclude = null, double startSeconds = 0)
    {
        if (_input == null) throw new InvalidOperationException("先に入力デバイスを開いてください。");
        StopPlayback();

        var mix = SessionMix.Build(session, exclude, startSeconds);
        if (mix == null) return false;

        if (mix.SampleRate != _input.SampleRate)
        {
            mix.Dispose();
            throw new InvalidOperationException(
                $"セッションは {mix.SampleRate / 1000.0:0.#} kHz ですが、入力は {_input.SampleRate / 1000.0:0.#} kHz です。\n" +
                "同じサンプルレートで開き直すか、新しいセッションを作ってください。");
        }

        _mix = mix;
        AddOutputSource(mix.Provider);
        _playClock.Restart();
        IsPlaying = true;
        return true;
    }

    /// <summary>再生ソースをミキサーに載せ、出力を頭から動かす。</summary>
    private void AddOutputSource(ISampleProvider provider)
    {
        if (_outputMixer == null) return;
        RemoveMixInput();
        _outputMixer.AddMixerInput(provider);
        _mixInput = provider;
        StartOutputDevice();
    }

    private void RemoveMixInput()
    {
        if (_outputMixer != null && _mixInput != null)
        {
            try { _outputMixer.RemoveMixerInput(_mixInput); } catch { /* 既に外れている */ }
        }
        _mixInput = null;
    }

    public void StopPlayback()
    {
        IsPlaying = false;
        _playClock.Reset();

        RemoveMixInput();
        StopOutputDeviceIfIdle();

        _mix?.Dispose();
        _mix = null;
    }

    // ---------- 録音 ----------

    /// <param name="trimFrames">
    /// 録音の頭から捨てるフレーム数。重ね録りでは「出力遅延＋入力遅延」のぶんだけ
    /// 演奏が後ろにズレて記録されるため、ここで削って既存トラックと揃える。
    /// </param>
    public void StartRecording(string path, SaveFormat saveFormat)
    {
        PrepareWriter(path, saveFormat);
        _trimRemaining = 0;
        IsRecording = true;
    }

    /// <param name="intoTrack">
    /// 既存トラックにテイクを足す場合はそのトラック。そのトラックは再生から外す
    /// （前のテイクが耳に返ってくると重なって聴こえるため）。
    /// </param>
    public bool StartOverdub(Session session, string path, SaveFormat saveFormat, int trimFrames,
                             Track? intoTrack, double startSeconds = 0)
    {
        if (_input == null) throw new InvalidOperationException("先に入力デバイスを開いてください。");
        if (IsRecording) return false;

        PrepareWriter(path, saveFormat);

        bool playing = false;
        try
        {
            playing = StartPlayback(session, intoTrack, startSeconds);
        }
        catch
        {
            _writerRunning = false;
            _writer?.Dispose();
            _writer = null;
            throw;
        }

        _trimRemaining = playing ? (long)Math.Max(0, trimFrames) * _input.Channels : 0;
        IsRecording = true;
        return playing;
    }

    private void PrepareWriter(string path, SaveFormat saveFormat)
    {
        if (_input == null) throw new InvalidOperationException("先に入力デバイスを開いてください。");

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        _saveFormat = saveFormat;
        _samplesWritten = 0;
        _droppedBuffers = 0;
        var fmt = saveFormat.ToWaveFormat(_input.SampleRate, _input.Channels);
        var bext = new BwfInfo(
            Description: Path.GetFileNameWithoutExtension(path),
            OriginatorReference: DateTime.Now.ToString("yyyyMMddHHmmss"),
            TimeReferenceSamples: 0,
            CodingHistory: $"A=PCM,F={fmt.SampleRate},W={fmt.BitsPerSample},M={(fmt.Channels == 1 ? "mono" : fmt.Channels == 2 ? "stereo" : fmt.Channels + "ch")}," +
                           $"T=Tonmeister desktop;input={_input.FormatDescription.Replace(',', ' ')}\r\n");
        _writer = new PartWavWriter(path, fmt, SplitBytes, bext);
        _writer.PartStarted += p => PartStarted?.Invoke(p);
        CurrentFilePath = path;

        _writerRunning = true;
        _writerThread = new Thread(WriterLoop)
        {
            IsBackground = true,
            Name = "RecorderWriter",
            Priority = ThreadPriority.AboveNormal,
        };
        _writerThread.Start();
    }

    /// <summary>録音を止め、書き出されたファイル（分割された場合は複数）を返す。</summary>
    public IReadOnlyList<string> StopRecording()
    {
        if (!IsRecording) return Array.Empty<string>();
        IsRecording = false;

        // 残りをすべて書き切ってから閉じる
        _writerRunning = false;
        _dataReady.Set();
        _writerThread?.Join(3000);
        _writerThread = null;

        DrainQueue();

        var writer = _writer;
        _writer = null;
        if (writer == null) return Array.Empty<string>();

        writer.Dispose();
        return writer.Files.ToList();
    }

    // ---------- オーディオスレッド ----------

    private void OnBuffer(float[] samples, int count)
    {
        if (count <= 0) return;

        _tap?.Invoke(samples, count);

        // モニターは録音される信号とは完全に別経路。ここで何をしても記録内容は変わらない。
        if (_monitorEnabled) _monitor.Push(samples, count);

        // メーター（録音していなくても常に更新する）：サンプルピーク・True Peak・割れ・平らな頭
        int ch = _peaks.Length;
        if (ch > 0)
        {
            for (int i = 0; i < count; i++)
            {
                int c = i % ch;
                float v = samples[i];
                float a = MathF.Abs(v);
                if (a > _peaks[c]) _peaks[c] = a;
                if (a >= 1.0f) _clips[c]++;

                if (a >= FlatLevel)
                {
                    if (_flatRun[c] == 0) { _flatMin[c] = a; _flatMax[c] = a; }
                    else { if (a < _flatMin[c]) _flatMin[c] = a; if (a > _flatMax[c]) _flatMax[c] = a; }
                    _flatRun[c]++;
                    if (_flatMax[c] - _flatMin[c] > FlatSpread) { _flatRun[c] = 1; _flatMin[c] = a; _flatMax[c] = a; }
                    else if (_flatRun[c] == FlatRun) _flats[c]++;
                }
                else _flatRun[c] = 0;

                var h = _tpHist[c];
                Array.Copy(h, 1, h, 0, TpTaps - 1);
                h[TpTaps - 1] = v;
                if (_tpWarm[c] > 0) { _tpWarm[c]--; continue; }
                float tp = _truePeaks[c];
                for (int p = 0; p < 3; p++)
                {
                    var coef = TpPhases[p];
                    float y = 0;
                    for (int k = 0; k < TpTaps; k++) y += h[k] * coef[k];
                    float ay = MathF.Abs(y);
                    if (ay > tp) tp = ay;
                }
                if (a > tp) tp = a;
                _truePeaks[c] = tp;
            }
        }

        if (!IsRecording) return;

        int start = 0;
        if (_trimRemaining > 0)
        {
            int skip = (int)Math.Min(_trimRemaining, count);
            _trimRemaining -= skip;
            start = skip;
            if (start >= count) return;
        }

        int len = count - start;
        if (_queue.Count > 256)
        {
            // 書き込みが追いつかない異常事態。無音で埋めるより欠落を明示する。
            Interlocked.Increment(ref _droppedBuffers);
            return;
        }

        var copy = ArrayPool<float>.Shared.Rent(len);
        Array.Copy(samples, start, copy, 0, len);
        _queue.Enqueue((copy, len));
        _dataReady.Set();
    }

    // ---------- 書き込みスレッド ----------

    private void WriterLoop()
    {
        try
        {
            while (_writerRunning)
            {
                _dataReady.WaitOne(200);
                DrainQueue();
            }
        }
        catch (Exception ex)
        {
            ErrorOccurred?.Invoke("書き込みに失敗しました: " + ex.Message);
        }
    }

    private void DrainQueue()
    {
        while (_queue.TryDequeue(out var item))
        {
            try
            {
                var writer = _writer;
                if (writer != null)
                {
                    int bytes = SampleConvert.FromFloat(item.buf, item.count, _saveFormat, ref _byteBuf);
                    writer.Write(_byteBuf, bytes);
                    _samplesWritten += item.count;
                }
            }
            finally
            {
                ArrayPool<float>.Shared.Return(item.buf);
            }
        }
    }

    // ---------- レイテンシ測定 ----------

    private const float ClickFrequency = 1000f;

    /// <param name="Frames">往復のフレーム数。測れなければ -1。</param>
    /// <param name="Peak">クリック帯域で観測した最大レベル。</param>
    /// <param name="Noise">同じ帯域の暗騒音。</param>
    /// <param name="Detail">各回の測定値など、失敗理由を追える情報。</param>
    public sealed record LatencyResult(int Frames, float Peak, float Noise, string Detail)
    {
        public static string Db(float v) => v > 0 ? $"{20 * Math.Log10(v):0.0} dBFS" : "-inf";
        public bool Success => Frames >= 0;
    }

    /// <summary>
    /// テスト音を出して、それが録音側に返ってくるまでのフレーム数を測る。
    /// 出力遅延＋空気/ケーブル＋入力遅延の合計＝重ね録りで削るべき量そのもの。
    ///
    /// 単純なピーク検出だと物音を誤検出するので、
    ///   (1) テスト音と同じ 1kHz の成分だけを見る整合フィルタ
    ///   (2) 複数回測って値が一致したときだけ採用する
    /// の二段構えにしている。一致しなければ「測れなかった」と正直に返す。
    /// </summary>
    public LatencyResult MeasureRoundTrip(int trials = 3, int timeoutMs = 1200)
    {
        if (_input == null) throw new InvalidOperationException("先に入力デバイスを開いてください。");
        if (IsRecording) throw new InvalidOperationException("録音中は測定できません。");

        int rate = _input.SampleRate;
        var results = new List<int>();
        float bestPeak = 0, bestNoise = 0;
        var detail = new List<string>();

        for (int t = 0; t < trials; t++)
        {
            var one = MeasureOnce(timeoutMs);
            bestPeak = Math.Max(bestPeak, one.Peak);
            bestNoise = Math.Max(bestNoise, one.Noise);
            detail.Add(one.Frames >= 0 ? $"{1000.0 * one.Frames / rate:0.0}ms" : "検出なし");
            if (one.Frames >= 0) results.Add(one.Frames);
            Thread.Sleep(120);
        }

        string detailText = "各回: " + string.Join(" / ", detail);

        // 2回以上が 10ms 以内で一致していれば本物とみなす
        int tolerance = rate / 100;
        foreach (var candidate in results.OrderBy(x => x))
        {
            var agree = results.Where(x => Math.Abs(x - candidate) <= tolerance).ToList();
            if (agree.Count >= 2)
            {
                agree.Sort();
                return new LatencyResult(agree[agree.Count / 2], bestPeak, bestNoise, detailText);
            }
        }

        return new LatencyResult(-1, bestPeak, bestNoise, detailText);
    }

    /// <summary>
    /// 解析用に生の入力を指定秒数ぶん取り込む。録音経路には一切手を加えないので、
    /// ここで得られる値がそのまま「このデバイスで録れる音」の素性になる。
    /// </summary>
    public (float[] Samples, int Frames, int Channels, int Rate) CaptureForAnalysis(double seconds)
    {
        if (_input == null) throw new InvalidOperationException("先に入力デバイスを開いてください。");
        if (IsRecording) throw new InvalidOperationException("録音中は測定できません。");

        int rate = _input.SampleRate;
        int channels = _input.Channels;
        int wanted = (int)(rate * seconds) * channels;

        var captured = new List<float>(wanted);
        var done = new ManualResetEventSlim(false);

        _tap = (buf, count) =>
        {
            lock (captured)
            {
                int take = Math.Min(count, wanted - captured.Count);
                for (int i = 0; i < take; i++) captured.Add(buf[i]);
                if (captured.Count >= wanted) done.Set();
            }
        };

        try
        {
            done.Wait((int)(seconds * 1000) + 2000);
        }
        finally
        {
            _tap = null;
        }

        float[] samples;
        lock (captured) samples = captured.ToArray();
        return (samples, samples.Length / channels, channels, rate);
    }

    public enum ProcessingVerdict
    {
        /// <summary>静かな間だけ入力が絞られている。</summary>
        Gated,
        /// <summary>素の入力が届いている。</summary>
        Clean,
        /// <summary>テスト音が拾えず判定できない。</summary>
        Undetermined,
    }

    /// <param name="LoudRmsDb">音を鳴らしている間のレベル。</param>
    /// <param name="QuietRmsDb">静かにしてしばらく経ったあとのレベル。</param>
    public sealed record ProcessingCheck(ProcessingVerdict Verdict, double LoudRmsDb,
                                         double QuietRmsDb, string Detail)
    {
        public double DropDb => LoudRmsDb - QuietRmsDb;
        public bool Gated => Verdict == ProcessingVerdict.Gated;
    }

    /// <summary>
    /// OS の音声補正（ノイズ抑制）が入力を加工していないかを調べる。
    ///
    /// 音を鳴らしている間と、静かにしてしばらく経ったあとのレベルを比べる。
    /// 素の入力なら、暗騒音は鳴らしていた音より 20〜40 dB 低い程度に収まる。
    /// 60 dB 以上も落ちるなら、静かな間だけ潰す仕組みが働いている。
    /// これが働いていると「実際に鳴っている音」は記録されない。
    /// </summary>
    public ProcessingCheck CheckInputProcessing()
    {
        if (_input == null) throw new InvalidOperationException("先に入力デバイスを開いてください。");
        if (IsRecording) throw new InvalidOperationException("録音中は検査できません。");

        bool previousMonitor = _monitorEnabled;
        MonitorEnabled = false;

        double loud, quiet;
        try
        {
            // 鳴らしている間
            var tone = new ClickProvider(_input.SampleRate, continuous: true);
            AddOutputSource(tone);
            Thread.Sleep(700); // 補正が開くのを待つ
            loud = Rms(CaptureForAnalysis(1.5).Samples);
            RemoveMixInput();
            StopOutputDeviceIfIdle();

            // 静かにしてしばらく経ったあと
            Thread.Sleep(2500);
            quiet = Rms(CaptureForAnalysis(2.0).Samples);
        }
        finally
        {
            RemoveMixInput();
            StopOutputDeviceIfIdle();
            MonitorEnabled = previousMonitor;
        }

        double loudDb = loud > 0 ? 20 * Math.Log10(loud) : -200;
        double quietDb = quiet > 0 ? 20 * Math.Log10(quiet) : -200;
        double drop = loudDb - quietDb;

        // 判定は「鳴らしたときと静かなときの差」で行う。
        // スピーカーの音量が小さくてもテスト音が届いていれば差ははっきり出るので、
        // 絶対レベルでテスト音の有無を決めてはいけない。
        if (drop > 60)
            return new ProcessingCheck(ProcessingVerdict.Gated, loudDb, quietDb,
                $"音を止めると {drop:0} dB も落ちます。静かな間だけ入力を潰す処理が入っています。");

        // 差が小さいうえに全体が極端に低いなら、テスト音自体が届いていない
        if (drop < 10 && loudDb < -90)
            return new ProcessingCheck(ProcessingVerdict.Undetermined, loudDb, quietDb,
                "テスト音を拾えませんでした。スピーカーの音量を上げるか、" +
                "マイクに近づけてもう一度試してください。");

        return new ProcessingCheck(ProcessingVerdict.Clean, loudDb, quietDb,
            $"音を止めたときの差は {drop:0} dB。素の入力が届いていると考えられます。");
    }

    private static double Rms(float[] x)
    {
        if (x.Length == 0) return 0;
        double sum = 0;
        foreach (var v in x) sum += (double)v * v;
        return Math.Sqrt(sum / x.Length);
    }

    private LatencyResult MeasureOnce(int timeoutMs)
    {
        StopPlayback();

        int rate = _input!.SampleRate;
        int channels = _input.Channels;
        int maxFrames = rate * timeoutMs / 1000;

        var captured = new List<float>(maxFrames);
        var done = new ManualResetEventSlim(false);

        // 整合フィルタにかけるので、絶対値ではなく生の波形を残す
        // （整流すると 1kHz 成分が消えて検出できなくなる）
        _tap = (buf, count) =>
        {
            lock (captured)
            {
                for (int i = 0; i + channels <= count; i += channels)
                {
                    float v = 0;
                    for (int c = 0; c < channels; c++) v += buf[i + c];
                    captured.Add(v / channels);
                }
                if (captured.Count >= maxFrames) done.Set();
            }
        };

        // 測定中は自分のモニター音が混ざらないようにする
        bool previousMonitor = _monitorEnabled;
        MonitorEnabled = false;

        var click = new ClickProvider(rate);
        try
        {
            AddOutputSource(click);
            // 基準点を録音時と揃える：再生が始まった直後から数える
            lock (captured) captured.Clear();
            done.Wait(timeoutMs + 500);
        }
        finally
        {
            _tap = null;
            RemoveMixInput();
            StopOutputDeviceIfIdle();
            MonitorEnabled = previousMonitor;
        }

        float[] frames;
        lock (captured) frames = captured.ToArray();

        return FindClick(frames, rate);
    }

    /// <summary>
    /// 1kHz 成分のエネルギーが立ち上がる位置を探す。
    /// 物音は帯域が広いので、この帯域だけ見ると誤検出が大きく減る。
    /// </summary>
    private static LatencyResult FindClick(float[] frames, int rate)
    {
        int window = rate / 100;          // 10ms（テスト音の長さと同じ）
        int step = Math.Max(1, rate / 6000); // 約0.17ms刻み
        int skip = Math.Min(Math.Max(0, frames.Length - 1), rate / 500);

        if (frames.Length < skip + window + step)
            return new LatencyResult(-1, 0, 0, "録音が短すぎます");

        double w = 2 * Math.PI * ClickFrequency / rate;
        double coeff = 2 * Math.Cos(w);

        int count = (frames.Length - window - skip) / step;
        var env = new float[count];
        for (int k = 0; k < count; k++)
        {
            int start = skip + k * step;
            double s1 = 0, s2 = 0;
            for (int n = 0; n < window; n++)
            {
                double s0 = frames[start + n] + coeff * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
            env[k] = (float)(2 * Math.Sqrt(Math.Max(0, power)) / window);
        }

        var sorted = (float[])env.Clone();
        Array.Sort(sorted);
        float noise = sorted[sorted.Length / 2];

        float peak = 0;
        int peakIndex = -1;
        for (int k = 0; k < count; k++)
        {
            if (env[k] > peak) { peak = env[k]; peakIndex = k; }
        }

        // 判定の主軸は「1kHz 帯で暗騒音より桁違いに大きいか」。
        // 音量が小さくても帯域を絞れば十分検出できるので、絶対値の下限は低めでよい。
        // 誤検出は複数回の一致判定でふるい落とす。
        if (peakIndex < 0 || peak < 0.0003f || peak < noise * 10)
            return new LatencyResult(-1, peak, noise, "");

        float threshold = Math.Max(peak * 0.35f, noise * 5);
        for (int k = 0; k <= peakIndex; k++)
        {
            if (env[k] >= threshold)
                return new LatencyResult(skip + k * step, peak, noise, "");
        }
        return new LatencyResult(skip + peakIndex * step, peak, noise, "");
    }

    /// <summary>測定用のテスト音（1kHz を 10ms）。先頭に無音を置かず、即座に鳴らす。</summary>
    private sealed class ClickProvider : ISampleProvider
    {
        private readonly int _burstSamples;
        private readonly bool _continuous;
        private int _pos;

        /// <param name="continuous">true なら鳴らし続ける（音声補正の検査用）。</param>
        public ClickProvider(int rate, bool continuous = false)
        {
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(rate, 2);
            _continuous = continuous;
            _burstSamples = rate / 100; // 10ms
        }

        public WaveFormat WaveFormat { get; }

        public int Read(float[] buffer, int offset, int count)
        {
            int rate = WaveFormat.SampleRate;
            for (int i = 0; i < count; i += 2)
            {
                int frame = _pos++;
                float v = 0;
                if (_continuous)
                {
                    v = 0.5f * MathF.Sin(2 * MathF.PI * ClickFrequency * frame / rate);
                }
                else if (frame < _burstSamples)
                {
                    // 端で切れるとブツッというノイズになるので窓をかける
                    float env = MathF.Sin(MathF.PI * frame / _burstSamples);
                    v = 0.9f * env * MathF.Sin(2 * MathF.PI * ClickFrequency * frame / rate);
                }
                buffer[offset + i] = v;
                if (i + 1 < count) buffer[offset + i + 1] = v;
            }
            return count;
        }
    }

    // ---------- メーター ----------

    /// <summary>前回呼び出し以降のピーク（0..1+）を返し、内部値をリセットする。</summary>
    public float[] ReadPeaks()
    {
        var result = new float[_peaks.Length];
        for (int i = 0; i < _peaks.Length; i++)
        {
            result[i] = _peaks[i];
            _peaks[i] = 0f;
        }
        return result;
    }

    public int[] ReadClipCounts() => (int[])_clips.Clone();

    /// <summary>前回呼び出し以降の True Peak（サンプルの間も含めた最大）。</summary>
    public float[] ReadTruePeaks()
    {
        var result = (float[])_truePeaks.Clone();
        Array.Clear(_truePeaks, 0, _truePeaks.Length);
        return result;
    }

    /// <summary>0 dBFS に届かないまま頭が平らになった回数（機材側の歪み）。</summary>
    public int[] ReadFlatCounts()
    {
        var result = new int[_flats.Length];
        for (int i = 0; i < result.Length; i++) result[i] = _flats[i] - _flatBase[i];
        return result;
    }
    public void ResetFlats() { for (int i = 0; i < _flats.Length; i++) _flatBase[i] = _flats[i]; }

    /// <summary>
    /// 前回呼び出し以降に、実際に出力へ流れた音のピーク（0..1+）。
    /// 「再生したのに聞こえない」とき、音が出ていないのか、
    /// 出ているが機器側で絞られているのかを切り分けるために使う。
    /// </summary>
    public float ReadOutputPeak() => _outputMeter?.ReadPeak() ?? 0f;

    /// <summary>出力へ流れる音を素通しさせながら、ピークだけ控える。</summary>
    private sealed class OutputMeter : ISampleProvider
    {
        private readonly ISampleProvider _source;
        private float _peak;

        public OutputMeter(ISampleProvider source) => _source = source;

        public WaveFormat WaveFormat => _source.WaveFormat;

        public int Read(float[] buffer, int offset, int count)
        {
            int read = _source.Read(buffer, offset, count);
            float peak = _peak;
            for (int i = 0; i < read; i++)
            {
                float a = MathF.Abs(buffer[offset + i]);
                if (a > peak) peak = a;
            }
            _peak = peak;
            return read;
        }

        public float ReadPeak()
        {
            float v = _peak;
            _peak = 0f;
            return v;
        }
    }

    public void ResetClips()
    {
        for (int i = 0; i < _clips.Length; i++) _clips[i] = 0;
    }

    public void Dispose()
    {
        CloseInput();
        _dataReady.Dispose();
    }
}
