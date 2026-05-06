# singbox-argo

这是基于 [eooce/nodejs-argo](https://github.com/eooce/nodejs-argo) 的最小改良版，保留原项目 Node.js 一键部署、环境变量配置、自动下载二进制、自动生成配置、自动启动核心、自动生成订阅、免费容器 / PaaS 友好的使用方式。

本项目同时吸收 [fscarmen/sing-box](https://github.com/fscarmen/sing-box) 中和 Cloudflare Argo、订阅输出、非交互部署、优选地址可配置相关的优点，但不照搬 VPS 全家桶。这里**只保留 cloudflared 节点**，不实现 Reality、Hysteria2、Tuic、ShadowTLS、AnyTLS、NaiveProxy、Warp 等协议。

默认目标是 Northflank `app.northflank.com` 免费 / 小规格容器，例如约 `0.2 vCPU + 512MB RAM`：顺序下载和启动核心、低日志级别、少依赖、不启用额外协议和实验功能。主力节点推荐 **VLESS WS TLS + Cloudflare Tunnel**，VMess 和 Trojan 只作为备用。

## 改动点

- 原 `web` 二进制改为官方最新稳定版 sing-box。
- 原 `bot` 二进制改为官方最新正式版 cloudflared。
- 只支持 `linux/amd64` / x86_64，删除 ARM 逻辑。
- 删除哪吒相关变量和逻辑。
- 支持 JSON 固定隧道、Token 固定隧道、临时隧道三种 Argo 模式。
- 新增 `/sub/sing-box` 和 `/sub/clash`，输出更适合客户端导入的订阅片段。
- 新增 `PUBLIC_SUB_DOMAIN`，可把 Northflank 平台域名作为订阅入口，而节点 `host` / `sni` 仍使用 `ARGO_DOMAIN`。
- 新增 `FORCE_UPDATE`，默认复用已有 sing-box / cloudflared 二进制以加快重启。
- 新增 `ko` 环境变量，用于运行你自己的 Komari Agent 安装命令。
- 不加入 Komari 服务端、不加入复杂管理面板、不伪装进程、不隐藏日志。

## 最新稳定版策略

sing-box 和 cloudflared 是运行时二进制，容器启动时从官方 GitHub Release 下载，保留原项目“运行时自举”的风格。

- sing-box 从 `SagerNet/sing-box` Releases 中过滤 `draft`、`prerelease`、`alpha`、`beta`、`rc`，只选择最新稳定版。
- cloudflared 从 `cloudflare/cloudflared` latest 正式 release 下载 `cloudflared-linux-amd64`。
- npm 依赖不使用 `latest`，固定为 `express@5.2.1` 和 `axios@1.16.0`，避免构建时因为 npm 标签移动造成不可预期变化。

## Argo 模式

### A. JSON 固定隧道模式，推荐

设置：

```bash
ARGO_DOMAIN=argo.example.com
ARGO_AUTH='{"AccountTag":"...","TunnelSecret":"...","TunnelID":"..."}'
```

程序会写入 `tunnel.json`，自动生成 `tunnel.yml`，并启动：

```bash
cloudflared tunnel --edge-ip-version auto --protocol http2 --config tunnel.yml run
```

JSON 固定隧道性能最好，因为 cloudflared 根据 ingress 直接分流到 sing-box 本地端口，VLESS / VMess / Trojan 不经过 Node.js WebSocket 反代，少一层转发，更适合小规格容器长期运行。

自动生成的 ingress：

```yaml
ingress:
  - hostname: ARGO_DOMAIN
    path: /vless-argo*
    service: http://127.0.0.1:3002
  - hostname: ARGO_DOMAIN
    path: /vmess-argo*
    service: http://127.0.0.1:3003
  - hostname: ARGO_DOMAIN
    path: /trojan-argo*
    service: http://127.0.0.1:3004
  - hostname: ARGO_DOMAIN
    path: /sub*
    service: http://127.0.0.1:3000
  - hostname: ARGO_DOMAIN
    service: http://127.0.0.1:3000
  - service: http_status:404
```

### B. Token 固定隧道模式

设置：

```bash
ARGO_AUTH=你的 Cloudflare Tunnel token
ARGO_DOMAIN=argo.example.com
```

程序会启动：

```bash
cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ARGO_AUTH
```

Token 模式的 ingress / service 主要在 Cloudflare Dashboard 配置。如果要多路径自动分流，推荐使用 JSON credentials 模式。Token 模式建议也填写 `ARGO_DOMAIN`，否则程序无法知道订阅里的 `host` / `sni` 应该写什么。

Token 模式可以长期使用，但必须在 Cloudflare Dashboard 正确配置 Public Hostname / Service，否则节点会连接失败。建议：

| 用途 | Path | Service |
| --- | --- | --- |
| VLESS 主力节点 | `/vless-argo*` | `http://127.0.0.1:3002` |
| 订阅入口 | `/sub*` | `http://127.0.0.1:3000` |
| VMess 备用 | `/vmess-argo*` | `http://127.0.0.1:3003` |
| Trojan 备用 | `/trojan-argo*` | `http://127.0.0.1:3004` |

如果只用主力节点，至少配置 `/vless-argo* -> http://127.0.0.1:3002`。如果要通过 Cloudflare 固定隧道访问订阅，还需要配置 `/sub* -> http://127.0.0.1:3000`。

### C. 临时隧道模式

当 `ARGO_AUTH` 和 `ARGO_DOMAIN` 都为空时，会启用临时隧道：

```bash
cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://127.0.0.1:3000
```

临时隧道只适合测试：

- 域名重启后可能变化。
- 不适合长期稳定使用。
- 速度和稳定性不如固定隧道。
- 可能多一层 Node.js WebSocket 反代。
- 程序会从 cloudflared 日志中提取 `trycloudflare.com` 域名。
- 域名提取前访问 `/sub` 会返回 `temporary tunnel domain not ready`。
- 长期节点不要依赖临时隧道，推荐 JSON 或 Token 固定隧道。

## http2 和 quic 怎么选

支持：

- `ARGO_PROTOCOL=http2`，默认，更适合免费容器和多数 PaaS。
- `ARGO_PROTOCOL=quic`，可在 VPS 或 UDP 出站稳定的平台测试。
- `EDGE_IP_VERSION=auto`，默认，也可设置为 `4` 或 `6`。

Northflank / 免费容器默认推荐 `http2`，因为 TCP 出站通常比 UDP 出站更稳。`quic` 可能速度更好，但依赖 UDP 出站质量，免费容器不一定稳定。想测速可以临时改 `ARGO_PROTOCOL=quic`，如果断流或不稳就改回 `http2`。

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3000` | Node.js HTTP 服务端口。 |
| `FILE_PATH` | 否 | `.tmp` | 运行目录，保存二进制、配置和订阅缓存。 |
| `UUID` | 建议必填 | 随机生成 | VLESS / VMess UUID，Trojan 密码；未填时重启会变化。 |
| `ARGO_DOMAIN` | 固定隧道建议必填 | 空 | Cloudflare Tunnel 域名。 |
| `PUBLIC_SUB_DOMAIN` | 否 | 空 | 订阅展示域名，可填 Northflank 平台自带域名；不参与节点 host/sni。 |
| `ARGO_AUTH` | 固定隧道必填 | 空 | Cloudflare Tunnel token 或 JSON credentials。 |
| `ARGO_PROTOCOL` | 否 | `http2` | cloudflared 协议，可选 `http2` / `quic`。 |
| `EDGE_IP_VERSION` | 否 | `auto` | cloudflared edge IP，可选 `auto` / `4` / `6`。 |
| `CFIP` | 否 | `saas.sin.fan` | 订阅节点地址，可填优选 IP / 优选域名 / CDN 地址。 |
| `CFPORT` | 否 | `443` | 订阅节点端口。 |
| `FP` | 否 | `chrome` | TLS fingerprint，可填 `chrome` 或 `firefox` 等客户端支持值。 |
| `NAME` | 否 | `singbox-argo` | 节点名称前缀。 |
| `SUB_PATH` | 否 | `sub` | 订阅路径。 |
| `ko` | 否 | 空 | Komari Agent 安装命令。 |
| `UPLOAD_URL` | 否 | 空 | 订阅或节点上传地址，兼容原逻辑。 |
| `PROJECT_URL` | 否 | 空 | 项目外部访问地址，用于上传订阅或自动访问。 |
| `AUTO_ACCESS` | 否 | `false` | 设置为 `true` 时自动访问 `PROJECT_URL`。 |
| `FORCE_UPDATE` | 否 | `false` | 设置为 `true` 时强制重新下载官方最新二进制。 |

已删除且不再使用：`NEZHA_SERVER`、`NEZHA_PORT`、`NEZHA_KEY`、ARM 相关变量。

## Northflank / 免费容器注意事项

- 请选择 `linux/amd64` 或 x86_64 运行环境。
- 对外 HTTP 端口设置为 `3000`。
- 免费容器建议使用 `ARGO_PROTOCOL=http2`。
- 长期使用建议配置 JSON 或 Token 固定隧道。
- 临时隧道适合首次测试，重启后域名可能变化。
- `UUID` 建议手动设置固定值，否则未填时每次重启都会生成新的随机值。
- JSON credentials 建议完整粘贴到环境变量，注意平台对引号和换行的处理。
- Northflank 自带域名适合访问 `/` 和 `/sub`，Cloudflare 固定隧道域名适合做节点 `host` / `sni`。
- 如果平台文件系统保留 `.tmp`，默认会复用已有 sing-box / cloudflared，加快重启；如果文件不存在会自动重新下载。

## Northflank 0.2 vCPU + 512MB 推荐配置

```bash
PORT=3000
UUID=自己生成的固定UUID
ARGO_DOMAIN=你的Cloudflare固定隧道域名
PUBLIC_SUB_DOMAIN=你的Northflank平台自带域名
ARGO_AUTH=你的Cloudflare Tunnel Token或JSON
ARGO_PROTOCOL=http2
EDGE_IP_VERSION=auto
CFIP=saas.sin.fan
CFPORT=443
FP=chrome
SUB_PATH=sub
NAME=northflank
FORCE_UPDATE=false
ko=你的Komari Agent安装命令，可选
```

最终建议：

- 长期稳定：固定隧道 + `ARGO_PROTOCOL=http2`。
- 想测速：临时改 `ARGO_PROTOCOL=quic` 测试，不稳就换回 `http2`。
- 主力节点：VLESS WS TLS。
- 订阅入口：`https://PUBLIC_SUB_DOMAIN/sub`。
- 节点 `host` / `sni`：`ARGO_DOMAIN`。
- 不建议长期使用临时隧道。

## Docker 运行示例

JSON 固定隧道：

```bash
docker build -t singbox-argo .
docker run -d --name singbox-argo \
  -p 3000:3000 \
  -e UUID="请填写自己的UUID" \
  -e ARGO_DOMAIN="argo.example.com" \
  -e ARGO_AUTH='{"AccountTag":"...","TunnelSecret":"...","TunnelID":"..."}' \
  -e CFIP="saas.sin.fan" \
  -e CFPORT="443" \
  -e FP="chrome" \
  -e NAME="my-node" \
  singbox-argo
```

临时隧道测试：

```bash
docker run -d --name singbox-argo \
  -p 3000:3000 \
  -e UUID="请填写自己的UUID" \
  singbox-argo
```

## GHCR 使用示例

GitHub Actions 会在推送 `main` 时构建 `linux/amd64` 镜像并推送到 GHCR：

```bash
docker pull ghcr.io/你的用户名或组织/你的仓库:latest
docker run -d --name singbox-argo \
  -p 3000:3000 \
  -e UUID="请填写自己的UUID" \
  -e ARGO_DOMAIN="argo.example.com" \
  -e ARGO_AUTH="你的 token 或 JSON credentials" \
  ghcr.io/你的用户名或组织/你的仓库:latest
```

Actions 不会下载 sing-box 或 cloudflared，二进制仍在容器运行时从官方 Release 自动下载。

## Komari Agent

本项目不内置 Komari 服务端，也不内置任何 token。你已经有自己的 Komari 面板时，在面板中复制 Agent 安装命令，完整填入 `ko` 环境变量即可。

示例格式：

```bash
ko='wget -qO- https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh | bash -s -- -e https://komari.example.com -t 你的token --month-rotate 1'
```

容器里通常是 root，Alpine 也不一定有 `sudo`，程序会自动去掉命令里的 `sudo`。`ko` 为空时会输出：

```text
ko variable is empty, skip Komari agent
```

Komari 安装失败只会打印错误，不会阻止 sing-box 和 cloudflared 继续启动。不要公开你的 Komari token。

## 订阅地址

默认路径：

- Base64 通用订阅：`https://你的ARGO_DOMAIN/sub`
- 原始节点文本：`https://你的ARGO_DOMAIN/sub/raw`
- sing-box 客户端 outbound JSON：`https://你的ARGO_DOMAIN/sub/sing-box`
- Clash Mihomo proxies YAML 片段：`https://你的ARGO_DOMAIN/sub/clash`

如果设置了 `PUBLIC_SUB_DOMAIN`，状态页展示的订阅地址会优先使用：

- `https://PUBLIC_SUB_DOMAIN/sub`
- `https://PUBLIC_SUB_DOMAIN/sub/raw`
- `https://PUBLIC_SUB_DOMAIN/sub/sing-box`
- `https://PUBLIC_SUB_DOMAIN/sub/clash`

注意：`PUBLIC_SUB_DOMAIN` 只用于展示订阅 URL，不参与节点连接参数。订阅里的节点 `host` / `sni` 永远优先使用 `ARGO_DOMAIN`；临时隧道模式才使用提取到的 `trycloudflare.com` 域名。

如果修改了 `SUB_PATH`，例如 `SUB_PATH=my-sub`，则地址变为：

- `/my-sub`
- `/my-sub/raw`
- `/my-sub/sing-box`
- `/my-sub/clash`

订阅只包含 cloudflared WS 节点：

- VLESS WS：`/vless-argo?ed=2048`，推荐主力使用
- VMess WS：`/vmess-argo`，备用
- Trojan WS：`/trojan-argo`，备用

VLESS WS TLS 配置简单、兼容 Cloudflare Tunnel、资源占用低，更适合 Northflank 小规格容器。

节点参数使用：

- `add`: `CFIP`
- `port`: `CFPORT`
- `host` / `sni`: 固定隧道使用 `ARGO_DOMAIN`，临时隧道使用提取到的 `trycloudflare.com` 域名
- `security`: `tls`
- `type`: `ws`
- `fp`: `FP`

## 安全提示

- 不要使用默认或临时 UUID，务必设置自己的固定 `UUID`。
- 不要公开 `ARGO_AUTH`。
- 不要公开 Komari token。
- 不要把包含 token 的运行日志公开发布。
- 请遵守 Cloudflare、容器平台和所在地法律法规及服务条款。
