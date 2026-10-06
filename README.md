# REST vs gRPC: .NET ⇄ TypeScript

Benchmarks REST (HTTP/1.1 + JSON), REST (HTTP/2 cleartext + JSON) and gRPC (HTTP/2 + protobuf) between a
.NET 10 service and a Node/TypeScript service, in **both directions** plus same-language baselines.
Everything is plaintext on loopback to keep TLS out of the picture.

## Layout

```
proto/bench.proto        single source of truth for the gRPC contract and the payload model
dotnet/Bench.Common      generated proto types, JSON DTOs, deterministic data generator
dotnet/Bench.Server      Kestrel: REST/1.1 (base), REST/h2c (base+1), gRPC (base+2)   default base 5100
dotnet/Bench.Client      load harness (HttpClient, Grpc.Net.Client, HdrHistogram)
ts/src/server.ts         Fastify (1.1 + h2c) and @grpc/grpc-js                          default base 5200
ts/src/client.ts         load harness (undici, node:http2, @grpc/grpc-js, hdr-histogram-js)
runner/                  orchestrator + markdown report
runner/micro.ts          serialization micro-benchmark + latency-share report
results/                 results-*.json/.md and micro-*.json/.md (git-ignored)
```

## Prerequisites

- Node 22+ — **use a native build for your CPU** (see "Apple Silicon" below)
- .NET SDK 10 (`brew install --cask dotnet-sdk`); if `dotnet` isn't on PATH set `DOTNET=/usr/local/share/dotnet/dotnet`

## Run

```sh
npm install
npm run build          # installs ts deps, compiles TS, builds .NET in Release
npm run smoke          # ~3 min, sanity check of all 4 client→server pairs
npm run bench          # "quick" preset
npm run bench -- --preset full          # all scenarios, concurrency 1/10/100/1000, 3 runs x 25s
```

Useful flags (all optional, they override the preset):

| flag | meaning |
|---|---|
| `--scenarios echo,getorder-large,listorders,createorder-small,...` | see table below |
| `--protocols rest1,rest2,grpc` | |
| `--servers ts,dotnet` / `--clients ts,dotnet` | restrict the matrix, e.g. `--servers dotnet --clients ts` |
| `--concurrency 1,10,100,1000` | closed loop: concurrent in-flight calls; open loop: max connections for REST/1.1 |
| `--duration 25 --warmup 8 --runs 3` | seconds measured, seconds discarded, repetitions |
| `--mode open --rate 2000` | open loop at a fixed req/s (latency measured from *scheduled* send time) |
| `--connections 4` | HTTP/2 + gRPC connections per client (default 1) |

Measure how much of the latency is serialization (JSON vs protobuf), in isolation and as a share of the
end-to-end c=1 p50 from the latest `results-*.json`:

```sh
npm run micro                                   # or: npm run micro -- --results results/results-<stamp>.json
```

Re-render a report: `npm run report -- results/results-<stamp>.json`.

Run one client by hand (both clients take identical flags and print one JSON line):

```sh
BASE_PORT=5100 dotnet dotnet/Bench.Server/bin/Release/net10.0/Bench.Server.dll &
node ts/dist/client.js --protocol grpc --scenario getorder --items 1000 --concurrency 100 --base-port 5100
```

## Scenarios

| name | operation | payload |
|---|---|---|
| `echo` | `POST /echo` / `Echo` | tiny message, measures per-call overhead |
| `getorder-small` / `-large` | `GET /orders/{id}?items=N` / `GetOrder` | Order with 10 / 1000 line items (~1 KB / ~72 KB JSON) |
| `listorders` | `GET /orders?count=1000&items=3` / `ListOrders` | 1000 orders in one response |
| `createorder-small` / `-large` | `POST /orders` / `CreateOrder` | client uploads an Order, server replies with a tiny ack |

Orders come from a seeded generator implemented identically in `ts/src/gen.ts` and `dotnet/Bench.Common/Gen.cs`;
both services return byte-identical JSON for the same request (verified with `cmp`).

## Method and caveats

- Closed loop: N workers each issue the next call when the previous one returns. Open loop: fixed schedule,
  capped at 20k in flight (excess is reported as `dropped`).
- Warmup is discarded; latency uses HdrHistogram (µs resolution, 3 significant digits). Reported figure per cell is the
  median run by throughput.
- Protocol order is rotated between runs to reduce order bias. One server process is reused for a whole sweep.
- Bytes are payload only (JSON body / protobuf message), not headers or framing.
- Server CPU is process CPU time (`ps cputime`) over the whole client run, warmup included; 100% = one core.
  Client and server share the machine, so they compete for cores — treat absolute numbers as relative.
- Defaults left untouched on purpose: Kestrel allows 100 concurrent streams per HTTP/2 connection, and each client uses
  one HTTP/2 connection unless `--connections` says otherwise. At high concurrency this queues streams for REST/h2c
  and gRPC but not for REST/1.1 (which opens N connections). Compare `--connections 1` vs `--connections 8` to see it.
- Fastify uses plain `JSON.stringify` (no response schema / fast-json-stringify); .NET uses reflection-based
  `System.Text.Json`. Both are "typical" setups, not maximally tuned.
- Test the numbers on an otherwise idle machine, plugged in, not thermally throttled.

## Apple Silicon

If `file $(which node)` says `x86_64` on an M-series Mac, Node runs under Rosetta and TypeScript results will be
unfairly slow compared with native .NET. The runner prints a warning in that case. Fix: install an arm64 Node
(from a terminal that is *not* running under Rosetta, e.g. `nvm install 22` after confirming `uname -m` prints `arm64`
and `node -p process.arch` prints `arm64`).
