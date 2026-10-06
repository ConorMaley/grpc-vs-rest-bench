import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_PATH = path.resolve(__dirname, "../../proto/bench.proto");

const def = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});

export const proto = grpc.loadPackageDefinition(def) as any;
export const Benchmark = proto.bench.Benchmark;
export const CHANNEL_OPTIONS = {
  "grpc.max_receive_message_length": -1,
  "grpc.max_send_message_length": -1,
};
