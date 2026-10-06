using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Bench.Common;
using Bench.Proto;
using Grpc.Net.Client;
using HdrHistogram;

var opt = ParseArgs(args);
string Get(string k, string d) => opt.TryGetValue(k, out var v) ? v : d;

var protocol = Get("protocol", "grpc");   // rest1 | rest2 | grpc
var scenario = Get("scenario", "echo");   // echo | getorder | listorders | createorder
var mode = Get("mode", "closed");         // closed | open
int concurrency = int.Parse(Get("concurrency", "10"));
int connections = int.Parse(Get("connections", "1"));
int duration = int.Parse(Get("duration", "10"));
int warmup = int.Parse(Get("warmup", "3"));
double rate = double.Parse(Get("rate", "1000"));
int items = int.Parse(Get("items", "10"));
int count = int.Parse(Get("count", "100"));
var host = Get("host", "127.0.0.1");
int basePort = int.Parse(Get("base-port", "5100"));

AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

var jsonOpts = new JsonSerializerOptions(JsonSerializerDefaults.Web);

// ---------- APIs: each call returns the response payload size in bytes ----------
IApi MakeApi() => protocol switch
{
    "rest1" => new RestApi(host, basePort, http2: false, concurrency, connections, jsonOpts),
    "rest2" => new RestApi(host, basePort + 1, http2: true, concurrency, connections, jsonOpts),
    "grpc" => new GrpcApi(host, basePort + 2, connections),
    _ => throw new ArgumentException($"unknown protocol {protocol}"),
};

Func<Task<int>> MakeOp(IApi api)
{
    switch (scenario)
    {
        case "echo": return () => api.Echo("ping");
        case "getorder":
            long id = 0;
            return () => api.GetOrder((Interlocked.Increment(ref id) - 1) % 1000 + 1, items);
        case "listorders": return () => api.ListOrders(count, items);
        case "createorder":
            var dto = Gen.Dto(1, items);
            var proto = Gen.Proto(1, items);
            return () => api.CreateOrder(dto, proto);
        default: throw new ArgumentException($"unknown scenario {scenario}");
    }
}

// ---------- probe: payload bytes per call ----------
async Task<(int req, int res)> Probe()
{
    SizeExt.ProbeMode = true;
    using var api = MakeApi();
    int res = await MakeOp(api)();
    SizeExt.ProbeMode = false;
    int req = scenario switch
    {
        "echo" => JsonSerializer.SerializeToUtf8Bytes(new EchoDto("ping"), jsonOpts).Length,
        "createorder" => JsonSerializer.SerializeToUtf8Bytes(Gen.Dto(1, items), jsonOpts).Length,
        _ => 0,
    };
    if (protocol == "grpc")
    {
        req = scenario switch
        {
            "echo" => new EchoMessage { Message = "ping" }.CalculateSize(),
            "getorder" => new GetOrderRequest { Id = 1, Items = items }.CalculateSize(),
            "listorders" => new ListOrdersRequest { Count = count, Items = items }.CalculateSize(),
            "createorder" => Gen.Proto(1, items).CalculateSize(),
            _ => 0,
        };
    }
    return (req, res);
}

// ---------- load drivers ----------
static double NowMs() => Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency;

var hist = new LongConcurrentHistogram(1, 120_000_000, 3);
long completed = 0, errors = 0, dropped = 0;
void Record(double startMs)
{
    hist.RecordValue(Math.Max(1, (long)Math.Round((NowMs() - startMs) * 1000)));
    Interlocked.Increment(ref completed);
}

async Task RunClosed(Func<Task<int>> op, double measureStart, double end)
{
    async Task Worker()
    {
        while (true)
        {
            double s = NowMs();
            if (s >= end) return;
            try
            {
                await op();
                if (s >= measureStart) Record(s);
            }
            catch
            {
                if (s >= measureStart) Interlocked.Increment(ref errors);
                if (Interlocked.Read(ref errors) > 1000 && Interlocked.Read(ref completed) == 0)
                    throw new Exception("too many errors, aborting");
            }
        }
    }
    await Task.WhenAll(Enumerable.Range(0, concurrency).Select(_ => Task.Run(Worker)));
}

