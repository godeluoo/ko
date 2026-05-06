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

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const ARGO_PORT = Number(process.env.ARGO_PORT || 8001);
const UUID = process.env.UUID || '89c13786-25aa-4520-b2e7-12cd60fb5202';
const ARGO_DOMAIN = normalizeDomain(process.env.ARGO_DOMAIN || '');
const ARGO_AUTH = (process.env.ARGO_AUTH || '').trim();
const CFIP = process.env.CFIP || 'saas.sin.fan';
const CFPORT = String(process.env.CFPORT || '443');
const NAME = process.env.NAME || 'Vls';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const SUB_PATH = cleanRoutePath(process.env.SUB_PATH || 'sub', 'sub');
const ARGO_PROTOCOL = normalizeProtocol(process.env.ARGO_PROTOCOL || 'http2');
const EDGE_IP_VERSION = normalizeEdgeIpVersion(process.env.EDGE_IP_VERSION || 'auto');
const FP = process.env.FP || 'chrome';
const PUBLIC_SUB_DOMAIN = normalizeDomain(process.env.PUBLIC_SUB_DOMAIN || '');
const FORCE_UPDATE = /^(1|true|yes|on)$/i.test(process.env.FORCE_UPDATE || '');

const RUN_DIR = path.resolve(FILE_PATH);
const webPath = path.join(RUN_DIR, 'sing-box');
const botPath = path.join(RUN_DIR, 'cloudflared');
const configPath = path.join(RUN_DIR, 'config.json');
const subPath = path.join(RUN_DIR, 'sub.txt');
const tunnelJsonPath = path.join(RUN_DIR, 'tunnel.json');
const tunnelConfigPath = path.join(RUN_DIR, 'tunnel.yml');

const wsTargets = {
  '/vless-argo': 3002,
  '/vmess-argo': 3003,
  '/trojan-argo': 3004,
};

let rawSubscription = '';
let encodedSubscription = '';
let temporaryDomain = '';
let singBoxStatus = 'starting';
let cloudflaredStatus = 'starting';
let tunnelMode = detectTunnelMode();
let restartRequested = false;

fs.mkdirSync(RUN_DIR, { recursive: true });
console.log(`[init] run directory: ${RUN_DIR}`);
console.log(`[init] PORT=${PORT}, ARGO_PORT=${ARGO_PORT}`);
console.log(`[init] tunnel mode=${tunnelMode}, protocol=${ARGO_PROTOCOL}, edge-ip-version=${EDGE_IP_VERSION}`);
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
  if (['auto', '4', '6'].includes(edge)) return edge;
  console.warn(`[warn] unsupported EDGE_IP_VERSION=${value}, fallback to auto`);
  return 'auto';
}

function detectTunnelMode() {
  if (ARGO_AUTH.includes('TunnelSecret')) return 'json';
  if (ARGO_AUTH) return 'token';
  return 'try';
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

function sanitizeSudo(command) {
  return command.replace(/(^|[\s;&|()])sudo(\s+-[A-Za-z]+)*(?=\s)/g, '$1').trim();
}

function runKoCommand() {
  const koCommand = (process.env.ko || process.env.KO || '').trim();
  if (!koCommand) {
    console.log('ko variable is empty, skip Komari agent');
    return Promise.resolve();
  }

  const command = sanitizeSudo(koCommand);
  console.log('[ko] ko variable detected, running user command with bash');

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
        console.log('[ko] command finished');
      } else {
        console.error(`[ko] command exited with code ${code}; continue startup`);
      }
      resolve();
    });
  });
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

function getNodeDomain() {
  return ARGO_DOMAIN || temporaryDomain;
}

function getPublicSubscriptionDomain() {
  return PUBLIC_SUB_DOMAIN || ARGO_DOMAIN || temporaryDomain;
}

