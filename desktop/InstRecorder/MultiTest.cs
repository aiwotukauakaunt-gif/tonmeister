using System.Diagnostics;
using System.IO;
using System.Text;
using InstRecorder.Audio;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace InstRecorder;

/// <summary>
/// 多重録音まわりを GUI 無しで検証する開発用モード。
/// 使い方: InstRecorder.exe --mtest [レポート出力先]
/// </summary>
internal static class MultiTest
{
    public static void Run(string reportPath)
    {
        var log = new StringBuilder();
        void W(string s) => log.AppendLine(s);

        string root = Path.Combine(Path.GetTempPath(), "instrec_mtest");
        if (Directory.Exists(root)) Directory.Delete(root, true);
        Directory.CreateDirectory(root);

        using var engine = new RecorderEngine();

        try
        {
            // 使える入力を1つ選ぶ
            var dev = DeviceScanner.ScanDevices()
                .Where(d => d.Api != ApiKind.Asio)
                .OrderBy(d => d.Api == ApiKind.WasapiExclusive ? 0 : 1)
                .FirstOrDefault(d => DeviceScanner.ScanFormats(d).Count > 0);

            if (dev == null)
            {
                W("使える入力デバイスがありません。");
                File.WriteAllText(reportPath, log.ToString(), new UTF8Encoding(false));
                return;
            }

            var fmt = DeviceScanner.ScanFormats(dev)[0];
            W($"入力: {dev} / {fmt}");
            engine.OpenInput(dev, fmt, 0);
            W($"経路: {engine.FormatDescription}");
            W("");

            var session = Session.CreateNew(root);
            W($"=== セッション作成 === {session.Name}");

            // --- 1本目（再生なし） ---
            var path1 = session.NextRecordingPath(SaveFormat.Float32, null);
            bool overdub1 = engine.StartOverdub(session, path1, SaveFormat.Float32, 0, null);
            Thread.Sleep(1500);
            var files1 = engine.StopRecording();
            engine.StopPlayback();
            var t1 = AddTrack(session, files1);
            W($"1本目: 重ね録り={overdub1}（トラックが無いので false が正しい） " +
              $"長さ {t1.Seconds:0.000} 秒 / {t1.ActiveTake!.Channels}ch");

            // --- 2本目（1本目を再生しながら／レイテンシ補正あり） ---
            int trim = engine.SampleRate / 10; // 0.1秒ぶん削る
            var path2 = session.NextRecordingPath(SaveFormat.Float32, null);
            bool overdub2 = engine.StartOverdub(session, path2, SaveFormat.Float32, trim, null);
            // 計測は「録音が始まってから」。StartOverdub の初期化時間を含めない。
            var sw = Stopwatch.StartNew();
            Thread.Sleep(1500);
            var files2 = engine.StopRecording();
            sw.Stop();
            engine.StopPlayback();
            var t2 = AddTrack(session, files2);

            double expected = sw.Elapsed.TotalSeconds - (double)trim / engine.SampleRate;
            W($"2本目: 重ね録り={overdub2}（true が正しい） 長さ {t2.Seconds:0.000} 秒");
            W($"    レイテンシ補正 {trim} サンプル = {1000.0 * trim / engine.SampleRate:0.0} ms を削った");
            W($"    実測 {sw.Elapsed.TotalSeconds:0.000} 秒 − 補正 ⇒ 期待 {expected:0.000} 秒 / " +
              $"差 {Math.Abs(t2.Seconds - expected) * 1000:0} ms " +
              (Math.Abs(t2.Seconds - expected) < 0.15 ? "→ OK" : "→ 要調査"));
            W("");

            // --- 既存トラックへのテイク追加（前のテイクは再生から外れるべき） ---
            var target = session.Tracks[0];
            var pathT2 = session.NextRecordingPath(SaveFormat.Float32, target);
            engine.StartOverdub(session, pathT2, SaveFormat.Float32, 0, target);
            Thread.Sleep(800);
            var filesT2 = engine.StopRecording();
            engine.StopPlayback();
            target.AddTake(Take.FromFiles($"テイク {target.Takes.Count + 1}", filesT2));
            W($"テイク追加: 「{target.Name}」が {target.Takes.Count} テイクに / " +
              $"選択中={target.ActiveTake!.Name}（最後に録ったものが選ばれるのが正しい）");
            W($"    録り直し中の再生から本人を外せているか: " +
              (SessionMix.Build(session, target) is { } m
                  ? Check(m, session, target)
                  : "ミックス作成失敗"));
            W("");

            // --- 長時間録音の自動分割 ---
            engine.SplitBytes = 400_000; // テストのため小さくする（実際は 3.9GB）
            var pathSplit = session.NextRecordingPath(SaveFormat.Float32, null);
            engine.StartRecording(pathSplit, SaveFormat.Float32);
            Thread.Sleep(1200);
            var splitFiles = engine.StopRecording();
            engine.SplitBytes = PartWavWriter.DefaultSplitBytes;
            var splitTake = Take.FromFiles("テイク 1", splitFiles);
            W("=== 長時間録音の自動分割 ===");
            W($"    {splitFiles.Count} ファイルに分割 / 合計 {splitTake.Seconds:0.000} 秒");
            foreach (var f in splitFiles)
                W($"      {Path.GetFileName(f)}  {new FileInfo(f).Length:N0} バイト");
            double expectedSplit = 1.2;
            W($"    連続性: 合計 {splitTake.Seconds:0.000} 秒 vs 実測 約 {expectedSplit:0.0} 秒 " +
              (Math.Abs(splitTake.Seconds - expectedSplit) < 0.2 ? "→ OK（サンプルの欠落なし）" : "→ 要調査"));
            W("");

            // --- セッションの保存と読み直し ---
            session.Save();
            var reloaded = Session.Load(session.Folder);
            W($"=== 保存/読込 === トラック {reloaded.Tracks.Count} 本 / " +
              $"{reloaded.SampleRate / 1000.0:0.#} kHz / " +
              (reloaded.Tracks.Count == session.Tracks.Count ? "一致" : "不一致"));

            // --- ミュート・ソロの実効ゲイン ---
            reloaded.Tracks[0].Volume = 0.5f;
            reloaded.Tracks[1].Muted = true;
            W($"ゲイン確認: T1(vol0.5)={reloaded.EffectiveGain(reloaded.Tracks[0])} " +
              $"T2(mute)={reloaded.EffectiveGain(reloaded.Tracks[1])}");
            reloaded.Tracks[1].Muted = false;
            reloaded.Tracks[1].Soloed = true;
            W($"ソロ確認: T1={reloaded.EffectiveGain(reloaded.Tracks[0])}（0 が正しい） " +
              $"T2={reloaded.EffectiveGain(reloaded.Tracks[1])}");
            reloaded.Tracks[1].Soloed = false;
            reloaded.Tracks[0].Volume = 1f;
            W("");

            // --- ミックスダウン ---
            var mixPath = Path.Combine(reloaded.Folder, "mixdown.wav");
            var r = Mixdown.Export(reloaded, mixPath, SaveFormat.Float32);
            double longest = reloaded.Tracks.Max(t => t.Seconds);
            using (var reader = new WaveFileReader(mixPath))
            {
                W($"=== ミックスダウン ===");
                W($"    長さ {reader.TotalTime.TotalSeconds:0.000} 秒 / 最長トラック {longest:0.000} 秒 " +
                  (Math.Abs(reader.TotalTime.TotalSeconds - longest) < 0.05 ? "→ OK" : "→ 要調査"));
                W($"    形式 {reader.WaveFormat} / ピーク " +
                  (r.Peak > 0 ? $"{20 * Math.Log10(r.Peak):0.0} dBFS" : "-inf"));
            }
            W("");

            // --- ダイレクトモニタリング ---
            W("=== ダイレクトモニタリング ===");
            W("    " + MonitorBufferCheck());
            W("    " + MonitorPathCheck(engine));
            W("");

            // --- 再生経路そのものの確認（スピーカー音量に依存しない） ---
            W("=== 再生経路のループバック確認 ===");
            W("    " + CheckOutputPath());
            W("");

            // --- レイテンシ自動測定 ---
            W("=== レイテンシ自動測定（マイクで拾えるかどうか） ===");
            var lat = engine.MeasureRoundTrip();
            W(lat.Success
                ? $"    {lat.Frames} サンプル = {1000.0 * lat.Frames / engine.SampleRate:0.0} ms " +
                  $"/ クリック {RecorderEngine.LatencyResult.Db(lat.Peak)}"
                : $"    測定不能。最大 {RecorderEngine.LatencyResult.Db(lat.Peak)} / " +
                  $"暗騒音 {RecorderEngine.LatencyResult.Db(lat.Noise)}");
            W($"    {lat.Detail}");
            W($"    再生先: {DeviceScanner.OutputVolumeInfo(null)}");

            engine.CloseInput();
            W("");
            W($"生成物: {reloaded.Folder}");
        }
        catch (Exception ex)
        {
            W("エラー: " + ex);
        }

        File.WriteAllText(reportPath, log.ToString(), new UTF8Encoding(false));
    }

