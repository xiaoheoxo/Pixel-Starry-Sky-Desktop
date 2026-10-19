// 示例：覆盖注释、字符串、数字、关键字、类型、特性、LINQ、模式匹配、异步等
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Demo.Orders;

/// <summary>订单状态。</summary>
public enum OrderStatus { Pending, Paid, Shipped, Cancelled }

public interface IOrderStore
{
    Task<Order?> FindAsync(int id, CancellationToken cancellationToken = default);
}

public record Order(int Id, string Customer, decimal Total, OrderStatus Status = OrderStatus.Pending)
{
    public bool IsOpen => Status is OrderStatus.Pending or OrderStatus.Paid;
}

[Obsolete("Use OrderService instead")]
public sealed class LegacyService { }

public class OrderService(IOrderStore store, ILogger<OrderService> logger)
{
    private const int MaxRetries = 3;
    private static readonly string Prefix = @"C:\orders\";
    private readonly Dictionary<int, Order> _cache = new();

    /* 块注释：先查缓存，再查存储 */
    public async Task<Order> GetAsync(int id, CancellationToken ct = default)
    {
        if (_cache.TryGetValue(id, out var cached)) return cached;

        for (var attempt = 1; attempt <= MaxRetries; attempt++)
        {
            try
            {
                var order = await store.FindAsync(id, ct) ?? throw new KeyNotFoundException($"订单 {id} 不存在");
                _cache[id] = order;
                logger.LogInformation("Loaded order {OrderId} on attempt {Attempt}", id, attempt);
                return order;
            }
            catch (TimeoutException ex) when (attempt < MaxRetries)
            {
                logger.LogWarning(ex, "Retry {Attempt}", attempt);
            }
        }
        throw new InvalidOperationException("unreachable");
    }

    public static string Describe(object value) => value switch
    {
        null => "null",
        int n when n > 100 => $"big {n:N0}",
        int n => $"int {n}",
        Order { Status: OrderStatus.Cancelled } => "cancelled order",
        Order o => $"order #{o.Id} for {o.Customer}",
        string { Length: 0 } => "empty",
        _ => value.ToString() ?? "?",
    };

    public static IEnumerable<string> TopCustomers(IEnumerable<Order> orders, int count = 5)
    {
        var query = from o in orders
                    where o.IsOpen && o.Total >= 0x10
                    group o by o.Customer into g
                    orderby g.Sum(x => x.Total) descending
                    select g.Key;
        return query.Take(count).ToList();
    }

    public static double Ratio() => 1_000.5e-2 / 3.14f + 0b1010 + 'x';
}

#region Helpers
internal static class Raw
{
    public const string Json = """
        { "name": "demo", "count": 3 }
        """;
}
#endregion
