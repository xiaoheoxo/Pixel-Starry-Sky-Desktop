package com.example.demo;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * 示例：订单服务。
 *
 * @author demo
 */
@SuppressWarnings("unused")
public class OrderService {

    private static final int MAX_ITEMS = 100;
    private static final double TAX_RATE = 0.0825;
    private static final long TIMEOUT_MS = 0x7FFF_FFFFL;
    private static final String GREETING = "hello, \"world\"\n";

    private final Map<String, Order> orders = new ConcurrentHashMap<>();

    public sealed interface Shape permits Circle, Square {}

    public record Circle(double radius) implements Shape {}

    public record Square(double side) implements Shape {}

    public enum Status {
        NEW, PAID, SHIPPED;

        public boolean isFinal() {
            return this == SHIPPED;
        }
    }

    public record Order(String id, List<String> items, Status status) {
        public Order {
            if (items == null || items.size() > MAX_ITEMS) {
                throw new IllegalArgumentException("items");
            }
        }
    }

    // 查找订单，不存在时返回空
    public Optional<Order> find(String id) {
        return Optional.ofNullable(orders.get(id));
    }

    /* 统计各状态数量 */
    public Map<Status, Long> countByStatus() {
        return orders.values().stream()
                .collect(Collectors.groupingBy(Order::status, Collectors.counting()));
    }

    public static double area(Shape shape) {
        return switch (shape) {
            case Circle c -> Math.PI * c.radius() * c.radius();
            case Square s -> s.side() * s.side();
        };
    }

    public <T extends Comparable<T>> T max(List<? extends T> values) {
        T best = null;
        for (T v : values) {
            if (best == null || v.compareTo(best) > 0) {
                best = v;
            }
        }
        return best;
    }

    public static void main(String[] args) throws Exception {
        var service = new OrderService();
        List<Integer> nums = new ArrayList<>(List.of(1, 2, 3));
        char c = 'x';
        float f = 1.5f;
        boolean flag = nums.size() > 2 && c != 'y';
        String text = """
            多行文本块
            第二行 %d
            """.formatted(42);
        Runnable r = () -> System.out.println(text + f + flag);
        r.run();
        Thread.sleep(Duration.ofMillis(10).toMillis());
    }
}