    /// <summary>モニター用リングバッファの中身が入力と一致するか（音を変えていないか）を確かめる。</summary>
    private static string MonitorBufferCheck()
    {
        var results = new List<string>();

        // ステレオ：入れた値がそのまま出てくること
        var mb = new MonitorBuffer();
        mb.Configure(48000, 2, 4800);
        var src = new float[200];
        for (int i = 0; i < src.Length; i++) src[i] = (i % 100) / 100f - 0.5f;
        mb.Push(src, src.Length);
        var dst = new float[200];
        mb.Read(dst, 0, dst.Length);
        bool same = src.SequenceEqual(dst);
        results.Add($"ステレオ素通し {(same ? "一致" : "不一致")}");

        // モノラル：左右に同じ値が複製されること
        mb = new MonitorBuffer();
        mb.Configure(48000, 1, 4800);
        var mono = new float[] { 0.1f, 0.2f, 0.3f };
        mb.Push(mono, mono.Length);
        var outBuf = new float[6];
        mb.Read(outBuf, 0, 6);
        bool dup = outBuf[0] == 0.1f && outBuf[1] == 0.1f && outBuf[2] == 0.2f
                   && outBuf[3] == 0.2f && outBuf[4] == 0.3f && outBuf[5] == 0.3f;
        results.Add($"モノラル複製 {(dup ? "OK" : "NG")}");

        // 溜まりすぎたら古い方を捨てて遅延を育てないこと
        mb = new MonitorBuffer();
        mb.Configure(48000, 2, 512); // maxFill = 1024
        var big = new float[8000];
        for (int i = 0; i < big.Length; i++) big[i] = 1f;
        mb.Push(big, big.Length);
        var drain = new float[8000];
        mb.Read(drain, 0, drain.Length);
        int held = drain.Count(v => v != 0f);
        results.Add($"遅延の上限 {(held <= 1024 ? "OK" : "NG")}（8000 入れて保持 {held}、上限 1024）");

        // 足りないときは無音で埋め、取りこぼしを数えること
        mb = new MonitorBuffer();
        mb.Configure(48000, 2, 4800);
        mb.Push(new float[10], 10);
        var starve = new float[100];
        mb.Read(starve, 0, 100);
        results.Add($"枯渇時の埋め {(mb.Underruns == 1 ? "OK" : "NG")}");

        return "バッファ: " + string.Join(" / ", results);
    }

