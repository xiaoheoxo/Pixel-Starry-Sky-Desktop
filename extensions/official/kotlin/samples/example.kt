package com.example.demo

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.time.Instant

/**
 * 示例：覆盖注释、字符串、数字、关键字、函数、类型。
 */
@Target(AnnotationTarget.CLASS)
annotation class Entity(val table: String = "")

sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>
    data class Err(val message: String, val code: Int = -1) : Result<Nothing>
}

@Entity(table = "users")
data class User(
    val id: Long,
    val name: String,
    val email: String? = null,
    val tags: List<String> = emptyList(),
)

enum class Level(val weight: Int) {
    LOW(1), MEDIUM(5), HIGH(10);

    fun isUrgent(): Boolean = this == HIGH
}

object Registry {
    private val users = mutableMapOf<Long, User>()
    const val MAX_USERS = 1_000

    fun add(user: User) {
        require(users.size < MAX_USERS) { "too many users: ${users.size}" }
        users[user.id] = user
    }

    operator fun get(id: Long): User? = users[id]
}

class Repository<T : Any>(private val loader: suspend (Long) -> T?) {
    companion object {
        private const val TAG = "Repository"
        val DEFAULT_TIMEOUT = 30_000L
    }

    private val cache by lazy { HashMap<Long, T>() }

    suspend fun find(id: Long): Result<T> {
        cache[id]?.let { return Result.Ok(it) }
        val value = withContext(Dispatchers.IO) { loader(id) }
        return if (value != null) {
            cache[id] = value
            Result.Ok(value)
        } else {
            Result.Err("not found: $id", code = 404)
        }
    }
}

fun String.initials(): String =
    split(' ', '-').filter { it.isNotBlank() }.joinToString("") { it.first().uppercase() }

fun ticker(periodMs: Long): Flow<Instant> = flow {
    while (true) {
        emit(Instant.now())
        delay(periodMs)
    }
}

fun describe(r: Result<User>): String = when (r) {
    is Result.Ok -> "user ${r.value.name} <${r.value.email ?: "n/a"}>"
    is Result.Err -> "error(${r.code}): ${r.message}"
}

fun main() = runBlocking {
    val repo = Repository<User> { id -> if (id > 0) User(id, "Ada Lovelace") else null }
    val raw = """
        |multi-line
        |  string with $TAG_PLACEHOLDER
    """.trimMargin()
    val ratio = 0x1F + 0b101 + 3.14f + 1e-3 + 100L
    val ch = '\n'
    val results = listOf(1L, 2L, -1L).map { async { repo.find(it) } }.awaitAll()
    for ((index, r) in results.withIndex()) {
        println("#$index ${describe(r as Result<User>)}") // trailing comment
    }
    println(raw.length + ratio.toInt() + ch.code)
}

private const val TAG_PLACEHOLDER = "x"
