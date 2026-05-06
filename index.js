const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error(`Only linux amd64/x64 is supported. Current platform=${process.platform}, arch=${process.arch}`);
  process.exit(1);
}

const app = express();

const UPLOAD_URL = process.env.UPLOAD_URL || '';
const PROJECT_URL = process.env.PROJECT_URL || '';
const AUTO_ACCESS = /^(1|true|yes|on)$/i.test(process.env.AUTO_ACCESS || '');
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const UUID = process.env.UUID || crypto.randomUUID();
const ARGO_DOMAIN = normalizeDomain(process.env.ARGO_DOMAIN || '');
const PUBLIC_SUB_DOMAIN = normalizeDomain(process.env.PUBLIC_SUB_DOMAIN || '');
const ARGO_AUTH = (process.env.ARGO_AUTH || '').trim();
const ARGO_PROTOCOL = normalizeProtocol(process.env.ARGO_PROTOCOL || 'http2');
const EDGE_IP_VERSION = normalizeEdgeIpVersion(process.env.EDGE_IP_VERSION || 'auto');
const CFIP = process.env.CFIP || 'saas.sin.fan';
const CFPORT = String(process.env.CFPORT || '443');
const FP = process.env.FP || 'chrome';
const NAME = process.env.NAME || 'singbox-argo';
const SUB_PATH = cleanRoutePath(process.env.SUB_PATH || 'sub', 'sub');
const FORCE_UPDATE = /^(1|true|yes|on)$/i.test(process.env.FORCE_UPDATE || '');

if (!process.env.UUID) {
  console.warn(`[warn] UUID is not set. Generated temporary UUID for this run: ${UUID}`);
}

const RUN_DIR = path.resolve(FILE_PATH);
const webPath = path.join(RUN_DIR, 'sing-box');
const botPath = path.join(RUN_DIR, 'cloudflared');
const configPath = path.join(RUN_DIR, 'config.json');
const subPath = path.join(RUN_DIR, 'sub.txt');
const listPath = path.join(RUN_DIR, 'list.txt');
const tunnelJsonPath = path.join(RUN_DIR, 'tunnel.json');
const tunnelConfigPath = path.join(RUN_DIR, 'tunnel.yml');

const wsTargets = {
  '/vless-argo': 3002,
  '/vmess-argo': 3003,
  '/trojan-argo': 3004,
};

let rawSubscription = '';
let encodedSubscription = '';
let singBoxStatus = 'starting';
let cloudflaredStatus = 'starting';
let tunnelMode = detectTunnelMode();
let temporaryDomain = '';
let currentDomain = ARGO_DOMAIN;
let restartRequested = false;

fs.mkdirSync(RUN_DIR, { recursive: true });
console.log(`[init] run directory: ${RUN_DIR}`);
console.log(`[init] tunnel mode: ${tunnelMode}`);
console.log(`[init] ARGO_PROTOCOL=${ARGO_PROTOCOL}, EDGE_IP_VERSION=${EDGE_IP_VERSION}`);
console.log(`[init] FORCE_UPDATE=${FORCE_UPDATE}`);

