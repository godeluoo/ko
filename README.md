# ko

一个极简 Node.js + sing-box + cloudflared 容器项目。

基于 `eooce/nodejs-argo` 的使用思路，保留简单环境变量、一键部署、自动生成订阅、自动启动隧道的体验。

## 特点

- AMD64 only
- 自动下载官方最新稳定版 sing-box
- 自动下载官方最新版 cloudflared
- 支持 Cloudflare Tunnel Token 固定隧道
- 支持 VLESS / VMess / Trojan WS TLS
- 支持小火箭 Shadowrocket
- 支持 v2rayN
- 支持 `/sub` 通用订阅
- 支持 `/sub/raw` 原始节点
- 支持 Komari Agent 安装命令
- Cloudflare Dashboard 只需要一条路由

## 最少环境变量

只需要填这三个：

| 变量名 | 示例 | 说明 |
|---|---|---|
| `ARGO_DOMAIN` | `node.example.com` | Cloudflare Tunnel 固定域名 |
| `ARGO_AUTH` | `eyJh...` | Cloudflare Tunnel Token |
| `CFIP` | `saas.sin.fan` | 优选域名或优选 IP |

## 推荐环境变量

```env
ARGO_DOMAIN=node.example.com
ARGO_AUTH=你的Cloudflare Tunnel Token
CFIP=saas.sin.fan
可选环境变量
变量名	默认值	说明
PORT	3000	HTTP 状态页和订阅端口
ARGO_PORT	8001	Cloudflare Tunnel 转发端口
UUID	89c13786-25aa-4520-b2e7-12cd60fb5202	用户 UUID
CFPORT	443	优选端口
NAME	Vls	节点名前缀
FILE_PATH	.tmp	运行目录
SUB_PATH	sub	订阅路径
ARGO_PROTOCOL	http2	cloudflared 协议
EDGE_IP_VERSION	auto	Cloudflare edge IP 版本
FP	chrome	TLS fingerprint
PUBLIC_SUB_DOMAIN	空	平台自带订阅域名，可不填
FORCE_UPDATE	false	是否强制重新下载核心
ko / KO	空	Komari Agent 安装命令
Cloudflare Tunnel 配置

在 Cloudflare Zero Trust 的 Tunnel 里，只需要配置一条 Public Hostname：

Hostname: 你的 ARGO_DOMAIN
Path: *
Service: http://localhost:8001

示例：

Hostname: node.example.com
Path: *
Service: http://localhost:8001

项目内部会按路径自动转发：

/vless-argo   -> VLESS
/vmess-argo   -> VMess
/trojan-argo  -> Trojan
订阅地址
https://你的ARGO_DOMAIN/sub

原始节点：

https://你的ARGO_DOMAIN/sub/raw

如果你设置了 PUBLIC_SUB_DOMAIN，也可以使用平台自带域名访问订阅：

https://你的PUBLIC_SUB_DOMAIN/sub
https://你的PUBLIC_SUB_DOMAIN/sub/raw
节点说明

默认生成三个节点：

VLESS WS TLS
VMess WS TLS
Trojan WS TLS

推荐主力使用：

VLESS WS TLS

路径：

/vless-argo
Komari Agent

如果你已经有 Komari 面板，只需要把官方安装命令填进环境变量 ko 即可。

示例：

ko=wget -qO- https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh | bash -s -- -e https://komari.example.com -t 你的token

容器里一般不需要 sudo。

如果 Komari 面板显示离线，通常是 Komari 安装脚本尝试使用 systemd 启动服务，而容器环境不一定支持 systemd。

Docker 运行示例
docker run -d \
  --name ko \
  --restart unless-stopped \
  -e ARGO_DOMAIN="node.example.com" \
  -e ARGO_AUTH="你的Cloudflare Tunnel Token" \
  -e CFIP="saas.sin.fan" \
  -p 3000:3000 \
  ghcr.io/jkrore/ko:latest
GHCR 镜像

GitHub Actions 构建成功后，镜像地址：

ghcr.io/jkrore/ko:latest
Northflank 使用

Northflank 里部署镜像：

ghcr.io/jkrore/ko:latest

端口：

3000 HTTP Public

环境变量最少填：

ARGO_DOMAIN=你的Cloudflare固定隧道域名
ARGO_AUTH=你的Cloudflare Tunnel Token
CFIP=saas.sin.fan

然后在 Cloudflare Tunnel 里配置：

Path: *
Service: http://localhost:8001
安全提示
不要公开 ARGO_AUTH
不要公开 Komari token
建议自己设置固定 UUID
遵守平台服务条款

---

你现在 GitHub 里 `Dockerfile` 和 `build-docker-image.yml` 被压成一行，所以必须按上面替换。`package.json` 一行虽然能用，但建议也替换成格式化版本。README 可以直接覆盖。
::contentReference[oaicite:0]{index=0}
