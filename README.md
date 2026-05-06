# nodejs-argo sing-box 简化版

这是基于 [eooce/nodejs-argo](https://github.com/eooce/nodejs-argo) 的最小改良版，目标是回到简单的一键部署体验：Node.js 启动，自动下载官方 sing-box 和 cloudflared，自动生成节点和订阅。

本项目只服务小火箭 Shadowrocket 和 v2rayN 常用订阅格式，只生成：

- VLESS WS TLS，推荐主力使用
- VMess WS TLS，备用
- Trojan WS TLS，备用

不包含 Reality、Hysteria2、Tuic、AnyTLS、NaiveProxy、Warp、哪吒、Komari server，也不需要配置复杂的多客户端订阅。

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

其他变量都有默认值。

## 默认值

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 普通 HTTP 状态页和订阅端口 |
| `ARGO_PORT` | `8001` | Cloudflare Tunnel 指向的本地入口端口 |
| `UUID` | `89c13786-25aa-4520-b2e7-12cd60fb5202` | 建议自己改成固定 UUID |
| `CFPORT` | `443` | 节点端口 |
| `NAME` | `Vls` | 节点名称 |
| `FILE_PATH` | `.tmp` | 运行目录 |
| `SUB_PATH` | `sub` | 订阅路径 |
| `ARGO_PROTOCOL` | `http2` | cloudflared 协议 |
| `EDGE_IP_VERSION` | `auto` | cloudflared edge IP |
| `FP` | `chrome` | TLS fingerprint |
| `PUBLIC_SUB_DOMAIN` | 空 | 可选，只用于显示订阅地址 |
| `FORCE_UPDATE` | `false` | 可选，强制重新下载二进制 |
| `ko` | 空 | 可选，Komari Agent 安装命令 |

## Cloudflare Tunnel 配置

推荐使用 Token 固定隧道。

在 Cloudflare Dashboard 里配置 Public Hostname：

```text
Hostname: 你的 ARGO_DOMAIN
Path: *
Service: http://localhost:8001
```

只需要这一条，不需要分别配置 `/vless-argo`、`/vmess-argo`、`/trojan-argo`。

程序会在 `ARGO_PORT=8001` 上接收 Cloudflare Tunnel 流量，并按 path 自动转发：

```text
/vless-argo  -> 127.0.0.1:3002
/vmess-argo  -> 127.0.0.1:3003
/trojan-argo -> 127.0.0.1:3004
/sub         -> Node.js 订阅
```

JSON credentials 模式也保留，会自动生成一个简单的 `tunnel.yml`，把域名转发到 `http://127.0.0.1:8001`。

临时隧道只作为 fallback：当 `ARGO_AUTH` 为空时才会启用，不推荐长期使用。

## 订阅地址

小火箭和 v2rayN 都可以导入：

```text
https://你的 ARGO_DOMAIN/sub
```

原始节点：

```text
https://你的 ARGO_DOMAIN/sub/raw
```

如果设置了 `SUB_PATH`，例如 `SUB_PATH=abc`，则订阅地址变为：

```text
https://你的 ARGO_DOMAIN/abc
https://你的 ARGO_DOMAIN/abc/raw
```

如果设置了 `PUBLIC_SUB_DOMAIN`，状态页会优先显示它作为订阅访问域名；但节点里的 `host` / `sni` 仍然使用 `ARGO_DOMAIN`。

## 节点参数

VLESS 主力节点：

```text
address = CFIP
port = CFPORT
host = ARGO_DOMAIN
sni = ARGO_DOMAIN
path = /vless-argo
security = tls
type = ws
fp = chrome
encryption = none
```

VMess 备用：

```text
path = /vmess-argo
tls = tls
ws = ws
```

Trojan 备用：

```text
path = /trojan-argo
tls = tls
ws = ws
```

## Komari Agent

本项目不内置 Komari server，只保留 `ko` 变量用于执行你自己复制的 Komari Agent 官方安装命令。

示例：

```bash
ko=wget -qO- https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh | bash -s -- -e https://komari.godeluoo.eu.org -t 你的token
```

程序只会自动去掉命令里的 `sudo`，不会追加 `nohup`，不会追加 `--disable-web-ssh`，也不会追加 `--month-rotate`。

如果 Komari 面板显示离线，通常是 Komari 官方安装脚本依赖 systemd，而容器环境不一定支持 systemd。这是 Komari 脚本自身限制，不影响代理节点运行。

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

如果需要自定义 UUID：

```bash
-e UUID="你的固定UUID"
```

## GitHub Actions / GHCR

推送到 `main` 会自动构建 `linux/amd64` 镜像并推送到 GHCR。

Actions 不会下载 sing-box 或 cloudflared，二进制仍然在容器运行时从官方 GitHub Release 下载。

## 安全提示

- 建议把默认 `UUID` 改成自己的固定 UUID。
- 不要公开 `ARGO_AUTH`。
- 不要公开 Komari token。
- 遵守 Cloudflare 和部署平台的服务条款。
