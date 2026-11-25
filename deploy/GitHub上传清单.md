# 上传到 GitHub —— 操作清单

> 本地仓库已完全就绪，只剩浏览器里 2 个动作。

---

## ✅ 已完成的事（不用你管）

| 项 | 状态 |
|---|---|
| git 仓库初始化 | ✅ 分支 `main` |
| `.gitignore` | ✅ 排除 `data/`、`room.key`、`share-link.txt`、`node_modules/` 等敏感文件 |
| `.gitattributes` | ✅ 锁定 shell 脚本为 LF，保证 Linux 上能直接执行 |
| `LICENSE` | ✅ MIT |
| 首次提交 | ✅ `374a367`，27 个文件，6981 行 |
| 提交身份 | ✅ `yayajing1 <yayajing1@users.noreply.github.com>` |
| 远程地址 | ✅ `git@github.com:yayajing1/liaotian-wangye.git` |
| SSH config | ✅ `~/.ssh/config` 已配好 github.com 条目 |
| 克隆验证 | ✅ clone 后 `npm ci` → 服务启动 → 口令自动生成 → 页面 200 |

**已确认仓库里没有任何敏感内容**：聊天记录、房间口令、分享链接、依赖目录全部排除在外。

**你的账号已核实**：`yayajing1`（2026-10-09 注册），`liaotian-wangye` 这个名字**没有被占用**。

---

## 第 1 步：添加 SSH 公钥（必做，现在还没加）

我查过 GitHub API：你的账号 `yayajing1` 的 **SSH keys 列表是空的**，所以推送会失败。

### 复制公钥

打开这个文件，全选复制（一整行，别漏开头结尾）：

```
C:\Users\31217\.ssh\id_ed25519.pub
```

内容是：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMQ0AYTQVP6pmYxKmQMp4QWucBvnkctdArZCcYFqzjPV yayajing1@github-powercontext
```

### 添加

1. 打开 **https://github.com/settings/keys**
2. 右上角 **New SSH key**
3. 填：

| 框 | 填什么 |
|---|---|
| Title | `我的电脑` （随便写，方便自己认出来） |
| Key | 上面那整行 |
| Key type | Authentication Key（默认就是） |

4. **Add SSH key** → 可能要输一次密码 → 确认

> 💡 **为什么需要这一步**：SSH 推送靠的是"你的公钥在 GitHub 注册过"。
> 你之前推 OceanBase 项目用的应该是同一把钥匙，但那个账号下没有这把 ——
> GitHub **每把钥匙绑定一个账号**，所以要在 `yayajing1` 下重新添加一次。

---

## 第 2 步：建仓库

1. 打开 **https://github.com/new**
2. 填：

| 项 | 填什么 |
|---|---|
| Owner | `yayajing1`（自动带出） |
| Repository name | `liaotian-wangye` |
| Description | `多人网页聊天室：WebSocket 实时聊天，SQLite 持久化，无需注册登录` |
| Visibility | **Public** |
| ❌ 不要勾 | README / .gitignore / License（**我们已建好，勾了会冲突**） |

3. 点 **Create repository**

---

## 第 3 步：回来告诉我

做完跟我说一声，我会：
1. 验证 SSH 连接通了
2. 推送代码
3. 核对 GitHub 上的文件和本地一致
4. **再确认一遍没有敏感文件被传上去**

---

## 卡住了怎么办

| 提示 | 原因和解决 |
|---|---|
| `Permission denied (publickey)` | 公钥没加成功。回第 1 步，确认复制的是**完整一行**（112 字节），中间没断行 |
| `remote origin already exists` | 已经有远程地址了，不影响，忽略 |
| 推送时问密码 | 说明 SSH 没走通，说明第 1 步没成功 |
| `refusing to merge unrelated histories` | 远程仓库里已有内容。告诉我，我用 `--allow-unrelated-histories` 处理 |
| 推送成功但仓库是空的 | 不可能。推送成功就一定有文件，我会帮你核对 |
