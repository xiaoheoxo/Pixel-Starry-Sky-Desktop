/*
 * 示例：简单的整数栈，覆盖注释、字符串、数字、关键字、函数和类型。
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include "stack.h"

#define STACK_INITIAL_CAPACITY 16
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define UNUSED(x) (void)(x)

#ifdef DEBUG
#define LOG(fmt, ...) fprintf(stderr, "[debug] " fmt "\n", __VA_ARGS__)
#else
#define LOG(fmt, ...) ((void)0)
#endif

typedef enum {
    STACK_OK = 0,
    STACK_EMPTY,
    STACK_NOMEM,
} stack_status;

typedef struct stack {
    int32_t *items;
    size_t   size;
    size_t   capacity;
} stack;

static const double kGrowthFactor = 1.5;
static const char *const kNames[] = { "ok", "empty", "no memory" };

// 创建一个栈，失败返回 NULL
stack *stack_new(void) {
    stack *s = malloc(sizeof(*s));
    if (s == NULL) {
        return NULL;
    }
    s->items = malloc(STACK_INITIAL_CAPACITY * sizeof(*s->items));
    if (s->items == NULL) {
        free(s);
        return NULL;
    }
    s->size = 0;
    s->capacity = STACK_INITIAL_CAPACITY;
    return s;
}

stack_status stack_push(stack *s, int32_t value) {
    if (s->size == s->capacity) {
        size_t new_cap = (size_t)(s->capacity * kGrowthFactor) + 1;
        int32_t *grown = realloc(s->items, new_cap * sizeof(*grown));
        if (!grown) {
            return STACK_NOMEM;
        }
        s->items = grown;
        s->capacity = new_cap;
    }
    s->items[s->size++] = value;
    LOG("push %d, size=%zu", value, s->size);
    return STACK_OK;
}

stack_status stack_pop(stack *s, int32_t *out) {
    if (s->size == 0) {
        return STACK_EMPTY;
    }
    *out = s->items[--s->size];
    return STACK_OK;
}

void stack_free(stack *s) {
    if (s != NULL) {
        free(s->items);
        free(s);
    }
}

int main(int argc, char *argv[]) {
    UNUSED(argv);
    unsigned long mask = 0xFFUL | 0b1010 | 017;
    float ratio = 3.14159f, small = 1.5e-3;
    char letter = 'a', newline = '\n';
    bool ok = true;

    stack *s = stack_new();
    if (s == NULL) {
        perror("stack_new");
        return EXIT_FAILURE;
    }

    for (int i = 0; i < argc * 4; i++) {
        switch (i % 3) {
        case 0:
            stack_push(s, i);
            break;
        case 1:
            stack_push(s, MAX(i, 10));
            break;
        default:
            continue;
        }
    }

    int32_t value;
    while (stack_pop(s, &value) == STACK_OK) {
        printf("value = %d (%s)%c", value, kNames[STACK_OK], newline);
    }

    printf("mask=%lu ratio=%.2f small=%g letter=%c ok=%d\n", mask, ratio, small, letter, ok);
    stack_free(s);
    return EXIT_SUCCESS;
}
