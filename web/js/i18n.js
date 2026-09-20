/*
  英語表示。日本語の文をそのまま鍵にして英語を引く（keyboard の T() と同じやり方）。
  辞書に無い文は日本語のまま出る。静的な文（index.html）は起動時と切り替え時に置き換え、
  動的な文は app.js 側で T() を通す。{name} のような穴は vars で埋める。
*/

const KEY = 'tonmeister_lang';
let lang = 'ja';
try { lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'ja'; } catch { }

export const EN = {
  // ---- 短い語 ----
  '素': 'Raw', '自動': 'Auto', '盛り': 'Finish', '消音': 'Mute', '部屋': 'Room', '単独': 'Solo', '録る': 'Record', '消す': 'Delete',
  '外す': 'Remove', '測る': 'Measure', '聞く': 'Listen', '録音中': 'Recording', '続ける': 'Continue', '盛り度': 'How much', 'やめる': 'Cancel',
  '未測定': 'Not measured', '整える': 'Tidy', '詳しく': 'Details', '変える': 'Change', '閉じる': 'Close', '割れる': 'Clips', 'ホール': 'Hall',
  '録　音': 'R E C O R D', '重ねる': 'Overdub', '仕上げ': 'Finished', '録音一覧': 'Recordings', '響きの量': 'Amount', 'まだ0本': 'none yet',
  '録る場所': 'Record to', '縦の拡大': 'Vertical zoom', '録音する': 'Record', '読み込む': 'Import', 'おすすめ': 'Recommended', '測り直す': 'Re-measure',
  '前の続き': 'Open previous', '小さすぎ': 'too quiet', '書き出す': 'Export', '横の拡大': 'Horizontal zoom', '音の残し方': 'Save format',
  '音の通り道': 'Capture path', '詳しい設定': 'Settings', '音の入り口': 'Input', '響きの長さ': 'Decay', '音の細かさ': 'Sample rate', '音の大きさ': 'Level',
  'ループバック': 'Loopback', '新しく始める': 'New session', '起動のしかた': 'On startup', 'チャンネル数': 'Channels', 'ちょうどよい': 'just right',
  '部屋とマイク': 'Room & mic', '音のチェック': 'Sound check', '何を書き出すか': 'What to export', 'フォルダを選ぶ': 'Choose folder', 'WAV を足す': 'Add WAV',
  '聞かせる録り：': 'Active take:', 'スイープで測る': 'Sweep measurement', '波形を見て直す': 'Edit waveform', '録るチャンネル': 'Channels to record',
  'ブラウザの加工': 'Browser processing', '録音する（R）': 'Record (R)', 'ファイルを選ぶ': 'Choose file', '音量を合わせる': 'Set level', '機器を探し直す': 'Rescan devices',
  '■ 録音をやめる': '■ Stop recording', '選んだものを消す': 'Delete selected', 'やめる（Esc）': 'Stop (Esc)', 'マイクを確かめる': 'Check mic',
  '直接音からの時間': 'time after direct sound', 'どれも消えません': 'nothing is deleted', '低い音 25Hz': 'low 25 Hz', '押す前の音も残す': 'Pre-roll',
  'いま録れている音': 'what is being recorded', 'ここだけ録り直す': 'Punch in here', '録った音を調べる': 'Analyze a take', '細かく決める ▸': 'Fine-tune ▸',
  '細かく決める ▾': 'Fine-tune ▾', '元の音は残ります': 'the original stays', 'まだ測っていません': 'not measured yet', '直接音から響きまで': 'Pre-delay',
  'B を録る（5秒）': 'Record B (5 s)', '音のチェックをする': 'Sound check', 'ズレ合わせ 未測定': 'Latency: not measured', 'ズレ合わせ 済': 'Latency: measured',
  'このトラックの音量': 'Track volume', 'そのままの音で残す': 'Keep the sound as is', 'ホールの響きを足す': 'Add hall reverb', 'スピーカー→マイク': 'speaker → mic',
  'いま選んでいるもの': 'Selection', '多入力の機材のとき': 'for multi-input interfaces', 'A を録る（5秒）': 'Record A (5 s)', '高い音 20kHz': 'high 20 kHz',
  'C を録る（5秒）': 'Record C (5 s)', 'このトラックを外す': 'Remove this track', '音を聞く準備をする': 'Open input', '録った音の置き場所': 'Storage',
  '容量を小さくして残す': 'Smaller file', 'マイクの較正ファイル': 'Mic calibration file', '保存するファイルの形': 'file format', 'これまでに測ったもの': 'Previous measurements',
  'ケーブルで出力→入力': 'cable out → in', '重ね録りのズレ合わせ': 'Overdub latency', '自分のフォルダにも書く': 'Also write to my folder', '▶ 選んだところを聞く': '▶ Play selection',
  'このトラックだけ鳴らす': 'Solo this track', '経路を検証する（2秒）': 'Verify path (2 s)', 'このトラックの響きの量': 'Reverb send for this track',
  '＋ この上に重ねて録る': '+ Overdub on top', 'スイープで測る（5秒）': 'Run sweep (5 s)', 'この選択が意味すること': 'What this means',
  '弾きながら測る（5秒）': 'Measure while playing (5 s)', '仕上げ（盛る）— 全体': 'Finish — whole session', '静かにして測る（5秒）': 'Measure silence (5 s)',
  '選んだところを切り出す': 'Crop selection', 'マイク位置を録り比べる': 'Compare mic positions', '試し弾きで音量を決める': 'Set gain by trial',
  'マイクを選んでください。': 'Choose a microphone.', '盛りが入っているときだけ': 'only when finishing is on', '開いたらすぐマイクを使う': 'Open the mic on startup',
  '頼む数。実際は機器しだい': 'requested; the device decides', 'マイクを準備しています…': 'Preparing the microphone…', 'Space でも押せます': 'or press Space',
  'しばらくお待ちください…': 'Please wait…', 'どの高さの音が入っているか': 'Spectrum', '電源のブーンという音を消す': 'Remove mains hum',
  'ヘッドホンで自分の音を聞く': 'Monitor in headphones', 'このトラックだけ鳴らさない': 'Mute this track', '加工ゼロ。必ず書き出します': 'zero processing; always exported',
  '1つの音にまとめて書き出す': 'Export mixdown', '弾いていない間を静かにする': 'Gate silence between notes', '24bit・機器と同じレート': '24-bit, same rate as the device',
  'スイープで測る（機材・部屋）': 'Sweep (interface / room)', 'はじめから聞く（Space）': 'Play from start (Space)', '仕上げ（盛る）— このトラック': 'Finish — this track',
  'このセッションを丸ごと書き出す': 'Export whole session', '周波数分布（1/3オクターブ）': '1/3-octave spectrum', '押している間だけ素で聞く（B）': 'Hold to hear raw (B)',
  'Tonmeister — 録音': 'Tonmeister — Recorder', '風音（30 Hz 以下）を切る': 'Cut rumble (below 30 Hz)', 'クリックすると音量を変えられます': 'click to change volume',
  'ブラウザが加工していないか調べる': 'Check browser processing', 'マイクの色を戻す（較正ファイル）': 'Undo mic coloration (calibration file)',
  'Windows 側で決まること：': 'Decided on the Windows side:', '響きの長さ（RT60）と初期反射': 'Decay (RT60) and early reflections',
  'クリックすると名前を変えられます': 'click to rename', '音の入り口を開いたときに自動で測る': 'Measure automatically when the input opens',
  '実際に演奏している間の音を調べます': 'analyzes the sound while you play', '分からなければ触らなくて大丈夫です': 'safe to leave alone',
  '重ね録りのとき、前の音を鳴らす機器': 'Output device for overdub playback', 'このトラックに仕上げが入っています': 'this track has finishing',
  'ヘッドホンを着けてから押してください': 'put on headphones first', 'いちばん大きいところを調べています…': 'Finding the peak…',
  '約2秒ごとに自動保存中・取りこぼし 0': 'autosaving every ~2 s · dropped 0', 'まず「静かにして測る」を押してください': 'Press "Measure silence" first',
  '周波数特性（1 kHz を 0 dB に）': 'Frequency response (0 dB at 1 kHz)', '1 kHz で THD+N を測る（3秒）': 'Measure THD+N at 1 kHz (3 s)',
  'クリックすると、この録音の名前を変えられます': 'click to rename this session', '名前・トラック数・長さ・容量・日時で選びます': 'name · tracks · length · size · date',
  'マイクの置き方を変えて短く録り、数字で見比べる': 'record short takes with different placements and compare numbers',
  'いちばん劣化しない形。あとで編集するならこれ。': 'The least lossy form. Use this if you will edit later.',
  '読み込む（session.json ＋ WAV）': 'Import (session.json + WAV)', 'クロックのずれを、重ね録りのとき再生側で相殺する': 'Compensate clock drift on playback when overdubbing',
  'まわりの静けさ（暗騒音）と電源のブーン音を調べます': 'measures background noise and mains hum',
  'ズレ合わせを測っていないので、後ろにズレて録れます': 'Latency not measured — this take will land late',
  '再生のとき、素の音を聞くか、仕上げを通した音を聞くか': 'listen to raw or finished during playback',
  '測っておくと、重ねて録った音が前の音とぴったり揃います。': 'Measure it and overdubs line up exactly with earlier tracks.',
  '同じ強さで同じフレーズを。位置の違いだけを見るためです。': 'Same phrase, same strength — so only the placement differs.',
  '仕上げ（盛り）が入っています。素の音はそのまま残っています': 'Finishing is on. The raw sound is kept untouched',
  '押している間だけ素の音になります（キーボードの B でも）': 'raw while held (or the B key)',
  '音量をそろえる（いちばん大きいところを −1 dBTP に）': 'Normalize (peak to −1 dBTP)',
  '対数スイープを鳴らして録り、インパルス応答から素性を出します': 'Plays a log sweep, records it and derives the impulse response',
  '静かな間だけ入力が絞られていないかを、音を鳴らして確かめます': 'plays a tone to check whether the input is gated in silence',
  '素の WAV には触りません。切れば1サンプルも違わず元に戻ります。': 'The raw WAV is untouched. Switch off and it is sample-identical again.',
  'いちばん強く鳴らした 6 秒から、入力つまみをどうすべきかを言います': 'from 6 s of your loudest playing, tells you how to set the input gain',
  '24bit で書き出します。24bit で録った音は完全に無劣化です。': 'Exports 24-bit. Audio recorded at 24-bit stays bit-exact.',
  'いまは何も盛っていません。聞こえるのも書き出すのも「素」そのものです。': 'Nothing is added. What you hear and export is the raw sound itself.',
  'WAV を新しいトラックとして足します（変換なし）。ここへ落としても足せます': 'adds a WAV as a new track (no conversion); you can also drop files here',
  '機材や置き場所を変えたあと、前より良くなったかを見比べるために残しています。': 'Kept so you can compare after changing gear or placement.',
  '置き方を変えて同じフレーズを 5 秒ずつ録り、数字で見比べます。音は残しません': 'Record the same phrase for 5 s per placement and compare numbers. Nothing is saved',
  '生フレーム取得（AudioContext を通さず、機器のレートのまま受ける）': 'Raw frame capture (bypasses AudioContext; device rate as-is)',
  '直接音には触りません。響きだけを足すので、量 0% は素と1サンプルも違いません。': 'The direct sound is untouched; only reverb is added. At 0% it is sample-identical to raw.',
  '機器から届いている入力のうち、どれを録るか。メーターと「音のチェック」は全部を見ます。': 'Which of the arriving inputs to record. Meters and Sound check watch all of them.',
  '使える機器が見つかりませんでした。マイクを挿してから「機器を探し直す」を押してください。': 'No usable device found. Plug in a microphone and press "Rescan devices".',
  '波形をクリックするとそのトラックを選べます。ドラッグすると「使いたいところ」を選べます。': 'Click a waveform to select the track. Drag to select a region.',
  '切ると、開いても音の大きさの目盛りは動きません。他のアプリとマイクを取り合いたくないときに。': 'When off, meters stay idle on startup. Useful when other apps need the mic.',
  'スイープを鳴らして測る。ケーブルで繋げば機材の往復特性、スピーカーで鳴らせば部屋とマイク位置': 'sweep measurement: with a cable, the interface round trip; with a speaker, the room and mic placement',
  'Chrome は何も言わないとモノラルに畳みます。2本のマイクや、ステレオ出力の機材は「2」に。': 'Chrome folds to mono unless asked. Use "2" for two mics or stereo interfaces.',
  'どちらも元の録音は書き換えず、新しい録りとして増えます。波形は音の大きさ（dB）の目盛りで描いています。': 'Neither rewrites the original; both add a new take. The waveform uses a dB scale.',
  'ブラウザは既定で入力に手を入れます。ここを全て「切」にしないと、録れるのは「実際に鳴っている音」ではありません。': 'Browsers process the input by default. Unless all are off, what you record is not the real sound.',
  'にして、「オーディオ拡張機能」を切ってください。届いているビット数は「音のチェック → 静かにして測る」で分かります。': ', and turn off "audio enhancements". The arriving bit depth shows in Sound check → Measure silence.',
  '生フレーム取得の道と AudioContext の道で同時に録って比べます。一致すれば、ブラウザが途中で何も掛けていない証明です': 'records raw capture and AudioContext at the same time and compares them; a match proves the browser adds nothing',
  '録れている音の素性を数字で出します。耳では分かりにくい雑音や電源のブーン音は、録ってしまうと後から取り除きにくいので、録る前に確かめます。': 'Puts numbers on what is being recorded. Noise and hum are hard to remove afterwards, so check before recording.',
  'ブラウザは機器の生のフォーマットを選べません。ここで選んだ値を機器に頼み、実際に届いた値を下に出します。生フレーム取得のときは、届いた値がそのまま録音のレートになります。': 'Browsers cannot pick the raw device format. The chosen value is requested and the actual value is shown below. With raw capture the arriving rate is the recording rate.',
  '録音していない間も直近の音を持っておき、押した瞬間にその前の数秒を先頭に付けます。「いい演奏が始まってから押した」を救います。重ねて録るときは、前の音と揃える必要があるので付けません。': 'Keeps the last few seconds while idle and prepends them when you press record. Saves the take you started late. Not used for overdubs, which must align to earlier tracks.',
  '測定用マイク（UMIK-1 など）に付いてくる「周波数 dB」のテキストを読み込むと、周波数分布からマイクの色を引いて本当の分布を見られます。仕上げの「マイク補正（戻し）」にも使えます。': 'Load the "frequency dB" text that comes with a measurement mic (e.g. UMIK-1) to remove the mic coloration from the spectrum. Also used by "Undo mic coloration" in finishing.',
  'ブラウザは Windows のミキサーを通ります。「サウンド設定 → 録音 → 機器のプロパティ → 詳細 → 既定の形式」が 16bit のままだと、24bit の機材でも 16bit しか届きません。': 'Browsers go through the Windows mixer. If Sound settings → Recording → Device properties → Advanced → Default format is 16-bit, only 16 bits arrive even from a 24-bit interface.',

  // ---- 動的な文（app.js 側で T() を通すもの） ----
  '生取得': 'raw capture', 'AudioContext 経由': 'via AudioContext', 'ブラウザ加工: 不明': 'browser processing: unknown', 'ブラウザ加工: すべて切': 'browser processing: all off',
  'ブラウザ加工: 入ったまま': 'browser processing: ON', 'マイクをまだ使えていません。「詳しい設定」で選んでください。': 'Microphone not open yet. Choose one in Settings.',
  'いい音量です。楽器をいちばん強く鳴らしても金の帯に収まっています。': 'Good level. Your loudest playing stays inside the gold band.',
  '音が小さすぎます。機材側の入力つまみを上げてください。': 'Too quiet. Raise the input gain on your interface.',
  '音が大きすぎて割れます。機材側の入力つまみを下げてください。': 'Too loud — it clips. Lower the input gain on your interface.',
  '楽器を鳴らしてみてください。いちばん強く鳴らしたときに金の帯へ入るのが目安です。': 'Play something. Your loudest note should land in the gold band.',
  'ちょうどいい': 'just right', '大きすぎ': 'too loud', '割れています': 'clipping', '音が出ていません': 'no output',
  '素のまま録れます': 'Records the raw sound', 'ほぼ素のまま録れます': 'Records almost raw', '手当てが要ります': 'Needs attention',
  '何もしない。録れた音そのもの。': 'Nothing. The recorded sound itself.', '風音（30 Hz 以下）カット・ハム除去・音量そろえ。音色は変えない。': 'Rumble cut, hum removal, normalize. Timbre unchanged.',
  '整える ＋ 小さな部屋の響きを薄く。': 'Tidy + a light small-room reverb.', '整える ＋ ホールの響き（種類と量を選べる）。': 'Tidy + hall reverb (choose hall and amount).',
  '新しく始めました。': 'Started a new session.', '保存しました。': 'Saved.', '戻すものがありません。': 'Nothing to undo.',
  '「{name}」を録りました（いちばん大きいところ {peak}）。いい音量です。': 'Recorded "{name}" (peak {peak}). Good level.',
  '押す前の {sec} 秒も含めて残しました。': 'Kept the {sec} s before you pressed record.',
  '録音・再生を止めてから開いてください。': 'Stop recording or playback first.', '先に音の入り口を開いてください。': 'Open the input first.',
  '分かりました': 'OK', '始める': 'Start', '足す': 'Add', '足さない': 'Skip', 'やり直す': 'Redo',
  '戻しました：{label}': 'Undone: {label}', 'やり直しました：{label}': 'Redone: {label}',
  '新しいトラックに録る': 'New track', '{name} に録り足す': 'Add take to {name}', '{n}本': '{n}', '無': 'none', '小': 'small', '中': 'medium', '大': 'large',
  '「測る」を押すと、素とどれだけ違うかを実際に計算します。': 'Press "Measure" to compute how far the finished mix is from raw.',
  // 録り終わりの一言
  '「{name}」は波の頭が {n} 回平らになっています。0 dBFS には届いていなくても、機材側（プリアンプ）で歪んでいます。入力つまみを下げて録り直してください。': '"{name}" has {n} flat-topped waves. Even below 0 dBFS, the preamp is clipping. Lower the input gain and record again.',
  '「{name}」に音がほとんど入っていません（いちばん大きいところ {peak}）。マイクが拾えているか確かめてください。': '"{name}" is almost silent (peak {peak}). Check that the mic is picking up sound.',
  '「{name}」は小さすぎます（いちばん大きいところ {peak}）。目安は −18〜−8 です。機材側の入力つまみを上げて録り直すと、あとが楽になります。': '"{name}" is too quiet (peak {peak}). Aim for −18 to −8. Raise the input gain and record again.',
  '「{name}」は音が割れています（{peak}）。つまみを下げて録り直してください。割れた音はあとから直せません。': '"{name}" is clipping ({peak}). Lower the gain and record again — clipping cannot be undone.',
  // 音のチェックの表
  'いちばん大きいところ': 'Peak', 'ノイズフロア（RMS）': 'Noise floor (RMS)', '実効ビット深度': 'Effective bits', '電源ハム': 'Mains hum', '直流オフセット': 'DC offset',
  'クリップ': 'Clipped samples', '届いているビット数': 'Arriving bit depth', '20 kHz より上の雑音': 'Noise above 20 kHz', 'L/R のマイクの距離差': 'L/R mic distance',
  '目安は −18〜−8 dBFS。': 'Aim for −18 to −8 dBFS.', '低いほど良い。−85 以下なら静か、−55 より上なら要改善。': 'Lower is better. Below −85 is quiet; above −55 needs work.',
  'この暗騒音の下で実際に使えているビット数。': 'Bits actually usable above this noise floor.', 'ヘッドルームを無駄に食う。': 'Wastes headroom.',
  '1つでもあれば入力つまみを下げる。': 'Any at all: lower the input gain.', 'Windows の「既定の形式」を 24bit に。': 'Set the Windows default format to 24-bit.',
  '24bit の刻みで届いている。': 'Arriving on the 24-bit grid.', '整数の刻みに乗っていない（途中で音量が掛かっているか float）。': 'Not on an integer grid (gain applied somewhere, or float).',
  '判断できる量がない。': 'Not enough signal to tell.', 'スイッチング電源・ディスプレイ・USB を離す。': 'Move switching supplies, displays and USB away.', '床と同じ。問題なし。': 'Same as the floor. Fine.',
  'まず「静かにして測る」を押してください': 'Press "Measure silence" first', '素の入力が届いています': 'The raw input is arriving', 'ブラウザが入力を加工しています': 'The browser is processing the input',
  '判定できませんでした': 'Could not determine', 'この数値は機材の性能ではありません': 'These numbers are not your gear', 'ちょうどいい音量です': 'Good level',
  '音が割れています': 'Clipping', '音量が目安から外れています': 'Level outside the target', '静かに録れる状態です': 'Quiet enough to record', '暗騒音がやや高めです': 'Background noise a bit high',
  'この録りは割れています': 'This take clips', 'この録りは小さめです': 'This take is quiet', 'この録りの音量は妥当です': 'This take has a sensible level',
  '2つの道は完全に一致しました': 'Both paths match exactly', '2つの道はほぼ一致（丸めの差だけ）': 'Both paths match (rounding only)', '2つの道で音が違います': 'The two paths differ',
  '比べる相手がありません': 'Nothing to compare against',
  // 書き出し
  '割れません。このまま書き出せます。': 'No clipping. Ready to export.', 'ぎりぎりです。少しだけトラックの音量を下げると安心です。': 'Right at the edge. Lower a track a little to be safe.',
  '合わせると 0 dBTP を超えます。「欠けない形（32bit float）」なら超えたぶんも保てますが、24bit では割れます。トラックの音量を下げるか、「音量をそろえる」を入れるのが確実です。': 'The mix exceeds 0 dBTP. 32-bit float keeps it; 24-bit will clip. Lower a track or turn on Normalize.',
  '素': 'Raw', '仕上げ': 'Finished', '仕上げのいちばん大きいところ': 'Finished peak', '素のいちばん大きいところ': 'Raw peak',
  // 設定
  'まだ音の入り口を開いていません。': 'The input is not open yet.', '開くと、ここに実際の通り道が出ます。': 'Open the input to see the actual path here.',
  'このブラウザには MediaStreamTrackProcessor が無いので、AudioContext 経由で受けます（Chrome / Edge なら生フレーム取得が使えます）。': 'This browser has no MediaStreamTrackProcessor, so capture goes via AudioContext (Chrome / Edge can capture raw frames).',
  '生フレーム取得は切っています（または開けなかったので AudioContext 経由に戻りました）。': 'Raw capture is off (or failed, so AudioContext is used).',
  '2本のマイクをステレオ1本として録ります。': 'Records two mics as one stereo track.', '2本のマイクを別々に扱いたいとき。各トラックはセッションの同じ位置から始まります。': 'For treating two mics separately. Each track starts at the same position.',
  '本線（ch1）が割れたところだけを、保険（ch2）で差し替えた録りを自動で足します。倍率は割れていない区間から実測するので、機材側で何 dB 下げたかは覚えなくて大丈夫です。元の 2ch の録りも残ります。': 'Where the main channel (ch1) clips, a take patched from the safety channel (ch2) is added automatically. The gain is measured from unclipped parts, so you need not remember the offset. The 2-channel original stays.',
  'このブラウザではフォルダを選べません（Chrome / Edge で使えます）。': 'This browser cannot pick folders (works in Chrome / Edge).',
  '選ぶと、OPFS の受け皿に加えて自分のフォルダにも本物の WAV を書きます。ブラウザが落ちても、20 秒ごとに閉じた部分ファイルが残ります。': 'Choose a folder to also write real WAV files there, in 20-second parts that survive a browser crash.',
  'クロックのずれ：開いてから 20 秒ほど経つと出ます。': 'Clock drift: shown about 20 s after opening.',
  '検証用の合成音': 'synthetic test tone', '（名前の分からない機器）': '(unnamed device)', '自動（ブラウザが選ぶ入り口）': 'Auto (browser picks the input)', 'いちばん確実。特に理由がなければこれで。': 'Most reliable. Use this unless you have a reason not to.',
  '自動（ブラウザがいま使っている機器）': 'Auto (device the browser is using)',
  // 測る・比べる
  'インターフェースの出力（ヘッドホン端子か LINE OUT）から入力（LINE IN）へケーブルで繋いでください。出力の音量は真ん中くらい。マイクは外れていて構いません。往復の周波数特性と THD+N（歪みと雑音）を測り、Windows の隠れた EQ もここで露見します。': 'Connect the interface output (headphone or LINE OUT) to the input (LINE IN) with a cable, output volume around the middle. The mic can be unplugged. Measures round-trip frequency response and THD+N, and exposes any hidden Windows EQ.',
  'スピーカー（PC のでも可）を楽器の位置に置き、マイクはいつも録る位置に。5 秒のスイープが鳴ります。帯域ごとの響きの長さ、近い面からの初期反射（何 cm 先か）、フラッターエコーを出します。': 'Put a speaker (the PC one is fine) where the instrument sits and the mic where you record. A 5-second sweep plays. Reports decay per band, early reflections (how many cm away), and flutter echo.',
  'ループバック：インターフェース＋Windows の往復': 'Loopback: interface + Windows round trip', '部屋とマイク位置': 'Room and mic placement', '1 kHz：歪みと雑音': '1 kHz: distortion and noise',
  '平均の大きさ（RMS）': 'Average level (RMS)', '低域の膨らみ（40〜200 Hz − 500〜2k）': 'Low-end bloom (40–200 Hz − 500–2k)', '明るさ（4〜12 kHz − 500〜2k）': 'Brightness (4–12 kHz − 500–2k)', '電源ハム（床より）': 'Mains hum (above floor)', 'L/R の距離差': 'L/R distance',
  // 少なく見せる画面
  'このトラックの仕上げ': 'Finish for this track', 'ほかの測り方 ▸': 'More checks ▸', 'ほかの測り方 ▾': 'More checks ▾',
  'くわしい設定 ▸': 'Advanced ▸', 'くわしい設定 ▾': 'Advanced ▾', '加工・通り道・チャンネル・フォルダ・出力機器・ズレ合わせ・較正・起動・置き場所': 'processing · path · channels · folder · output · latency · calibration · startup · storage',
  'メニュー': 'Menu', 'ほかにできること': 'More', 'English': 'English', '日本語': '日本語',
  'この経路で素のまま録れるか（◎ そのまま／○ ほぼ／△ 手当てが要る）。押すと理由が出ます': 'Can this path record the raw sound? (◎ yes / ○ almost / △ needs attention). Click for details',
  '経路の格：開いた瞬間に測る。手当てが要るときだけ自動で開き、それ以外は印を押したときだけ': '',
  '入力の音が {n} 回落ちています（合計 {ms} ms）。PC が重いか、機器のバッファが小さすぎます。': 'The input dropped {n} times ({ms} ms in total). The PC is busy or the device buffer is too small.',
  '裏に回っていた間も録れています（落ちた音 {n} 回）。': 'Kept recording in the background ({n} drops).',
  '長くなったので次の受け皿に切り替えました（{n} 本目）。音は1つも落としていません。止めると続きのトラックとして並びます。': 'Rolled over to a new file ({n}). No samples lost; the continuation appears as a following track when you stop.',
  'ズレ合わせを自動で測りました：往復 {ms} ms。': 'Latency measured automatically: round trip {ms} ms.',
  '置き場所の空きが少なく、あと約 {min} 分しか録れません。古い録音を「録音一覧」で消すか、丸ごと書き出して外へ移してください。': 'Storage is nearly full — about {min} minutes left. Delete old recordings or export them.',
  // 一般
  '録音・再生を止めてから読み込んでください。': 'Stop recording or playback before importing.', 'まだ書き出すものがありません。': 'Nothing to export yet.',
  '録音・再生を止めてから書き出してください。': 'Stop recording or playback before exporting.', 'ファイルがありません。': 'No files.',

};

export function currentLang() { return lang; }

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'ja';
  try { localStorage.setItem(KEY, lang); } catch { }
  applyStatic(document);
  document.documentElement.lang = lang;
}

/** 文を引く。{name} の穴は vars で埋める。 */
export function T(text, vars) {
  let out = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, text) ? EN[text] : text;
  if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

/* 静的な文：最初に見た日本語を控えておき、言語ごとに置き換える */
const originals = new WeakMap();

export function applyStatic(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName) && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    let orig = originals.get(n);
    if (orig === undefined) { orig = n.nodeValue; originals.set(n, orig); }
    const key = orig.trim();
    const t = T(key);
    if (t !== key || lang === 'ja') n.nodeValue = orig.replace(key, t);
  }
  for (const attr of ['title', 'placeholder']) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const k = `orig:${attr}`;
      if (!el.dataset[k.replace(':', '')]) el.dataset[k.replace(':', '')] = el.getAttribute(attr);
      el.setAttribute(attr, T(el.dataset[k.replace(':', '')]));
    }
  }
  // <template> の中身も
  for (const tpl of root.querySelectorAll ? root.querySelectorAll('template') : []) applyStatic(tpl.content);
}
