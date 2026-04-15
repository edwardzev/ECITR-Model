#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { captureConversationSnapshot } = require("../evidence/conversation-snapshot");
const { REPO_ROOT } = require("../validation/schema-registry");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const messages = JSON.parse(fs.readFileSync(options.messagesFile, "utf8"));
  const result = captureConversationSnapshot({
    catalogRoot: options.catalogRoot,
    conversationKey: options.conversationKey,
    messages,
    capturedAt: options.capturedAt,
    projectScope: options.projectScope,
    sourceLocator: options.sourceLocator,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: process.env.ECITR_CATALOG_ROOT ?? path.join(REPO_ROOT, ".local", "catalog"),
    projectScope: "project",
    sourceLocator: null,
    capturedAt: new Date().toISOString(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = args[++index];
        break;
      case "--conversation-key":
        options.conversationKey = args[++index];
        break;
      case "--messages-file":
        options.messagesFile = args[++index];
        break;
      case "--captured-at":
        options.capturedAt = args[++index];
        break;
      case "--project-scope":
        options.projectScope = args[++index];
        break;
      case "--source-locator":
        options.sourceLocator = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.conversationKey) {
    throw new Error("capture-conversation-snapshot requires --conversation-key.");
  }

  if (!options.messagesFile) {
    throw new Error("capture-conversation-snapshot requires --messages-file.");
  }

  return options;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
