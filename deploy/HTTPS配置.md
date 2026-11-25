# ============================================================
#  HTTPS 配置 —— 不用域名也能有地址栏小锁
#
#  场景：服务器在境外（新加坡/香港等），没有域名，
#        想让浏览器地址栏出现 🔒，聊天走 wss://
# ============================================================

## 一、先纠正一个常见误解

网上很多说法是反的，**注意别被带偏**：

| 说法 | 对错 | 正确表述 |
|---|---|---|
| 「服务器在国内不用备案，在国外要备案」 | ❌ **说反了** | **服务器在【国内】才要备案；在【国外】反而不用备案** |
| 「IP + 非标端口可以绕过备案」 | ⚠️ **不准确** | 阿里云官方明确：用域名解析到内地服务器，**哪怕走 8000 端口也仍需备案**。端口不改变备案义务 |

**官方口径**（阿里云备案文档）：

> 备案主要看您的网站或 App 等互联网信息服务**解析到的服务器是否在中国内地（大陆）**。
> 如果服务器在中国内地（大陆），必须完成 ICP 备案才可对外提供服务。
> 如果服务器在中国香港、中国澳门、中国台湾及其他国家和地区，
> **则不需要**进行工信部 ICP 备案。

所以你的情况：

- ✅ **新加坡服务器 → 不需要 ICP 备案**（境外节点，免备案）
- ✅ 用域名解析到新加坡 IP → 同样不需要 ICP 备案
- ⚠️ 唯一要注意的是「**公安联网备案**」，那是境内主体在国内开服务器的额外要求，
  境外节点不涉及

### 你的服务器现状

| 项 | 值 |
|---|---|
| 地域 | 亚太东南 1（新加坡）—— 境外 |
| ICP 备案 | **不需要** ✓ |
| 域名 | 目前没有 |

---

## 二、没域名怎么搞 HTTPS？三条路

| 方案 | 小锁 | 域名 | 费用 | 续期 | 适合 |
|---|---|---|---|---|---|
| **A. Let's Encrypt IP 证书** ⭐ | ✅ | 不需要 | 免费 | 自动（每 3 天检查） | **你的情况** |
| B. 买个域名 + certbot | ✅ | 需要 | ¥30-70/年 | 自动（90 天） | 长期运营 |
| C. Cloudflare 隧道 | ✅ | 赠送的临时域名 | 免费 | 隧道断了就失效 | 临时演示 |

### 为什么方案 A 现在可行了

**Let's Encrypt 于 2026 年 1 月 15 日正式开放 IP 地址证书**。

- 以前：证书只能签给域名，没有域名就没 HTTPS
- 现在：可以直接给公网 IP 签证书，浏览器一样显示小锁

但有两个硬性限制：

| 限制 | 说明 |
|---|---|
| **只能用 shortlived 配置** | 有效期只有 **160 小时（≈ 6.6 天）** |
| **只能用 http-01 / tls-alpn-01 验证** | 所以**必须放行 80 端口**（本方案用 http-01） |

6 天有效期意味着**必须自动续期**，否则证书一过期小锁就变感叹号。
脚本里做了双保险：cron + systemd timer，每天检查一次，剩 3 天就续。

### 签发频率限制

同一组 IP，Let's Encrypt 每 168 小时（7 天）最多签 5 张。
正常续期不受影响（acme.sh 复用同一张证书只换内容），但**反复手动重签**容易撞限。

---

## 三、怎么跑（三条命令）

### 全流程速查

整个过程分 4 个阶段，**每阶段都有明确的验证点**，不要跳着做：

| 阶段 | 动作 | 验证 | 卡住了怎么办 |
|---|---|---|---|
| **1. 放行端口** | 防火墙加 80/443/8000 | 规则列表有 3 条 | 等 1-2 分钟生效 |
| **2. 部署** | clone + deploy.sh | `curl http://IP:8000/chat` 返回 200 | 看 `journalctl -u chat-room` |
| **3. 配 HTTPS** | bash deploy/https-setup.sh | `curl https://IP/chat` 返回 200 | 看 `deploy/HTTPS配置.md` 排查表 |
| **4. 收尾** | **删掉 8000 规则** | 防火墙只剩 80/443 | — |

> **阶段 2 和阶段 3 是分开的**，故意这样设计：
> 先用 HTTP 确认服务活着，再用 HTTPS 升级。混在一起的话，
> 出问题时分不清是「程序没起来」还是「证书没签下来」。

