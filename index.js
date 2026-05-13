const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

process.title = 'npm start';

// ==================================================
// 直接写死配置：你后续自己改这里
// ==================================================
const HARDCODED_APP_KEY = '6319305a-ce2e-45a9-84ab-c616f5ec3118';
const HARDCODED_API_TOKEN = '把你的_API_TOKEN_粘贴到这里';
const HARDCODED_APP_DOMAIN = 'node.chatgptaigode.eu.org';

// ==================================================
// 基础配置
// ==================================================
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const ARGO_PORT = Number(process.env.BACKEND_PORT || 8001);

const UUID = HARDCODED_APP_KEY.trim();

const ARGO_DOMAIN = HARDCODED_APP_DOMAIN
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '');

const ARGO_AUTH = HARDCODED_API_TOKEN.trim();

const ARGO_PROTOCOL = (process.env.TUNNEL_PROTO || 'http2').toLowerCase();

const CFIP = process.env.CDN_HOST || 'saas.sin.fan';
const CFPORT = String(process.env.CDN_PORT || '443');
const NAME = process.env.NAME || 'godeluoo';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';

const SUB_PATH =
  (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '') || 'godeluoo';

// ==================================================
// 必填检查
// ==================================================
if (!UUID) {
  console.error('[fatal] APP_KEY 为空');
  process.exit(1);
}

if (!ARGO_AUTH || ARGO_AUTH === '把你的_API_TOKEN_粘贴到这里') {
  console.error('[fatal] API_TOKEN 为空，请在代码顶部 HARDCODED_API_TOKEN 填入 token');
  process.exit(1);
}

if (!ARGO_DOMAIN) {
  console.error('[fatal] APP_DOMAIN 为空');
  process.exit(1);
}

// ==================================================
// 工具函数
// ==================================================
function rnd(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz';
  const b = crypto.randomBytes(n);
  let r = '';

  for (let i = 0; i < n; i++) {
    r += c[b[i] % c.length];
  }

  return r;
}

// ==================================================
// 路径
// 这里改成使用镜像内置二进制，不再运行时下载
// ==================================================
const RUN_DIR = path.resolve(FILE_PATH);

const webPath = '/app/bin/web-linux-amd64';
const botPath = '/app/bin/bot-linux-amd64';

const cfgPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

// 注意：不要把 webPath / botPath 放进 cleanupFiles
// 否则 15 秒后会把二进制删掉
const cleanupFiles = [cfgPath, tunnelJsonPath, tunnelYmlPath];

// ==================================================
// 状态
// ==================================================
let tunnelMode = ARGO_AUTH.includes('TunnelSecret') ? 'json' : 'token';
const managedChildren = new Map();
let isShuttingDown = false;
let cachedSub = '';

// ==================================================
// 初始化
// ==================================================
fs.mkdirSync(RUN_DIR, { recursive: true });

try {
  fs.readdirSync(RUN_DIR).forEach((f) => {
    try {
      fs.unlinkSync(path.join(RUN_DIR, f));
    } catch (e) {}
  });
} catch (e) {}

const app = express();
app.disable('x-powered-by');

// ==================================================
// Xray 配置
// ==================================================
function generateConfig() {
  const config = {
    dns: {
      servers: ['https+local://8.8.8.8/dns-query'],
    },
    log: {
      access: '/dev/null',
      error: '/dev/null',
      loglevel: 'none',
    },
    inbounds: [
      {
        port: ARGO_PORT,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: {
          clients: [
            {
              id: UUID,
              level: 0,
            },
          ],
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: {
            path: '/vless-argo?ed=2560',
          },
        },
        sniffing: {
          enabled: false,
        },
      },
    ],
    outbounds: [
      {
        protocol: 'freedom',
        tag: 'direct',
      },
      {
        protocol: 'blackhole',
        tag: 'block',
      },
    ],
  };

  fs.writeFileSync(cfgPath, JSON.stringify(config));
}

// ==================================================
// 订阅
// ==================================================
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

// ==================================================
// 检查二进制文件
// ==================================================
function checkBinary(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);

  if (!stat.isFile()) {
    throw new Error(`${label} is not file: ${filePath}`);
  }

  if (stat.size < 1024) {
    throw new Error(`${label} file too small: ${stat.size} bytes`);
  }

  fs.chmodSync(filePath, 0o775);

  console.log(`[binary] ${label} ready: ${filePath}, size=${stat.size}`);
}

