import Fastify from "fastify";
import * as grpc from "@grpc/grpc-js";
import { makeOrder } from "./gen";
import { Benchmark, CHANNEL_OPTIONS } from "./proto";

// Ports: base = REST/HTTP1.1, base+1 = REST/h2c, base+2 = gRPC
const base = Number(process.env.BASE_PORT ?? 5200);
const HOST = "127.0.0.1";

function registerRoutes(app: any) {
  app.post("/echo", async (req: any) => req.body);
  app.get("/orders/:id", async (req: any) => makeOrder(Number(req.params.id), Number(req.query.items) || 1));
  app.get("/orders", async (req: any) => {
    const count = Number(req.query.count) || 1;
    const items = Number(req.query.items) || 1;
    const orders = new Array(count);
    for (let i = 0; i < count; i++) orders[i] = makeOrder(i + 1, items);
    return { orders };
  });
  app.post("/orders", async (req: any) => ({ id: req.body.id, itemCount: req.body.items.length }));
}

async function main() {
  const h1: any = Fastify({ logger: false });
  registerRoutes(h1);
  await h1.listen({ port: base, host: HOST });

  const h2: any = Fastify({ logger: false, http2: true }); // plaintext => h2c
  registerRoutes(h2);
  await h2.listen({ port: base + 1, host: HOST });

  const server = new grpc.Server(CHANNEL_OPTIONS);
  server.addService(Benchmark.service, {
    Echo: (call: any, cb: any) => cb(null, call.request),
    GetOrder: (call: any, cb: any) => cb(null, makeOrder(call.request.id, call.request.items || 1)),
    ListOrders: (call: any, cb: any) => {
      const { count, items } = call.request;
      const orders = new Array(count);
      for (let i = 0; i < count; i++) orders[i] = makeOrder(i + 1, items || 1);
      cb(null, { orders });
    },
    CreateOrder: (call: any, cb: any) => cb(null, { id: call.request.id, itemCount: call.request.items.length }),
  });
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(`${HOST}:${base + 2}`, grpc.ServerCredentials.createInsecure(), (err) => (err ? reject(err) : resolve())),
  );

  console.log("READY");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
