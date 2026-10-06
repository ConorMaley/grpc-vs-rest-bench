using System.Diagnostics;
using System.Text.Json;
using Bench.Common;
using Bench.Proto;
using Google.Protobuf;

// In-process serialization micro-benchmark: no network, no HTTP. Prints one JSON line.
// Mirrors ts/src/micro.ts. REST path = System.Text.Json over DTOs; gRPC path = Google.Protobuf.
static class Micro
{
    static long sink;

    static double Sample(Action fn, int ms)
    {
        var sw = Stopwatch.StartNew();
        long n = 0;
        do { for (int i = 0; i < 5; i++) fn(); n += 5; } while (sw.ElapsedMilliseconds < ms);
        return sw.Elapsed.TotalMilliseconds * 1000.0 / n; // µs per op
    }

    static double Bench(Action fn)
    {
        Sample(fn, 400);
        var s = new[] { Sample(fn, 500), Sample(fn, 500), Sample(fn, 500) };
        Array.Sort(s);
        return Math.Round(s[1] * 100) / 100;
    }

    public static int Run(Dictionary<string, string> opt)
    {
        string scenario = opt["scenario"];
        int items = int.Parse(opt.GetValueOrDefault("items", "10"));
        int count = int.Parse(opt.GetValueOrDefault("count", "100"));
        var jopt = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        Func<object> genDto;
        Func<IMessage> genProto;
        Type dtoType;
        MessageParser parser;
        switch (scenario)
        {
            case "echo":
                genDto = () => new EchoDto("ping");
                genProto = () => new EchoMessage { Message = "ping" };
                dtoType = typeof(EchoDto); parser = EchoMessage.Parser; break;
            case "getorder":
            case "createorder":
                genDto = () => Gen.Dto(1, items);
                genProto = () => Gen.Proto(1, items);
                dtoType = typeof(OrderDto); parser = Order.Parser; break;
            case "listorders":
                genDto = () => { var l = new List<OrderDto>(count); for (int i = 1; i <= count; i++) l.Add(Gen.Dto(i, items)); return new OrderListDto(l); };
                genProto = () => { var l = new OrderList(); for (int i = 1; i <= count; i++) l.Orders.Add(Gen.Proto(i, items)); return l; };
                dtoType = typeof(OrderListDto); parser = OrderList.Parser; break;
            default: throw new ArgumentException($"unknown scenario {scenario}");
        }

        var dto = genDto();
        var proto = genProto();
        byte[] jsonBytes = JsonSerializer.SerializeToUtf8Bytes(dto, dtoType, jopt);
        byte[] protoBytes = proto.ToByteArray();

        var result = new Dictionary<string, object?>
        {
            ["lang"] = "dotnet",
            ["scenario"] = scenario,
            ["items"] = items,
            ["jsonBytes"] = jsonBytes.Length,
            ["protoBytes"] = protoBytes.Length,
            ["genUs"] = Bench(() => sink += genDto().GetHashCode() & 1),
            ["genProtoUs"] = Bench(() => sink += genProto().CalculateSize() & 1),
            ["jsonEncUs"] = Bench(() => sink += JsonSerializer.SerializeToUtf8Bytes(dto, dtoType, jopt).Length),
            ["jsonDecUs"] = Bench(() => sink += JsonSerializer.Deserialize(jsonBytes, dtoType, jopt)!.GetHashCode() & 1),
            ["protoEncUs"] = Bench(() => sink += proto.ToByteArray().Length),
            ["protoDecUs"] = Bench(() => sink += parser.ParseFrom(protoBytes).GetHashCode() & 1),
        };
        if (scenario == "listorders") result["count"] = count;
        Console.WriteLine(JsonSerializer.Serialize(result));
        if (sink == long.MinValue) Console.Error.WriteLine(sink);
        return 0;
    }
}
