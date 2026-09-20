using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using InstRecorder.Audio;

namespace InstRecorder;

/// <summary>
/// これまでの録音を並べて選ぶ画面。
///
/// 以前は「録音一覧」を押すと「新しく始める／前の続き」の小さなお品書きが出るだけで、
/// 名前のとおりの一覧にはなっていなかった。録音に名前を付けられるようにした以上、
/// 名前で選べないと意味がない。
/// </summary>
public partial class SessionsWindow : Window
{
    private readonly string _rootFolder;
    private readonly string _currentFolder;

    /// <summary>選ばれた録音のフォルダ。選ばずに閉じたら null。</summary>
    public string? ChosenFolder { get; private set; }

    /// <summary>「新しく始める」が押された。</summary>
    public bool NewSessionRequested { get; private set; }

    public SessionsWindow(string rootFolder, string currentFolder)
    {
        InitializeComponent();
        _rootFolder = rootFolder;
        _currentFolder = currentFolder;
        TxtWhere.Text = rootFolder;

        Loaded += (_, _) => Build();
    }

    private void Build()
    {
        ListHost.Children.Clear();

        var folders = Directory.Exists(_rootFolder)
            ? Directory.GetDirectories(_rootFolder)
                .Where(d => File.Exists(Path.Combine(d, Session.MetaFileName)))
                .OrderByDescending(Directory.GetLastWriteTime)
                .ToList()
            : new List<string>();

        foreach (var folder in folders) ListHost.Children.Add(BuildRow(folder));

        TxtEmpty.Visibility = folders.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private Border BuildRow(string folder)
    {
        // 一覧の見出しだけが欲しいので、読めない録音があっても一行にして出す
        string name = Path.GetFileName(folder);
        string detail;
        try
        {
            var session = Session.Load(folder);
            if (!string.IsNullOrEmpty(session.Name)) name = session.Name;

            var length = TimeSpan.FromSeconds(session.LengthSeconds);
            detail = session.Tracks.Count == 0
                ? "まだ何も入っていません"
                : $"{session.Tracks.Count} トラック　" +
                  $"{(int)length.TotalMinutes}分{length.Seconds:00}秒　" +
                  $"{session.SampleRate / 1000.0:0.#} kHz";
        }
        catch
        {
            detail = "開けませんでした";
        }

        bool current = string.Equals(folder, _currentFolder, StringComparison.OrdinalIgnoreCase);
        var when = Directory.GetLastWriteTime(folder);

        var stack = new StackPanel();
        var head = new StackPanel { Orientation = Orientation.Horizontal };
        head.Children.Add(new TextBlock
        {
            Text = name,
            FontWeight = FontWeights.SemiBold,
            FontSize = 13,
        });
        if (current)
        {
            head.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(2),
                Padding = new Thickness(6, 1, 6, 1),
                Margin = new Thickness(9, 0, 0, 0),
                Background = (Brush)FindResource("Info"),
                Child = new TextBlock
                {
                    Text = "いま開いています",
                    FontSize = 10,
                    Foreground = (Brush)FindResource("Ink"),
                },
            });
        }
        stack.Children.Add(head);

        stack.Children.Add(new TextBlock
        {
            Text = $"{detail}　　{when:yyyy/MM/dd HH:mm}",
            FontFamily = new FontFamily("Consolas"),
            FontSize = 11,
            Margin = new Thickness(0, 5, 0, 0),
            Foreground = (Brush)FindResource("FgDim"),
        });

        var open = new Button
        {
            Content = current ? "開いています" : "開く",
            Height = 28,
            Padding = new Thickness(14, 0, 14, 0),
            FontSize = 12,
            IsEnabled = !current,
            VerticalAlignment = VerticalAlignment.Center,
        };
        open.Click += (_, _) =>
        {
            ChosenFolder = folder;
            Close();
        };

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(stack, 0);
        Grid.SetColumn(open, 1);
        grid.Children.Add(stack);
        grid.Children.Add(open);

        return new Border
        {
            Style = (Style)FindResource("CardBorder"),
            Margin = new Thickness(0, 0, 0, 8),
            BorderBrush = (Brush)FindResource(current ? "StrongLine" : "Line"),
            Child = grid,
        };
    }

    private void BtnNew_Click(object sender, RoutedEventArgs e)
    {
        NewSessionRequested = true;
        Close();
    }

    private void BtnFolder_Click(object sender, RoutedEventArgs e)
    {
        Directory.CreateDirectory(_rootFolder);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_rootFolder}\"") { UseShellExecute = true });
    }

    private void BtnClose_Click(object sender, RoutedEventArgs e) => Close();
}
