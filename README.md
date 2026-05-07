# ko-main

基于 [eooce/nodejs-argo](https://github.com/eooce/nodejs-argo) 的极致精简版。专为免费 PaaS 容器设计。

## 架构

```
客户端 ← TLS → Cloudflare CDN ← CF Tunnel → cloudflared → Xray VLESS-WS (:8001) → 目标

Node.js Express (:3000) → 仅提供网页伪装 + 订阅
```

- Node 不参与数据转发
- cloudflared 直连 Xray
- 仅 VLESS 单协议

## 必填环境变量

```bash
UUID=你的UUID            # 必须设置，无默认值
ARGO_AUTH=你的Token或JSON  # 必须设置，不支持临时隧道
ARGO_DOMAIN=你的隧道域名   # 固定隧道域名
```

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Node.js 网页/订阅端口 |
| `ARGO_PORT` | `8001` | Xray VLESS 监听端口（127.0.0.1） |
| `ARGO_PROTOCOL` | `http2` | cloudflared 协议，可选 `http2` / `quic` |
| `CFIP` | `saas.sin.fan` | 优选 IP / 优选域名 |
| `CFPORT` | `443` | 节点端口 |
| `NAME` | `Vls` | 节点名称 |
| `SUB_PATH` | UUID 的 MD5 前 8 位 | 订阅路径（不设置则自动随机） |
| `FILE_PATH` | `.tmp` | 运行目录 |
| `FP` | `chrome` | TLS fingerprint |
| `EDGE_IP_VERSION` | `auto` | cloudflared edge IP 版本 |

## 订阅

```
https://你的平台域名:3000/{SUB_PATH}
```

`SUB_PATH` 默认不是 `/sub`，而是基于 UUID 自动生成的 8 位随机路径。启动日志会打印实际路径。也可以通过环境变量 `SUB_PATH` 自定义。

**订阅不写磁盘**，内容缓存在内存中。

## 安全特性

| 特性 | 说明 |
| --- | --- |
| UUID 无默认值 | 必须手动设置，不提供公开默认值 |
| ARGO_AUTH 必填 | 不支持临时隧道，避免暴露 trycloudflare 特征 |
| 文件名全随机化 | 二进制、配置文件名均为 8 位随机字母 |
| 15 秒阅后即焚 | 启动后清除所有二进制和配置文件 |
| 启动时清理残留 | 容器重启后先清除上次运行痕迹 |
| Nginx 404 伪装 | 首页返回标准 nginx/1.27.3 的 404 页面 |
| Express 指纹移除 | 全局禁用 `X-Powered-By`，Server 头伪装为 nginx |
| 订阅不留盘 | sub.txt 不写磁盘，纯内存缓存 |
| 日志极简 | Xray `loglevel: none`，cloudflared `--loglevel fatal` |
| V8 内存限制 | `--max-old-space-size=64` |

## 稳定特性

| 特性 | 说明 |
| --- | --- |
| 子进程退出 → exit(1) | 交给平台自动重启容器 |
| 启动失败 → exit(1) | 不在错误状态下空转 |
| uncaughtException → exit(1) | 未知异常直接重启 |
| unhandledRejection → exit(1) | Promise 异常直接重启 |
| SIGTERM/SIGINT | 优雅关闭子进程 |
| 内置防休眠 | 4-8 分钟随机自保活 |

## VLESS 节点参数

```
address = CFIP
port    = CFPORT
uuid    = UUID
encryption = none
security   = tls
sni   = ARGO_DOMAIN
fp    = FP (默认 chrome)
type  = ws
host  = ARGO_DOMAIN
path  = /vless-argo?ed=2560
```

## Cloudflare Dashboard 配置

```
Hostname: 你的 ARGO_DOMAIN
Service:  http://localhost:8001
```

## Docker

```bash
docker build -t ko .
docker run -d --name ko \
  -p 3000:3000 \
  -e UUID="你的UUID" \
  -e ARGO_DOMAIN="argo.example.com" \
  -e ARGO_AUTH="你的Token" \
  -e CFIP="saas.sin.fan" \
  ko
```

## 安全提示

- **UUID** 必须自己生成，不要使用他人的
- 不要公开 `ARGO_AUTH`
- 遵守 Cloudflare 和部署平台的服务条款
