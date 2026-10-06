import * as fs from "node:fs";

export interface Row {
  server: string;
  client: string;
  protocol: string;
  scenario: string;
  scenarioName: string;
  mode: string;
  concurrency: number;
  connections: number;
  run: number;
  requests: number;
  errors: number;
  dropped: number;
  rps: number;
  latencyMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  requestBytes: number;
  responseBytes: number;
  serverCpuPct: number;
  serverRssMaxMb: number;
  rate?: number;
}

const PROTO_LABEL: Record<string, string> = { rest1: "REST/1.1+JSON", rest2: "REST/h2c+JSON", grpc: "gRPC+protobuf" };

function median(rows: Row[]): Row {
  const s = [...rows].sort((a, b) => a.rps - b.rps);
  return s[Math.floor(s.length / 2)];
}

export function renderReport(rows: Row[], meta: Record<string, unknown>): string {
  const out: string[] = ["# gRPC vs REST benchmark", ""];
  out.push("```json", JSON.stringify(meta, null, 2), "```", "");
  out.push(
    "Each cell is the **median run by throughput** across repeated runs. `client → server` shows the direction. " +
      "Bytes are payload only (no HTTP/gRPC framing or headers). CPU is server process CPU over the whole client run " +
      "(warmup included; 100% = one core). Latency is in ms.",
    "",
  );
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.scenarioName}|${r.mode}|${r.concurrency}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const byScenario = new Map<string, string[]>();
  for (const k of groups.keys()) {
    const [s] = k.split("|");
    (byScenario.get(s) ?? byScenario.set(s, []).get(s)!).push(k);
  }
  for (const [scenario, keys] of byScenario) {
    out.push(`## ${scenario}`, "");
    for (const k of keys) {
      const [, mode, conc] = k.split("|");
      const label = mode === "open" ? `open loop, ${groups.get(k)![0].rate} req/s, up to ${conc} connections` : `closed loop, concurrency ${conc}`;
      out.push(`### ${label}`, "");
      out.push("| direction | protocol | req/s | p50 | p95 | p99 | max | req B | resp B | srv CPU % | srv RSS MB | errors |");
      out.push("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
      const cells = new Map<string, Row[]>();
      for (const r of groups.get(k)!) {
        const ck = `${r.client}→${r.server}|${r.protocol}`;
        (cells.get(ck) ?? cells.set(ck, []).get(ck)!).push(r);
      }
      const order = ["rest1", "rest2", "grpc"];
      const sorted = [...cells.entries()].sort((x, y) => {
        const [dx, px] = x[0].split("|");
        const [dy, py] = y[0].split("|");
        return dx.localeCompare(dy) || order.indexOf(px) - order.indexOf(py);
      });
      for (const [ck, rs] of sorted) {
        const [dir, proto] = ck.split("|");
        const m = median(rs);
        out.push(
          `| ${dir} | ${PROTO_LABEL[proto] ?? proto} | ${m.rps.toLocaleString("en-US")} | ${m.latencyMs.p50} | ${m.latencyMs.p95} | ${m.latencyMs.p99} | ${m.latencyMs.max} | ${m.requestBytes} | ${m.responseBytes} | ${m.serverCpuPct} | ${m.serverRssMaxMb} | ${m.errors} |`,
        );
      }
      out.push("");
    }
  }
  return out.join("\n");
}

if (process.argv[1].endsWith("report.ts")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npm run report -- results/<file>.json");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const md = renderReport(data.rows, data.meta);
  fs.writeFileSync(file.replace(/\.json$/, ".md"), md);
  console.log(md);
}
