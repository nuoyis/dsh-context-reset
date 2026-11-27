# 发布指南 · @nuoyis/dsh-context-reset

包名已按你的要求定成作用域形式：**npm 上叫 `@nuoyis/dsh-context-reset`，仓库/署名写作 `nuoyis/dsh-context-reset`**。
已核对：`https://registry.npmjs.org/@nuoyis%2Fdsh-context-reset` 返回 404，名字目前是空的。

## 一、发布前必须由你做的事（我不能代做）

`npm publish` 需要你的账号凭据，这一步只能你自己来：

```bash
npm login --registry=https://registry.npmjs.org
# 用户名、密码、邮箱验证码/2FA，走浏览器或 CLI 都行
npm whoami --registry=https://registry.npmjs.org   # 应输出 nuoyis
```

如果你的 npm 用户名不是 `nuoyis`，作用域就不是你的，发布会被拒（`404 Not Found - PUT`）。
那就先改包名（`npm pkg set name=@<你的用户名>/dsh-context-reset`），或去 npm 建一个 `nuoyis` 组织再发。

## 二、一条命令发布

```bash
cd "C:\Users\nuoyi\Documents\deepseek-harness\default-workspace\会话归档\上下文重置插件\dsh-context-reset"

npm pack --dry-run           # 先看会发哪些文件，白名单在 package.json 的 files
npm publish --registry=https://registry.npmjs.org
```

**必须显式写 `--registry`**：本机 `~/.npmrc` 配的是 `registry=https://registry.npmmirror.com`（只读镜像），
往镜像 publish 会 403。包名带 `@nuoyis/` 是 scoped 包，`package.json` 里已写
`"publishConfig": {"access": "public"}`，否则默认私有、装不了。

发布后自检：

```bash
npm view @nuoyis/dsh-context-reset version dist.tarball --registry=https://registry.npmjs.org
```

## 三、用户怎么装

```bash
dsh plugin add @nuoyis/dsh-context-reset          # 从 npm 装（真实目录，推荐）
dsh plugin add <tgz 的绝对路径>                    # 离线
```

不要用「点目录」的方式装：那会装成符号链接，插件按真实路径解析不到 `@deepseek-ai/*`，
激活时报 `ERR_MODULE_NOT_FOUND`。npm 安装则是 profile `node_modules` 下的真实目录。

## 四、真正「被看到」还要上发现渠道

npm 只是仓库，DSH 用户并不会自动发现它。现有三条发现路径（都需要你注册账号后提交，我没有你的账号）：

| 渠道 | 要什么 | 备注 |
|---|---|---|
| GitHub 仓库 + topic `dsh-plugin` | 公开仓库，README 写清装法 | 插件雷达按 topic 抓取，是最省事的一条 |
| dsh.works 注册表 | 可验证的安装路径 + 它对 DSH 版本的核查 | 会记录「验证于哪个 DSH 版本」 |
| dsh.so | 验证等级 + 安全扫描结果 | 条目有 trust 标记，过扫描才有 |

建议顺序：先 GitHub（仓库名就叫 `nuoyis/dsh-context-reset`，与包名对齐），再拿去 dsh.works / dsh.so 提交。
仓库里把 `package.json`、`index.js`、`cordis.patch.yml`、`locale/`、`docs/` 一起推上去，别人能直接读到源码再决定装不装。

## 五、以后升级

```bash
npm version patch     # 或 minor / major；会顺手打 tag、升 version
npm publish --registry=https://registry.npmjs.org
```

- 改 bug、改文案 → `patch`
- 改 `cordis.patch.yml` 的挂载方式、改默认配置语义 → `minor`
- 改事件/工具/命令的名字（老的调用会断）→ `major`

CI 里发的话，用 `NPM_TOKEN` 环境变量 + `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，别把 token 写进文件。

## 六、踩过的坑（都在这台机器上验证过）

1. **镜像 registry**：默认 npmrc 指向 npmmirror，publish 必须 `--registry=https://registry.npmjs.org`。
2. **`private: true`**：会让 `npm publish` 直接拒绝。本地包原本是 private，已为发布移除。
3. **`files` 白名单**：决定的才是发包内容，`npm pack --dry-run` 是最快的核对方式。
4. **目录安装 = 软链接**：插件解析不到 `@deepseek-ai/*`；而且对 link 安装执行 remove 时，
   pnpm 会顺着链接把源码目录清空（我这次就中过，从 tgz 还原的）。发布渠道一律走 npm。
5. **同时装两份**：旧 `dsh-context-reset` 和新 `@nuoyis/dsh-context-reset` 会各注册一份
   `context_save` 和 `/handoff`，先 remove 旧的再装新的。
