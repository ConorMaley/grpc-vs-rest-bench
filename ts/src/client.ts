import { parseArgs } from "node:util";
import * as http2 from "node:http2";
import * as grpc from "@grpc/grpc-js";
import * as hdr from "hdr-histogram-js";
import { Pool } from "undici";
import { makeOrder } from "./gen";
import { Benchmark, CHANNEL_OPTIONS } from "./proto";

const { values: a } = parseArgs({
  options: {
    protocol: { type: "string" }, // rest1 | rest2 | grpc
    scenario: { type: "string" }, // echo | getorder | listorders | createorder
    mode: { type: "string", default: "closed" }, // closed | open
    concurrency: { type: "string", default: "10" },
    connections: { type: "string", default: "1" }, // h2 / grpc connection count
    duration: { type: "string", default: "10" },
    warmup: { type: "string", default: "3" },
    rate: { type: "string", default: "1000" }, // open mode, req/s
    items: { type: "string", default: "10" },
    count: { type: "string", default: "100" },
    host: { type: "string", default: "127.0.0.1" },
    "base-port": { type: "string", default: "5100" },
  },
});

const protocol = a.protocol!;
const scenario = a.scenario!;
const mode = a.mode!;
const concurrency = Number(a.concurrency);
const connections = Number(a.connections);
const duration = Number(a.duration);
const warmup = Number(a.warmup);
const rate = Number(a.rate);
const items = Number(a.items);
const count = Number(a.count);
const host = a.host!;
const basePort = Number(a["base-port"]);

// An Api method performs one call and returns the response payload size in bytes.
interface Api {
  echo(message: string): Promise<number>;
  getOrder(id: number, items: number): Promise<number>;
  listOrders(count: number, items: number): Promise<number>;
  createOrder(order: unknown): Promise<number>;
  close(): void;
}

// ---------- REST / HTTP 1.1 (undici) ----------
function rest1Api(): Api {
  const pool = new Pool(`http://${host}:${basePort}`, { connections: concurrency, pipelining: 1 });
  async function call(method: "GET" | "POST", path: string, body?: string): Promise<number> {
    const res = await pool.request({
      path,
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body,
    });
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
    JSON.parse(buf.toString("utf8"));
    return buf.length;
  }
  return {
    echo: (m) => call("POST", "/echo", JSON.stringify({ message: m })),
    getOrder: (id, n) => call("GET", `/orders/${id}?items=${n}`),
    listOrders: (c, n) => call("GET", `/orders?count=${c}&items=${n}`),
    createOrder: (o) => call("POST", "/orders", JSON.stringify(o)),
    close: () => void pool.close(),
  };
}

