namespace Bench.Common;

// REST/JSON shapes. Property names serialize as camelCase and match the TS service exactly.
public record CustomerDto(long Id, string Name, string Email, string Country);
public record LineItemDto(string Sku, int Quantity, double UnitPrice, List<string> Tags);
public record OrderDto(long Id, CustomerDto Customer, long CreatedAtMs, string Status, double Total, List<LineItemDto> Items);
public record OrderListDto(List<OrderDto> Orders);
public record AckDto(long Id, int ItemCount);
public record EchoDto(string Message);
