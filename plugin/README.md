# dsh-plugin-session-cleaner

给 DeepSeek Harness 桌面版 / Web 版补上**删除会话**的能力。

DSH 本身没有任何删除会话的途径：`sessionPersistence` 只有 `create/open/stat/list`，`sessionController` 没有 delete，侧边栏会话菜单只有 pin / rename / fork / archive，连官方「删除工作区」的文案都写着「会话记录会保留」。本插件补上这个缺口，并把删除做彻底。

## 它删什么

删一个会话时，以下位置会被一并清除：

| 位置 | 内容 |
|---|---|
| `~/.dsh/sessions/<工作区slug>/<sessionId>/` | 会话日志 `session.vN.jsonl.zstd`（唯一真相） |
| `~/.dsh/storages/session_projcache/sessions/<sessionId>.json` | 投影缓存 |
| `~/.dsh/storages/workspace.json` | 该 id 在 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds` 中的引用 |
| `~/.dsh/storages/*.db` | 派生搜索索引（存在且无法再对齐时整体移除，下次搜索自动重建） |

**它不碰**：`.credentials.yaml`、`settings.yaml`、`.anonymous-user-id`、`AGENTS.md`、`.env`、`skills/`、`profiles/`、`dsh-runtimes/`，以及工作区注册表里的工作区本身。

## 界面

以下为示意图（演示数据，非真实会话）：

![侧边栏会话菜单中的「删除会话」](screenshots/menu.png)

![删除前的确认弹窗](screenshots/confirm-dialog.png)

![设置 → 插件中的批量清理面板](screenshots/settings-panel.png)

## 三个入口

1. **侧边栏 · 会话「…」菜单 → 「删除会话」**（排在官方「归档」之后，order 500）。点击后弹确认框，显示会话标题、将要释放的空间、以及是否包含派生子代理会话。
2. **设置 → 插件 → 「会话清理」页**：列出磁盘上的全部会话（id / 工作区 / 大小，子代理会话带标记），支持按 id、工作区或路径筛选，全选后批量删除，删除前列出数量与总大小再确认。勾选主会话会自动带上其派生的子代理会话（Host 删除时它们本就会一并删除，勾选集合与实际删除闭包保持一致，取消勾选同理向上传播）。
3. **模型 Tool `session_delete`**：默认 `dryRun: true` 只列清单，必须显式传 `dryRun: false` 才真删。

## 安全设计

- **不可撤销**。DSH 没有回收站、没有软删除层、本插件不做备份。确认框会明确写这一点。
- **三重路径校验**：会话 id 必须匹配 DSH 的 id 语法；磁盘上的目录名必须与该 id 完全相等；规范化后的绝对路径必须落在 `sessions/` 或 `storages/` 之内。任一条不通过就整条跳过并记录原因，绝不猜、绝不越界。
- **不能删除当前打开的会话**：UI 禁用入口，Host 侧独立再拒一次（`guard` 参数），Tool 也拒绝把自己所在的会话作为目标。
- **运行中的会话先停止再删**：否则内存里的 Agent 会继续往刚删掉的日志追加写入，残留一个半截会话。若在超时内无法停止，**整个操作中止，一个文件都不删**。
- **递归删除子代理会话**：通过日志头部的 `parentSession` 字段展开全部后代，避免产生永远无法访问的孤儿数据。
- **先摘注册表、后删文件**，并且计划中的注册表引用先摘除，保证界面不会出现「看得见、点开报错」的空壳行。

## 安装

DSH 的 profile 使用 pnpm 的 `file:` 依赖 + `dsh.profile.bundles` 声明：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-plugin-session-cleaner": "file:<本仓库的克隆路径>\\plugin" },
  "dsh": { "profile": { "bundles": [ /* ... */, "dsh-plugin-session-cleaner" ] } }
}
```

**安装后需要重启 DSH**：插件行在 Loader 配置中会先显示为 `absent`，只有重启才会激活（Host 侧与客户端 bundle 都是如此）。

原因不是配置未生效，而是 Node 对 ESM 模块按 URL 永久缓存：同一进程内即便重新启用该条目，`import()` 仍会拿到首次求值的那个模块实例。因此**修改已安装的插件代码后必须重启**，`set_plugin` 的禁用/启用不足以让改动生效。

## 开发

```sh
node build/client.mjs                          # 构建 lib/
node --test tests/cleaner.test.mjs \
           tests/plugin.test.mjs \
           tests/client.test.mjs               # 31 个测试