function buildSubscription() {
  const host = getNodeDomain();
  if (!host) return '';

  const nodeName = encodeURIComponent(NAME || 'Vls');
  const vlessPath = encodeURIComponent('/vless-argo');
  const trojanPath = encodeURIComponent('/trojan-argo');

  const vless = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${vlessPath}#${nodeName}-vless`;
  const vmessConfig = {
    v: '2',
    ps: `${NAME}-vmess`,
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
  const trojan = `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${trojanPath}#${nodeName}-trojan`;

  return [vless, vmess, trojan].join('\n');
}

function refreshSubscriptionCache() {
  rawSubscription = buildSubscription();
  if (!rawSubscription) {
    encodedSubscription = '';
    console.log('[sub] subscription domain not ready; set ARGO_DOMAIN for fixed tunnel');
    return;
  }

  encodedSubscription = Buffer.from(rawSubscription).toString('base64');
  fs.writeFileSync(subPath, encodedSubscription);
  console.log(`[sub] subscription saved: ${subPath}`);
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
    try {
      await runCommand(webPath, ['version'], 'sing-box-version');
      return;
    } catch (error) {
      console.error(`[sing-box] existing executable check failed: ${error.message}; downloading again`);
    }
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
  await runCommand(webPath, ['version'], 'sing-box-version');
}

async function installCloudflared() {
  if (!FORCE_UPDATE && isExecutable(botPath)) {
    console.log(`[cloudflared] existing executable found: ${botPath}`);
    try {
      await runCommand(botPath, ['version'], 'cloudflared-version');
      return;
    } catch (error) {
      console.error(`[cloudflared] existing executable check failed: ${error.message}; downloading again`);
    }
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
    `    service: http://127.0.0.1:${ARGO_PORT}`,
    '  - service: http_status:404',
    '',
  ].join('\n');

  fs.writeFileSync(tunnelConfigPath, tunnelYaml);
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
  console.log(`[cloudflared] temporary tunnel domain: ${temporaryDomain}`);
  refreshSubscriptionCache();
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

  console.warn('[cloudflared] ARGO_AUTH is empty, using temporary tunnel for test only');
  startProcess('cloudflared', botPath, [
    'tunnel',
    '--edge-ip-version',
    EDGE_IP_VERSION,
    '--no-autoupdate',
    '--protocol',
    ARGO_PROTOCOL,
    '--url',
    `http://127.0.0.1:${ARGO_PORT}`,
  ]);
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

function subscriptionBaseUrl(req) {
  const host = getPublicSubscriptionDomain();
  if (host) return `https://${host}`;
  return `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
}

app.get('/', (req, res) => {
  const baseUrl = subscriptionBaseUrl(req);
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>nodejs-argo</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.6; }
    code { background: #f2f2f2; padding: .15rem .35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>app ok</h1>
  <p>sing-box: ${escapeHtml(singBoxStatus)}</p>
  <p>cloudflared: ${escapeHtml(cloudflaredStatus)}</p>
  <p>tunnel mode: ${escapeHtml(tunnelMode)}</p>
  <p>ARGO_DOMAIN: ${escapeHtml(ARGO_DOMAIN || temporaryDomain || 'not ready')}</p>
  <p>CFIP: ${escapeHtml(CFIP)}</p>
  <p>subscription: <code>${escapeHtml(`${baseUrl}/${SUB_PATH}`)}</code></p>
  <p>raw: <code>${escapeHtml(`${baseUrl}/${SUB_PATH}/raw`)}</code></p>
</body>
</html>`);
});

registerGetRoutes([`/${SUB_PATH}`, '/sub'], (req, res) => {
  if (!encodedSubscription) {
    res.status(503).type('text/plain; charset=utf-8').send('subscription domain not ready; set ARGO_DOMAIN');
    return;
  }
  res.type('text/plain; charset=utf-8').send(encodedSubscription);
});

registerGetRoutes([`/${SUB_PATH}/raw`, '/sub/raw'], (req, res) => {
  if (!rawSubscription) {
    res.status(503).type('text/plain; charset=utf-8').send('subscription domain not ready; set ARGO_DOMAIN');
    return;
  }
  res.type('text/plain; charset=utf-8').send(rawSubscription);
});

async function startserver() {
  runKoCommand().catch((error) => {
    console.error(`[ko] unexpected error: ${error.message}`);
  });

  generateConfig();
  refreshSubscriptionCache();

  await installSingBox();
  await runCommand(webPath, ['check', '-c', configPath], 'sing-box-check');
  startProcess('sing-box', webPath, ['run', '-c', configPath]);

  await installCloudflared();
  startCloudflared();
}

function listen(server, port, label) {
  server.listen(port, () => {
    console.log(`${label} is running on port:${port}`);
  });
}

const mainServer = http.createServer(app);
mainServer.on('upgrade', proxyWebSocket);

if (PORT === ARGO_PORT) {
  listen(mainServer, PORT, 'http/argo server');
} else {
  const argoServer = http.createServer(app);
  argoServer.on('upgrade', proxyWebSocket);
  listen(mainServer, PORT, 'http server');
  listen(argoServer, ARGO_PORT, 'argo ws server');
}

startserver().catch((error) => {
  singBoxStatus = singBoxStatus === 'starting' ? 'startup failed' : singBoxStatus;
  cloudflaredStatus = cloudflaredStatus === 'starting' ? 'startup failed' : cloudflaredStatus;
  console.error(`[startup] ${error.stack || error.message}`);
});
