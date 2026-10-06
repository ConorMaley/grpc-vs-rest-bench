import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { SCENARIOS } from "./scenarios";

// Measures serialization in isolation (no network) in each language, then, if an end-to-end results
// file is available, estimates what share of c=1 median latency serialization and data generation are.

const ROOT = path.resolve(__dirname, "..");
const DOTNET = process.env.DOTNET ?? "dotnet";
const { values: a } = parseArgs({
  options: { results: { type: "string" }, out: { type: "string", default: "results" }, scenarios: { type: "string" } },
});

const CMDS: Record<string, { cmd: string; args: string[] }> = {
  ts: { cmd: "node", args: [path.join(ROOT, "ts/dist/micro.js")] },
  dotnet: { cmd: DOTNET, args: [path.join(ROOT, "dotnet/Bench.Client/bin/Release/net10.0/Bench.Client.dll"), "--micro", "1"] },
};

interface Micro {
  lang: string; scenarioName: string; scenario: string; jsonBytes: number; protoBytes: number;
  genUs: number; genProtoUs: number; jsonEncUs: number; jsonDecUs: number; protoEncUs: number; protoDecUs: number;
}

function run(lang: string, args: string[]): Promise<any> {
  const c = CMDS[lang];
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, [...c.args, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(`${lang} micro exited ${code}`))));
  });
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
const f1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");
const pct = (n: number) => `${Math.round(n * 100)}%`;

async function main() {
  if (process.arch === "x64" && os.cpus()[0]?.model.includes("Apple")) {
    console.warn("\n!! WARNING: Node is x86_64 under Rosetta; TS timings are pessimistic. See README.\n");
  }
  const names = (a.scenarios ?? Object.keys(SCENARIOS).join(",")).split(",");
  const micro: Micro[] = [];
  for (const lang of Object.keys(CMDS)) {
    for (const name of names) {
      const sc = SCENARIOS[name];
      const args = ["--scenario", sc.scenario, "--items", String(sc.items ?? 10), "--count", String(sc.count ?? 100)];
      const r = await run(lang, args);
      micro.push({ ...r, scenarioName: name });
      console.log(`${lang.padEnd(6)} ${name.padEnd(18)} json enc/dec ${r.jsonEncUs}/${r.jsonDecUs}µs  proto enc/dec ${r.protoEncUs}/${r.protoDecUs}µs`);
    }
  }

  const md: string[] = ["# Serialization micro-benchmark", ""];
  md.push("In-process, no network. µs per operation (median of 3 x 0.5s samples after warmup). " +
    "JSON = `JSON.stringify`/`JSON.parse` (TS), `System.Text.Json` (.NET). Proto = protobufjs via grpc-js (TS), Google.Protobuf (.NET).", "");
  md.push("| lang | scenario | JSON B | proto B | gen µs | JSON enc | JSON dec | proto enc | proto dec |", "|---|---|--:|--:|--:|--:|--:|--:|--:|");
  for (const m of micro) {
    md.push(`| ${m.lang} | ${m.scenarioName} | ${m.jsonBytes} | ${m.protoBytes} | ${f1(m.genUs)} | ${f1(m.jsonEncUs)} | ${f1(m.jsonDecUs)} | ${f1(m.protoEncUs)} | ${f1(m.protoDecUs)} |`);
  }
  md.push("");

  // join with end-to-end results
  let resultsFile = a.results;
  if (!resultsFile) {
    const dir = path.join(ROOT, a.out!);
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^results-.*\.json$/.test(f)).sort() : [];
    if (all.length) resultsFile = path.join(dir, all[all.length - 1]);
  }
  if (resultsFile) {
    const data = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    const rows: any[] = data.rows.filter((r: any) => r.mode === "closed");
    const minC = Math.min(...rows.map((r) => r.concurrency));
    const get = (lang: string, name: string) => micro.find((m) => m.lang === lang && m.scenarioName === name);

    md.push(`## Share of end-to-end latency (c=${minC}, median p50) — from \`${path.basename(resultsFile)}\``, "");
    md.push("Serialization = the encode + decode work on the path of one call: the server encodes and the client decodes a response " +
      "(getorder/listorders), the client encodes and the server decodes a request (createorder), both for echo. " +
      "Gen = server-side data generation inside the timed call (getorder/listorders only; identical work for every protocol). " +
      "Other = HTTP/framing, sockets, scheduling, and client/server framework overhead. Warm, isolated micro timings, so this is an estimate.", "");
    md.push("| scenario | direction | protocol | e2e p50 µs | serialization µs | ser % | gen µs | gen % | other % |", "|---|---|---|--:|--:|--:|--:|--:|--:|");
    const keys = new Set<string>(rows.filter((r) => r.concurrency === minC).map((r) => `${r.scenarioName}|${r.client}|${r.server}|${r.protocol}`));
    const order = ["rest1", "rest2", "grpc"];
    const sorted = [...keys].sort((x, y) => {
      const [sx, cx, vx, px] = x.split("|");
      const [sy, cy, vy, py] = y.split("|");
      return sx.localeCompare(sy) || `${cx}${vx}`.localeCompare(`${cy}${vy}`) || order.indexOf(px) - order.indexOf(py);
    });
    for (const k of sorted) {
      const [name, client, server, protocol] = k.split("|");
      const p50us = median(rows.filter((r) => r.concurrency === minC && `${r.scenarioName}|${r.client}|${r.server}|${r.protocol}` === k).map((r) => r.latencyMs.p50 * 1000));
      const c = get(client, name), s = get(server, name);
      if (!c || !s) continue;
      const grpc = protocol === "grpc";
      const enc = (m: Micro) => (grpc ? m.protoEncUs : m.jsonEncUs);
      const dec = (m: Micro) => (grpc ? m.protoDecUs : m.jsonDecUs);
      const scn = SCENARIOS[name].scenario;
      const ser = scn === "echo" ? enc(s) + dec(c) + enc(c) + dec(s) : scn === "createorder" ? enc(c) + dec(s) : enc(s) + dec(c);
      const gen = scn === "getorder" || scn === "listorders" ? (grpc ? s.genProtoUs : s.genUs) : 0;
      const other = Math.max(0, 1 - (ser + gen) / p50us);
      md.push(`| ${name} | ${client}→${server} | ${grpc ? "gRPC" : protocol === "rest1" ? "REST/1.1" : "REST/h2c"} | ${f1(p50us)} | ${f1(ser)} | ${pct(ser / p50us)} | ${f1(gen)} | ${pct(gen / p50us)} | ${pct(other)} |`);
    }
    md.push("");
  } else {
    md.push("_No end-to-end results file found; run `npm run bench` first to get latency shares._", "");
  }

  fs.mkdirSync(path.join(ROOT, a.out!), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(ROOT, a.out!, `micro-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ date: new Date().toISOString(), nodeArch: process.arch, rows: micro }, null, 1));
  fs.writeFileSync(`${base}.md`, md.join("\n"));
  console.log(`\n${md.join("\n")}\n\nWrote ${path.relative(ROOT, base)}.json/.md`);
}

main().catch((e) => { console.error(e); process.exit(1); });