// ==================================================
// 进程管理
// ==================================================
function startProcess(label, cmd, args) {
  console.log(`[process] start ${label}: ${cmd} ${args.join(' ')}`);

  const child = spawn(cmd, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });

  if (child.stderr) {
    child.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[${label}]`, msg);
    });
  }

  managedChildren.set(label, child);

  child.on('error', (err) => {
    console.error(`[process] ${label} error:`, err.message || err);
    managedChildren.delete(label);
  });

  child.on('close', (code, sig) => {
    console.error(`[process] ${label} closed code=${code} sig=${sig}`);
    managedChildren.delete(label);

    if (isShuttingDown) return;

    process.exit(1);
  });

  return child;
}

// ==================================================
// Cloudflare Tunnel
// ==================================================
function startCloudflared() {
  const base = [
    'tunnel',
    '--edge-ip-version',
    EDGE_IP_VERSION,
    '--no-autoupdate',
    '--loglevel',
    'fatal',
    '--protocol',
    ARGO_PROTOCOL,
  ];

  if (tunnelMode === 'json') {
    const creds = JSON.parse(ARGO_AUTH);

    const tid =
      creds.TunnelID ||
      creds.tunnel_id ||
      creds.TunnelName ||
      creds.tunnel_name;

    if (!tid) {
      throw new Error('Tunnel JSON 缺少 TunnelID');
    }

    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);

    fs.writeFileSync(
      tunnelYmlPath,
      [
        `tunnel: ${tid}`,
        `credentials-file: ${tunnelJsonPath}`,
        `protocol: ${ARGO_PROTOCOL}`,
        'ingress:',
        `  - hostname: ${ARGO_DOMAIN}`,
        `    service: http://localhost:${ARGO_PORT}`,
        '  - service: http_status:404',
      ].join('\n')
    );

    return startProcess('cf', botPath, [
      ...base,
      '--config',
      tunnelYmlPath,
      'run',
    ]);
  }

  if (tunnelMode === 'token') {
    return startProcess('cf', botPath, [
      ...base,
      'run',
      '--token',
      ARGO_AUTH,
    ]);
  }

  throw new Error('unknown tunnel mode');
}

// ==================================================
// 清理临时配置
// ==================================================
function scheduleCleanup() {
  setTimeout(() => {
    cleanupFiles.forEach((f) => {
      try {
        fs.rmSync(f, { force: true });
      } catch (e) {}
    });
  }, 15000);
}

// ==================================================
// 路由
// ==================================================
const NGINX_404 =
  '<html>\n' +
  '<head><title>404 Not Found</title></head>\n' +
  '<body>\n' +
  '<center><h1>404 Not Found</h1></center>\n' +
  '<hr><center>nginx/1.27.3</center>\n' +
  '</body>\n' +
  '</html>\n';

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/robots.txt', (req, res) => {
  res.set('Server', 'nginx/1.27.3');
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

app.get('/', (req, res) => {
  setTimeout(() => {
    try {
      if (!res.headersSent) {
        res
          .status(404)
          .set({
            Server: 'nginx/1.27.3',
            'Content-Type': 'text/html',
            Connection: 'keep-alive',
          })
          .send(NGINX_404);
      }
    } catch (e) {}
  }, 1 + Math.random() * 14);
});

app.get(`/${SUB_PATH}`, (req, res) => {
  if (!cachedSub) {
    return res.status(503).send('not ready');
  }

  res.type('text/plain; charset=utf-8').send(cachedSub);
});

app.get('/healthz', (req, res) => {
  res.status(200).json({
    ok: true,
    port: PORT,
    sub: `/${SUB_PATH}`,
    domain: ARGO_DOMAIN,
    tunnelMode,
  });
});

app.use((req, res) => {
  setTimeout(() => {
    try {
      if (!res.headersSent) {
        res
          .status(404)
          .set({
            Server: 'nginx/1.27.3',
            'Content-Type': 'text/html',
            Connection: 'keep-alive',
          })
          .send(NGINX_404);
      }
    } catch (e) {}
  }, 1 + Math.random() * 14);
});

// ==================================================
// 主启动
// ==================================================
async function startserver() {
  console.log(`[env] PORT=${PORT}`);
  console.log(`[env] BACKEND_PORT=${ARGO_PORT}`);
  console.log(`[env] APP_DOMAIN=${ARGO_DOMAIN}`);
  console.log(`[env] SUB_PATH=/${SUB_PATH}`);
  console.log(`[env] TUNNEL_PROTO=${ARGO_PROTOCOL}`);
  console.log(`[env] tunnelMode=${tunnelMode}`);

  generateConfig();
  refreshSub();

  checkBinary(webPath, 'core');
  checkBinary(botPath, 'cf');

  startProcess('core', webPath, ['run', '-c', cfgPath]);
  startCloudflared();

  scheduleCleanup();

  console.log('[startup] ready');
}

app.listen(PORT, () => {
  console.log(`http :${PORT} | sub /${SUB_PATH}`);
});

startserver().catch((e) => {
  console.error('[startup]', e.message || e);
  process.exit(1);
});

// ==================================================
// 优雅退出
// ==================================================
async function shutdown() {
  if (isShuttingDown) return;

  isShuttingDown = true;

  const ps = [];

  for (const [, child] of managedChildren) {
    if (child && !child.killed) {
      ps.push(
        new Promise((r) => {
          const t = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch (e) {}
            r();
          }, 5000);

          child.once('close', () => {
            clearTimeout(t);
            r();
          });

          try {
            child.kill('SIGTERM');
          } catch (e) {}
        })
      );
    }
  }

  await Promise.all(ps);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message || err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
  process.exit(1);
});

// ==================================================
// 防休眠
// ==================================================
const KEEP_ALIVE_PATHS = [
  '/',
  '/index.html',
  '/about',
  '/contact',
  '/api/status',
  '/healthz',
];

(function keepAlive() {
  const lo = 4 * 60000;
  const hi = 8 * 60000;

  (function tick() {
    setTimeout(() => {
      const randomPath =
        KEEP_ALIVE_PATHS[Math.floor(Math.random() * KEEP_ALIVE_PATHS.length)];

      http
        .get(`http://127.0.0.1:${PORT}${randomPath}`, (r) => r.resume())
        .on('error', () => {});

      tick();
    }, lo + Math.floor(Math.random() * (hi - lo)));
  })();
})();
