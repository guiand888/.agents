# Architecture Standards

## Purpose
Define architectural patterns for resilient, scalable systems.

## Scope
Microservices, cloud-native design, 12-factor principles, and failure handling.

## Rules

### Always
- Build cloud-native microservices around business capabilities
- Design services as independently deployable units
- Keep services stateless with separate data stores
- Use loose coupling via lightweight APIs (REST)
- Follow Twelve-Factor App principles
- Design for horizontal scaling
- Use interfaces and abstract classes for clear boundaries
- Set an explicit timeout on every inter-service call — never rely on an implicit client-library default or an unbounded wait
- Propagate a timeout budget across service hops: pass the caller's remaining deadline downstream, and check it before starting further work
- Enforce a server-side limit alongside the client deadline for operations that mutate remote state (bulk writes, exports, long-running queries) — e.g. a database statement timeout
- Retry only transient failures, using exponential backoff with full jitter: `sleep = random(0, min(cap, base * 2 ** attempt))`
- Bound retries of single request/response calls with an attempt limit or a service-wide retry budget
- Retry indefinitely, with capped backoff and full jitter, for long-lived connections and subscriptions (message brokers, database pools, streaming clients) — override the client library's bounded-reconnect default
- Make giving up observable: a component that stops retrying must crash or raise an alertable signal
- Use circuit breaker patterns to prevent cascading failures
- Apply bulkhead patterns to isolate failing services: one resource pool — connection pool, HTTP transport, thread pool, worker queue — per downstream dependency

### Never
- Create tightly coupled services
- Mix business concerns in one service
- Create stateful services without clear separation
- Share a connection pool or HTTP transport across unrelated downstream dependencies
- Let a reconnect or retry loop exhaust its attempts and fall silent
- Treat a client-side timeout as having stopped the server-side work it initiated
- Retry a non-idempotent operation without an idempotency key or deduplication

## Retry & Timeout Reference

Backoff delay, per attempt: `sleep = random(0, min(cap, base * 2 ** attempt))`. Full jitter — a uniform draw across the whole interval — decorrelates retry waves. Symmetric jitter (a ±% band around the computed delay) leaves them correlated and is measurably weaker.

| Call shape | Retry policy | Failure mode |
|---|---|---|
| Single request/response (RPC, HTTP) | Bounded attempts or retry budget; exponential backoff + full jitter | Surface the error to the caller |
| Long-lived connection or subscription | Unbounded; exponential backoff + full jitter, capped interval | Crash or alertable signal — never fall silent |
| Mutating remote operation | Client deadline **and** server-side enforcement; idempotency key on retry | Orphaned server work — duplicate processing on retry |

The bounded/unbounded split is the distinction that matters: a single call must give up so its caller can, but a *connection* that gives up converts a transient dependency outage into a permanent one. Client libraries for brokers and databases commonly default to a bounded reconnect (for example, a fixed number of attempts at a fixed interval), after which the process keeps running while silently receiving and publishing nothing. Audit that default and either raise it to unbounded or make its exhaustion fatal.

A client-side deadline protects only the caller's own resources. Cancelling a call does not stop work already started on the far side, so a mutating operation needs its own server-enforced limit; otherwise the client times out, retries, and the orphaned first attempt completes anyway.

Sources:
- Marc Brooker, "Exponential Backoff And Jitter", AWS Architecture Blog, 2015-03-04 — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ — full jitter did the lowest total work of the variants measured, and completed far faster than equal jitter.
- Google SRE Book, Ch. 22, "Addressing Cascading Failures" — https://sre.google/sre-book/addressing-cascading-failures/ — randomized exponential backoff, per-request retry limits and retry budgets, and deadline propagation across the request tree.
