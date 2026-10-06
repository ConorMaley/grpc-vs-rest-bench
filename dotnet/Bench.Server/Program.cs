using System.Net;
using Bench.Common;
using Bench.Proto;
using Grpc.Core;
using Microsoft.AspNetCore.Server.Kestrel.Core;

// Ports: base = REST/HTTP1.1, base+1 = REST/h2c, base+2 = gRPC
int basePort = int.Parse(Environment.GetEnvironmentVariable("BASE_PORT") ?? "5100");

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(o =>
{
    o.Listen(IPAddress.Loopback, basePort, l => l.Protocols = HttpProtocols.Http1);
    o.Listen(IPAddress.Loopback, basePort + 1, l => l.Protocols = HttpProtocols.Http2);
    o.Listen(IPAddress.Loopback, basePort + 2, l => l.Protocols = HttpProtocols.Http2);
});
builder.Services.AddGrpc(o => { o.MaxReceiveMessageSize = null; o.MaxSendMessageSize = null; });

var app = builder.Build();

app.MapGrpcService<BenchImpl>();
app.MapPost("/echo", (EchoDto e) => e);
app.MapGet("/orders/{id:long}", (long id, int? items) => Gen.Dto(id, items is > 0 ? items.Value : 1));
app.MapGet("/orders", (int count, int items) =>
{
    var orders = new List<OrderDto>(count);
    for (int i = 1; i <= count; i++) orders.Add(Gen.Dto(i, items));
    return new OrderListDto(orders);
});
app.MapPost("/orders", (OrderDto o) => new AckDto(o.Id, o.Items.Count));

app.Lifetime.ApplicationStarted.Register(() => Console.WriteLine("READY"));
app.Run();

class BenchImpl : Benchmark.BenchmarkBase
{
    public override Task<EchoMessage> Echo(EchoMessage request, ServerCallContext context) => Task.FromResult(request);

    public override Task<Order> GetOrder(GetOrderRequest request, ServerCallContext context) =>
        Task.FromResult(Gen.Proto(request.Id, request.Items > 0 ? request.Items : 1));

    public override Task<OrderList> ListOrders(ListOrdersRequest request, ServerCallContext context)
    {
        var list = new OrderList();
        for (int i = 1; i <= request.Count; i++) list.Orders.Add(Gen.Proto(i, request.Items));
        return Task.FromResult(list);
    }

    public override Task<CreateOrderAck> CreateOrder(Order request, ServerCallContext context) =>
        Task.FromResult(new CreateOrderAck { Id = request.Id, ItemCount = request.Items.Count });
}
