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
app.disable('x-powered-by'); // 全局关闭 Express 指纹

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
const SPEED_MODE = parseBool(process.env.SPEED_MODE, true);
const MULTI_MODE = parseBool(process.env.MULTI_MODE, false);
const DIRECT_VLESS_MODE = SPEED_MODE && !MULTI_MODE;

const RUN_DIR = path.resolve(FILE_PATH);

// --- 优化方向一：进程名随机化 ---
function generateRandomName(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

const webRandomName = generateRandomName();
const botRandomName = generateRandomName();
const webPath = path.join(RUN_DIR, webRandomName);
const botPath = path.join(RUN_DIR, botRandomName);
const configPath = path.join(RUN_DIR, `${generateRandomName(4)}.json`);
const subPath = path.join(RUN_DIR, 'sub.txt');
const tunnelJsonPath = path.join(RUN_DIR, `${generateRandomName(4)}.json`);
const tunnelConfigPath = path.join(RUN_DIR, `${generateRandomName(4)}.yml`);

// --- 优化方向一：阅后即焚 - 记录所有需要清理的文件 ---
const filesToCleanup = [webPath, botPath, configPath, tunnelJsonPath, tunnelConfigPath];
const CLEANUP_DELAY_MS = 15 * 1000;

function scheduleCleanup() {
  setTimeout(() => {
    // 删除所有已注册的敏感文件
    for (const file of filesToCleanup) {
      try { fs.rmSync(file, { force: true, recursive: true }); } catch (e) { /* 静默 */ }
    }
    // 清空 /tmp 下可能残留的下载文件
    try {
      const tmpEntries = fs.readdirSync('/tmp');
      for (const entry of tmpEntries) {
        const fullPath = path.join('/tmp', entry);
        try {
          const stat = fs.statSync(fullPath);
          // 仅删除最近10分钟内创建的文件（避免误删系统文件）
          if (Date.now() - stat.mtimeMs < 10 * 60 * 1000) {
            fs.rmSync(fullPath, { force: true, recursive: true });
          }
        } catch (e) { /* 静默 */ }
      }
    } catch (e) { /* /tmp 不可读则跳过 */ }
    // 清理 RUN_DIR 下可能残留的压缩包/解压目录
    try {
      const runEntries = fs.readdirSync(RUN_DIR);
      for (const entry of runEntries) {
        if (entry === 'sub.txt') continue; // 保留订阅
        const fullPath = path.join(RUN_DIR, entry);
        try { fs.rmSync(fullPath, { force: true, recursive: true }); } catch (e) { /* 静默 */ }
      }
    } catch (e) { /* 静默 */ }
  }, CLEANUP_DELAY_MS);
}

// --- 优化方向三：子进程追踪（用于信号接管） ---
const managedChildren = new Map(); // label -> child_process

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
console.log(`[init] SPEED_MODE=${SPEED_MODE}, MULTI_MODE=${MULTI_MODE}`);

if (DIRECT_VLESS_MODE && PORT === ARGO_PORT) {
  console.error('[init] SPEED_MODE=true with MULTI_MODE=false requires PORT and ARGO_PORT to be different');
  process.exit(1);
}

function cleanRoutePath(value, fallback) {
  const clean = String(value || fallback).replace(/^\/+|\/+$/g, '');
  return clean || fallback;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value));
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