function cleanRoutePath(value, fallback) {
  const clean = String(value || fallback).replace(/^\/+|\/+$/g, '');
  return clean || fallback;
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

function normalizeProtocol(value) {
  const protocol = String(value || 'http2').toLowerCase();
  if (['http2', 'quic'].includes(protocol)) return protocol;
  console.warn(`[warn] unsupported ARGO_PROTOCOL=${value}, fallback to http2`);
  return 'http2';
}

function normalizeEdgeIpVersion(value) {
  const edge = String(value || 'auto').toLowerCase();
  if (['4', '6', 'auto'].includes(edge)) return edge;
  console.warn(`[warn] unsupported EDGE_IP_VERSION=${value}, fallback to auto`);
  return 'auto';
}

function detectTunnelMode() {
  if (ARGO_AUTH.includes('TunnelSecret')) return 'json';
  if (ARGO_AUTH) return 'token';
  if (!ARGO_AUTH && !ARGO_DOMAIN) return 'try';
  return 'invalid';
}

function registerGetRoutes(routes, handler) {
  [...new Set(routes)].forEach((route) => app.get(route, handler));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function maskUuid(value) {
  if (!value || value.length < 12) return 'not set';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMemoryUsage() {
  const memory = process.memoryUsage();
  return `rss ${formatBytes(memory.rss)}, heap ${formatBytes(memory.heapUsed)}/${formatBytes(memory.heapTotal)}`;
}

function formatUptime() {
  const seconds = Math.floor(process.uptime());
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function sanitizeSudo(command) {
  return command
    .replace(/(^|[\s;&|()])sudo(\s+-[A-Za-z]+)*(?=\s)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function runKoCommand() {
  const koCommand = (process.env.ko || '').trim();
  if (!koCommand) {
    console.log('ko variable is empty, skip Komari agent');
    return Promise.resolve();
  }

  const command = sanitizeSudo(koCommand);
  console.log('[ko] ko variable detected, running Komari agent command with bash');

  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout.on('data', (data) => process.stdout.write(`[ko] ${data}`));
    child.stderr.on('data', (data) => process.stderr.write(`[ko] ${data}`));
    child.on('error', (error) => {
      console.error(`[ko] failed to start command: ${error.message}`);
      resolve();
    });
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[ko] Komari agent command finished');
      } else {
        console.error(`[ko] Komari agent command exited with code ${code}; continue startup`);
      }
      resolve();
    });
  });
}

function deleteOldUploadedNodes() {
  if (!UPLOAD_URL || !fs.existsSync(subPath)) return;

  try {
    const fileContent = fs.readFileSync(subPath, 'utf-8');
    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter((line) => /^(vless|vmess|trojan):\/\//.test(line));
    if (nodes.length === 0) return;

    axios.post(`${UPLOAD_URL}/api/delete-nodes`, { nodes }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }).then(() => {
      console.log('[upload] old nodes deleted');
    }).catch((error) => {
      console.error(`[upload] delete old nodes failed: ${error.message}`);
    });
  } catch (error) {
    console.error(`[upload] read old subscription failed: ${error.message}`);
  }
}

function cleanupRuntimeFiles() {
  const files = [
    configPath,
    tunnelJsonPath,
    tunnelConfigPath,
    path.join(RUN_DIR, 'sing-box.tar.gz'),
  ];

  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      console.error(`[cleanup] failed to remove ${file}: ${error.message}`);
    }
  }

  try {
    fs.rmSync(path.join(RUN_DIR, 'sing-box-extract'), { recursive: true, force: true });
  } catch (error) {
    console.error(`[cleanup] failed to remove extract directory: ${error.message}`);
  }
}

