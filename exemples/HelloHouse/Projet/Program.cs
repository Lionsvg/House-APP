var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var dataDir = Path.Combine(AppContext.BaseDirectory, "data");
Directory.CreateDirectory(dataDir);
var counterFile = Path.Combine(dataDir, "visites.txt");
var greeting = Environment.GetEnvironmentVariable("GREETING") ?? "Bonjour";
var gate = new object();

int NextVisit()
{
    lock (gate)
    {
        var n = File.Exists(counterFile) && int.TryParse(File.ReadAllText(counterFile), out var v) ? v + 1 : 1;
        File.WriteAllText(counterFile, n.ToString());
        return n;
    }
}

app.MapGet("/", () =>
{
    var n = NextVisit();
    var html = $$"""
        <!doctype html>
        <html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Hello House</title>
        <style>body{font-family:system-ui,sans-serif;background:#111214;color:#e8e8ea;display:grid;place-items:center;min-height:100vh;margin:0}
        main{text-align:center}h1{font-weight:600}p{color:#8b8d93}</style></head>
        <body><main><h1>{{greeting}}</h1><p>Visite n° {{n}} — .NET {{Environment.Version}}</p></main></body></html>
        """;
    return Results.Content(html, "text/html; charset=utf-8");
});

app.MapGet("/api/info", () => new { greeting, machine = Environment.MachineName, dotnet = Environment.Version.ToString() });

app.Run();
