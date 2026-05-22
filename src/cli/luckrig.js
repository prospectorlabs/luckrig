#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startProxyServer } from '../proxy/server.js';
import { generateBoxKeyPair } from '../shared/keyhandshake.js';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return `luckrig POC CLI

Usage:
  luckrig register --tracker http://127.0.0.1:8787 --endpoint-url http://127.0.0.1:8788/v1 --model-name qwen --quantization Q4_K_M --gpu RTX_5090 [--node-public-key PEM] [--dry-run]
  luckrig token --tracker http://127.0.0.1:8787 --node-id first-5090-qwen3 [--user-id alice] [--contribution-score 1] [--crypto-mode plain|public-key|session-secret] [--user-public-key PEM]
  luckrig proxy --node-id first-5090-qwen3 [--port 8788] [--upstream-url http://127.0.0.1:8088/v1] [--node-private-key PEM]
  luckrig keygen [--out-prefix node]

Notes:
  - register/token use tracker HTTP API.
  - proxy starts the node-side luckrig proxy with /health and /v1/chat/completions.
  - --dry-run prints the request JSON without network access.
`;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(payload)}`);
  return payload;
}

function required(args, key) {
  if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  return args[key];
}

export function buildRegisterRequest(args) {
  const body = {
    id: args.id,
    display_name: args.displayName,
    endpoint_url: required(args, 'endpointUrl'),
    health_url: args.healthUrl,
    node_public_key: args.nodePublicKey,
    model_name: required(args, 'modelName'),
    quantization: required(args, 'quantization'),
    lora: args.lora,
    gpu: required(args, 'gpu'),
    vram_gb: args.vramGb ? Number(args.vramGb) : undefined,
    context_length: args.contextLength ? Number(args.contextLength) : undefined,
    availability_note: args.availabilityNote,
    tuning_note: args.tuningNote,
    tags: args.tags ? String(args.tags).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };
  const tracker = args.tracker ?? 'http://127.0.0.1:8787';
  return { method: 'POST', url: `${tracker.replace(/\/$/, '')}/api/nodes`, body };
}

async function register(args) {
  const request = buildRegisterRequest(args);
  if (args.dryRun) {
    console.log(JSON.stringify(request, null, 2));
    return;
  }
  console.log(JSON.stringify(await postJson(request.url, request.body), null, 2));
}

export function buildTokenRequest(args) {
  const body = {
    node_id: required(args, 'nodeId'),
    user_id: args.userId ?? 'anonymous',
    contribution_score: args.contributionScore ? Number(args.contributionScore) : 0,
    ttl_sec: args.ttlSec ? Number(args.ttlSec) : undefined,
    crypto_mode: args.cryptoMode,
    user_public_key: args.userPublicKey,
    node_public_key: args.nodePublicKey,
  };
  const tracker = args.tracker ?? 'http://127.0.0.1:8787';
  return { method: 'POST', url: `${tracker.replace(/\/$/, '')}/api/tokens`, body };
}

async function token(args) {
  const request = buildTokenRequest(args);
  if (args.dryRun) {
    console.log(JSON.stringify(request, null, 2));
    return;
  }
  console.log(JSON.stringify(await postJson(request.url, request.body), null, 2));
}

async function keygen(args) {
  const keys = generateBoxKeyPair();
  if (args.outPrefix) {
    const publicPath = `${args.outPrefix}-public.pem`;
    const privatePath = `${args.outPrefix}-private.pem`;
    await writeFile(publicPath, keys.publicKeyPem, { mode: 0o644 });
    await writeFile(privatePath, keys.privateKeyPem, { mode: 0o600 });
    console.log(JSON.stringify({ public_key_path: publicPath, private_key_path: privatePath }, null, 2));
    return;
  }
  console.log(JSON.stringify(keys, null, 2));
}

function proxy(args) {
  startProxyServer({
    host: args.host ?? '127.0.0.1',
    port: args.port ? Number(args.port) : 8788,
    nodeId: args.nodeId ?? process.env.LUCKRIG_NODE_ID,
    trackerSecret: args.trackerSecret ?? process.env.LUCKRIG_TRACKER_SECRET,
    upstreamUrl: args.upstreamUrl ?? process.env.LUCKRIG_UPSTREAM_URL,
    nodePrivateKey: args.nodePrivateKey ?? process.env.LUCKRIG_NODE_PRIVATE_KEY,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    console.log(usage());
    return;
  }
  if (command === 'register') return register(args);
  if (command === 'token') return token(args);
  if (command === 'proxy') return proxy(args);
  if (command === 'keygen') return keygen(args);
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