function generateConfig() {
  const config = {
    log: {
      level: 'warn',
      timestamp: true,
    },
    inbounds: [
      {
        type: 'vless',
        tag: 'vless-ws-in',
        listen: '127.0.0.1',
        listen_port: 3002,
        users: [
          {
            name: NAME,
            uuid: UUID,
          },
        ],
        transport: {
          type: 'ws',
          path: '/vless-argo',
        },
      },
      {
        type: 'vmess',
        tag: 'vmess-ws-in',
        listen: '127.0.0.1',
        listen_port: 3003,
        users: [
          {
            name: NAME,
            uuid: UUID,
            alterId: 0,
          },
        ],
        transport: {
          type: 'ws',
          path: '/vmess-argo',
        },
      },
      {
        type: 'trojan',
        tag: 'trojan-ws-in',
        listen: '127.0.0.1',
        listen_port: 3004,
        users: [
          {
            name: NAME,
            password: UUID,
          },
        ],
        transport: {
          type: 'ws',
          path: '/trojan-argo',
        },
      },
    ],
    outbounds: [
      {
        type: 'direct',
        tag: 'direct',
      },
      {
        type: 'block',
        tag: 'block',
      },
    ],
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[sing-box] config generated: ${configPath}`);
}

function getSubscriptionDomain() {
  if (tunnelMode === 'invalid') return '';
  if (tunnelMode === 'try') return temporaryDomain;
  return currentDomain;
}

function getSubscriptionDisplayDomain() {
  return PUBLIC_SUB_DOMAIN || getSubscriptionDomain();
}

function buildNodes() {
  const host = getSubscriptionDomain();
  if (!host) return null;

  const prefix = NAME || 'singbox-argo';
  const vlessName = encodeURIComponent(`${prefix}-vless`);
  const vmessName = `${prefix}-vmess`;
  const trojanName = encodeURIComponent(`${prefix}-trojan`);
  const vlessPath = encodeURIComponent('/vless-argo?ed=2048');
  const trojanPath = encodeURIComponent('/trojan-argo');

  const vless = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${vlessPath}#${vlessName}`;
  const vmessConfig = {
    v: '2',
    ps: vmessName,
    add: CFIP,
    port: CFPORT,
    id: UUID,
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host,
    path: '/vmess-argo',
    tls: 'tls',
    sni: host,
    alpn: '',
    fp: FP,
  };
  const vmess = `vmess://${Buffer.from(JSON.stringify(vmessConfig)).toString('base64')}`;
  const trojan = `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${trojanPath}#${trojanName}`;

  return { host, vless, vmess, trojan };
}

function refreshSubscriptionCache() {
  const nodes = buildNodes();
  if (!nodes) {
    rawSubscription = '';
    encodedSubscription = '';
    if (tunnelMode === 'try') {
      console.log('[sub] temporary tunnel domain not ready');
    } else {
      console.error('[sub] ARGO_DOMAIN is empty, subscription is not generated');
    }
    return;
  }

  rawSubscription = [nodes.vless, nodes.vmess, nodes.trojan].join('\n');
  encodedSubscription = Buffer.from(rawSubscription).toString('base64');
  fs.writeFileSync(subPath, encodedSubscription);
  fs.writeFileSync(listPath, rawSubscription);
  console.log(`[sub] subscription domain: ${nodes.host}`);
  console.log(`[sub] subscription saved: ${subPath}`);
  console.log(`[sub] raw nodes saved: ${listPath}`);
}

function buildSingBoxClientConfig() {
  const nodes = buildNodes();
  if (!nodes) return null;

  return {
    outbounds: [
      {
        type: 'vless',
        tag: `${NAME}-vless`,
        server: CFIP,
        server_port: Number(CFPORT),
        uuid: UUID,
        tls: {
          enabled: true,
          server_name: nodes.host,
          utls: {
            enabled: true,
            fingerprint: FP,
          },
        },
        transport: {
          type: 'ws',
          path: '/vless-argo?ed=2048',
          headers: {
            Host: nodes.host,
          },
        },
      },
      {
        type: 'vmess',
        tag: `${NAME}-vmess`,
        server: CFIP,
        server_port: Number(CFPORT),
        uuid: UUID,
        security: 'auto',
        alter_id: 0,
        tls: {
          enabled: true,
          server_name: nodes.host,
          utls: {
            enabled: true,
            fingerprint: FP,
          },
        },
        transport: {
          type: 'ws',
          path: '/vmess-argo',
          headers: {
            Host: nodes.host,
          },
        },
      },
      {
        type: 'trojan',
        tag: `${NAME}-trojan`,
        server: CFIP,
        server_port: Number(CFPORT),
        password: UUID,
        tls: {
          enabled: true,
          server_name: nodes.host,
          utls: {
            enabled: true,
            fingerprint: FP,
          },
        },
        transport: {
          type: 'ws',
          path: '/trojan-argo',
          headers: {
            Host: nodes.host,
          },
        },
      },
    ],
  };
}

function buildClashProxies() {
  const nodes = buildNodes();
  if (!nodes) return '';

  const port = Number(CFPORT);
  return [
    'proxies:',
    `  - name: ${yamlQuote(`${NAME}-vless`)}`,
    '    type: vless',
    `    server: ${yamlQuote(CFIP)}`,
    `    port: ${port}`,
    `    uuid: ${yamlQuote(UUID)}`,
    '    network: ws',
    '    tls: true',
    '    udp: true',
    `    servername: ${yamlQuote(nodes.host)}`,
    `    client-fingerprint: ${yamlQuote(FP)}`,
    '    ws-opts:',
    '      path: /vless-argo?ed=2048',
    '      headers:',
    `        Host: ${yamlQuote(nodes.host)}`,
    `  - name: ${yamlQuote(`${NAME}-vmess`)}`,
    '    type: vmess',
    `    server: ${yamlQuote(CFIP)}`,
    `    port: ${port}`,
    `    uuid: ${yamlQuote(UUID)}`,
    '    alterId: 0',
    '    cipher: auto',
    '    network: ws',
    '    tls: true',
    '    udp: true',
    `    servername: ${yamlQuote(nodes.host)}`,
    `    client-fingerprint: ${yamlQuote(FP)}`,
    '    ws-opts:',
    '      path: /vmess-argo',
    '      headers:',
    `        Host: ${yamlQuote(nodes.host)}`,
    `  - name: ${yamlQuote(`${NAME}-trojan`)}`,
    '    type: trojan',
    `    server: ${yamlQuote(CFIP)}`,
    `    port: ${port}`,
    `    password: ${yamlQuote(UUID)}`,
    '    network: ws',
    '    tls: true',
    '    udp: true',
    `    sni: ${yamlQuote(nodes.host)}`,
    `    client-fingerprint: ${yamlQuote(FP)}`,
    '    ws-opts:',
    '      path: /trojan-argo',
    '      headers:',
    `        Host: ${yamlQuote(nodes.host)}`,
    '',
  ].join('\n');
}

async function uploadNodes() {
  if (!rawSubscription) return;

  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL.replace(/\/+$/, '')}/${SUB_PATH}`;
    try {
      await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, {
        subscription: [subscriptionUrl],
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      console.log('[upload] subscription uploaded successfully');
    } catch (error) {
      console.error(`[upload] subscription upload failed: ${error.message}`);
    }
    return;
  }

  if (UPLOAD_URL) {
    const nodes = rawSubscription.split('\n').filter((line) => /^(vless|vmess|trojan):\/\//.test(line));
    if (nodes.length === 0) return;

    try {
      await axios.post(`${UPLOAD_URL}/api/add-nodes`, { nodes }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      console.log('[upload] nodes uploaded successfully');
    } catch (error) {
      console.error(`[upload] nodes upload failed: ${error.message}`);
    }
  }
}

async function getLatestStableRelease(repo) {
  const response = await axios.get(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nodejs-argo-runtime',
    },
    timeout: 30000,
  });

  const releases = Array.isArray(response.data) ? response.data : [];
  const release = releases.find((item) => (
    !item.draft &&
    !item.prerelease &&
    !/(alpha|beta|rc)/i.test(`${item.tag_name} ${item.name || ''}`)
  ));

  if (!release) {
    throw new Error(`No stable release found for ${repo}`);
  }

  return release;
}

async function getLatestRelease(repo) {
  const response = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nodejs-argo-runtime',
    },
    timeout: 30000,
  });

  return response.data;
}

function findAsset(release, matcher, label) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item) => matcher(item.name));

  if (!asset || !asset.browser_download_url) {
    throw new Error(`Cannot find ${label} asset in release ${release.tag_name}`);
  }

  return asset;
}

async function downloadFile(url, filePath, label) {
  const tempPath = `${filePath}.download`;
  fs.rmSync(tempPath, { force: true });

  console.log(`[download] ${label}: ${url}`);
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: 180000,
    headers: {
      'User-Agent': 'nodejs-argo-runtime',
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const hash = crypto.createHash('sha256');
  response.data.on('data', (chunk) => hash.update(chunk));
  await pipeline(response.data, fs.createWriteStream(tempPath));

  const sha256 = hash.digest('hex');
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o775);
  console.log(`[download] ${label} sha256: ${sha256}`);
  return sha256;
}

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(`[${label}] ${data}`);
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(`[${label}] ${data}`);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${label} exited with code ${code}`));
      }
    });
  });
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findFileRecursive(directory, fileName) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    }
  }

  return '';
}