    /// <summary>
    /// モニターの配線が正しいかを、音ではなく状態で確かめる。
    /// 音で確かめようとすると、他アプリの音やハウリングが混ざって判定できない。
    /// </summary>
    private static string MonitorPathCheck(RecorderEngine engine)
    {
        var steps = new List<string>();

        bool idleBefore = engine.IsOutputRunning;
        steps.Add($"モニターOFF時に出力停止 {(idleBefore ? "NG" : "OK")}");

        engine.MonitorEnabled = true;
        Thread.Sleep(200);
        steps.Add($"モニターONで出力開始 {(engine.IsOutputRunning ? "OK" : "NG")}");

        int underrunsAtStart = engine.MonitorUnderruns;
        Thread.Sleep(600);
        int newUnderruns = engine.MonitorUnderruns - underrunsAtStart;
        steps.Add($"0.6秒間の途切れ {newUnderruns} 回{(newUnderruns <= 2 ? "" : "（多い）")}");

        engine.MonitorEnabled = false;
        Thread.Sleep(200);
        steps.Add($"モニターOFFで出力解放 {(engine.IsOutputRunning ? "NG" : "OK")}");

        return "実経路: " + string.Join(" / ", steps);
    }

    /// <summary>
    /// 既定の出力デバイスに正弦波を流し、同じデバイスのループバックで拾えるか確かめる。
    /// スピーカーの音量やミュートに左右されずに「アプリが音を出せているか」だけを見られる。
    /// </summary>
    private static string CheckOutputPath()
    {
        try
        {
            var gen = new NAudio.Wave.SampleProviders.SignalGenerator(48000, 2)
            {
                Gain = 0.5,
                Frequency = 1000,
                Type = NAudio.Wave.SampleProviders.SignalGeneratorType.Sin,
            };

            using var capture = new WasapiLoopbackCapture();
            float peak = 0;
            capture.DataAvailable += (_, e) =>
            {
                var fmt = capture.WaveFormat;
                var buf = Array.Empty<float>();
                int n = SampleConvert.ToFloat(e.Buffer, e.BytesRecorded, fmt, ref buf);
                for (int i = 0; i < n; i++) peak = Math.Max(peak, Math.Abs(buf[i]));
            };

            using var output = new WasapiOut(NAudio.CoreAudioApi.AudioClientShareMode.Shared, 80);
            output.Init(new SampleToWaveProvider(gen));

            capture.StartRecording();
            output.Play();
            Thread.Sleep(700);
            output.Stop();
            capture.StopRecording();
            Thread.Sleep(200);

            return peak > 0.05f
                ? $"OK: 出力に {RecorderEngine.LatencyResult.Db(peak)} の信号が出ている（再生経路は正常）"
                : $"NG: 出力に信号が出ていない（最大 {RecorderEngine.LatencyResult.Db(peak)}）";
        }
        catch (Exception ex)
        {
            return "確認できず: " + ex.Message;
        }
    }

    /// <summary>録り直し中のトラックが再生ミックスから確実に外れているかを見る。</summary>
    private static string Check(SessionMix mix, Session session, Track excluded)
    {
        using (mix)
        {
            using var all = SessionMix.Build(session);
            int withAll = all?.TrackCount ?? 0;
            int expected = withAll - 1;
            return $"ミックスに入ったトラック数 除外なし {withAll} → 除外あり {mix.TrackCount}（期待 {expected}）→ " +
                   (mix.TrackCount == expected ? "OK" : "要調査");
        }
    }

    private static Track AddTrack(Session session, IReadOnlyList<string> files)
    {
        var take = Take.FromFiles("テイク 1", files);
        var t = new Track { Name = session.NextTrackName() };
        t.AddTake(take);
        if (session.SampleRate <= 0) session.SampleRate = take.SampleRate;
        session.Tracks.Add(t);
        return t;
    }
}
