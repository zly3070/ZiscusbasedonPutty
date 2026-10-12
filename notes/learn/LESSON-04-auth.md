# 第 4 课：`auth.ts` —— 请求头、以及"3 行代码里的三个决定"

> 文件：`worker/src/auth.ts`（**52 行，但其中 44 行是注释；真代码只有 8 行**）
> 前置：第 1 课（Request/Response）、第 2 课（类型、`?` 可选）、第 3 课（读纯函数）

---

## 4.0 为什么这个"最短的文件"值得单独一课

**真正的代码只有这几行：**

```ts
export function requireAuth(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });
  const auth = request.headers.get("Authorization");
  if (auth === `Bearer ${env.ADMIN_SECRET}`) return null;
  return new Response("Unauthorized", { status: 401 });
}
```

**但它做了三个"有取舍的决定"，每一个都值得理解：**

| #   | 决定                          | 为什么重要                                 |
| --- | ----------------------------- | ------------------------------------------ |
| 1   | 密码走 **请求头**，不走网址   | 网址会泄露到历史、日志、Referer            |
| 2   | 返回值是 **`Response \| null`** | 一种很顺手的错误处理约定                   |
| 3   | **没配置密钥时【锁死】**      | 保守优先于方便 —— 这是安全意识             |

**⭐ 而第 3 条，人家在本课里【实测】发现它是一句【没有测试保护】的安全关键代码。**
**详见 4.8 —— 那是这一课最值钱的部分。**

---

## 4.1 新概念：请求头（Request Headers）

**第 1 课说过：后端 = 一个函数，收 `Request` 返 `Response`。**

**`Request` 里装的东西，除了"方法"和"网址"，还有一组"请求头"：**

```
POST /submit HTTP/1.1
Host: example.com
Content-Type: application/x-www-form-urlencoded
Origin: https://myblog.com
Authorization: Bearer abc123          ← 我们要读的就是这种
User-Agent: Mozilla/5.0 ...
```

**⭐ 请求头就是"随请求一起送过来的额外信息"，每条是 `名字: 值`。**

**读取方式（本文件第 49 行）：**

```ts
const auth = request.headers.get("Authorization");
//           ↑        ↑      ↑
//        request   headers  get("名字")
```

| 部分                    | 意思                             |
| ----------------------- | -------------------------------- |
| `request`               | 参数（第 1 课学过）              |
| `.headers`              | 请求里装着所有请求头的那个对象   |
| `.get("Authorization")` | **取某一项的值**。取不到返回 `null` |

**⭐ 对比一下你项目里读过的其他请求头：**

```ts
request.headers.get("Origin")        // submit.ts 用来防 CSRF
request.headers.get("Referer")       // submit.ts 用它做兜底
request.headers.get("Cookie")        // index.ts 用来读 flash cookie
request.headers.get("Accept")        // index.ts 用它区分浏览器/CLI
request.headers.get("Content-Type")  // admin-api.ts 判断 JSON 还是表单
```

**读法都一样：`request.headers.get("名字")`。** 名字记不住没关系，用到就查。

**⚠️ 两个容易踩的点：**

1. **名字不区分大小写。** `"Authorization"`、`"authorization"` 都行
2. **取不到返回 `null`，不是空字符串。** 所以判断要写 `if (auth === null)` 或 `if (!auth)`

---

## 4.2 `Bearer` 是什么

**请求头的值长这样：**

```
Authorization: Bearer abc123def456
```

**⭐ `Bearer` 是一个"认证方案名"，意思是"持有这张令牌的人就是合法用户"**
（`Bearer` = 持票人，有点像"凭票入场"）。

**所以第 50 行的判断是：**

```ts
if (auth === `Bearer ${env.ADMIN_SECRET}`) return null;
//          ↑ 反引号 = 模板字符串
```

**⚠️ 注意是反引号 `` ` `` 不是引号 `"`** —— 这叫**模板字符串**，
可以在里面用 `${...}` 嵌入变量：

```ts
const name = "Ada";
`Hello ${name}`        // → "Hello Ada"
"Hello ${name}"        // → "Hello ${name}"   ❌ 普通引号里不生效
```

**这里有个细小但重要的设计：这是【完整字符串精确比较】，不是"包含"或"开头是"。**