async function installSingBox() {
  if (!FORCE_UPDATE && isExecutable(webPath)) {
    console.log(`[sing-box] existing executable found: ${webPath}`);
    console.log('[sing-box] reuse existing version:');
    try {
      await runCommand(webPath, ['version'], 'sing-box-version');
      return;
    } catch (error) {
      console.error(`[sing-box] existing executable check failed: ${error.message}; downloading again`);
    }
  }

  if (FORCE_UPDATE) {
    console.log('[sing-box] FORCE_UPDATE=true, downloading latest stable release');
  }

  const release = await getLatestStableRelease('SagerNet/sing-box');
  const asset = findAsset(
    release,
    (name) => /linux-amd64\.tar\.gz$/i.test(name) && !/(sha|dgst|asc|sig)/i.test(name),
    'sing-box linux-amd64 tar.gz',
  );
  const archivePath = path.join(RUN_DIR, 'sing-box.tar.gz');
  const extractDir = path.join(RUN_DIR, 'sing-box-extract');

  console.log(`[sing-box] latest stable release: ${release.tag_name}`);
  await downloadFile(asset.browser_download_url, archivePath, 'sing-box archive');

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await runCommand('tar', ['-xzf', archivePath, '-C', extractDir], 'tar');

  const extractedBinary = findFileRecursive(extractDir, 'sing-box');
  if (!extractedBinary) {
    throw new Error('sing-box executable not found in downloaded archive');
  }

  fs.copyFileSync(extractedBinary, webPath);
  fs.chmodSync(webPath, 0o775);
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log(`[sing-box] installed: ${webPath}`);
  console.log('[sing-box] downloaded version:');
  await runCommand(webPath, ['version'], 'sing-box-version');
}