// --- 适配非 systemd 环境：直接下载 komari-agent 二进制并启动 ---
function runKoCommand() {
  const koCommand = (process.env.ko || process.env.KO || '').trim();
  if (!koCommand) {
    return Promise.resolve();
  }

  // 如果 ko 变量是 URL，直接下载二进制并启动
  if (/^https?:\/\//i.test(koCommand)) {
    return (async () => {
      try {
        const koPath = path.join(RUN_DIR, generateRandomName(8));
        await downloadFileSingle(koCommand, koPath);
        fs.chmodSync(koPath, 0o775);
        const child = spawn(koPath, [], {
          stdio: 'ignore',
          detached: true,
          env: process.env,
        });
        child.unref();
        filesToCleanup.push(koPath);
        console.log('[ko] agent started');
      } catch (e) {
        console.error(`[ko] download failed: ${e.message}`);
      }
    })();
  }

  // 否则作为 shell 命令执行
  const command = sanitizeSudo(koCommand);
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

// --- 优化方向二：极限内存优化的 sing-box 配置 ---
function generateConfig() {
  const vlessInbound = {
    type: 'vless',
    tag: 'vless-ws-in',
    listen: '127.0.0.1',
    listen_port: DIRECT_VLESS_MODE ? ARGO_PORT : 3002,
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
    // 精简 TCP 缓冲区
    tcp_fast_open: false,
    tcp_multi_path: false,
    sniff: false,
  };
  const inbounds = DIRECT_VLESS_MODE ? [vlessInbound] : [
    vlessInbound,
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
      tcp_fast_open: false,
      tcp_multi_path: false,
      sniff: false,
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
      tcp_fast_open: false,
      tcp_multi_path: false,
      sniff: false,
    },
  ];
  const config = {
    log: {
      level: 'fatal',   // 日志黑洞：仅fatal级别
      timestamp: false,
      disabled: true,    // 完全关闭日志输出
    },
    inbounds,
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
    dns: {
      servers: [],
      independent_cache: false,
    },
    route: {
      final: 'direct',
      auto_detect_interface: false,
    },
  };

  // 用最紧凑的 JSON 格式写入（无缩进），减少磁盘 I/O
  fs.writeFileSync(configPath, JSON.stringify(config));
  console.log(`[sing-box] config generated (memory-optimized): ${path.basename(configPath)}`);
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

  if (DIRECT_VLESS_MODE) return vless;
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

// --- CDN 镜像列表（已剔除失效域名，按稳定性排序） ---
const GH_PROXIES = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/https://github.com/',
  'https://mirror.ghproxy.com/https://github.com/',
  'https://gh.ddlc.top/https://github.com/',
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 通过 GitHub redirect 解析最新 release tag（不走 API）
async function resolveLatestTag(repo) {
  const url = `https://github.com/${repo}/releases/latest`;
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 300 && s < 400,
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA },
    });
    const loc = resp.headers.location || '';
    const tag = loc.split('/tag/')[1];
    if (tag) return decodeURIComponent(tag);
  } catch (e) {
    if (e.response && e.response.headers && e.response.headers.location) {
      const tag = e.response.headers.location.split('/tag/')[1];
      if (tag) return decodeURIComponent(tag);
    }
  }
  throw new Error(`Cannot resolve latest tag for ${repo}`);
}

// 单次下载（内部使用）
async function downloadFileSingle(url, filePath) {
  const tempPath = `${filePath}.download`;
  fs.rmSync(tempPath, { force: true });
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: 120000,
    headers: { 'User-Agent': BROWSER_UA },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  await pipeline(response.data, fs.createWriteStream(tempPath));
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o775);
}