### 第 0 步：控制台放行端口 ⚠️ 必须先做

轻量应用服务器 → 控制台 → 实例 → **防火墙** → **添加规则**，加三条：

| 协议 | 端口 | 授权对象 | 用途 | 后续 |
|---|---|---|---|---|
| TCP | `80` | `0.0.0.0/0` | ACME 签证书验证用 | 保留 |
| TCP | `443` | `0.0.0.0/0` | HTTPS 入口 | 保留 |
| TCP | `8000` | `0.0.0.0/0` | **临时**：HTTP 直连调试 | ⚠️ **装完 HTTPS 后删掉** |

> ECS 的话是 **安全组 → 配置规则 → 入方向** 手动添加。

**为什么要临时开 8000**：部署完到装好 HTTPS 之间有个时间差，
先用 `http://IP:8000/chat` 确认服务真的跑起来了，比等 HTTPS 全套跑完再排查要省事得多。

**为什么最后要删**：装完 HTTPS 后，`https-setup.sh` 会把 Node 改成
**只监听 127.0.0.1**（8000 端口不再对公网监听），
这时 8000 这条防火墙规则**已经没有任何作用**，删掉它只是让规则表更干净、
减少一个对外暴露的端口。

> 也就是说：**8000 规则留着的那段时间里，真正的门禁是「房间口令」。**
> 口令是 12 位随机 hex（48 位熵），暴力猜不现实，但扫描器能看到
> 「这个端口有个 WebSocket 服务在跑」—— 内测阶段流量极小，可接受。
>
> ⚠️ 别忘了删。删的方式：防火墙规则列表里找到 8000 那条，
> 点右边的「删除」→ 确认。

### 第 1 步：装程序（GitHub 拉代码，免传文件）

```bash
mkdir -p /opt/chat-room && cd /opt/chat-room
git clone --depth 1 https://github.com/yayajing1/liaotian-wangye.git app
cd app && bash deploy/deploy.sh
```

> 脚本会**自动识别**「代码就在当前目录」，就地安装，
> 不会重复 clone，也不会把代码和数据目录拆到两个地方。
>
> 也可以一条命令搞定（脚本自己去 GitHub 拉）：
> ```bash
> mkdir -p /opt/chat-room && cd /opt/chat-room
> bash <(curl -fsSL https://raw.githubusercontent.com/yayajing1/liaotian-wangye/main/deploy/deploy.sh) --git https://github.com/yayajing1/liaotian-wangye.git
> ```

**验证阶段 2**（先确认服务活着）：

```bash
# 在你自己的电脑上跑，把 IP 换成实际公网 IP
curl -s -o /dev/null -w "%{http_code}\n" http://<你的IP>:8000/chat
# 期望输出 200
```

浏览器打开 `http://<你的IP>:8000/chat` 能看到聊天室界面，也算通过。

### 第 2 步：配 HTTPS

```bash
cd /opt/chat-room/app
bash deploy/https-setup.sh
```

**验证阶段 3**：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<你的IP>/chat
# 期望输出 200

# 看证书签给谁了 —— 应该出现 IP:xxx
echo | openssl s_client -connect <你的IP>:443 2>/dev/null | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
```

浏览器打开 `https://<你的IP>/chat`，地址栏应该有 🔒。

### 第 3 步：删掉 8000 规则（收尾）

回到阿里云控制台 → 轻量应用服务器 → 实例 → **防火墙** →
找到 8000 那条规则 → 点右边的**「删除」** → 确认。

删完再测一次，确认 HTTPS 仍然通：

```bash
curl -s -o /dev/null -w "HTTPS: %{http_code}\n" https://<你的IP>/chat     # 期望 200
curl -s -o /dev/null -w "HTTP8000: %{http_code}\n" http://<你的IP>:8000/chat  # 期望 000（连不上才对）
```

第二条返回 `000`（连接超时/拒绝）说明 8000 确实已经关闭了 —— 这正是预期结果。

> 也可以在服务器上确认 Node 只监听本机：
> ```bash
> ss -tln | grep 8000
> # 期望看到 127.0.0.1:8000，而不是 0.0.0.0:8000 或 *:8000
> ```

### 第 4 步：发链接给朋友

脚本最后会打印带口令的链接：

```
https://<你的IP>/chat#key=xxxxxxxxxxxx
```

复制这一行发给朋友即可 —— 他点开直接进，地址栏有 🔒，聊天走 wss。

---

## 四、脚本做了什么

