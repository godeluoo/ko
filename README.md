# nodejs-argo sing-box 极速简化版

这是基于 [eooce/nodejs-argo](https://github.com/eooce/nodejs-argo) 的最小改良版，并吸收 [fscarmen/sing-box](https://github.com/fscarmen/sing-box) 里和 sing-box、Cloudflare Argo、CFIP/CDN、WS TLS 订阅相关的优点。

本项目的结合方式很简单：

- eooce/nodejs-argo 的优点：PaaS / Node 玩具平台友好、少变量、单入口、自动节点、自动订阅。
- fscarmen/sing-box 的优点：sing-box 核心、Cloudflare Argo / Tunnel 思路、CFIP 优选、VLESS / VMess / Trojan WS TLS。
- 本项目只做：简单部署 + sing-box 核心 + Cloudflare 固定隧道 + CFIP 优选 + 小火箭 / v2rayN 订阅。

不包含 Reality、Hysteria2、Tuic、AnyTLS、NaiveProxy、Warp、哪吒、Komari server、nginx、systemd、openrc，也不增加额外 npm 依赖。

## 最少必填环境变量

只需要填三个：

```bash
ARGO_DOMAIN=你的固定隧道域名
ARGO_AUTH=你的 Cloudflare Tunnel Token
CFIP=stable.cf.090227.xyz
```

`CFIP` 也可以用：

```bash
CFIP=saas.sin.fan
```

建议额外设置自己的固定 UUID：

```bash
UUID=你的固定UUID
```

## 默认极速模式

默认：

```bash
SPEED_MODE=true
MULTI_MODE=false
```

特点：

- 最快、最稳。
- 只启用 VLESS 主力节点。
- sing-box 的 VLESS inbound 直接监听 `127.0.0.1:8001`。
- Cloudflare Tunnel 直接转发到 sing-box，不经过 Node.js WebSocket proxy。
- 适合 Northflank 免费容器长期使用。

VLESS 流量路径：

```text
Cloudflare Tunnel -> cloudflared -> sing-box VLESS 8001
```

Cloudflare Dashboard 只需要一条：

```text
Hostname: 你的 ARGO_DOMAIN
Path: *
Service: http://localhost:8001
```

极速模式下 `/sub` 和 `/sub/raw` 仍由 Node.js 的 `PORT=3000` 提供。可以通过 Northflank 平台域名访问订阅，或设置 `PUBLIC_SUB_DOMAIN` 用于状态页显示订阅入口。节点里的 `host` / `sni` 永远使用 `ARGO_DOMAIN`。

## 三节点兼容模式

如果你确实要同时使用 VLESS / VMess / Trojan：

```bash
MULTI_MODE=true
```

或：

```bash
SPEED_MODE=false
```

特点：

- VLESS / VMess / Trojan 都能用。
- Node.js 在 `ARGO_PORT=8001` 做 WebSocket path proxy：

```text
/vless-argo  -> 127.0.0.1:3002
/vmess-argo  -> 127.0.0.1:3003
/trojan-argo -> 127.0.0.1:3004
```

- Cloudflare Dashboard 仍然只需要：

```text
Hostname: 你的 ARGO_DOMAIN
Path: *
Service: http://localhost:8001
```

三节点模式易用性更高，但速度略低于默认的 VLESS 直通极速模式。

## 临时隧道测试模式

当 `ARGO_DOMAIN` 和 `ARGO_AUTH` 都不填时，会启用临时 trycloudflare 隧道。

临时隧道只适合测试：

- 域名重启后可能变化。
- 不适合长期稳定使用。
- 长期使用请配置 Token 或 JSON 固定隧道。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ARGO_DOMAIN` | 空 | Cloudflare 固定隧道域名 |
| `ARGO_AUTH` | 空 | Cloudflare Tunnel Token 或 JSON credentials |
| `CFIP` | `saas.sin.fan` | 优选 IP / 优选域名 / CDN 地址 |
| `PORT` | `3000` | Node.js 状态页和订阅端口 |
| `ARGO_PORT` | `8001` | Cloudflare Tunnel 指向的本地入口端口 |
| `UUID` | `89c13786-25aa-4520-b2e7-12cd60fb5202` | 建议改成自己的固定 UUID |
| `CFPORT` | `443` | 节点端口 |
| `NAME` | `Vls` | 节点名称 |
| `FILE_PATH` | `.tmp` | 运行目录 |
| `SUB_PATH` | `sub` | 订阅路径 |
| `ARGO_PROTOCOL` | `http2` | cloudflared 协议，可选 `http2` / `quic` |
| `EDGE_IP_VERSION` | `auto` | cloudflared edge IP，可选 `auto` / `4` / `6` |
| `FP` | `chrome` | TLS fingerprint |
| `FORCE_UPDATE` | `false` | 强制重新下载官方二进制 |
| `SPEED_MODE` | `true` | 极速 VLESS 直通模式 |
| `MULTI_MODE` | `false` | 三节点兼容模式 |
| `PUBLIC_SUB_DOMAIN` | 空 | 可选，只用于显示订阅地址 |
| `ko` / `KO` | 空 | 可选，Komari Agent 用户命令 |

## 订阅

小火箭 Shadowrocket 和 v2rayN 都可以导入：

```text
https://你的订阅域名/sub
```

原始节点：

```text
https://你的订阅域名/sub/raw
```

如果设置 `SUB_PATH=abc`：

```text
https://你的订阅域名/abc
https://你的订阅域名/abc/raw
```

订阅规则：

- `SPEED_MODE=true` 且 `MULTI_MODE=false`：只输出 VLESS 主力节点。
- `MULTI_MODE=true` 或 `SPEED_MODE=false`：输出 VLESS / VMess / Trojan。
- VLESS 永远排第一位，作为主力节点。

## 节点参数

VLESS 主力节点：

```text
address = CFIP
port = CFPORT
uuid = UUID
encryption = none
security = tls
sni = ARGO_DOMAIN
fp = FP
type = ws
host = ARGO_DOMAIN
path = /vless-argo
```

VMess 备用节点：

```text
add = CFIP
port = CFPORT
id = UUID
aid = 0
scy = auto
net = ws
type = none
host = ARGO_DOMAIN
path = /vmess-argo
tls = tls
sni = ARGO_DOMAIN
fp = FP
```

Trojan 备用节点：

```text
password = UUID
address = CFIP
port = CFPORT
security = tls
sni = ARGO_DOMAIN
fp = FP
type = ws
host = ARGO_DOMAIN
path = /trojan-argo
```

默认不使用 `/vless-argo?ed=2048`，路径就是 `/vless-argo`，更适合小火箭和 v2rayN。

## Komari Agent

本项目不内置 Komari server，只保留 `ko` / `KO` 环境变量用于执行你自己复制的 Komari Agent 官方安装命令。

示例：

```bash
ko=wget -qO- https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh | bash -s -- -e https://komari.example.com -t 你的token
```

程序只会自动去掉命令里的 `sudo`，不会改你的命令，不会追加 `nohup`，不会自动追加任何参数。命令失败只打印日志，不影响代理启动。

Northflank 容器没有 systemd，Komari 官方安装脚本可能只安装不启动。如果需要长期在线，可以自己在 `ko` 里追加类似：

```bash
; nohup /opt/komari/agent -e ENDPOINT -t TOKEN >/tmp/komari-agent.log 2>&1 &
```

## Docker 运行示例

```bash
docker build -t nodejs-argo-singbox .
docker run -d --name nodejs-argo-singbox \
  -p 3000:3000 \
  -e ARGO_DOMAIN="argo.example.com" \
  -e ARGO_AUTH="你的 Cloudflare Tunnel Token" \
  -e CFIP="stable.cf.090227.xyz" \
  nodejs-argo-singbox
```

三节点兼容模式：

```bash
-e MULTI_MODE=true
```

## GitHub Actions / GHCR

推送到 `main` 会自动构建 `linux/amd64` 镜像并推送到 GHCR。

Actions 不会下载 sing-box 或 cloudflared，二进制仍然在容器运行时从官方 GitHub Release 下载。

## 安全提示

- 建议把默认 `UUID` 改成自己的固定 UUID。
- 不要公开 `ARGO_AUTH`。
- 不要公开 Komari token。
- 遵守 Cloudflare 和部署平台的服务条款。
