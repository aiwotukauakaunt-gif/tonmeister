using NAudio.Wave;

namespace InstRecorder.Audio;

/// <summary>
/// インパルス応答を畳み込んで響きを足す。
///
/// **直接音（乾いた音）には触らない。** 元の信号はそのまま出し、
/// 別に作った響きだけを足す。だから「響きの量 0%」は元の音とサンプル単位で同一になる。
///
/// 響きは <see cref="BlockSize"/> サンプルぶん遅れて出てくる（分割畳み込みの構造上）。
/// これは欠点ではなく、ホールの**プリディレイ**（直接音が届いてから壁の反射が届くまでの間）
/// そのものなので、設定のプリディレイからこのぶんを差し引いて辻褄を合わせている。
/// 直接音は遅れないので、重ね録りのズレ合わせにも再生位置の表示にも影響しない。
///
/// 響きは左右を合わせた1本から作り、左右それぞれ別のインパルス応答に通す。
/// 直接音の定位はそのまま残り、響きだけが左右にばらける。
/// </summary>
public sealed class ConvolutionReverb : ISampleProvider
{
    /// <summary>分割畳み込みの1ブロック。48kHz で 21.3ms。</summary>
    public const int BlockSize = 1024;

    private readonly ISampleProvider _src;
    private readonly PartitionedConvolver _left;
    private readonly PartitionedConvolver _right;
    private readonly float[] _preL;
    private readonly float[] _preR;
    private readonly int _preLen;
    private int _prePos;
    private readonly float _wet;

    /// <summary>直接音から響きが始まるまでの実際の間（秒）。ブロック分＋追加のプリディレイ。</summary>
    public double PreDelaySeconds { get; }

    /// <summary>響きが鳴り終わるまでの長さ（秒）。書き出しをこのぶん伸ばす。</summary>
    public double TailSeconds { get; }

    /// <param name="mix">響きの量。0 で完全に元の音、1 で響きが直接音と同じくらいの大きさ。</param>
    /// <param name="preDelaySeconds">
    /// 直接音から響きが始まるまで。<see cref="BlockSize"/> ぶんの遅れより短くはできない。
    /// </param>
    public ConvolutionReverb(ISampleProvider src, ImpulseResponse ir, double mix, double preDelaySeconds)
    {
        if (src.WaveFormat.Channels != 2)
            throw new ArgumentException("響きはステレオの信号にだけかけられます。", nameof(src));
        if (src.WaveFormat.SampleRate != ir.SampleRate)
            throw new ArgumentException("インパルス応答のサンプルレートが合っていません。", nameof(ir));

        _src = src;
        _wet = (float)Math.Clamp(mix, 0, 4);
        _left = new PartitionedConvolver(ir.Left, BlockSize);
        _right = new PartitionedConvolver(ir.Right, BlockSize);

        int rate = ir.SampleRate;
        double blockDelay = BlockSize / (double)rate;
        int extra = Math.Max(0, (int)Math.Round((preDelaySeconds - blockDelay) * rate));
        _preLen = extra;
        _preL = new float[Math.Max(1, extra)];
        _preR = new float[Math.Max(1, extra)];

        PreDelaySeconds = blockDelay + extra / (double)rate;
        TailSeconds = PreDelaySeconds + ir.Seconds;
    }

    public WaveFormat WaveFormat => _src.WaveFormat;

    public int Read(float[] buffer, int offset, int count)
    {
        int n = _src.Read(buffer, offset, count);

        for (int i = 0; i + 2 <= n; i += 2)
        {
            float l = buffer[offset + i];
            float r = buffer[offset + i + 1];

            float send = 0.5f * (l + r);
            float wl = _left.Process(send);
            float wr = _right.Process(send);

            if (_preLen > 0)
            {
                float dl = _preL[_prePos], dr = _preR[_prePos];
                _preL[_prePos] = wl;
                _preR[_prePos] = wr;
                wl = dl; wr = dr;
                if (++_prePos == _preLen) _prePos = 0;
            }

            buffer[offset + i] = l + wl * _wet;
            buffer[offset + i + 1] = r + wr * _wet;
        }

        return n;
    }
}

/// <summary>
/// 一様分割オーバーラップ加算による畳み込み。
///
/// インパルス応答を B サンプルずつに切って周波数領域に持っておき、
/// 入力も B サンプルたまるごとに変換して掛け合わせる。
/// 素直に時間領域で畳み込むと1サンプルあたり IR の長さぶんの積和が要るが、
/// この方法なら3秒の IR でも実時間のごく一部で済む。
///
/// 入力も IR も実数なので、スペクトルは上下対称になる。
/// 掛け合わせるのは下半分（0〜N/2）だけにして、残りは折り返して作る。
/// いちばん重い積和がこれで半分になる。
/// </summary>
internal sealed class PartitionedConvolver
{
    private readonly int _b;         // ブロック長
    private readonly int _n;         // 変換長（= 2B）
    private readonly int _h;         // 使うビンの数（= N/2 + 1）
    private readonly int _k;         // 分割数
    private readonly Fft _fft;

    private readonly float[][] _hRe, _hIm;    // IR の各分割のスペクトル（下半分だけ）
    private readonly float[][] _xRe, _xIm;    // 周波数領域の遅延線（下半分だけ）
    private int _newest;                      // 遅延線の最新スロット

    private readonly double[] _re, _im;       // 変換の作業用
    private readonly double[] _accRe, _accIm; // 積和の受け皿
    private readonly float[] _in, _out, _overlap;
    private int _pos;

