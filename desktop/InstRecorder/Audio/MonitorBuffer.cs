using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// 入力を出力へ返すための橋渡し。録音側のスレッドが書き、再生側のスレッドが読む。
/// 途中でゲイン以外の加工は一切しない（モニターの音を変えると演奏の判断を誤る）。
///
/// 入力と出力は別々のタイミングで動くので、間にリングバッファを1つ挟む。
/// 貯めすぎると遅延になり、足りないと音が途切れるため、溜まりすぎたら古い方を捨てて
/// 遅延が育たないようにしている。
/// </summary>
public sealed class MonitorBuffer : ISampleProvider
{
    private const int Capacity = 1 << 16; // 65536 サンプル ≒ 48kHz ステレオで 0.68 秒

    private readonly float[] _ring = new float[Capacity];
    private int _writePos;
    private int _readPos;
    private int _count;
    private readonly object _lock = new();

    private int _channels = 2;
    private int _maxFill = Capacity / 4;

    public float Volume { get; set; } = 1f;
    public int Underruns { get; private set; }

    public WaveFormat WaveFormat { get; private set; } = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);

    public void Configure(int sampleRate, int channels, int maxLatencySamples)
    {
        lock (_lock)
        {
            _channels = Math.Max(1, channels);
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, 2);
            _maxFill = Math.Clamp(maxLatencySamples * 2, 512, Capacity / 2);
            _writePos = _readPos = _count = 0;
            Underruns = 0;
        }
    }

    public void Clear()
    {
        lock (_lock)
        {
            _writePos = _readPos = _count = 0;
        }
    }

    /// <summary>録音スレッドから呼ばれる。入力のチャンネル数によらずステレオに揃えて積む。</summary>
    public void Push(float[] samples, int count)
    {
        lock (_lock)
        {
            int ch = _channels;
            for (int i = 0; i + ch <= count; i += ch)
            {
                float l, r;
                if (ch == 1)
                {
                    l = r = samples[i];
                }
                else
                {
                    l = samples[i];
                    r = samples[i + 1];
                }

                Write(l);
                Write(r);
            }

            // 溜まりすぎ＝遅延が育っている。古い方を捨てて詰める。
            while (_count > _maxFill)
            {
                _readPos = (_readPos + 2) % Capacity;
                _count -= 2;
            }
        }
    }

    private void Write(float v)
    {
        if (_count >= Capacity)
        {
            _readPos = (_readPos + 1) % Capacity;
            _count--;
        }
        _ring[_writePos] = v;
        _writePos = (_writePos + 1) % Capacity;
        _count++;
    }

    /// <summary>再生スレッドから呼ばれる。足りない分は無音で埋める（詰まらせない）。</summary>
    public int Read(float[] buffer, int offset, int count)
    {
        float gain = Volume;
        lock (_lock)
        {
            int n = Math.Min(count, _count);
            for (int i = 0; i < n; i++)
            {
                buffer[offset + i] = _ring[_readPos] * gain;
                _readPos = (_readPos + 1) % Capacity;
            }
            _count -= n;

            if (n < count)
            {
                Underruns++;
                for (int i = n; i < count; i++) buffer[offset + i] = 0f;
            }
        }
        return count;
    }
}