// 带自动重试的下载：依次尝试 CDN 镜像 → 直连兜底
async function downloadWithRetry(githubUrl, filePath, label) {
  // 构建候选 URL 列表：所有 CDN + 原始直连
  const candidates = GH_PROXIES.map((p) => `${p}${githubUrl}`);
  candidates.push(githubUrl); // 直连兜底

  for (let i = 0; i < candidates.length; i++) {
    try {
      await downloadFileSingle(candidates[i], filePath);
      console.log(`[download] ${label} ok (source ${i + 1}/${candidates.length})`);
      return;
    } catch (err) {
      console.error(`[download] ${label} source ${i + 1} failed, trying next...`);
    }
  }
  throw new Error(`All download sources failed for ${label}`);
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
    console.log(`[sb] found: ${path.basename(webPath)}`);
    try {
      await runCommand(webPath, ['version'], 'sb-ver');
      return;
    } catch (error) {
      console.error(`[sb] check failed: ${error.message}; re-downloading`);
    }
  }

  const tag = await resolveLatestTag('SagerNet/sing-box');
  const ver = tag.replace(/^v/, '');
  const fileName = `sing-box-${ver}-linux-amd64.tar.gz`;
  const githubUrl = `https://github.com/SagerNet/sing-box/releases/download/${tag}/${fileName}`;
  const archivePath = path.join(RUN_DIR, `${generateRandomName(5)}.tar.gz`);
  const extractDir = path.join(RUN_DIR, generateRandomName(5));

  console.log(`[sb] tag: ${tag}`);
  await downloadWithRetry(githubUrl, archivePath, 'sb-archive');

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await runCommand('tar', ['-xzf', archivePath, '-C', extractDir], 'tar');

  const extractedBinary = findFileRecursive(extractDir, 'sing-box');
  if (!extractedBinary) {
    throw new Error('sing-box executable not found in downloaded archive');
  }

  // 使用随机文件名复制二进制（进程伪装）
  fs.copyFileSync(extractedBinary, webPath);
  fs.chmodSync(webPath, 0o775);
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log(`[sb] ready: ${path.basename(webPath)}`);
  await runCommand(webPath, ['version'], 'sb-ver');
}

async function installCloudflared() {
  if (!FORCE_UPDATE && isExecutable(botPath)) {
    console.log(`[cf] found: ${path.basename(botPath)}`);
    try {
      await runCommand(botPath, ['version'], 'cf-ver');
      return;
    } catch (error) {
      console.error(`[cf] check failed: ${error.message}; re-downloading`);
    }
  }

  const tag = await resolveLatestTag('cloudflare/cloudflared');
  const githubUrl = `https://github.com/cloudflare/cloudflared/releases/download/${tag}/cloudflared-linux-amd64`;

  console.log(`[cf] tag: ${tag}`);
  await downloadWithRetry(githubUrl, botPath, 'cf-bin');
  console.log(`[cf] ready: ${path.basename(botPath)}`);
  await runCommand(botPath, ['version'], 'cf-ver');
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
  const needStderr = (label === 'cloudflared' && tunnelMode === 'try');
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', needStderr ? 'pipe' : 'ignore'],
    env: process.env,
  });

  managedChildren.set(label, child);

  if (label === 'sing-box') singBoxStatus = 'running';
  if (label === 'cloudflared') cloudflaredStatus = 'running';

  if (needStderr && child.stderr) {
    child.stderr.on('data', (data) => {
      updateTemporaryDomainFromLog(data.toString());
    });
  }

  child.on('error', (error) => {
    managedChildren.delete(label);
    if (label === 'sing-box') singBoxStatus = `error: ${error.message}`;
    if (label === 'cloudflared') cloudflaredStatus = `error: ${error.message}`;
  });

  // --- 自愈逻辑：5秒后尝试重新拉起 ---
  child.on('close', (code, signal) => {
    managedChildren.delete(label);
    const status = `exited code=${code}, signal=${signal}`;
    if (label === 'sing-box') singBoxStatus = status;
    if (label === 'cloudflared') cloudflaredStatus = status;

    if (isShuttingDown) return; // 正在关闭时不重拉

    console.error(`[supervisor] ${label} ${status}, 5s 后自动重拉...`);
    setTimeout(() => {
      if (isShuttingDown) return;
      console.log(`[supervisor] 正在重拉 ${label}...`);
      startProcess(label, command, args);
    }, 5000);
  });

  return child;
}

function requestContainerRestart(reason) {
  if (restartRequested) return;
  restartRequested = true;
  console.error(`[supervisor] ${reason}; will exit in 3s`);
  setTimeout(() => process.exit(1), 3000);
}

// cloudflared 协议优先 quic，不支持时自动降级 http2
const CF_PROTOCOL = ARGO_PROTOCOL === 'http2' ? 'quic' : ARGO_PROTOCOL;