```

`build/client.mjs` 是一个零依赖的极简打包器：DSH 的客户端模块系统每个包只加载**一个自包含的 `client.js`**（entry 与 chunk 之间不能同步 require 另一个相对 `client*.js`），所以相对 require 被内联，React / react-dom 则保留为平台模块请求，由 shell 冻结的模块表应答。

`tests/verify-dry-run.mjs` 与 `tests/verify-delete.mjs` 用于对**真实**数据根做端到端验证，前者只预览、后者执行删除。

## 沙箱验证

首次安装曾导致桌面版启动崩溃，根因与修复都在隔离的沙箱数据根（`DSH_HOME` 指向独立目录 + `dsh sb --port 0 --no-open`，不碰真实 profile）里复现并验证过。沙箱目录含会话日志，**不随仓库分发**：

| 缺陷 | 症状 | 修复 |
|---|---|---|
| `package.json` 声明 `./typert` 导出但没有该文件 | typert-loader 导入失败 → **插件条目激活失败**（桌面版对此反应为崩溃重启并回滚 bundles） | 新增 `src/typert.host.js` + 构建生成 `lib/typert.host.js` |
| 契约用 `src-json` 编解码器 | typert-loader 拒绝：所有 codec（参数与结果）**必须是 strict** | strict + `typeSymbol` + 透传 `create()`（网关只调 `.parse()`，鸭子类型即可，无需 zod） |
| Host 侧调用 `remote.$mount()` | 向 Host 网关注册了无记录的描述符 | 移除——挂载是**客户端**的职责（与 whale-pet 一致） |
| 客户端 bundle 输出 `module.exports = ...` | 浏览器模块系统无法注册 | 改为官方格式 `window.__ModuleLoader__.load({id, factory})` |
| 曾把 `dsh.client.inject` 和插件对象的 `inject: ['slots']` 当作"不必要的组合依赖"删掉 | **菜单项与设置页永不出现**，界面与控制台都没有任何报错：客户端 factory 在 shell 发布 `slots` 服务之前执行 `ctx.slots.inject`，抛出的 TypeError 被空 `catch` 吞掉 | 两者都恢复（见下） |

修复后沙箱验证全过：冷启动**零警告**、bundle 以正确格式服务（HTTP 200，含菜单/设置页 slot、内联契约、中文文案）、**热重载存活**（运行中改 profile package.json 不再影响宿主）。

## 客户端插件必须对齐的五处约定

DSH 的客户端插件是惰性物化的，而且失败大多**无声**。下面三处都得自己声明清楚。

### 1. 服务依赖：等 `slots` 发布，`remote`/`typert` 必须显式声明

```js
// client.js — 插件对象上的服务依赖：apply 会一直等到这些服务就位
return { name: 'sessionCleanerClient', inject: ['slots', 'locale', 'remote', 'typert'], apply(ctx) { /* ... */ } }
```

缺 `slots` 时，factory 会在 shell 发布服务之前执行 `ctx.slots.inject`，抛出的 TypeError 被空 `catch` 吞掉——菜单项和设置页**永不出现**，界面与控制台都没有任何提示。`locale` 是下面第 3 条要用的服务。

**`remote` 与 `typert` 同理且更隐蔽**：Cordis 的 context 是代理，读取未在 `inject` 里声明的服务属性会直接抛 `cannot get property "remote" without inject`。曾经这两项漏声明，`acquire()` 里的 `.catch(() => undefined)` 把异常整个吞掉，于是确认弹窗永远停在「正在统计将要删除的内容…」、「永久删除」永远禁用——Host 服务、契约、slot 全都正常，坏在这一行读取上。`typert` 也是必需的：`$mount()` 内部通过**调用方**的 context 走 `callerCtx.typert.remotes.register(...)`，缺了它挂载必炸。

### 1b. namespace 服务要用组合键读取

`$mount()` 之后，每个 namespace 由 Gateway 以 `remoteServiceKey(namespace)`（即 `` `remote.${namespace}` ``）注册成一个 Cordis Service，实例挂在 context 的**同名属性**上。所以动态注入拿到 scope 后要读 `scope['remote.sessionCleaner']`——写成 `scope.remote.sessionCleaner` 是在 Remote 管理器对象上找子属性，永远是 `undefined`，且不抛任何错误。另外 `$mount()` 成功后**不得重试**：Typert Remote store 按包名登记，第二次注册直接抛 `already registered`；只有失败的挂载可以重试。

### 2. 客户端模块的激活顺序

```jsonc
// package.json — 列表里只能是真实存在且已启用的客户端包
"dsh": { "client": {
  "platform": "web",
  "immediately": true,
  "inject": ["@deepseek-ai/dsh-client-ui-workspace", "@deepseek-ai/dsh-client-ui-settings"]
}}
```

`dsh.client.inject` 只决定激活顺序（`immediately` 在浏览器侧目前并未被消费）。组合阶段会**拒绝"缺失提供方"**，因此写错包名会让整张启动图失败，比不写更糟——加包名之前先用 `tools/asar-read.mjs` 确认它出现在 `@deepseek-ai/dsh-web-app/cordis.patch.yml` 里，并且自带 `dsh.client.platform: web`。

### 3. slot 传进来的 props 不能猜，菜单行要用官方的 `MenuItemButton`

菜单行不要自己写 `<button>`：官方 pin/rename/fork/archive 行全部渲染自 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton`（隐式 baseline external——Module Loader lane 的 `require` 直接解析它，不要打包副本），自带宿主字体、行距、hover 与键盘走查；图标用同一包的 `Icon*OutlineRegular` 系列（如 `IconTrashOutlineRegular`，默认 16px 与其他行一致）。自己写的按钮字体、对齐、间距都与官方行不一致。