`deploy/https-setup.sh` 六步：

| 步骤 | 动作 |
|---|---|
| 0 | 检查 Node 服务在跑；装 Nginx、cron、acme.sh |
| 1 | 探测公网 IP（阿里云元数据 → ipify → ifconfig → 网卡，4 级兜底） |
| 2 | 先起 Nginx 的 80 端口（此时**不跳 HTTPS**，http://IP 先能用） |
| 3 | acme.sh 签 IP 证书（`--certificate-profile shortlived --days 3`） |
| 4 | 装证书到 `/etc/nginx/ssl/chatroom/`，开启 443，80 改成 301 跳 HTTPS |
| 5 | 注册 cron + systemd timer 双保险续期；Node 收回 127.0.0.1 |

### Nginx 配置要点

WebSocket 必须单独配升级头，少了这段**页面能开但消息发不出去**：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # ← 关键
    proxy_set_header Connection "upgrade";        # ← 关键
    proxy_read_timeout 3600s;                     # 长连接别被掐断
}
```

前端 `public/app.js` 已经会自动切换协议：

```js
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
```

所以**不用改任何代码**，上了 HTTPS 就自动走 wss。

---

## 五、常见问题

### Q: 签发失败怎么办

脚本会打印具体原因。对照表：

| 现象 | 原因 | 解决 |
|---|---|---|
| `Timeout during connect` | 80 端口没放行 | 控制台加防火墙规则 |
| `Invalid response from http://IP/.well-known/...` | Nginx 没起来或路径不对 | `nginx -t` 检查；确认 `/var/www/letsencrypt` 存在 |
| `too many certificates already issued` | 撞了频率限制 | 等 168 小时，或先用 `--server letsencrypt_test` 测 |
| `curl` 超时 | 服务器本地防火墙 | `ufw allow 80/tcp` |

### Q: 证书 6 天就过期了会不会断

正常不会。acme.sh 每 3 天检查一次，剩 3 天就自动续，续完自动 `systemctl reload nginx`。

手动查续期状态：

```bash
systemctl status acme-renew.timer      # systemd 兜底
crontab -l | grep acme                 # cron 兜底
~/.acme.sh/acme.sh --renew -d <你的IP>  # 手动续一次
```

**如果续期失败**，小锁会消失，但 http://IP/chat 仍然能用（80 端口保留了反代）。
建议再加一个监控：

```bash
# 加到 crontab，每天检查证书剩余有效期
echo '0 9 * * * [ -f /etc/nginx/ssl/chatroom/fullchain.pem ] && openssl x509 -enddate -noout -in /etc/nginx/ssl/chatroom/fullchain.pem' | crontab -
```

### Q: 6 天证书会不会让浏览器缓存报错

不会。短周期证书反而是为了让密钥泄露能快速失效。
浏览器缓存的是证书链，不是"这张证书永久有效"。

### Q: 以后想买域名了怎么办

域名不是必需品，但有几个好处：

- 证书可以换回 **90 天**的普通配置（不用每 3 天续）
- 以后要换 ECS 内地节点时，**域名必须先完成 ICP 备案**才能解析过去
- 阿里云买域名约 ¥30-70/年

迁移步骤：

```bash
# 1. 域名解析到服务器 IP（A 记录）
# 2. Nginx 里把 server_name _ 改成你的域名
# 3. 换普通证书
certbot --nginx -d your.domain.com
```

### Q: 不用 HTTPS 行不行

行。**内测阶段 HTTP + IP 完全够用**，小锁只是锦上添花。
唯一的实际差异是：浏览器在 HTTPS 页面里会禁止连 `ws://`（混合内容拦截）——
但你们直接访问的是 `http://IP/chat`，页面自己就是 HTTP，不存在这个问题。

### Q: 服务器在境内节点怎么办

那必须先备案。备案流程见阿里云备案系统，7-20 个工作日。
在此期间只能：
- 用 IP + 非标端口临时访问（但**用域名解析到境内 IP 仍需备案**，端口不豁免）
- 或者继续用境外节点

---

## 附：相关文件

| 文件 | 作用 |
|---|---|
| `deploy/https-setup.sh` | HTTPS 装配脚本（可独立运行） |
| `deploy/deploy.sh` | 主部署脚本，`--https` 参数会带上 HTTPS 环节 |
| `deploy/backup.sh` | 数据备份/迁移 |
| `deploy/云服务器部署指南.md` | 完整部署流程（含备案说明） |
