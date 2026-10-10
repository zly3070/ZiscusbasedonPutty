# 从零读懂 ziscus —— 带读笔记

> 这份笔记是**边学边记**的产物，按课程顺序累积。
> 目标读者：**没接触过 TypeScript 和网络编程**，但想能自己改代码（目标 b）。
> 每条知识点都锚定到**项目里的真实文件和行号**，不是抽象教程。

---

## 目录

- [第 0 课：环境准备（依赖安装与报红问题）](#第-0-课环境准备)
- [第 1 课：`index.ts` 的骨架 —— 后端编程只有 7 行核心](#第-1-课indexts-的骨架)
- [第 2 课：`types.ts` —— 类型到底是什么](#第-2-课typests--类型到底是什么)
- [待续](#待续)

---

# 第 0 课：环境准备

## 0.1 为什么编辑器里满屏红色波浪线

**现象**：`Request`、`URL`、`Response`、`D1Database` 底下有红波浪线，
鼠标移上去显示「找不到名称 Request」。

**这不是代码错了，是依赖没装。**

### 名字的四个来源（★ 最重要的判断方法）

TypeScript 里出现的每一个名字，都来自下面四类之一：

| 类别 | 例子 | 靠什么拿到 |
|---|---|---|
| ① **语言内置** | `string` `number` `if` `function` | 永远有 |
| ② **运行环境** | `URL` `console` `setTimeout` | `tsconfig.json` 的 `"lib"` |
| ③ **第三方包** | `Request` `Response` `D1Database` `Fetcher` `Ai` | **需要 `pnpm install`** |
| ④ **项目自己** | `Env` `Comment` `RebuildResult` | 本项目的 `types.ts` |

**⭐ 遇到「找不到名称 XXX」时，先问：XXX 属于哪一类？**

- 属于 ③ → **依赖没装**（本次的问题）
- 属于 ④ → 检查 `import` 有没有写、名字有没有拼错
- 属于 ①② → 检查 `tsconfig.json` 的 `lib` / `target`

### 关键认知：波浪线 ≠ 代码不能跑

| | 类型检查（波浪线） | 实际运行 |
|---|---|---|
| 谁在做 | 编辑器 / TypeScript 编译器 | Cloudflare 运行时 |
| 何时 | 你写代码时 | 访客访问时 |
| `Request` 从哪来 | 需要 `.d.ts` 类型文件 | **运行时本来就提供** |
| 报红的后果 | 只是提示 | **完全不影响运行** |

**为什么运行时不需要类型** —— 因为**类型在编译时会被全部擦掉**：

```ts
// 你写的 TypeScript
export function requireAuth(request: Request, env: Env): Response | null {

// 实际跑起来的 JavaScript
export function requireAuth(request, env) {
```

**但波浪线还是要消掉**，因为它让你失去三件东西：

1. **自动补全** —— 打 `request.` 不会弹出可用属性
2. **拼写检查** —— 写成 `request.mthod` 不会被发现
3. **可读性** —— 满屏红线容易误以为代码坏了

### 修复

```powershell
cd C:\Users\asus\Desktop\ZiscusbasedonPutty
pnpm install
```

**为什么在根目录跑**：这是 monorepo，看 `pnpm-workspace.yaml`：

```yaml
packages:
  - worker
  - embed
```

根目录统一管理两个子包的依赖，**一次装好两个**。

**装完后的变化**：

| 变化 | 意义 |
|---|---|
| 出现 `node_modules/` | 依赖就位 |
| 波浪线消失 | 类型找到了 |
| 能跑 `pnpm test` | 项目自带测试终于可跑 |
| 能跑 `pnpm typecheck` | 真正的类型检查 |
| 打 `request.` 有补全 | **对写代码帮助最大** |

## 0.2 网络问题（国内环境必读）

### 症状

```
ETIMEDOUT  request to https://registry.npmjs.org/... failed
```

### 本机的真实状况

```
pnpm 要下载依赖
    ├─→ registry.npmjs.org        ❌ 被墙，超时
    └─→ 系统代理 127.0.0.1:7897
              └─→ 端口没人在听（代理软件没开）
```

**⚠️ 这是个容易误判的状态**：系统设置里 `ProxyEnable = 1`，
但代理软件没运行 —— 比「完全没代理」更麻烦，因为程序会去连死端口然后等超时。

### 两个解决方案

**A. 用国内镜像（最省事）**

```powershell
pnpm install --registry=https://registry.npmmirror.com
```

永久生效：

```powershell
pnpm config set registry https://registry.npmmirror.com
```

**B. 把代理软件开起来**，确认它监听 `7897`（或改系统代理设置指向实际端口）。

**⚠️ 以后能正常用代理了，建议改回官方源**（镜像有时不同步）：

```powershell
pnpm config set registry https://registry.npmjs.org
```

### 怎么自己诊断这类问题

```powershell
# 1. 看系统代理设置
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' |
  Select-Object ProxyEnable, ProxyServer

# 2. 测某个域名通不通
Test-NetConnection registry.npmjs.org -Port 443 -InformationLevel Quiet

# 3. 对比国内镜像
Test-NetConnection registry.npmmirror.com -Port 443 -InformationLevel Quiet
```

---

# 第 1 课：`index.ts` 的骨架

**文件**：`worker/src/index.ts`（433 行，但核心只有最后 7 行）

## 1.1 心智模型：后端 = 一个函数

```
                    访客的浏览器
                         │ ① 发来【请求 Request】
                         ▼
        ┌────────────────────────────────────┐
        │  export default {                  │
        │    async fetch(request, env) {     │  ← ② 这个函数被调用
        │      ...                           │
        │      return new Response(...)      │  ← ⑤ 返回【响应 Response】
        │    }                               │
        │  }                                 │
        └────────────────┬───────────────────┘
                         │ ③ 交给 route() 分诊
                         ▼
                    route() 里一串 if
                    "这个网址该谁处理？"
                         │ ④ 找到对应函数
                         ▼
            handleSubmit / handleGetComments / …
```

**⭐ 记住这一句：**

> **后端编程 = 写一个函数，收到「请求」返回「响应」。**

项目里所有 `handleXxx` 函数都是这个形状，没有例外。

## 1.2 逐行拆解（`index.ts` 第 425-433 行）

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return route(request, env);
    const isAdmin = new URL(request.url).pathname.startsWith("/admin/");
    const res = await route(request, env);
    return addSecurityHeaders(res, isAdmin);
  },
};
```

### 第 2 行的四块信息

```ts
async  fetch  (  request: Request ,  env: Env  )  :  Promise<Response>  {
 ↑      ↑         ↑        ↑           ↑    ↑         ↑
 ①      ②         ③        ④           ⑤    ⑥         ⑦
```

| # | 代码 | 意思 |
|---|---|---|
| ① | `async` | 「这个函数里会有 `await`」 |
| ② | `fetch` | **函数名，Cloudflare 规定的，不能改** |
| ③ | `request` | 参数名，装着访客的请求 |
| ④ | `: Request` | **类型标注，运行时不存在** |
| ⑤ | `env` | 参数名，装着所有外部资源 |
| ⑥ | `: Env` | 类型标注（`Env` 定义在 `types.ts`） |
| ⑦ | `: Promise<Response>` | 返回一个 Response，但要等一下 |

**⭐ 读代码的技巧：把 ④⑥⑦ 全部划掉，剩下的就是真正运行的东西。**

### 三个语法点

| 写法 | 含义 | 注意 |
|---|---|---|
| `a.b` | 取 `a` 里面的 `b` | 点号 = 「里面的」 |
| `===` | 判断相等 | ⚠️ **三个等号**。`==` 会做类型转换，坑多，别用 |
| `return` | 立刻返回，函数结束 | 后面的代码**不再执行** |

**⭐ 「提前 return」是后端代码最常见的写法** —— 用来一层层筛掉不需要处理的请求。
`route()` 里有几十个这样的 `if`。

### `new URL(...)` 在干什么

```ts
const isAdmin = new URL(request.url).pathname.startsWith("/admin/");
```

| 部分 | 意思 |
|---|---|
| `const isAdmin` | 声明变量（不能重新赋值；`let` 可以） |
| `new URL(...)` | 造一个 URL 对象 |
| `request.url` | 完整网址，如 `https://x.com/admin/stats?limit=5` |
| `.pathname` | **只取路径部分** → `/admin/stats` |
| `.startsWith("/admin/")` | 判断是否以某段文字开头 → `true` / `false` |

**自己试试**（浏览器 F12 → Console）：

```js
new URL("https://x.com/admin/stats?limit=5").pathname
```

### `await` 为什么必须写

```ts
const res = await route(request, env);
```

```
1. 调用 route(request, env)
2. route 要查数据库、干很多事 —— 需要时间
3. await = 「我在这里等它算完」
4. 算完后，结果存进 res
```

**⚠️ `route()` 是 `async` 函数，不会立刻给结果，而是给一个「将来会有结果」的凭证。
`await` 就是「等凭证兑现」。**

**实用规则（先记这个）：**

> **看到 `async` 函数，调用它就要 `await`。**

## 1.3 现在可以跳过什么

**读代码的一半能力在于「知道什么可以先跳过」。**

| 位置 | 内容 | 为什么跳过 |
|---|---|---|
| 第 3-150 行 | `dashboardRedirect`、`addSecurityHeaders` 实现 | 工具函数，用时知道「它加工响应」即可 |
| 第 153-193 行 | 路由表大注释 | 当字典查 |
| 第 194-410 行 | `route()` 里几十个 `if` | **结构完全一样**，认一个就会认全部 |
| 所有 `try / catch` | 错误处理 | 后面单独讲 |

**⭐ 读代码不是从第一行读到最后一行，而是先找骨架，再按需深入。**

## 1.4 HTTP 状态码速查

| 码 | 意思 | 什么时候用 |
|---|---|---|
| **200** | 成功 | 正常返回内容 |
| **302** | 临时跳转 | 让浏览器换地址 |
| **303** | 跳转（方法变 GET） | **表单提交后跳转（本项目大量用）** |
| **401** | 没认证 | 密码不对 |
| **403** | 禁止 | 不允许这么做 |
| **404** | 找不到 | 没有这个页面 |
| **500** | 服务器出错 | 代码崩了 |

## 1.5 改动任务 ①：首页跳转到管理面板

**改哪里**：`worker/src/index.ts` 的 `route` 函数（第 194 行附近），
插在 `route()` 的**最前面**：

```ts
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // ★★★ 插入这三行 ★★★
  // 首页直接跳到管理面板
  if (path === "/" && request.method === "GET") {
    return new Response(null, { status: 302, headers: { Location: "/admin/dashboard" } });
  }

  // CORS 预检
  if (request.method === "OPTIONS") {
```

**逐行解释**：

```ts
if (path === "/" && request.method === "GET") {
```
| 部分 | 意思 |
|---|---|
| `path === "/"` | 路径正好是首页 |
| `&&` | 「并且」，两边都真才成立 |
| `request.method === "GET"` | 这是普通访问，不是提交表单 |

```ts
return new Response(null, { status: 302, headers: { Location: "/admin/dashboard" } });
```
| 部分 | 意思 |
|---|---|
| `new Response(...)` | 造一个响应 |
| `null` | 响应内容。跳转不需要内容 |
| `{ status: 302 }` | 302 = 临时跳转 |
| `{ Location: ... }` | **跳转的暗号**，告诉浏览器去这个地址 |

**⚠️ 两个提醒**：

1. **位置重要** —— 必须插在最前面。`if` 从上往下判断，插在后面的 `if` 底下就永远轮不到
2. **改完要验证**：

```powershell
node --experimental-vm-modules notes/tscheck.mjs worker/src/index.ts
```

看到 `✓` 就说明语法没写坏。

---

# 第 2 课：`types.ts` —— 类型到底是什么

**文件**：`worker/src/types.ts`

**这个文件没有任何逻辑** —— 没有 `if`、没有计算、没有函数。
它只做一件事：**告诉 TypeScript「一个东西应该长什么样」**。

## 2.1 `interface` = 描述形状

```ts
export interface Env {      // ← 「我要描述一种叫 Env 的东西」
  DB: D1Database;           // ← 「它有一个属性叫 DB，类型是 D1Database」
  ASSETS?: Fetcher;         // ← 「它有一个【可选】属性 ASSETS」
  ADMIN_SECRET?: string;    // ← ← 你问的 D1Database 就在这里被用到
  MODERATION: string;       // ← 「这个一定要有」
  RATE_LIMIT?: string;
}
```

| 写法 | 意思 | 大白话 |
|---|---|---|
| `DB: D1Database` | 属性 `DB`，类型 `D1Database` | 「DB 是个数据库」 |
| `ASSETS?: Fetcher` | **`?` = 可选** | 「可能有，也可能没有」 |
| `MODERATION: string` | 没有 `?` = 必需 | 「一定要有」 |

## 2.2 ⭐ `?` 是理解这个项目的关键

**回忆学到的东西**：

```ts
if (!env.AI_MOD) return "approve";        // classify.ts
if (!env.ASSETS) return redirect(...);    // html-rewriter.ts
if (!env.ADMIN_SECRET) return 401;        // auth.ts
```

**这些检查存在的唯一原因，就是这些属性标了 `?`。**

**对照表**：

| 属性 | 有 `?` 吗 | 代码里有判空吗 |
|---|---|---|
| `ASSETS?: Fetcher` | ✅ 可选 | ✅ `if (!env.ASSETS)` |
| `AI_MOD?: Ai` | ✅ 可选 | ✅ `if (!env.AI_MOD)` |
| `ADMIN_SECRET?: string` | ✅ 可选 | ✅ `if (!env.ADMIN_SECRET)` |
| `MODERATION: string` | ❌ 必需 | ❌ 直接用 |
| `DB: D1Database` | ❌ 必需 | ❌ 直接用 |

**⭐ 规律：**

> **标了 `?` 的，代码里就必须判空。**
> **没标 `?` 的，代码就放心直接用。**

**这就是类型系统的价值** —— 它把「这个值可能没有」写在代码里，而不是靠记忆。

## 2.3 改动任务 ②：加一个新配置项

在 `Env` 接口里加一行：

```ts
  /** 页面上最多显示多少条评论（默认 200） */
  MAX_COMMENTS_DISPLAY?: string;
```

**加完观察**：

1. 保存后有没有波浪线？（应该没有）
2. **思考**：这个属性带了 `?`，用它的时候需不需要判空？

**答案**：需要。因为标了可选，TypeScript 会强制你处理「可能没有」的情况 ——
**这正是类型系统的保护作用。**

---

# 待续

## 后续课程计划

| 课 | 文件 | 会学到 | 改动任务 |
|---|---|---|---|
| 3 | `worker/src/html.ts` | 纯函数、字符串处理、正则 | 加一个转义字符 |
| 4 | `worker/src/auth.ts` | 请求头、401 | 加一个备用密码 |
| 5 | `worker/src/structural-filter.ts` | 正则、数组遍历、`if` 链 | 加一条过滤规则 |
| 6 | `worker/src/rate-limit.ts` | 第一次碰 SQL、原子操作 | 改限流次数 |
| 7 | `worker/src/submit.ts` | 主流程串联 | 改提交后的跳转 |
| 8 | 回到 `worker/src/index.ts` | 此时能全看懂 | 加一个新端点 |

## 常用命令速查

```powershell
# 语法检查（人家写的检查器）
node --experimental-vm-modules notes/tscheck.mjs worker/src/index.ts

# 装依赖（国内镜像）
pnpm install --registry=https://registry.npmmirror.com

# 跑测试（需要先装依赖）
pnpm test

# 类型检查（需要先装依赖，比 tscheck 严格）
pnpm typecheck
```

## 人家为这个项目留下的辅助文件

| 文件 | 用途 |
|---|---|
| `notes/tscheck.mjs` | TS 语法 + 模块可加载性检查器 |
| `notes/verify-html-escape.mjs` | 验证 HTML 转义行为 |
| `notes/verify-unescape-step-by-step.mjs` | 逐步观察 `&amp;lt;` 怎么被解码 |
| `notes/verify-unescape-rule-order.mjs` | 穷举 120 种规则顺序，验证 `&amp;` 必须最后解 |