async function installCloudflared() {
  if (!FORCE_UPDATE && isExecutable(botPath)) {
    console.log(`[cloudflared] existing executable found: ${botPath}`);
    console.log('[cloudflared] reuse existing version:');
    try {
      await runCommand(botPath, ['version'], 'cloudflared-version');
      return;
    } catch (error) {
      console.error(`[cloudflared] existing executable check failed: ${error.message}; downloading again`);
    }
  }

  if (FORCE_UPDATE) {
    console.log('[cloudflared] FORCE_UPDATE=true, downloading latest release');
  }

  const release = await getLatestRelease('cloudflare/cloudflared');
  const asset = findAsset(
    release,
    (name) => name === 'cloudflared-linux-amd64',
    'cloudflared-linux-amd64',
  );

  console.log(`[cloudflared] latest release: ${release.tag_name}`);
  await downloadFile(asset.browser_download_url, botPath, 'cloudflared');
  console.log(`[cloudflared] installed: ${botPath}`);
  console.log('[cloudflared] downloaded version:');
  await runCommand(botPath, ['version'], 'cloudflared-version');
}

function parseTunnelCredentials() {
  if (!ARGO_AUTH.includes('TunnelSecret')) return null;

  try {
    return JSON.parse(ARGO_AUTH);
  } catch (error) {
    const tunnelId = (ARGO_AUTH.match(/"TunnelID"\s*:\s*"([^"]+)"/) || [])[1];
    const tunnelName = (ARGO_AUTH.match(/"TunnelName"\s*:\s*"([^"]+)"/) || [])[1];
    if (!tunnelId && !tunnelName) {
      throw new Error(`ARGO_AUTH contains TunnelSecret but is not valid JSON credentials: ${error.message}`);
    }
    return { TunnelID: tunnelId, TunnelName: tunnelName };
  }
}

