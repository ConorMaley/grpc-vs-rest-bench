// In-process serialization micro-benchmark: no network, no HTTP. Prints one JSON line.
// Mirrors dotnet/Bench.Client/Micro.cs. Uses the same (de)serializers as the real hot paths:
// JSON.stringify/JSON.parse for REST, grpc-js's protobufjs-based (de)serializers for gRPC.
import { parseArgs } from "node:util";
import { makeOrder } from "./gen";
import { Benchmark } from "./proto";

const { values: a } = parseArgs({
  options: {
    scenario: { type: "string" },
    items: { type: "string", default: "10" },
    count: { type: "string", default: "100" },
  },
  strict: false,
});
const scenario = a.scenario as string;
const items = Number(a.items);
const count = Number(a.count);
const svc = Benchmark.service;

let gen: () => any;
let enc: (o: any) => Buffer;
let dec: (b: Buffer) => any;
switch (scenario) {
  case "echo":
    gen = () => ({ message: "ping" });
    [enc, dec] = [svc.Echo.requestSerialize, svc.Echo.requestDeserialize];
    break;
  case "getorder":
    gen = () => makeOrder(1, items);
    [enc, dec] = [svc.GetOrder.responseSerialize, svc.GetOrder.responseDeserialize];
    break;
  case "listorders":
    gen = () => ({ orders: Array.from({ length: count }, (_, i) => makeOrder(i + 1, items)) });
    [enc, dec] = [svc.ListOrders.responseSerialize, svc.ListOrders.responseDeserialize];
    break;
  case "createorder":
    gen = () => makeOrder(1, items);
    [enc, dec] = [svc.CreateOrder.requestSerialize, svc.CreateOrder.requestDeserialize];
    break;
  default:
    throw new Error(`unknown scenario ${scenario}`);
}

let sink = 0;
function sample(fn: () => unknown, ms: number): number {
  const t = performance.now();
  const end = t + ms;
  let n = 0;
  do {
    for (let i = 0; i < 5; i++) {
      const r: any = fn();
      sink += r?.length ?? 1;
    }
    n += 5;
  } while (performance.now() < end);
  return ((performance.now() - t) * 1000) / n; // µs per op
}
function bench(fn: () => unknown): number {
  sample(fn, 400); // warmup / JIT
  const s = [sample(fn, 500), sample(fn, 500), sample(fn, 500)].sort((x, y) => x - y);
  return Math.round(s[1] * 100) / 100;
}

const payload = gen();
const json = JSON.stringify(payload);
const jsonBuf = Buffer.from(json);
const protoBuf = enc(payload);

const result = {
  lang: "ts",
  scenario,
  items,
  count: scenario === "listorders" ? count : undefined,
  jsonBytes: jsonBuf.length,
  protoBytes: protoBuf.length,
  genUs: bench(gen),
  genProtoUs: undefined as number | undefined, // same generator feeds both protocols in TS
  jsonEncUs: bench(() => JSON.stringify(payload)),
  jsonDecUs: bench(() => JSON.parse(jsonBuf.toString("utf8"))),
  protoEncUs: bench(() => enc(payload)),
  protoDecUs: bench(() => dec(protoBuf)),
};
result.genProtoUs = result.genUs;
console.log(JSON.stringify(result));
if (sink === -1) console.error(sink);