```js
// factory(require) 顶部；失败时回退普通按钮，行仍然可用
let MenuItemButton, IconTrashOutlineRegular
try {
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  ;({ MenuItemButton, IconTrashOutlineRegular } = primitives)
} catch { /* stand-alone stubs */ }

// 行内：icon 占图标槽，children 是标签
React.createElement(MenuItemButton, { icon: React.createElement(IconTrashOutlineRegular), onSelect }, t('menu.delete'))
```

`sidebar.workspaces.session.menu.item` 的条目只收到 `sessionId` 与 `displayTitle`，外加一个 **slot 级 hook**：

```js
const [, setMenuOpen] = props.useMenuOpenState()   // 返回 [open, setOpen] 元组
setMenuOpen(false)
```

把这个 hook 的返回值当函数调用（`closeMenu()`）会在点击时抛 TypeError，`setOpen(true)` 永远执行不到——**菜单项看得见，点了毫无反应**。

当前语言取自 locale 快照的 `active` 字段（不是 `id` / `locale`）：

```js
const snapshot = ctx.locale?.getLocale?.()        // { active, locales, revision }
const id = typeof snapshot.active === 'string' ? snapshot.active : snapshot.active?.id
```

### 4. 对话框不能住在菜单项里

菜单条目是**随菜单存亡**的：点击它会关闭菜单，而条目在同一次提交里就被卸载。把确认框渲染在条目内部（哪怕用 `createPortal` 挂到 `document.body`），它会在画出来之前被丢掉——**菜单项看得见，点了毫无反应**，控制台也不会有任何错误。

正确做法是拆成两半：条目只关闭菜单并**发出请求**，对话框交给常驻的 `shell.overlay` 条目渲染。官方包的重命名、停止并归档对话框都是这个结构（`@deepseek-ai/dsh-client-ui-workspace/README.zh.md`：「浮层也自己带……注册在 `shell.overlay` 的条目」）。

```js
// 菜单条目：只发请求，不持有对话框状态
onClick: () => { setMenuOpen(false); store.request(sessionId, displayTitle) }

// 常驻条目：frame-wide，菜单关了它还在
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'session-cleaner.confirm', order: 90,
}, ConfirmDialog))
```

两个配套细节：`shell.overlay` 的容器通常关闭命中测试（`pointer-events: none`），对话框要显式声明 `pointerEvents: 'auto'`；条目空闲时渲染一个隐藏节点而不是 `null`，免得被当作"没有条目"。

### 改完必须重启

Host 把每个包的 `dsh.client` 元数据缓存在内存里**直到重启**；禁用/启用条目不足以让它重新读取，`lib/client.js` 的新产物也不会被重新组合。

权威写法见 DSH 内置 `cordis-plugin-development` skill 的 `templates/decoration/{package.json,client.js}`，以及 `@deepseek-ai/dsh-client-ui-workspace/README.zh.md` 的「Session 行 action」一节。桌面版里它们都在 `app.asar` 内，用 `tools/asar-read.mjs` 取出来。

## 结构

```
plugin/
├─ src/
│  ├─ cleaner.js      纯逻辑：扫描、级联展开、路径校验、注册表摘除、计划与执行
│  ├─ index.js        Host 插件：服务、Remote 绑定、Tool 注册、会话停止
│  ├─ contract.cjs    Remote 契约（CJS，两半共用，strict 编解码器）
│  ├─ typert.host.js  typert 严格反射（typert-loader 按 ./typert 约定加载）
│  └─ remote.js       Host 侧的契约入口
├─ client/            Web 客户端源码（菜单项 + 确认弹窗 + 设置页批量面板）
├─ build/client.mjs   构建（lib/ 转发 + 客户端单文件打包）
├─ lib/               构建产物
├─ locale/            中英文案
└─ tests/             单元与集成测试
```

Host 侧**不静态导入任何 `@deepseek-ai/*` 包**：profile 中的这些条目有一部分是无法解析的断链，静态依赖会让插件在加载时直接失败。所需能力全部通过 Cordis 上下文注入获得。