function writeTunnelConfig() {
  if (tunnelMode !== 'json') return;
  if (!ARGO_DOMAIN) {
    throw new Error('ARGO_DOMAIN is required in JSON credentials tunnel mode');
  }

  const credentials = parseTunnelCredentials();
  const tunnelId = credentials.TunnelID || credentials.tunnel_id || credentials.TunnelName || credentials.tunnel_name;
  if (!tunnelId) {
    throw new Error('TunnelID is missing in ARGO_AUTH JSON credentials');
  }

  fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
  const tunnelYaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${tunnelJsonPath}`,
    `protocol: ${ARGO_PROTOCOL}`,
    'ingress:',
    `  - hostname: ${ARGO_DOMAIN}`,
    '    path: /vless-argo*',
    '    service: http://127.0.0.1:3002',
    `  - hostname: ${ARGO_DOMAIN}`,
    '    path: /vmess-argo*',
    '    service: http://127.0.0.1:3003',
    `  - hostname: ${ARGO_DOMAIN}`,
    '    path: /trojan-argo*',
    '    service: http://127.0.0.1:3004',
    `  - hostname: ${ARGO_DOMAIN}`,
    '    path: /sub*',
    '    service: http://127.0.0.1:3000',
    `  - hostname: ${ARGO_DOMAIN}`,
    '    service: http://127.0.0.1:3000',
    '  - service: http_status:404',
    '',
  ].join('\n');

  fs.writeFileSync(tunnelConfigPath, tunnelYaml);
  console.log(`[cloudflared] credentials saved: ${tunnelJsonPath}`);
  console.log(`[cloudflared] tunnel config generated: ${tunnelConfigPath}`);
}

function printableArgs(args) {
  return args.map((arg, index) => (args[index - 1] === '--token' ? '***' : arg));
}

function updateTemporaryDomainFromLog(text) {
  if (tunnelMode !== 'try') return;

  const match = text.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
  if (!match || temporaryDomain === match[1]) return;

  temporaryDomain = match[1];
  currentDomain = temporaryDomain;
  console.log(`[cloudflared] temporary tunnel domain: ${temporaryDomain}`);
  refreshSubscriptionCache();
  uploadNodes().catch((error) => console.error(`[upload] upload after temporary domain failed: ${error.message}`));
}

function startProcess(label, command, args) {
  console.log(`[${label}] starting: ${command} ${printableArgs(args).join(' ')}`);
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (label === 'sing-box') singBoxStatus = 'running';
  if (label === 'cloudflared') cloudflaredStatus = 'running';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(`[${label}] ${text}`);
    if (label === 'cloudflared') updateTemporaryDomainFromLog(text);
  });
  child.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(`[${label}] ${text}`);
    if (label === 'cloudflared') updateTemporaryDomainFromLog(text);
  });
  child.on('error', (error) => {
    if (label === 'sing-box') singBoxStatus = `error: ${error.message}`;
    if (label === 'cloudflared') cloudflaredStatus = `error: ${error.message}`;
    console.error(`[${label}] failed to start: ${error.message}`);
    if (label === 'sing-box' || label === 'cloudflared') {
      requestContainerRestart(`${label} failed to start`);
    }
  });
  child.on('close', (code, signal) => {
    const status = `exited code=${code}, signal=${signal}`;
    if (label === 'sing-box') singBoxStatus = status;
    if (label === 'cloudflared') cloudflaredStatus = status;
    console.error(`[${label}] ${status}`);
    if (label === 'sing-box' || label === 'cloudflared') {
      requestContainerRestart(`${label} exited`);
    }
  });

  return child;
}

function requestContainerRestart(reason) {
  if (restartRequested) return;
  restartRequested = true;
  console.error(`[supervisor] ${reason}; exiting Node.js so the platform can restart the container`);
  setTimeout(() => process.exit(1), 1000);
}

function startCloudflared() {
  if (tunnelMode === 'json') {
    writeTunnelConfig();
    startProcess('cloudflared', botPath, [
      'tunnel',
      '--edge-ip-version',
      EDGE_IP_VERSION,
      '--protocol',
      ARGO_PROTOCOL,
      '--config',
      tunnelConfigPath,
      'run',
    ]);
    return;
  }

  if (tunnelMode === 'token') {
    if (!ARGO_DOMAIN) {
      console.warn('[cloudflared] token mode without ARGO_DOMAIN: tunnel can run, but subscription cannot know host/sni');
    }
    startProcess('cloudflared', botPath, [
      'tunnel',
      '--edge-ip-version',
      EDGE_IP_VERSION,
      '--no-autoupdate',
      '--protocol',
      ARGO_PROTOCOL,
      'run',
      '--token',
      ARGO_AUTH,
    ]);
    return;
  }

  if (tunnelMode === 'try') {
    console.warn('[cloudflared] temporary tunnel mode is for testing only; domain may change after restart');
    startProcess('cloudflared', botPath, [
      'tunnel',
      '--edge-ip-version',
      EDGE_IP_VERSION,
      '--no-autoupdate',
      '--protocol',
      ARGO_PROTOCOL,
      '--url',
      `http://127.0.0.1:${PORT}`,
    ]);
    return;
  }

  cloudflaredStatus = 'invalid config';
  console.error('[cloudflared] invalid tunnel config: set both ARGO_DOMAIN and ARGO_AUTH for fixed tunnel, or leave both empty for temporary tunnel');
}