| 客户端发来的             | 结果                       |
| ------------------------ | -------------------------- |
| `Bearer 密钥`            | ✅ 通过                    |
| `bearer 密钥`            | ❌ 401（**大小写敏感**）   |
| `Bearer  密钥`（两空格） | ❌ 401                     |
| `密钥`（少了前缀）       | ❌ 401                     |

**⭐ 为什么不用 `.includes()`？** 因为那样 `"xxxxBearer 密钥yyyy"` 也会通过 ——
**精确比较杜绝了模糊匹配。**

**⚠️ 但也要注意：这里用 `===` 而不是"恒定时间比较"。**
对普通博客够了；银行系统会关心"时序攻击"（通过测响应时间逐字节猜密钥）。
**这是一个有意识的取舍，不是疏漏。**

---

## 4.3 ⭐ 决定 1：为什么密码不能放在网址里

**先看反例**（假设有人写成支持 URL 参数）：

```
https://ziscus.example.com/admin/dashboard?token=abc123
```

**密钥会泄露到至少四个地方：**

| #   | 泄露去处           | 怎么泄的                                            |
| --- | ------------------ | --------------------------------------------------- |
| 1   | **浏览器历史**     | URL 存在本地历史记录里，共用电脑就完了              |
| 2   | **Referer 头**     | 页面里的外部资源（图片、字体、分析脚本）收到完整 URL |
| 3   | **CDN / 代理日志** | Cloudflare 和中间层默认记录完整 URL                 |
| 4   | **搜索引擎**       | 被爬到的 URL 会进索引                               |

**⭐ 走请求头为什么安全：**

> **请求头不进浏览器历史、不进 Referer、通常也不进访问日志。**

**这个项目专门写了一条测试来锁住这个行为**（`dashboard.test.ts` 第 68-71 行）：

