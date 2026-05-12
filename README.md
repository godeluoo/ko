# ko-vip

自动编译 [sing-box](https://github.com/SagerNet/sing-box) 和 [cloudflared](https://github.com/cloudflare/cloudflared) 二进制文件，供 ko 主项目下载使用。

## 用途

通过 GitHub Actions 自动拉取上游最新 Release 源码，编译为精简版二进制，并以固定文件名发布到 Release，方便 ko 主项目通过稳定 URL 下载。

## 编译产出

| 文件名 | 对应程序 | 架构 |
|--------|----------|------|
| `web-linux-amd64` | sing-box | linux/amd64 |
| `web-linux-arm64` | sing-box | linux/arm64 |
| `bot-linux-amd64` | cloudflared | linux/amd64 |
| `bot-linux-arm64` | cloudflared | linux/arm64 |

## 触发方式

- **手动触发**：`workflow_dispatch`，可在 Actions 页面手动运行
- **定时触发**：每周一 UTC 02:00 自动执行（`cron: '0 2 * * 1'`）

## 编译参数与优化

| 参数 | 说明 |
|------|------|
| `CGO_ENABLED=0` | 纯静态编译，无 C 依赖，兼容所有 Linux 环境 |
| `-trimpath` | 移除编译路径信息，消除本地路径泄露 |
| `-ldflags="-s -w -buildid="` | 剥离符号表和调试信息，清空 buildid |
| `-tags "with_utls"` | sing-box 启用 uTLS 指纹伪装支持 |
| UPX `--best --lzma` | 极限压缩，大幅缩减二进制体积 |

## 在 ko 主项目中引用

Release 下载地址格式：

```
https://github.com/godeluoo1/ko-vip/releases/latest/download/web-linux-amd64
https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-amd64
```

通过 `/releases/latest/download/` 路径始终指向最新编译版本，无需手动更新 URL。

## 为什么要自编译

- **唯一 Hash 防指纹**：每次编译产出的二进制 Hash 唯一，避免与官方发布版相同被特征识别
- **精简体积快速启动**：剥离调试信息 + UPX 压缩，体积更小，部署下载更快
- **最新版安全修复**：自动跟踪上游最新 Release，第一时间获取安全补丁和新功能
