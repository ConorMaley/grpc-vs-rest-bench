using Bench.Proto;

namespace Bench.Common;

// Deterministic data generator. Must stay in lock-step with ts/src/gen.ts (same RNG, same call order).
// Dto() and Proto() deliberately duplicate the sequence so neither REST nor gRPC pays a mapping cost.
public static class Gen
{
    static readonly string[] Names = { "Ada Lovelace", "Alan Turing", "Grace Hopper", "Linus Torvalds", "Margaret Hamilton", "Dennis Ritchie" };
    static readonly string[] Countries = { "US", "GB", "DE", "FR", "JP", "AU", "CA", "BR" };
    static readonly string[] Tags = { "fragile", "gift", "express", "bulk", "returnable", "oversize", "perishable", "eco" };
    static readonly string[] Statuses = { "PENDING", "PAID", "SHIPPED", "CANCELLED" };

    struct Rng
    {
        uint s;
        public Rng(long seed) { s = unchecked((uint)seed * 2654435761u); }
        public uint Next() { s = unchecked(s * 1664525u + 1013904223u); return s >> 8; }
    }

    public static OrderDto Dto(long id, int items)
    {
        var r = new Rng(id);
        long customerId = r.Next() % 100000 + 1;
        var name = Names[r.Next() % Names.Length];
        var country = Countries[r.Next() % Countries.Length];
        var status = Statuses[r.Next() % Statuses.Length];
        long created = 1700000000000L + (long)r.Next() * 1000;
        long totalCents = 0;
        var lines = new List<LineItemDto>(items);
        for (int i = 0; i < items; i++)
        {
            var sku = "SKU-" + (r.Next() % 1000000).ToString("D6");
            int quantity = (int)(r.Next() % 10) + 1;
            long cents = r.Next() % 100000 + 100;
            int tagCount = (int)(r.Next() % 3);
            var tags = new List<string>(tagCount);
            for (int t = 0; t < tagCount; t++) tags.Add(Tags[r.Next() % Tags.Length]);
            totalCents += quantity * cents;
            lines.Add(new LineItemDto(sku, quantity, cents / 100.0, tags));
        }
        return new OrderDto(id, new CustomerDto(customerId, name, $"user{customerId}@example.com", country), created, status, totalCents / 100.0, lines);
    }

    public static Order Proto(long id, int items)
    {
        var r = new Rng(id);
        long customerId = r.Next() % 100000 + 1;
        var name = Names[r.Next() % Names.Length];
        var country = Countries[r.Next() % Countries.Length];
        int statusIdx = (int)(r.Next() % Statuses.Length);
        long created = 1700000000000L + (long)r.Next() * 1000;
        long totalCents = 0;
        var order = new Order
        {
            Id = id,
            Customer = new Customer { Id = customerId, Name = name, Email = $"user{customerId}@example.com", Country = country },
            CreatedAtMs = created,
            Status = (Status)(statusIdx + 1),
        };
        for (int i = 0; i < items; i++)
        {
            var line = new LineItem { Sku = "SKU-" + (r.Next() % 1000000).ToString("D6") };
            line.Quantity = (int)(r.Next() % 10) + 1;
            long cents = r.Next() % 100000 + 100;
            int tagCount = (int)(r.Next() % 3);
            for (int t = 0; t < tagCount; t++) line.Tags.Add(Tags[r.Next() % Tags.Length]);
            line.UnitPrice = cents / 100.0;
            totalCents += line.Quantity * cents;
            order.Items.Add(line);
        }
        order.Total = totalCents / 100.0;
        return order;
    }
}
