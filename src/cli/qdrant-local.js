#!/usr/bin/env node

const {
  DEFAULT_QDRANT_VERSION,
  resolveLocalQdrantPaths,
  installLocalQdrantBinary,
  startLocalQdrant,
  stopLocalQdrant,
  getLocalQdrantStatus,
} = require("../qdrant/local-runtime");

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const paths = resolveLocalQdrantPaths();

  let result;
  switch (command) {
    case "install":
      result = await installLocalQdrantBinary({
        version: options.version,
        paths,
      });
      break;
    case "start":
      result = await startLocalQdrant({
        version: options.version,
        paths,
        host: options.host,
        httpPort: options.httpPort,
        grpcPort: options.grpcPort,
      });
      break;
    case "stop":
      result = await stopLocalQdrant({
        paths,
        host: options.host,
        httpPort: options.httpPort,
      });
      break;
    case "status":
      result = await getLocalQdrantStatus({
        paths,
        host: options.host,
        httpPort: options.httpPort,
      });
      break;
    default:
      throw new Error(`Unsupported qdrant local command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    version: DEFAULT_QDRANT_VERSION,
    host: "127.0.0.1",
    httpPort: 6333,
    grpcPort: 6334,
  };

  const [command = "status", ...rest] = args;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--version":
        options.version = rest[++index];
        break;
      case "--host":
        options.host = rest[++index];
        break;
      case "--http-port":
        options.httpPort = Number.parseInt(rest[++index], 10);
        break;
      case "--grpc-port":
        options.grpcPort = Number.parseInt(rest[++index], 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    command,
    options,
  };
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
