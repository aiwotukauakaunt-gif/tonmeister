using System.Windows;

namespace InstRecorder;

/// <summary>
/// 「重ね録りのズレ合わせ」を測る一連の流れ。
/// 「録る」画面のピルからも「詳しい設定」からも同じ手順で測れるよう、ここ1か所にまとめている。
/// </summary>
public static class LatencyMeasure
{
    /// <summary>測れたら true。断られた場合も false を返す。</summary>
    public static async Task<bool> RunAsync(Window owner, InputSetup setup, int sessionSampleRate)
    {
        var error = setup.EnsureOpen(sessionSampleRate);
        if (error != null)
        {
            Warn(owner, error);
            return false;
        }

        var answer = MessageBox.Show(owner,
            "テスト用の音を鳴らして、それが録音側に返ってくるまでの時間を測ります。\n\n" +
            "・ヘッドホンを使う場合は、片方をマイクに近づけてください\n" +
            "・スピーカーでも測れます\n" +
            "・測定中（約2秒）は静かにしてください",
            "ズレ合わせを測る", MessageBoxButton.OKCancel, MessageBoxImage.Information);
        if (answer != MessageBoxResult.OK) return false;

        try
        {
            var r = await Task.Run(() => setup.Engine.MeasureRoundTrip());
            if (r.Success)
            {
                setup.SetLatency(r.Frames, true, "");
                return true;
            }

            setup.SetLatency(setup.LatencyFrames, false, r.Detail);
            Warn(owner,
                "テスト音を録音側で確実に拾えませんでした。\n\n" +
                $"{r.Detail}\n\n" +
                "・Windows の音量とアプリの音量が上がっているか\n" +
                "・音を鳴らす機器が、実際に音の出るものになっているか\n" +
                "・ヘッドホンならマイクに近づける\n" +
                "を確かめて、もう一度試してください。");
            return false;
        }
        catch (Exception ex)
        {
            Warn(owner, ex.Message);
            return false;
        }
    }

    private static void Warn(Window owner, string message) =>
        MessageBox.Show(owner, message, "ズレ合わせ", MessageBoxButton.OK, MessageBoxImage.Warning);
}