// ---------- REST / h2c (node:http2, prior knowledge) ----------
function rest2Api(): Api {
  const sessions = Array.from({ length: connections }, () => http2.connect(`http://${host}:${basePort + 1}`));
  sessions.forEach((s) => s.on("error", () => {}));
  let rr = 0;
  function call(method: "GET" | "POST", path: string, body?: string): Promise<number> {
    const session = sessions[rr++ % sessions.length];
    return new Promise((resolve, reject) => {
      const req = session.request({
        ":method": method,
        ":path": path,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      });
      const chunks: Buffer[] = [];
      let status = 0;
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (status !== 200) return reject(new Error(`status ${status}`));
        const buf = Buffer.concat(chunks);
        JSON.parse(buf.toString("utf8"));
        resolve(buf.length);
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  return {
    echo: (m) => call("POST", "/echo", JSON.stringify({ message: m })),
    getOrder: (id, n) => call("GET", `/orders/${id}?items=${n}`),
    listOrders: (c, n) => call("GET", `/orders?count=${c}&items=${n}`),
    createOrder: (o) => call("POST", "/orders", JSON.stringify(o)),
    close: () => sessions.forEach((s) => s.close()),
  };
}

// ---------- gRPC (@grpc/grpc-js) ----------
const lastBytes = { req: 0, res: 0 };

function grpcClients(wrap: boolean): any[] {
  let svc: any = Benchmark.service;
  if (wrap) {
    // Probe-only: record serialized sizes. Not used on the measured path.
    svc = {};
    for (const [k, d] of Object.entries<any>(Benchmark.service)) {
      svc[k] = {
        ...d,
        requestSerialize: (v: any) => {
          const b = d.requestSerialize(v);
          lastBytes.req = b.length;
          return b;
        },
        responseDeserialize: (b: Buffer) => {
          lastBytes.res = b.length;
          return d.responseDeserialize(b);
        },
      };
    }
  }
  const Ctor = grpc.makeGenericClientConstructor(svc, "Benchmark");
  return Array.from(
    { length: wrap ? 1 : connections },
    () =>
      new Ctor(`${host}:${basePort + 2}`, grpc.credentials.createInsecure(), {
        ...CHANNEL_OPTIONS,
        "grpc.use_local_subchannel_pool": 1, // one real connection per client
      }) as any,
  );
}

function grpcApi(wrap = false): Api {
  const clients = grpcClients(wrap);
  let rr = 0;
  const pick = () => clients[rr++ % clients.length];
  const unary = (method: string, req: unknown): Promise<number> =>
    new Promise((resolve, reject) =>
      pick()[method](req, (err: Error | null) => (err ? reject(err) : resolve(lastBytes.res))),
    );
  return {
    echo: (m) => unary("echo", { message: m }),
    getOrder: (id, n) => unary("getOrder", { id, items: n }),
    listOrders: (c, n) => unary("listOrders", { count: c, items: n }),
    createOrder: (o) => unary("createOrder", o),
    close: () => clients.forEach((c) => c.close()),
  };
}

// ---------- scenario ops ----------
function makeOp(api: Api): () => Promise<number> {
  switch (scenario) {
    case "echo":
      return () => api.echo("ping");
    case "getorder": {
      let id = 0;
      return () => api.getOrder((id++ % 1000) + 1, items);
    }
    case "listorders":
      return () => api.listOrders(count, items);
    case "createorder": {
      const order = makeOrder(1, items);
      return () => api.createOrder(order);
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

// One sequential call against a size-recording client, to report payload bytes per call.
async function probeBytes(): Promise<{ requestBytes: number; responseBytes: number }> {
  if (protocol === "grpc") {
    const api = grpcApi(true);
    lastBytes.req = lastBytes.res = 0;
    await makeOp(api)();
    api.close();
    return { requestBytes: lastBytes.req, responseBytes: lastBytes.res };
  }
  const api = protocol === "rest1" ? rest1Api() : rest2Api();
  const responseBytes = await makeOp(api)();
  api.close();
  let requestBytes = 0;
  if (scenario === "echo") requestBytes = Buffer.byteLength(JSON.stringify({ message: "ping" }));
  if (scenario === "createorder") requestBytes = Buffer.byteLength(JSON.stringify(makeOrder(1, items)));
  return { requestBytes, responseBytes };
}

// ---------- load drivers ----------
const hist = hdr.build({ lowestDiscernibleValue: 1, highestTrackableValue: 120_000_000, numberOfSignificantValueDigits: 3 });
let completed = 0;
let errors = 0;
let dropped = 0;

async function runClosed(op: () => Promise<number>, measureStart: number, end: number) {
  const worker = async () => {
    while (true) {
      const s = performance.now();
      if (s >= end) return;
      try {
        await op();
        if (s >= measureStart) {
          hist.recordValue(Math.max(1, Math.round((performance.now() - s) * 1000)));
          completed++;
        }
      } catch {
        if (s >= measureStart) errors++;
        if (errors > 1000 && completed === 0) throw new Error("too many errors, aborting");
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// Open loop: requests are issued on a fixed schedule regardless of completions, and latency is
// measured from the *scheduled* send time (avoids coordinated omission).
async function runOpen(op: () => Promise<number>, t0: number, measureStart: number, end: number) {
  const interval = 1000 / rate;
  const MAX_INFLIGHT = 20000;
  let i = 0;
  let inflight = 0;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = performance.now();
      while (t0 + i * interval <= now && t0 + i * interval < end) {
        const sched = t0 + i * interval;
        i++;
        if (inflight >= MAX_INFLIGHT) {
          if (sched >= measureStart) dropped++;
          continue;
        }
        inflight++;
        op()
          .then(() => {
            if (sched >= measureStart) {
              hist.recordValue(Math.max(1, Math.round((performance.now() - sched) * 1000)));
              completed++;
            }
          })
          .catch(() => {
            if (sched >= measureStart) errors++;
          })
          .finally(() => inflight--);
      }
      if ((now >= end && inflight === 0) || now > end + 10_000) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
}

async function main() {
  const bytes = await probeBytes();
  const api = protocol === "rest1" ? rest1Api() : protocol === "rest2" ? rest2Api() : grpcApi();
  const op = makeOp(api);

  const t0 = performance.now();
  const measureStart = t0 + warmup * 1000;
  const end = measureStart + duration * 1000;
  if (mode === "open") await runOpen(op, t0, measureStart, end);
  else await runClosed(op, measureStart, end);
  api.close();

  const ms = (us: number) => Math.round(us) / 1000;
  const result = {
    client: "ts",
    protocol,
    scenario,
    mode,
    concurrency,
    connections: protocol === "rest1" ? concurrency : connections,
    durationSec: duration,
    rate: mode === "open" ? rate : undefined,
    items,
    count: scenario === "listorders" ? count : undefined,
    requests: completed,
    errors,
    dropped,
    rps: Math.round((completed / duration) * 10) / 10,
    latencyMs: {
      mean: ms(hist.mean),
      p50: ms(hist.getValueAtPercentile(50)),
      p95: ms(hist.getValueAtPercentile(95)),
      p99: ms(hist.getValueAtPercentile(99)),
      max: ms(hist.maxValue),
    },
    ...bytes,
  };
  console.log(JSON.stringify(result));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