// Open loop: fixed schedule; latency measured from the scheduled send time (no coordinated omission).
async Task RunOpen(Func<Task<int>> op, double t0, double measureStart, double end)
{
    double interval = 1000.0 / rate;
    const int MaxInflight = 20000;
    long i = 0, inflight = 0;
    while (true)
    {
        double now = NowMs();
        while (t0 + i * interval <= now && t0 + i * interval < end)
        {
            double sched = t0 + i * interval;
            i++;
            if (Interlocked.Read(ref inflight) >= MaxInflight)
            {
                if (sched >= measureStart) Interlocked.Increment(ref dropped);
                continue;
            }
            Interlocked.Increment(ref inflight);
            _ = Task.Run(async () =>
            {
                try
                {
                    await op();
                    if (sched >= measureStart) Record(sched);
                }
                catch
                {
                    if (sched >= measureStart) Interlocked.Increment(ref errors);
                }
                finally { Interlocked.Decrement(ref inflight); }
            });
        }
        if ((now >= end && Interlocked.Read(ref inflight) == 0) || now > end + 10_000) break;
        await Task.Delay(1);
    }
}

// ---------- main ----------
var (reqBytes, resBytes) = await Probe();
using (var api = MakeApi())
{
    var op = MakeOp(api);
    double t0 = NowMs();
    double measureStart = t0 + warmup * 1000.0;
    double end = measureStart + duration * 1000.0;
    if (mode == "open") await RunOpen(op, t0, measureStart, end);
    else await RunClosed(op, measureStart, end);
}

double Ms(double us) => Math.Round(us) / 1000.0;
var result = new Dictionary<string, object?>
{
    ["client"] = "dotnet",
    ["protocol"] = protocol,
    ["scenario"] = scenario,
    ["mode"] = mode,
    ["concurrency"] = concurrency,
    ["connections"] = protocol == "rest1" ? concurrency : connections,
    ["durationSec"] = duration,
    ["rate"] = mode == "open" ? rate : null,
    ["items"] = items,
    ["count"] = scenario == "listorders" ? count : null,
    ["requests"] = completed,
    ["errors"] = errors,
    ["dropped"] = dropped,
    ["rps"] = Math.Round(completed / (double)duration * 10) / 10,
    ["latencyMs"] = new Dictionary<string, double>
    {
        ["mean"] = Ms(hist.GetMean()),
        ["p50"] = Ms(hist.GetValueAtPercentile(50)),
        ["p95"] = Ms(hist.GetValueAtPercentile(95)),
        ["p99"] = Ms(hist.GetValueAtPercentile(99)),
        ["max"] = Ms(hist.GetMaxValue()),
    },
    ["requestBytes"] = reqBytes,
    ["responseBytes"] = resBytes,
};
Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull }));
return 0;

static Dictionary<string, string> ParseArgs(string[] a)
{
    var d = new Dictionary<string, string>();
    for (int i = 0; i + 1 < a.Length; i += 2) d[a[i].TrimStart('-')] = a[i + 1];
    return d;
}

interface IApi : IDisposable
{
    Task<int> Echo(string message);
    Task<int> GetOrder(long id, int items);
    Task<int> ListOrders(int count, int items);
    Task<int> CreateOrder(OrderDto dto, Order proto);
}

sealed class RestApi : IApi
{
    readonly HttpClient[] clients;
    readonly JsonSerializerOptions json;
    readonly Version version;
    int rr;

    public RestApi(string host, int port, bool http2, int concurrency, int connections, JsonSerializerOptions json)
    {
        this.json = json;
        version = http2 ? HttpVersion.Version20 : HttpVersion.Version11;
        int n = http2 ? connections : 1;
        clients = new HttpClient[n];
        for (int i = 0; i < n; i++)
        {
            var handler = new SocketsHttpHandler
            {
                MaxConnectionsPerServer = http2 ? int.MaxValue : concurrency,
                EnableMultipleHttp2Connections = false,
                PooledConnectionLifetime = Timeout.InfiniteTimeSpan,
            };
            clients[i] = new HttpClient(handler, disposeHandler: true)
            {
                BaseAddress = new Uri($"http://{host}:{port}"),
                DefaultRequestVersion = http2 ? HttpVersion.Version20 : HttpVersion.Version11,
                DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
                Timeout = TimeSpan.FromSeconds(60),
            };
        }
    }