function startAutoAccess() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log('[auto-access] skipped');
    return;
  }

  const visit = async () => {
    try {
      await axios.get(PROJECT_URL, {
        timeout: 15000,
        headers: { 'User-Agent': 'nodejs-argo-auto-access' },
      });
      console.log('[auto-access] project url visited');
    } catch (error) {
      console.error(`[auto-access] visit failed: ${error.message}`);
    }
  };

  visit();
  setInterval(visit, 6 * 60 * 1000);
}

function proxyWebSocket(req, socket, head) {
  const urlPath = (req.url || '').split('?')[0];
  const targetPort = wsTargets[urlPath];
  if (!targetPort) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstream = net.connect(targetPort, '127.0.0.1');
  upstream.on('connect', () => {
    const requestHead = [
      `${req.method} ${req.url} HTTP/${req.httpVersion}`,
      ...req.rawHeaders.reduce((headers, value, index, array) => {
        if (index % 2 === 0) headers.push(`${value}: ${array[index + 1]}`);
        return headers;
      }, []),
      '',
      '',
    ].join('\r\n');

    upstream.write(requestHead);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', (error) => {
    console.error(`[ws-proxy] ${urlPath} -> 127.0.0.1:${targetPort} failed: ${error.message}`);
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
}

function baseUrl(req) {
  const host = getSubscriptionDisplayDomain();
  if (host) return `https://${host}`;
  return `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
}

app.get('/', (req, res) => {
  const origin = baseUrl(req);
  const domain = getSubscriptionDomain() || 'not ready';
  const subscriptionUrl = `${origin}/${SUB_PATH}`;
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>singbox-argo</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.6; color: #1f2933; }
    main { max-width: 840px; }
    code { background: #f1f5f9; padding: .15rem .35rem; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    td, th { border-bottom: 1px solid #d8dee4; padding: .55rem .4rem; text-align: left; }
  </style>
</head>
<body>
  <main>
    <h1>singbox-argo is running</h1>
    <table>
      <tr><th>Item</th><th>Value</th></tr>
      <tr><td>app</td><td>ok</td></tr>
      <tr><td>platform hint</td><td>Northflank-ready</td></tr>
      <tr><td>arch</td><td>${escapeHtml(`${process.platform}/${process.arch}`)}</td></tr>
      <tr><td>memory usage</td><td>${escapeHtml(formatMemoryUsage())}</td></tr>
      <tr><td>uptime</td><td>${escapeHtml(formatUptime())}</td></tr>
      <tr><td>sing-box</td><td>${escapeHtml(singBoxStatus)}</td></tr>
      <tr><td>cloudflared</td><td>${escapeHtml(cloudflaredStatus)}</td></tr>
      <tr><td>tunnel mode</td><td>${escapeHtml(tunnelMode)}</td></tr>
      <tr><td>domain</td><td>${escapeHtml(domain)}</td></tr>
      <tr><td>subscription URL</td><td>${escapeHtml(subscriptionUrl)}</td></tr>
      <tr><td>recommended node</td><td>VLESS WS TLS</td></tr>
      <tr><td>UUID</td><td>${escapeHtml(maskUuid(UUID))}</td></tr>
      <tr><td>CFIP</td><td>${escapeHtml(CFIP)}</td></tr>
      <tr><td>CFPORT</td><td>${escapeHtml(CFPORT)}</td></tr>
      <tr><td>ARGO_PROTOCOL</td><td>${escapeHtml(ARGO_PROTOCOL)}</td></tr>
      <tr><td>EDGE_IP_VERSION</td><td>${escapeHtml(EDGE_IP_VERSION)}</td></tr>
    </table>
    <h2>Subscriptions</h2>
    <p><code>${escapeHtml(`${origin}/${SUB_PATH}`)}</code></p>
    <p><code>${escapeHtml(`${origin}/${SUB_PATH}/raw`)}</code></p>
    <p><code>${escapeHtml(`${origin}/${SUB_PATH}/sing-box`)}</code></p>
    <p><code>${escapeHtml(`${origin}/${SUB_PATH}/clash`)}</code></p>
  </main>
</body>
</html>`);
});

