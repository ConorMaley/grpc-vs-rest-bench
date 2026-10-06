import { spawn, execFileSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { renderReport, Row } from "./report";
import { SCENARIOS } from "./scenarios";

const ROOT = path.resolve(__dirname, "..");
const DOTNET = process.env.DOTNET ?? "dotnet";

const PRESETS: Record<string, any> = {
  smoke: { scenarios: "echo,getorder-large", concurrency: "1,10", duration: 3, warmup: 1, runs: 1 },
  quick: { scenarios: "echo,getorder-large,listorders,createorder-large", concurrency: "1,100", duration: 10, warmup: 3, runs: 1 },
  full: { scenarios: Object.keys(SCENARIOS).join(","), concurrency: "1,10,100,1000", duration: 25, warmup: 8, runs: 3 },
};

const { values: a } = parseArgs({
  options: {
    preset: { type: "string", default: "quick" },
    scenarios: { type: "string" },
    protocols: { type: "string", default: "rest1,rest2,grpc" },
    servers: { type: "string", default: "ts,dotnet" },
    clients: { type: "string", default: "ts,dotnet" },
    concurrency: { type: "string" },
    duration: { type: "string" },
    warmup: { type: "string" },
    runs: { type: "string" },
    mode: { type: "string", default: "closed" },
    rate: { type: "string", default: "2000" },
    connections: { type: "string", default: "1" },
    out: { type: "string", default: "results" },
  },
});
const preset = PRESETS[a.preset!];
if (!preset) throw new Error(`unknown preset ${a.preset}`);
const cfg = {
  scenarios: (a.scenarios ?? preset.scenarios).split(","),
  protocols: a.protocols!.split(","),
  servers: a.servers!.split(","),
  clients: a.clients!.split(","),
  concurrency: (a.concurrency ?? preset.concurrency).split(",").map(Number),
  duration: Number(a.duration ?? preset.duration),
  warmup: Number(a.warmup ?? preset.warmup),
  runs: Number(a.runs ?? preset.runs),
  mode: a.mode!,
  rate: Number(a.rate),
  connections: Number(a.connections),
};

const SERVERS: Record<string, { cmd: string; args: string[]; basePort: number }> = {
  ts: { cmd: "node", args: [path.join(ROOT, "ts/dist/server.js")], basePort: 5200 },
  dotnet: { cmd: DOTNET, args: [path.join(ROOT, "dotnet/Bench.Server/bin/Release/net10.0/Bench.Server.dll")], basePort: 5100 },
};
const CLIENTS: Record<string, { cmd: string; args: string[] }> = {
  ts: { cmd: "node", args: [path.join(ROOT, "ts/dist/client.js")] },
  dotnet: { cmd: DOTNET, args: [path.join(ROOT, "dotnet/Bench.Client/bin/Release/net10.0/Bench.Client.dll")] },
};

function startServer(name: string): Promise<ChildProcess> {
  const s = SERVERS[name];
  const child = spawn(s.cmd, s.args, { env: { ...process.env, BASE_PORT: String(s.basePort) }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.on("exit", (c) => reject(new Error(`${name} server exited early (${c})`)));
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("READY")) resolve(child);
    });
    setTimeout(() => reject(new Error(`${name} server start timeout`)), 30000);
  });
}

// cumulative CPU seconds + RSS (KB) of a pid, via ps
function sample(pid: number): { cpuSec: number; rssKb: number } {
  const [cputime, rss] = execFileSync("ps", ["-o", "cputime=,rss=", "-p", String(pid)]).toString().trim().split(/\s+/);
  const parts = cputime.split(":").map(Number);
  const cpuSec = parts.reduce((acc, p) => acc * 60 + p, 0);
  return { cpuSec, rssKb: Number(rss) };
}

function runClient(client: string, args: string[]): Promise<any> {
  const c = CLIENTS[client];
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, [...c.args, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`client ${client} exited ${code}`));
      resolve(JSON.parse(out.trim().split("\n").pop()!));
    });
  });
}

function warnRosetta() {
  const apple = os.cpus()[0]?.model.includes("Apple");
  if (apple && process.arch === "x64") {
    console.warn(
      "\n!! WARNING: Node is an x86_64 build running under Rosetta on Apple Silicon, while .NET runs natively.\n" +
        "!! This penalises every TypeScript result. Install a native arm64 Node (see README) before trusting numbers.\n",
    );
  }
}

async function main() {
  warnRosetta();
  fs.mkdirSync(path.join(ROOT, a.out!), { recursive: true });
  const rows: Row[] = [];
  const total = cfg.servers.length * cfg.clients.length * cfg.scenarios.length * cfg.protocols.length * cfg.concurrency.length * cfg.runs;
  let n = 0;

  for (const server of cfg.servers) {
    const proc = await startServer(server);
    try {
      for (const client of cfg.clients) {
        for (const scenarioName of cfg.scenarios) {
          const sc = SCENARIOS[scenarioName];
          if (!sc) throw new Error(`unknown scenario ${scenarioName}`);
          for (const conc of cfg.concurrency) {
            for (let run = 1; run <= cfg.runs; run++) {
              // rotate protocol order each run to reduce order bias
              const protos = [...cfg.protocols.slice(run % cfg.protocols.length), ...cfg.protocols.slice(0, run % cfg.protocols.length)];
              for (const protocol of protos) {
                n++;
                const args = [
                  "--protocol", protocol, "--scenario", sc.scenario, "--mode", cfg.mode,
                  "--concurrency", String(conc), "--connections", String(cfg.connections),
                  "--duration", String(cfg.duration), "--warmup", String(cfg.warmup), "--rate", String(cfg.rate),
                  "--items", String(sc.items ?? 10), "--count", String(sc.count ?? 100),
                  "--base-port", String(SERVERS[server].basePort),
                ];
                const before = sample(proc.pid!);
                let rssMax = before.rssKb;
                const t0 = Date.now();
                const timer = setInterval(() => (rssMax = Math.max(rssMax, sample(proc.pid!).rssKb)), 500);
                const res = await runClient(client, args).finally(() => clearInterval(timer));
                const after = sample(proc.pid!);
                const wall = (Date.now() - t0) / 1000;
                const row: Row = {
                  ...res,
                  server,
                  scenarioName,
                  run,
                  serverCpuPct: Math.round(((after.cpuSec - before.cpuSec) / wall) * 1000) / 10,
                  serverRssMaxMb: Math.round(Math.max(rssMax, after.rssKb) / 1024),
                };
                rows.push(row);
                console.log(
                  `[${n}/${total}] ${client}→${server} ${protocol.padEnd(5)} ${scenarioName} c=${conc} run${run}: ` +
                    `${row.rps} rps  p50=${row.latencyMs.p50} p99=${row.latencyMs.p99}ms  err=${row.errors}  cpu=${row.serverCpuPct}%`,
                );
              }
            }
          }
        }
      }
    } finally {
      proc.removeAllListeners("exit");
      proc.kill();
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const meta = { date: new Date().toISOString(), host: `${process.platform}/${os.arch()}`, node: process.version, nodeArch: process.arch, preset: a.preset, ...cfg };
  const file = path.join(ROOT, a.out!, `results-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta, rows }, null, 1));
  fs.writeFileSync(file.replace(/\.json$/, ".md"), renderReport(rows, meta));
  console.log(`\nWrote ${path.relative(ROOT, file)} and .md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