    HttpClient Pick() => clients[(uint)Interlocked.Increment(ref rr) % (uint)clients.Length];

    async Task<int> Send<T>(HttpRequestMessage req)
    {
        req.Version = version;
        req.VersionPolicy = HttpVersionPolicy.RequestVersionExact;
        using var resp = await Pick().SendAsync(req, HttpCompletionOption.ResponseContentRead);
        resp.EnsureSuccessStatusCode();
        var bytes = await resp.Content.ReadAsByteArrayAsync();
        JsonSerializer.Deserialize<T>(bytes, json);
        return bytes.Length;
    }

    static HttpRequestMessage Post(string path, byte[] body)
    {
        var content = new ByteArrayContent(body);
        content.Headers.ContentType = new("application/json");
        return new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
    }

    public Task<int> Echo(string m) => Send<EchoDto>(Post("/echo", JsonSerializer.SerializeToUtf8Bytes(new EchoDto(m), json)));
    public Task<int> GetOrder(long id, int items) => Send<OrderDto>(new HttpRequestMessage(HttpMethod.Get, $"/orders/{id}?items={items}"));
    public Task<int> ListOrders(int count, int items) => Send<OrderListDto>(new HttpRequestMessage(HttpMethod.Get, $"/orders?count={count}&items={items}"));
    public Task<int> CreateOrder(OrderDto dto, Order proto) => Send<AckDto>(Post("/orders", JsonSerializer.SerializeToUtf8Bytes(dto, json)));

    public void Dispose() { foreach (var c in clients) c.Dispose(); }
}

sealed class GrpcApi : IApi
{
    readonly GrpcChannel[] channels;
    readonly Benchmark.BenchmarkClient[] clients;
    int rr;

    public GrpcApi(string host, int port, int connections)
    {
        channels = new GrpcChannel[connections];
        clients = new Benchmark.BenchmarkClient[connections];
        for (int i = 0; i < connections; i++)
        {
            channels[i] = GrpcChannel.ForAddress($"http://{host}:{port}", new GrpcChannelOptions
            {
                MaxReceiveMessageSize = null,
                MaxSendMessageSize = null,
                HttpHandler = new SocketsHttpHandler
                {
                    EnableMultipleHttp2Connections = false,
                    PooledConnectionLifetime = Timeout.InfiniteTimeSpan,
                },
            });
            clients[i] = new Benchmark.BenchmarkClient(channels[i]);
        }
    }

    Benchmark.BenchmarkClient Pick() => clients[(uint)Interlocked.Increment(ref rr) % (uint)clients.Length];

    public async Task<int> Echo(string m) => (await Pick().EchoAsync(new EchoMessage { Message = m })).CalculateSizeCheap();
    public async Task<int> GetOrder(long id, int items) => (await Pick().GetOrderAsync(new GetOrderRequest { Id = id, Items = items })).CalculateSizeCheap();
    public async Task<int> ListOrders(int count, int items) => (await Pick().ListOrdersAsync(new ListOrdersRequest { Count = count, Items = items })).CalculateSizeCheap();
    public async Task<int> CreateOrder(OrderDto dto, Order proto) => (await Pick().CreateOrderAsync(proto)).CalculateSizeCheap();

    public void Dispose() { foreach (var c in channels) c.Dispose(); }
}

static class SizeExt
{
    // Response sizes are only reported by the single-call probe; on the hot path this is a no-op
    // so gRPC is not charged for re-encoding the response.
    public static bool ProbeMode;
    public static int CalculateSizeCheap(this Google.Protobuf.IMessage m) => ProbeMode ? m.CalculateSize() : 0;
}