    public PartitionedConvolver(float[] impulse, int blockSize)
    {
        _b = blockSize;
        _n = blockSize * 2;
        _h = _n / 2 + 1;
        _fft = new Fft(_n);
        _k = Math.Max(1, (impulse.Length + _b - 1) / _b);

        var re = new double[_n];
        var im = new double[_n];

        _hRe = new float[_k][];
        _hIm = new float[_k][];
        for (int k = 0; k < _k; k++)
        {
            Array.Clear(re);
            Array.Clear(im);
            int off = k * _b;
            int len = Math.Min(_b, impulse.Length - off);
            for (int i = 0; i < len; i++) re[i] = impulse[off + i];
            _fft.Forward(re, im);

            _hRe[k] = new float[_h];
            _hIm[k] = new float[_h];
            for (int j = 0; j < _h; j++) { _hRe[k][j] = (float)re[j]; _hIm[k][j] = (float)im[j]; }
        }

        _xRe = new float[_k][];
        _xIm = new float[_k][];
        for (int k = 0; k < _k; k++)
        {
            _xRe[k] = new float[_h];
            _xIm[k] = new float[_h];
        }

        _re = new double[_n];
        _im = new double[_n];
        _accRe = new double[_n];
        _accIm = new double[_n];
        _in = new float[_b];
        _out = new float[_b];
        _overlap = new float[_b];
    }

    /// <summary>1サンプル入れて1サンプル受け取る。出てくるのは B サンプル前の入力に対する結果。</summary>
    public float Process(float x)
    {
        float y = _out[_pos];
        _in[_pos] = x;
        if (++_pos == _b)
        {
            _pos = 0;
            Block();
        }
        return y;
    }

    private void Block()
    {
        Array.Clear(_re);
        Array.Clear(_im);
        for (int i = 0; i < _b; i++) _re[i] = _in[i];
        _fft.Forward(_re, _im);

        // 遅延線を1つ巻き戻して、いま変換したブロックを最新として置く
        _newest = (_newest + _k - 1) % _k;
        var nr = _xRe[_newest]; var ni = _xIm[_newest];
        for (int j = 0; j < _h; j++) { nr[j] = (float)_re[j]; ni[j] = (float)_im[j]; }

        Array.Clear(_accRe);
        Array.Clear(_accIm);
        for (int k = 0; k < _k; k++)
        {
            int slot = (_newest + k) % _k;   // k=0 が最新 → IR の先頭と組む
            var xr = _xRe[slot]; var xi = _xIm[slot];
            var hr = _hRe[k]; var hi = _hIm[k];
            for (int j = 0; j < _h; j++)
            {
                _accRe[j] += (double)xr[j] * hr[j] - (double)xi[j] * hi[j];
                _accIm[j] += (double)xr[j] * hi[j] + (double)xi[j] * hr[j];
            }
        }

        // 上半分は下半分の折り返し（実数信号のスペクトルは共役対称）
        for (int j = 1; j < _n / 2; j++)
        {
            _accRe[_n - j] = _accRe[j];
            _accIm[_n - j] = -_accIm[j];
        }

        _fft.Inverse(_accRe, _accIm);

        // 前半は前ブロックのはみ出しと足し合わせ、後半は次に持ち越す
        for (int i = 0; i < _b; i++) _out[i] = (float)_accRe[i] + _overlap[i];
        for (int i = 0; i < _b; i++) _overlap[i] = (float)_accRe[_b + i];
    }
}

/// <summary>
/// 基数2の高速フーリエ変換。回転因子とビット反転の表は作るときに一度だけ用意する。
/// 畳み込みにしか使わないので、複素数の型は起こさず re/im の配列を直接受ける。
/// </summary>
internal sealed class Fft
{
    private readonly int _n;
    private readonly int[] _rev;
    private readonly double[] _cos, _sin;

    public Fft(int n)
    {
        if (n < 2 || (n & (n - 1)) != 0)
            throw new ArgumentException("変換長は2のべき乗である必要があります。", nameof(n));
        _n = n;

        int bits = 0;
        while ((1 << bits) < n) bits++;

        _rev = new int[n];
        for (int i = 0; i < n; i++)
        {
            int r = 0;
            for (int b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b);
            _rev[i] = r;
        }

        _cos = new double[n / 2];
        _sin = new double[n / 2];
        for (int i = 0; i < n / 2; i++)
        {
            double a = -2.0 * Math.PI * i / n;
            _cos[i] = Math.Cos(a);
            _sin[i] = Math.Sin(a);
        }
    }

    public int Size => _n;

    public void Forward(double[] re, double[] im) => Run(re, im, false);

    public void Inverse(double[] re, double[] im)
    {
        Run(re, im, true);
        double s = 1.0 / _n;
        for (int i = 0; i < _n; i++) { re[i] *= s; im[i] *= s; }
    }

    private void Run(double[] re, double[] im, bool inverse)
    {
        for (int i = 0; i < _n; i++)
        {
            int j = _rev[i];
            if (j > i)
            {
                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }
        }

        for (int len = 2; len <= _n; len <<= 1)
        {
            int half = len >> 1;
            int step = _n / len;
            for (int i = 0; i < _n; i += len)
            {
                for (int k = 0; k < half; k++)
                {
                    int t = k * step;
                    double wr = _cos[t];
                    double wi = inverse ? -_sin[t] : _sin[t];
                    int a = i + k, b = a + half;
                    double xr = re[b] * wr - im[b] * wi;
                    double xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                }
            }
        }
    }
}
