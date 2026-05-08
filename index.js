const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

// ==================== 环境变量 ====================
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const ARGO_PORT = Number(process.env.ARGO_PORT || 8001);
const UUID = (process.env.UUID || '').trim();
const ARGO_DOMAIN = (process.env.ARGO_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
const ARGO_AUTH = (process.env.ARGO_AUTH || '').trim();
const ARGO_PROTOCOL = (process.env.ARGO_PROTOCOL || 'http2').toLowerCase();
const CFIP = process.env.CFIP || 'saas.sin.fan';
const CFPORT = String(process.env.CFPORT || '443');
const NAME = process.env.NAME || 'Vls';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';

// 必须手动设置 UUID，不提供默认值
if (!UUID) { console.error('[fatal] UUID 未设置，请配置环境变量 UUID'); process.exit(1); }

// 必须配置 ARGO_AUTH，禁止临时隧道
if (!ARGO_AUTH) { console.error('[fatal] ARGO_AUTH 未设置，不支持临时隧道'); process.exit(1); }

// SUB_PATH: 用户自定义 > 基于UUID生成的随机路径（不再是可猜测的 /sub）
const SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '')
  || crypto.createHash('md5').update(UUID).digest('hex').slice(0, 8);

// ==================== 工具 ====================
function rnd(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz', b = crypto.randomBytes(n);
  let r = ''; for (let i = 0; i < n; i++) r += c[b[i] % c.length]; return r;
}

// ==================== 路径（全随机化） ====================
const RUN_DIR = path.resolve(FILE_PATH);
const webPath = path.join(RUN_DIR, rnd());
const botPath = path.join(RUN_DIR, rnd());
const cfgPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

// 阅后即焚清单（sub.txt 也包含在内，不留盘）
const cleanupFiles = [webPath, botPath, cfgPath, tunnelJsonPath, tunnelYmlPath];

// ==================== 状态 ====================
let tunnelMode = ARGO_AUTH.includes('TunnelSecret') ? 'json' : 'token';
const managedChildren = new Map();
let isShuttingDown = false;
let cachedSub = '';

// ==================== 初始化 ====================
fs.mkdirSync(RUN_DIR, { recursive: true });

// 启动时清理历史残留（容器重启后上次的二进制/配置可能还在）
try { fs.readdirSync(RUN_DIR).forEach(f => {
  try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch (e) {}
}); } catch (e) {}

const app = express();
app.disable('x-powered-by');

// ==================== Xray 配置（仅VLESS-WS + Early Data） ====================
function generateConfig() {
  fs.writeFileSync(cfgPath, JSON.stringify({
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [{
      port: ARGO_PORT,
      listen: '127.0.0.1',
      protocol: 'vless',
      settings: { clients: [{ id: UUID, level: 0 }], decryption: 'none' },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/vless-argo?ed=2560' } },
      sniffing: { enabled: false },
    }],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
  }));
}

// ==================== 订阅（内存缓存，不留盘） ====================
function buildSub() {
  const host = ARGO_DOMAIN;
  if (!host) return '';
  const n = encodeURIComponent(NAME);
  const p = encodeURIComponent('/vless-argo?ed=2560');
  return `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${p}#${n}`;
}

function refreshSub() {
  cachedSub = Buffer.from(buildSub()).toString('base64');
}

// ==================== 下载 ====================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function download(url, dest) {
  const tmp = `${dest}.dl`;
  fs.rmSync(tmp, { force: true });
  const r = await axios({ method: 'get', url, responseType: 'stream', timeout: 120000,
    headers: { 'User-Agent': UA }, validateStatus: s => s >= 200 && s < 300 });
  await pipeline(r.data, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o775);
}

async function downloadRetry(urls, dest, label) {
  for (let i = 0; i < urls.length; i++) {
    try { await download(urls[i], dest); return; } catch (e) {}
  }
  throw new Error(`${label}: all sources failed`);
}

// ==================== 安装 ====================
async function installXray() {
  await downloadRetry([
    'https://amd64.ssss.nyc.mn/web',
  ], webPath, 'xray');
}

async function installCloudflared() {
  await downloadRetry([
    'https://amd64.ssss.nyc.mn/bot',
  ], botPath, 'cf');
}

// ==================== 进程管理 ====================
function startProcess(label, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'ignore', env: process.env });
  managedChildren.set(label, child);
  child.on('error', () => managedChildren.delete(label));
  child.on('close', (code, sig) => {
    managedChildren.delete(label);
    if (isShuttingDown) return;
    // 子进程挂了 → 直接退出，让平台重启容器
    process.exit(1);
  });
  return child;
}

// ==================== 隧道 ====================
function startCloudflared() {
  const base = ['tunnel', '--edge-ip-version', EDGE_IP_VERSION, '--no-autoupdate', '--loglevel', 'fatal', '--protocol', ARGO_PROTOCOL];

  if (tunnelMode === 'json') {
    const creds = JSON.parse(ARGO_AUTH);
    const tid = creds.TunnelID || creds.tunnel_id || creds.TunnelName || creds.tunnel_name;
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tid}`, `credentials-file: ${tunnelJsonPath}`, `protocol: ${ARGO_PROTOCOL}`,
      'ingress:', `  - hostname: ${ARGO_DOMAIN}`, `    service: http://localhost:${ARGO_PORT}`, '  - service: http_status:404',
    ].join('\n'));
    return startProcess('cf', botPath, [...base, '--config', tunnelYmlPath, 'run']);
  }

  if (tunnelMode === 'token') {
    return startProcess('cf', botPath, [...base, 'run', '--token', ARGO_AUTH]);
  }
}

// ==================== 阅后即焚（15秒后清除磁盘痕迹） ====================
function scheduleCleanup() {
  setTimeout(() => {
    cleanupFiles.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  }, 15000);
}

// ==================== 路由（Nginx 404 伪装） ====================
const NGINX_404 = '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>\n';

app.get('/', (req, res) => {
  res.removeHeader('X-Powered-By');
  res.status(404)
    .set({
      'Server': 'nginx/1.27.3',
      'Content-Type': 'text/html',
      'Connection': 'keep-alive'
    })
    .send(NGINX_404);
});

app.get(`/${SUB_PATH}`, (req, res) => {
  if (!cachedSub) return res.status(503).send('not ready');
  res.type('text/plain; charset=utf-8').send(cachedSub);
});

// ==================== 主启动 ====================
async function startserver() {
  generateConfig();
  refreshSub();

  await installXray();
  startProcess('xray', webPath, ['run', '-c', cfgPath]);

  await installCloudflared();
  startCloudflared();

  scheduleCleanup();
}

app.listen(PORT, () => console.log(`http :${PORT} | sub /${SUB_PATH}`));

startserver().catch(() => process.exit(1));

// ==================== 优雅退出 ====================
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const ps = [];
  for (const [, child] of managedChildren) {
    if (child && !child.killed) {
      ps.push(new Promise(r => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} r(); }, 5000);
        child.once('close', () => { clearTimeout(t); r(); });
        try { child.kill('SIGTERM'); } catch (e) {}
      }));
    }
  }
  await Promise.all(ps);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));

// ==================== 防休眠 ====================
(function keepAlive() {
  const lo = 4 * 60000, hi = 8 * 60000;
  (function tick() {
    setTimeout(() => {
      http.get(`http://127.0.0.1:${PORT}/`, r => r.resume()).on('error', () => {});
      tick();
    }, lo + Math.floor(Math.random() * (hi - lo)));
  })();
})();