registerGetRoutes([`/${SUB_PATH}`, '/sub'], (req, res) => {
  if (!encodedSubscription) {
    const message = tunnelMode === 'try'
      ? 'temporary tunnel domain not ready'
      : 'subscription is not ready; set ARGO_DOMAIN for host/sni';
    res.status(503).type('text/plain; charset=utf-8').send(message);
    return;
  }
  res.type('text/plain; charset=utf-8').send(encodedSubscription);
});

registerGetRoutes([`/${SUB_PATH}/raw`, '/sub/raw'], (req, res) => {
  if (!rawSubscription) {
    const message = tunnelMode === 'try'
      ? 'temporary tunnel domain not ready'
      : 'subscription is not ready; set ARGO_DOMAIN for host/sni';
    res.status(503).type('text/plain; charset=utf-8').send(message);
    return;
  }
  res.type('text/plain; charset=utf-8').send(rawSubscription);
});

registerGetRoutes([`/${SUB_PATH}/sing-box`, '/sub/sing-box'], (req, res) => {
  const config = buildSingBoxClientConfig();
  if (!config) {
    const message = tunnelMode === 'try'
      ? 'temporary tunnel domain not ready'
      : 'subscription is not ready; set ARGO_DOMAIN for host/sni';
    res.status(503).type('text/plain; charset=utf-8').send(message);
    return;
  }
  res.type('application/json; charset=utf-8').send(JSON.stringify(config, null, 2));
});

registerGetRoutes([`/${SUB_PATH}/clash`, '/sub/clash'], (req, res) => {
  const yaml = buildClashProxies();
  if (!yaml) {
    const message = tunnelMode === 'try'
      ? 'temporary tunnel domain not ready'
      : 'subscription is not ready; set ARGO_DOMAIN for host/sni';
    res.status(503).type('text/plain; charset=utf-8').send(message);
    return;
  }
  res.type('text/yaml; charset=utf-8').send(yaml);
});

async function startserver() {
  runKoCommand().catch((error) => {
    console.error(`[ko] unexpected error: ${error.message}`);
  });

  deleteOldUploadedNodes();
  cleanupRuntimeFiles();
  generateConfig();
  refreshSubscriptionCache();

  await installSingBox();
  console.log('[sing-box] version before start:');
  await runCommand(webPath, ['version'], 'sing-box-version');
  await runCommand(webPath, ['check', '-c', configPath], 'sing-box-check');
  startProcess('sing-box', webPath, ['run', '-c', configPath]);

  await installCloudflared();
  console.log('[cloudflared] version before start:');
  await runCommand(botPath, ['version'], 'cloudflared-version');
  startCloudflared();
  await uploadNodes();
  startAutoAccess();
}

const server = http.createServer(app);
server.on('upgrade', proxyWebSocket);
server.listen(PORT, () => {
  console.log(`http server is running on port:${PORT}!`);
  startserver().catch((error) => {
    singBoxStatus = singBoxStatus === 'starting' ? 'startup failed' : singBoxStatus;
    cloudflaredStatus = cloudflaredStatus === 'starting' ? 'startup failed' : cloudflaredStatus;
    console.error(`[startup] ${error.stack || error.message}`);
  });
});
