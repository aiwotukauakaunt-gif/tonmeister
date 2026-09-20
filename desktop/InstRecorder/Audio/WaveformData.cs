namespace InstRecorder.Audio;

/// <summary>
/// 波形描画用に、一定サンプルごとの最小値・最大値だけを取り出したもの。
/// 波形は「どこで鳴っていて、どこが無音か」が見えれば十分なので、
/// 全サンプルを持たずにこの要約だけを持つ。
/// </summary>
public sealed class WaveformData
{
    /// <summary>1つの山谷にまとめるサンプル数（フレーム単位）。</summary>
    public const int FramesPerBucket = 256;

    public float[] Min { get; }
    public float[] Max { get; }
    public int SampleRate { get; }
    public int Channels { get; }
    public double TotalSeconds { get; }

    private WaveformData(float[] min, float[] max, int rate, int channels, double seconds)
    {
        Min = min;
        Max = max;
        SampleRate = rate;
        Channels = channels;
        TotalSeconds = seconds;
    }

    public int BucketCount => Min.Length;
    public double SecondsPerBucket => (double)FramesPerBucket / SampleRate;

    public static WaveformData? Build(Take take, CancellationToken cancel = default)
    {
        using var reader = TakeReader.Open(take);
        if (reader == null) return null;

        int channels = reader.Channels;
        int rate = reader.SampleRate;
        int bucketSamples = FramesPerBucket * channels;

        var mins = new List<float>((int)(take.Seconds * rate / FramesPerBucket) + 16);
        var maxs = new List<float>(mins.Capacity);

        var buffer = new float[bucketSamples * 64];
        int carry = 0;
        float curMin = float.MaxValue, curMax = float.MinValue;
        long totalFrames = 0;

        int read;
        while ((read = reader.Provider.Read(buffer, 0, buffer.Length)) > 0)
        {
            cancel.ThrowIfCancellationRequested();

            for (int i = 0; i + channels <= read; i += channels)
            {
                // 左右をまとめて1本の波形にする（見た目の判断にはこれで足りる）
                float v = 0;
                for (int c = 0; c < channels; c++) v += buffer[i + c];
                v /= channels;

                if (v < curMin) curMin = v;
                if (v > curMax) curMax = v;

                carry++;
                totalFrames++;
                if (carry >= FramesPerBucket)
                {
                    mins.Add(curMin);
                    maxs.Add(curMax);
                    curMin = float.MaxValue;
                    curMax = float.MinValue;
                    carry = 0;
                }
            }
        }

        if (carry > 0)
        {
            mins.Add(curMin == float.MaxValue ? 0 : curMin);
            maxs.Add(curMax == float.MinValue ? 0 : curMax);
        }

        return new WaveformData(mins.ToArray(), maxs.ToArray(), rate, channels,
                                (double)totalFrames / rate);
    }
}