```ts
it("rejects query-string token (header-only auth)", async () => {
  const res = await SELF.fetch(
    `https://test.example.com/admin/dashboard?token=${env.ADMIN_SECRET}`,
  );
  expect(res.status).toBe(401);   // ← 就算密钥是对的，放网址里也一律拒绝
});
```

**⭐ 这条测试的意义：它把"只能用请求头"这个设计决定【固化】下来了。**
以后谁想改成支持 URL 参数，测试会先拦住他。

**还有一条更细致的（第 73-78 行）：**

```ts
it("never embeds the secret in dashboard HTML", async () => {
  const html = await res.text();
  expect(html).not.toContain("token=");
  expect(html).not.toContain(env.ADMIN_SECRET);   // ← 密钥决不能出现在页面里
});
```

**⭐ 这是在防"为了图方便，把密钥写进页面里的表单"** ——
那样按钮能带了，但密钥就暴露给任何能看到 HTML 的人了。

### ⚠️ 这个设计带来一个真实的痛点

**浏览器地址栏没法设自定义请求头。所以：**

```
CLI（npx ziscus ...）  →  ✅ 能设 Authorization 头，工作正常
浏览器访问 /admin/...  →  ❌ 设不了头 → 每个按钮都是 401
```

**项目的对策是让你装浏览器扩展**（ModHeader / Requestly）来注入这个头。

**⭐ 人家的评价：这是这个项目在开发体验上最大的痛点。**
如果你要"深度自定义"，**这是值得优先改进的地方** ——
标准做法是加 `/admin/login`，用密码换 **HttpOnly Cookie**，之后浏览器自动携带
（但你要自己处理 CSRF，因为 cookie 会被跨站自动带上）。

---

## 4.4 ⭐ 决定 2：`Response | null` 这个返回值约定

```ts
export function requireAuth(request: Request, env: Env): Response | null {
```

**意思是"要么是一个 401 响应，要么是 null"。**

**⭐ 妙处看调用方就懂了：**

```ts
const authErr = requireAuth(request, env);
if (authErr) return authErr;
//  ↑ 有值 = 鉴权失败，直接把那个 401 响应返回出去
//    没值 = 通过了，继续往下走
```

**对比另外两种写法：**

| 写法                              | 调用方代码                                     | 问题                                             |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| **返回 `Response \| null`**（本项目） | `const e = requireAuth(...); if (e) return e;` | ✅ 简洁，且失败响应由鉴权函数**统一构造**        |
| 返回 `boolean`                    | `if (!requireAuth(...)) return unauthorized();` | ❌ 每个调用方自己构造 401，容易写得不一样        |
| 抛异常                            | `try { ... } catch { ... }`                    | ❌ 累赘；而且"鉴权失败"是**预期情况**，不是异常 |

**⭐ 第 3 种值得多说一句：** `401` 是**完全正常、可预期的业务结果**
（用户没带密码而已），**不是程序出错**。用异常表达"预期情况"是常见的设计坏味道。

**⚠️ 但这个约定有一个真实风险**（第 1 课提过）：

> **容易被忘记调用。** 看 `admin-api.ts` 里十几个 handler，
> **每个都得自己写**那两行。
> **新增管理端点时忘记写 = 那个端点完全没有保护。**
>
> **这是这个设计最大的风险点。** ★ 改进方向：在路由层统一鉴权 ——
> `index.ts` 的 `/admin/` 分支里先调一次，通过后再分发，
> 这样就没有"忘记"的可能了。

---

## 4.5 ⭐ 决定 3：没配置密钥时【锁死】

```ts
if (!env.ADMIN_SECRET) return new Response("Unauthorized", { status: 401 });
```

**`!env.ADMIN_SECRET` 在两种情况下为真：**

| 情况                 | 值          |
| -------------------- | ----------- |
| 环境变量没配置       | `undefined` |
| 配置了但是空字符串   | `""`        |

**⭐ 注意它的处理是【返回 401】，不是"放行"也不是"500 报错"。**

| 做法                       | 后果                                               | 评价                                 |
| -------------------------- | -------------------------------------------------- | ------------------------------------ |
| **没密钥 → 放行**          | 部署时忘了配 → **管理端点对全世界敞开**            | ❌ 灾难                              |
| **没密钥 → 500 报错**      | 服务报错，你能立刻发现                             | ⚠️ 可接受，但不如 401 干净           |
| **没密钥 → 401**（本项目） | 端点锁死，行为一致，提示"未授权"而不是"服务器坏了" | ✅ 最保守且最一致                    |

**⭐ 记住这条通用原则：**

> **"配置缺失"必须落到【最安全】的行为上，而不是【最方便】的行为上。**
>
> 因为"忘了配置"是**很常见**的失误，而它的后果不该是"安全措施消失"。

**⚠️ 这也解释了一个可能让你困惑的现象**（第 0 课提到过）：

> 部署后访问 `/admin/*` 全部 401，**可能不是代码有 bug，而是 `ADMIN_SECRET` 没设**。
>
> 怎么区分？看别的地方正不正常（比如 `/comments/test` 能返回 JSON
> 就说明 Worker 活着），那问题就只在密钥上。

---

## 4.6 谁在用这个函数（一个函数，十几处调用）

**`requireAuth` 是"全项目唯一的一处鉴权实现"。人家查了调用点：**

| 文件                | 调用位置                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| `comments-api.ts`   | `handleApprove`、`handleReject`、`handleSpam`、`handleUnapprove`、`handleDeleteComment` |
| `admin-api.ts`      | 12 个 handler 全部                                                             |
| `dashboard.ts`      | `handleDashboard`                                                              |
| `mod-log.ts`        | `handleGetModLog`                                                              |
| `index.ts`          | `/admin/rebuild`、`/admin/classify`、`/admin/pause/:slug`（内联调用）            |

**⭐ 读代码的实用技巧：**

> **看到一个"到处都是"的小函数时，先确认它是【唯一真相】还是【复制粘贴】。**
>
> · 像 `requireAuth` 只有一份实现的 → **改动它会影响全项目**，要特别小心
> · 像 `escHtml`（第 3 课）有两份副本的 → **改动时要找齐所有副本**

**怎么判断？搜"定义"而不是搜"调用"。** 定义通常长这样：`export function 函数名(`

---

## 4.7 ⭐⭐ 人家做的一个实验：删掉那句保护，会发生什么

**人家在备课的时候想：第 48 行那句判断「看起来有点多余」——
`auth === \`Bearer ${env.ADMIN_SECRET}\`` 不是已经能挡住没密码的人了吗？
那为什么不配密钥时要单独返回 401？**

**为了搞清楚，人家做了这个实验：**

### 实验一：删掉第 48 行，跑全量测试

```
删掉前：  Tests  250 passed (250)
删掉后：  Tests  250 passed (250)      ← ❗ 一个都没挂！
```

**⭐ 结论：那句安全保护【完全没有任何测试覆盖】。**
**任何人删掉它，测试都会告诉他"一切正常"。**

### 实验二：那句保护到底在防什么？

**人家写了个探针，直接观察行为：**

```
PROBE env.ADMIN_SECRET = "test-admin-secret"
PROBE 用 undefined 密钥时的拼接结果 = "Bearer undefined"
```

**⭐ 注意那个拼接结果 —— 这就是答案：**

当 `env.ADMIN_SECRET` 是 `undefined` 时：

```ts
`Bearer ${undefined}`    // JavaScript 会把它变成字符串 "Bearer undefined"
```

**于是如果删掉第 48 行的保护，代码就变成：**

```ts
const auth = request.headers.get("Authorization");
if (auth === "Bearer undefined") return null;    // ← 攻击者可以猜到这个！
```

**⭐ 也就是说：任何请求，只要它的 `Authorization` 头正好是 `Bearer undefined`，
就能通过鉴权。**

**这不是理论危险 —— 这是一个真实存在的漏洞类型**，在很多语言/框架里都出现过：
把 `null`/`undefined` 拼进字符串去比较，结果"字面量 undefined 反而能通过"。

**所以第 48 行那句"看起来多余"的判断，实际上拦住了这个漏洞。**

---

## 4.8 ⭐ 从这次实验得到的三条规律

### 规律 1：字符串化会把"缺失"变成【可猜到的字面量】

```
undefined  →  "undefined"
null       →  "null"
NaN        →  "NaN"
[1,2]      →  "1,2"
{}         →  "[object Object]"
```

**⭐ 所以：凡是"拿变量拼字符串再比较"的地方，
都要先确认那个变量不是 `undefined` / `null`。**

### 规律 2：⚠️ 安全代码常常"没有测试覆盖"

**这次实验最让人警醒的地方不是漏洞本身，而是：**

> **删掉一句安全保护，250 个测试【全部通过】。**

**为什么会这样？** 因为测试测的是"正常路径"：

```ts
it("returns 401 without token", ...);        // 不带任何头 → 401   ✅ 测了
it("returns 401 with wrong token", ...);     // 带了错的     → 401   ✅ 测了
// 但没有人测："当【密钥本身没配置】时，应该怎样？"        ❌ 没测
```

**⭐ 这教给你一个很实用的检查方法：**

> **对每一句 `if (某个配置/变量缺失) return ...` 的判断，
> 问自己："有测试吗？"
>
> 没有的话，它就是一段【删掉也没人知道】的代码。**

### 规律 3：边界情况（edge case）恰恰是安全问题的藏身处

**上面那段测试列表暴露了一个典型思维盲区：**

| 测试覆盖了       | 没覆盖                        |
| ---------------- | ----------------------------- |
| 密码**对**       | 密码**没配置**                |
| 密码**错**       | 密码**是空字符串**            |
| 密码**放错位置** | 密码**被拼成 "undefined"**    |

**⭐ 前面三列是"正常世界里的异常"，后面一列是"配置世界里的异常"。**
**写测试时最容易漏掉的，就是后面这种。**

**★ 如果你想动手：给这个漏洞补一条测试是很好的练习。**
在 `worker/src/dashboard.test.ts` 里加：

```ts
it("locks admin endpoints when ADMIN_SECRET is not configured", async () => {
  // 难点：SELF 用的是配置好的 env，没法改。
  // 所以要直接调 requireAuth 并自己构造 env —— 这正是 classify.test.ts
  // 里 "AI moderation security model" 那组测试用的手法。
  const noSecretEnv = { ...env, ADMIN_SECRET: undefined } as typeof env;
  const res = requireAuth(
    new Request("https://x/", { headers: { Authorization: "Bearer undefined" } }),
    noSecretEnv,
  );
  expect(res).not.toBeNull();      // 必须被拒绝
  expect(res!.status).toBe(401);
});
```

---

## 4.9 改动任务：加一个"备用密钥"

**场景（很实际）：轮换密钥时想新旧并存一段时间。**

**任务：让 `requireAuth` 也接受 `env.ADMIN_SECRET_ALT`。**

### 第 1 步：先想清楚要改几处（本课最重要的思维训练）

| 要改哪里                     | 为什么                                          |
| ---------------------------- | ----------------------------------------------- |
| ① `types.ts` 的 `Env` 接口   | 让 TS 认识 `env.ADMIN_SECRET_ALT`               |
| ② `auth.ts` 的判断逻辑       | 核心改动                                        |
| ③ `worker/vitest.config.ts`  | 测试环境要有这个变量才能测                      |
| ④ `worker/wrangler.toml`     | 真部署时的配置（可选，注释性）                  |

**⚠️ 你可能会漏掉 ① 或 ③。** 试着**先只改 ②**，看 TS 怎么提示你 ——
**让编译器教你该改哪里，这是学 TS 最快的方式之一。**

### 第 2 步：改 `auth.ts`

**只给方向，代码你写：**

```ts
export function requireAuth(request: Request, env: Env): Response | null {
  // ⚠ 这个判断也要跟着变：现在"一个密钥都没有"才算配置缺失
  if (!env.ADMIN_SECRET && !env.ADMIN_SECRET_ALT) {
    return new Response("Unauthorized", { status: 401 });
  }
  const auth = request.headers.get("Authorization");
  // ↓ 这里要接受【两个】可能的密钥。想想怎么写最清楚？
  //   提示：用 || 连接两个比较
  ...
}
```

**⭐ 注意第一个 `if` 也被连带改了** —— 这就是改动的连带影响，要主动去想。

### 第 3 步：改 `types.ts`

照着 `ADMIN_SECRET?` 那一行的样子加。

### 第 4 步：改 `vitest.config.ts`

在 `bindings` 里加测试值（参考 `ADMIN_SECRET: "test-admin-secret",`）。

### 第 5 步：写一条测试

在 `worker/src/dashboard.test.ts` 里加（照着第 50-71 行的风格）：

```ts
it("accepts the alternate secret", async () => {
  const res = await SELF.fetch("https://test.example.com/admin/dashboard", {
    headers: { Authorization: `Bearer ${env.ADMIN_SECRET_ALT}` },
  });
  expect(res.status).toBe(200);
});
```

**⚠️ `env.ADMIN_SECRET_ALT` 的类型可能是 `string | undefined`
（因为你在 `Env` 里标了 `?`），TS 可能要求你处理这种情况。**
**这正是第 2 课那条规律的实战：标了 `?` 就要判空。**

### 第 6 步：跑全量测试

```powershell
cd C:\Users\asus\Desktop\ZiscusbasedonPutty
pnpm typecheck
pnpm test
```

**预期：原来的 383 个测试全部继续通过（向后兼容），加上你新写的那条。**

**⭐ "原测试全部通过"本身就是重要信息** —— 说明你的改动没破坏既有行为。

---

## 4.10 这一课你要记住的五件事

| #   | 知识点                                                                 | 为什么重要                                     |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | **`request.headers.get("名字")`** 读请求头，取不到返回 `null`          | 名字不区分大小写，但值是**精确比较**           |
| 2   | **模板字符串 `` `...${x}...` ``** 才能嵌入变量                         | 普通引号里 `${x}` 不生效                       |
| 3   | ⭐ **`Response \| null` 约定**：有值即错误，`if (e) return e;`          | 比布尔值/异常都顺手，但**容易被忘记调用**      |
| 4   | ⭐ **配置缺失时落到最安全的行为**                                      | "没密钥就锁死"，不是"没密钥就放行"             |
| 5   | ⭐⭐ **字符串化会把 `undefined`/`null` 变成可猜到的字面量**             | 所以拼字符串比较前，必须确认变量有值           |

**⭐ 还有一条来自实验的元教训：**

> **一句没有测试覆盖的安全保护，和一句注释没有区别。**
>
> 人家实测：删掉 `auth.ts` 第 48 行，250 个测试全部通过。
> **所以你以后看到 `if (配置缺失) return 拒绝` 这类代码，
> 都要问一句："这条有人测吗？"**

---

## 4.11 下一课预告

**第 5 课：`structural-filter.ts`**（59 行，反垃圾第一层）

你会学到：

- **正则进阶实战**：`[...]`、`\p{L}`、`{19,}`、`\1`（第 3 课认识过，这次真用上）
- `for...of` 遍历数组
- **"早返回"（early return）链** —— 一系列 `if` 依次筛掉不合格输入
- 一个反垃圾的核心思路：**规则层不该判断"内容好不好"，
  只该判断"这根本不可能是人写的"**