function startCloudflared() {
  if (tunnelMode === 'json') {
    writeTunnelConfig();
    startProcess('cloudflared', botPath, [
      'tunnel',
      '--edge-ip-version', EDGE_IP_VERSION,
      '--no-autoupdate',
      '--loglevel', 'fatal',
      '--protocol', CF_PROTOCOL,
      '--config', tunnelConfigPath,
      'run',
    ]);
    return;
  }

  if (tunnelMode === 'token') {
    startProcess('cloudflared', botPath, [
      'tunnel',
      '--edge-ip-version', EDGE_IP_VERSION,
      '--no-autoupdate',
      '--loglevel', 'fatal',
      '--protocol', CF_PROTOCOL,
      'run',
      '--token', ARGO_AUTH,
    ]);
    return;
  }

  startProcess('cloudflared', botPath, [
    'tunnel',
    '--edge-ip-version', EDGE_IP_VERSION,
    '--no-autoupdate',
    '--loglevel', 'fatal',
    '--protocol', CF_PROTOCOL,
    '--url', `http://127.0.0.1:${ARGO_PORT}`,
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

// --- 前端深度伪装：Nginx 默认 404 页面 + 完整 Header ---
const NGINX_404_BODY = `<html>
<head><title>404 Not Found</title></head>
<body>
<center><h1>404 Not Found</h1></center>
<hr><center>nginx/1.27.3</center>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.status(404)
    .set({
      'Server': 'nginx/1.27.3',
      'Content-Type': 'text/html',
      'Content-Length': Buffer.byteLength(NGINX_404_BODY),
      'Connection': 'keep-alive',
      'X-Powered-By': undefined, // 移除 Express 指纹
    })
    .removeHeader('X-Powered-By')
    .send(NGINX_404_BODY);
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

  // --- 优化方向一：启动阅后即焚定时器 ---
  scheduleCleanup();
}

function listen(server, port, label) {
  server.listen(port, () => {
    console.log(`${label} is running on port:${port}`);
  });
}

const mainServer = http.createServer(app);

if (DIRECT_VLESS_MODE) {
  listen(mainServer, PORT, 'http server');
} else if (PORT === ARGO_PORT) {
  mainServer.on('upgrade', proxyWebSocket);
  listen(mainServer, PORT, 'http/argo server');
} else {
  mainServer.on('upgrade', proxyWebSocket);
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

// --- 优化方向三：优雅的进程退出与信号接管 ---
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] 收到 ${signal} 信号，开始优雅退出...`);

  const killTimeout = 10000; // 最多等待 10 秒
  const killPromises = [];

  for (const [label, child] of managedChildren.entries()) {
    if (child && !child.killed) {
      killPromises.push(
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            console.warn(`[shutdown] ${label} 未在超时内退出，强制终止 (SIGKILL)`);
            try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
            resolve();
          }, killTimeout);

          child.once('close', () => {
            clearTimeout(timer);
            console.log(`[shutdown] ${label} 已退出`);
            resolve();
          });

          console.log(`[shutdown] 向 ${label} 发送 SIGTERM...`);
          try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ }
        })
      );
    }
  }

  if (killPromises.length > 0) {
    await Promise.all(killPromises);
  }

  console.log('[shutdown] 所有子进程已退出，Node.js 安全退出');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', () => {
  // 静默，不退出
});

// --- 防僵尸休眠：随机4-8分钟自保活 ---
function keepAlive() {
  const minMs = 4 * 60 * 1000;
  const maxMs = 8 * 60 * 1000;

  function ping() {
    const interval = minMs + Math.floor(Math.random() * (maxMs - minMs));
    setTimeout(() => {
      const url = process.env.KEEP_ALIVE_URL || `http://127.0.0.1:${PORT}/`;
      http.get(url, (res) => {
        res.resume(); // 消费响应体防止内存泄漏
      }).on('error', () => {
        // 静默，绝不崩溃
      });
      ping();
    }, interval);
  }

  ping();
}

keepAlive();
