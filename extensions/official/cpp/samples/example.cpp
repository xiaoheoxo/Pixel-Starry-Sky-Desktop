// 示例：一个小型事件总线，覆盖模板、lambda、智能指针、concept 等写法。
#include <algorithm>
#include <concepts>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

#define APP_VERSION "1.0.0"

namespace demo {

/* 事件的种类 */
enum class Kind : std::uint8_t { Created, Updated, Removed };

template <typename T>
concept Printable = requires(std::ostream& os, const T& v) {
    { os << v } -> std::same_as<std::ostream&>;
};

struct Event {
    Kind kind;
    std::string name;
    std::optional<int> payload = std::nullopt;
};

class Listener {
public:
    virtual ~Listener() = default;
    virtual void on_event(const Event& event) = 0;
};

class Logger final : public Listener {
public:
    explicit Logger(std::string_view prefix) : prefix_(prefix) {}

    void on_event(const Event& event) override {
        std::cout << prefix_ << ": " << event.name;
        if (event.payload) {
            std::cout << " = " << *event.payload;
        }
        std::cout << '\n';
    }

private:
    std::string prefix_;
};

template <typename T, std::size_t N = 8>
class Ring {
public:
    constexpr bool push(T value) noexcept {
        if (size_ == N) return false;
        data_[(head_ + size_++) % N] = std::move(value);
        return true;
    }

    [[nodiscard]] constexpr std::size_t size() const noexcept { return size_; }

private:
    T data_[N]{};
    std::size_t head_ = 0, size_ = 0;
};

class Bus {
public:
    void subscribe(std::shared_ptr<Listener> listener) {
        listeners_.push_back(std::move(listener));
    }

    void publish(const Event& event) const {
        for (const auto& listener : listeners_) {
            listener->on_event(event);
        }
    }

private:
    std::vector<std::shared_ptr<Listener>> listeners_;
};

template <Printable T>
void print_all(const std::vector<T>& items) {
    for (const auto& item : items) {
        std::cout << item << ' ';
    }
    std::cout << std::endl;
}

}  // namespace demo

int main() {
    using namespace demo;
    Bus bus;
    bus.subscribe(std::make_shared<Logger>("log"));

    std::map<std::string, int> counts{{"a", 1}, {"b", 2}};
    if (auto it = counts.find("b"); it != counts.end()) {
        bus.publish({Kind::Updated, it->first, it->second});
    }
    for (const auto& [key, value] : counts) {
        bus.publish(Event{Kind::Created, key, value * 10});
    }

    std::vector<double> values = {1.5, 2.25, 3e2, 0x1Fp0};
    auto total = [&values] {
        double sum = 0;
        for (double v : values) sum += v;
        return sum;
    }();
    print_all(values);

    std::variant<int, std::string> v = std::string("text");
    std::visit([](const auto& x) { std::cout << x << "\n"; }, v);

    auto ring = std::make_unique<Ring<int>>();
    ring->push(42);
    std::cout << R"(raw "string" \n)" << total << ' ' << ring->size() << " v" APP_VERSION << '\n';
    return 0;
}
