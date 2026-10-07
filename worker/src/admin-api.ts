/**
 * ============================================================================
 * worker/src/admin-api.ts —— 管理 API（/admin/* 的 JSON 后端，面板与 CLI 共用）
 * ============================================================================
 *
 * 【这个文件在整个系统里的位置】
 *
 *   ┌────────────────────┐        ┌──────────────────────────────┐
 *   │ 管理面板（纯 HTML）│        │ CLI / 脚本（npx ziscus ...）  │
 *   │ 表单 POST + Bearer │        │ fetch + Bearer               │
 *   └─────────┬──────────┘        └───────────────┬──────────────┘
 *             └───────────────┬───────────────────┘
 *                             ▼
 *   index.ts  route()  ← 只负责【路由匹配】和【把结果交给 dashboardRedirect()】
 *                             ▼
 *   本文件（12 个 handler，全部都是"鉴权 → 读写 D1 → 返回 Response"）
 *     handleGetStats      GET    /admin/stats
 *     handleListComments  GET    /admin/comments
 *     handleSetMode       POST   /admin/mode
 *     handleGetMode       GET    /admin/mode
 *     handleBanIp         POST   /admin/ban
 *     handleUnbanIp       DELETE /admin/ban/:ip_hash
 *     handleListBans      GET    /admin/bans
 *     handleBulkApprove   POST   /admin/bulk/approve
 *     handleExport        GET    /admin/export
 *     handleImport        POST   /admin/import
 *     handleGdprDelete    DELETE /admin/gdpr/:ip_hash
 *     handleRebuild       POST   /admin/rebuild
 *                             ▼
 *                Cloudflare D1：comments / banned_ips / meta / mod_log
 *
 * 【两个调用者，一种返回形态 —— 重定向不在这里做】
 *   浏览器表单希望"跳回面板看到刷新后的列表"，CLI 希望"拿到原始 JSON"。
 *   这件事【不在这 12 个 handler 里判断】：它们一律返回原始 Response，
 *   由 index.ts 的 dashboardRedirect() 按 Accept 头决定要不要换成 303。
 *   所以没有重定向不是遗漏，是分层：**handler 只管数据，路由层管表现**。
 *
 * 【三条贯穿全文件的约定】
 *   1. 每个 handler 第一行都是 requireAuth()（返回 Response | null），
 *      `if (authErr) return authErr;` 是最常见的四行。鉴权【不做统一中间件】，
 *      每个 handler 自己来 —— 好处是被单独 import / 单测时不可能漏鉴权，
 *      代价是新增 handler 时必须记得写。★ 新增时第一行照抄这个模式。
 *   2. 成功一律 `{ status: 200, headers: JSON_HEADERS }`；
 *      失败一律【纯文本 + 4xx/5xx】（不是 JSON 错误体）—— CLI 靠状态码分流。
 *   3. 所有 SQL 都是 prepared statement + bind()，值从不拼进 SQL 字符串
 *      （唯一"拼"的是 handleListComments 的 WHERE 片段，但拼的是固定列名）。
 *
 * ⚠ 注意（原注释 / 文档漂移，不是代码 bug）：
 *   index.ts 顶部的路由表注释里写的是 /admin/bulk-approve、/admin/gdpr-delete
 *   和 /admin/unban，但【实际生效的路由】是：
 *     POST   /admin/bulk/approve
 *     DELETE /admin/gdpr/:ip_hash
 *     DELETE /admin/ban/:ip_hash   ← 解封走的是这条，没有 /admin/unban
 *   单测（worker/src/index.test.ts）验证的也是上面这三条。以代码为准。
 */
import type { Env } from "./types.js";
import { requireAuth } from "./auth.js";
import { logModAction } from "./mod-log.js";
import { escHtml } from "./html.js";
import { triggerRebuild, getLastRebuildResult } from "./debounce.js";

// 所有 JSON 响应的公共 header。★ 注意这是一个【被共享的同一个对象引用】，
// 不要在某个 handler 里对它 set/delete（会污染其它响应）；要加头就 new 一个。
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * GET /admin/stats —— 各状态的评论计数 + 最近一次重建派发的结果。
 *
 * 【做什么】
 *   一条 GROUP BY 把四种状态的条数聚合出来，再顺手读一下 meta.last_rebuild_result，
 *   拼成一个扁平对象返回：
 *     { pending, approved, rejected, spam, rebuild: RebuildResult | null }
 *
 * 【为什么把 rebuild 结果混进 stats】
 *   "重建管线还活着吗"是运维最关心的问题之一，而它的结果只存在 meta 表里
 *   （写入逻辑见 debounce.ts 的 recordResult）。放这里能让 CLI 用【一次请求】
 *   同时拿到"积压多少条"和"上次派发给 GitHub 成功了没"，不必两次鉴权、两次往返。
 *
 * 【为什么用 Promise.all】
 *   两条查询互不依赖，并行发出去省一个 D1 往返 —— 在边缘节点上往返就是延迟。
 *
 * ⚠ stats 的初值只预设了 4 个键。如果库里出现第 5 种 status（导入脏数据、
 *   或你以后加了新状态），它会作为【新字段】被附加进响应而不是被丢弃。
 *   调用方不要假设响应形状永远只有这 5 个键。
 *
 * ★ 自定义提示：想加"今日新增 / 本周删除"这类指标，在这里加查询即可；
 *   注意面板（dashboard.ts）是【自己重查一遍】的，不会自动跟着变。
 */
export async function handleGetStats(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const [{ results }, rebuild] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) as count FROM comments GROUP BY status")
      .all<{ status: string; count: number }>(),
    getLastRebuildResult(env.DB),
  ]);

  // 先铺好 4 个键（缺省 0），保证"没有评论"时响应形状依然稳定；
  // 下面循环把实际计数覆盖上去（未知状态会新增键，见上面的 ⚠）。
  const stats: Record<string, number> = { pending: 0, approved: 0, rejected: 0, spam: 0 };
  for (const row of results ?? []) {
    stats[row.status] = row.count;
  }

  return new Response(JSON.stringify({ ...stats, rebuild }), { status: 200, headers: JSON_HEADERS });
}

/**
 * POST /admin/rebuild —— 手动强制触发一次 repository_dispatch（人肉"立即重建"按钮）。
 *
 * 【做什么】
 *   绕开 debounce 窗口（force: true）直接让 GitHub 派发重建事件，
 *   并把 GitHub 的裁决【如实翻译成 HTTP 状态码】：
 *     派发成功            → 200
 *     not_configured      → 503（没配 GITHUB_REPO / GITHUB_TOKEN）
 *     其它（token 被拒 / 网络故障）→ 502
 *
 * 【为什么它是运维探针】
 *   重建失败过去是"静默"的：评论入库了，站点却一直不更新，没人知道为什么。
 *   这里把失败显式暴露给调用者 —— 一个过期的 token 会得到 502 + GitHub 的
 *   原始 message，而不是消失在后台日志里。这也是面板上"Rebuild pipeline"
 *   卡片的数据来源（见 dashboard.ts 与 debounce.ts 的 recordResult）。
 *
 * 【输入契约 —— 一个端点服务两种调用者】
 *   Content-Type: application/json                        → 读 body.slug
 *   application/x-www-form-urlencoded / multipart/form-data → 读表单字段 slug
 *     （面板上的 "rebuild now" 按钮走这条：<form method="POST"> 只能发表单）
 *   两者都没命中 / 值为空 → slug 回落为 "all"（整个站点重建）
 *
 * ⚠ Content-Type 嗅探是【刻意宽容】的：类型不认识时不报错，直接按 "all" 重建。
 *   对面板友好（浏览器表单的 Content-Type 固定，能命中），但副作用是：
 *   CLI 忘了设 Content-Type 时，得到的是一次"全站重建"而不是 400。
 *
 * ⚠ slug 白名单 /^[a-z0-9-]{1,255}$/ 是【信任边界】：
 *   这个值会被塞进 GitHub 的 client_payload。字符集限制保证它不可能带引号、
 *   斜杠或换行去污染下游 JSON / workflow 参数。别放宽。
 *   另外注意："all" 在这里只是一个普通 slug 字符串 —— Worker 【不知道】
 *   all 代表什么，解释权在你的 GitHub Actions workflow 里
 *   （事件名是 debounce.ts 里的 rebuild-comments）。
 *
 * ⚠ 这里【没有重试】：GitHub 抖一下就是一次 502，操作者得再点一次。
 *   要加重试/队列，改 debounce.ts 的 triggerRebuild。
 *
 * 【响应形态】index.ts 给它挂了
 *   dashboardRedirect(..., { alsoOn: (s) => s >= 500 }) ——
 *   带 Accept: text/html 的浏览器（面板点按钮）在 200/502/503 时都会被 303
 *   跳回 /admin/dashboard，失败原因显示在 Rebuild pipeline 卡片上；
 *   CLI / fetch 则原样拿到 JSON 和状态码。
 */
export async function handleRebuild(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  let slug = "all";
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    let body: { slug?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (typeof body.slug === "string" && body.slug) slug = body.slug;
  } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    // 面板表单分支：拿不到就用默认的 "all"
    const field = (await request.formData()).get("slug");
    if (typeof field === "string" && field) slug = field;
  }
  if (!/^[a-z0-9-]{1,255}$/.test(slug)) {
    return new Response("Invalid slug", { status: 400 });
  }

  // force: true = 忽略 debounce 窗口；actor: "admin" 让 mod_log 里能区分
  // "有人手动点的" 和 "系统因批准评论自动触发的"。
  const result = await triggerRebuild(env.DB, env, slug, { force: true, actor: "admin" });
  // 503 与 502 的区别是有意的：
  //   503 = 你自己还没接好（缺配置），改 wrangler.toml / secret 就能解决；
  //   502 = 上游（GitHub）拒绝了，问题在 token/仓库/网络。
  // ★ 调用方（CLI、监控）就是靠这个区分"配置问题"和"外部故障"的，别合并成 500。
  const status = result.dispatched ? 200 : result.code === "not_configured" ? 503 : 502;
  return new Response(JSON.stringify({ ok: result.dispatched, ...result }), { status, headers: JSON_HEADERS });
}

/**
 * GET /admin/comments —— 评论列表（筛选 + 分页），本文件里唯一"给机器读"的列表接口。
 *
 * 【做什么】
 *   支持 4 个可选筛选（status / slug / author / since）+ limit/offset 分页，
 *   按 created_at 倒序返回固定列。
 *
 * 【为什么它必须存在（而面板那套不够）】
 *   管理面板只做 pending 队列的简单分页与子串搜索；而 CLI、导出脚本、
 *   第三方集成需要按【任意状态】翻【任意页】，所以这个端点要通用。
 *
 * ⚠【最关键的一条】返回的 author / body 是【入库时已 HTML 转义过的形态】
 *   （见 html.ts 的"存储不变量"），形如 `&lt;b&gt;hi&lt;/b&gt;`。
 *   调用方要把它渲染成 HTML 必须写 escHtml(unescapeHtml(v))：
 *     直接塞进 HTML     → 用户看到字面实体（功能错）
 *     只 unescape 不转义 → XSS（安全错）
 *
 * ⚠ 响应里含 ip_hash（访客的假名化标识符）。它是"这条评论是谁发的"的唯一线索，
 *   属于敏感数据：别把 /admin/comments 的原始响应贴进公开 issue、
 *   别转给第三方前端日志。合规上它和 handleGdprDelete 处理的是同一类数据。
 *
 * ⚠ 输入校验有缺口（不影响安全，影响健壮性）：
 *   limit 只有上限 Math.min(x, 200)，没有 Number.isFinite / 下限判断；
 *   offset 也允许负数。`?limit=abc` → parseInt → NaN → bind("NaN") 直接交给 SQLite。
 *   CLI 正常传数字所以没暴露。★ 要加固就在这里兜底，别指望 D1 报错。
 *   （author 走的是 LIKE '%...%'，值仍然 bind 所以不构成注入；
 *     但 `%` / `_` 没转义，那是"通配符语义偏差"而不是注入。）
 *
 * ⚠ 这里的 SQL 是全文件唯一"拼字符串"的地方：conditions 里拼的是
 *   【固定列名 + ? 占位符】，值全部进 binds。★ 加新筛选条件时，
 *   只能往 conditions 里 push 常量片段，值必须 push 进 binds。
 *
 * ★ 自定义提示：想加排序参数（asc/desc）、按 id 精确取一条、
 *   把 limit 上限提到 1000，都改这个函数；index.ts 的路由不用动。
 */
export async function handleListComments(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const slug = url.searchParams.get("slug");
  const author = url.searchParams.get("author");
  const since = url.searchParams.get("since");
  // ⚠ 上限 200 是防"一次拉全库"；NaN/负值没处理（见函数头的 ⚠）
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  // 条件片段与绑定值【分开收集】：片段只含固定列名，值一律走 bind ——
  // 这是本文件"永不拼接用户输入"这条纪律的落点。
  const conditions: string[] = [];
  const binds: string[] = [];

  if (status) { conditions.push("status = ?"); binds.push(status); }
  if (slug) { conditions.push("slug = ?"); binds.push(slug); }
  if (author) { conditions.push("author LIKE ?"); binds.push(`%${author}%`); }
  if (since) { conditions.push("created_at >= ?"); binds.push(since); }

  // where 只可能是空串或 "WHERE 固定列名 = ? AND ..."，用户输入永远不在里面。
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // ⚠ 这里 select 出 ip_hash（敏感）—— 见函数头的 ⚠；列是【写死的白名单】，
  //   别改成 SELECT *：schema 以后新增内部列时会不声不响地泄漏出去。
  const query = `SELECT id, slug, author, body, status, ip_hash, created_at, approved_at FROM comments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  // 值作为字符串绑定；D1/SQLite 会按列亲和性把 LIMIT/OFFSET 当整数用。
  binds.push(limit.toString(), offset.toString());

  const stmt = env.DB.prepare(query);
  const bound = stmt.bind(...binds);

  const { results } = await bound.all();
  return new Response(JSON.stringify(results ?? []), { status: 200, headers: JSON_HEADERS });
}

/**
 * POST /admin/mode —— 切换评论模式（全项目【唯一的写入口】）。
 *
 * 【三种模式的确切语义 —— 读懂这三个才算读懂这个项目的行为】
 *   "on"     正常开放。新评论是"待审"还是"直接通过"，由 AI（绑定了 AI_MOD 时）
 *            或 env.MODERATION 决定（判定逻辑在 submit.ts）。
 *   "off"    关闭。submit.ts 直接 403 "Comments are disabled"；
 *            comments-api.ts 也不再把它返回给构建器，所以【已批准的评论会从
 *            页面上消失】—— 这点容易被忽略：off 不只是"不收新的"。
 *   "paused" 暂停 = "全部人工过一遍"。submit.ts 强制 status=pending，
 *            并且【跳过 AI 分类】（省额度，也避免 AI 误放）。
 *            与 "off" 的区别：off 是不收，paused 是收但一律待审。
 *            ⚠ 但它有个容易漏看的副作用：读路径（comments-api.ts 的
 *              handleGetComments）把 paused 和 off 一视同仁地"返回空数组"，
 *              于是切到 paused 之后，【下一次重建起，站点上已有的、已批准的
 *              评论也会一起从页面上消失】（不是立刻，要等重建）。
 *              想做到"只暂停新增、保留旧评论显示"，必须改 comments-api.ts
 *              里那个 `mode === "off" || mode === "paused"` 的判断。
 *
 * 【为什么必须是白名单】
 *   这个字符串会被写进 meta，之后被 submit.ts / comments-api.ts 读出来参与分支。
 *   放任意字符串进去不会报错，但会让"面板显示的值"和"实际行为"错位
 *   （所有 `mode === "..."` 判断都落空 → 行为等同 on）。校验就是防这个。
 *
 * ⚠ 只接受 JSON body（request.json()），【没有 formData 分支】。
 *   所以在面板上加一个 <form method="POST" action="/admin/mode"> 按钮是不工作的：
 *   浏览器表单发 urlencoded，request.json() 抛异常 → 500。
 *   ★ 要给面板加模式切换按钮，照 handleRebuild 那样先嗅探 Content-Type。
 *
 * 【副作用】① 写 meta（INSERT OR REPLACE，key 是主键 → 等价 upsert）
 *           ② 记一条 mod_log（action=mode_change，actor=admin，reason="mode → xxx"）
 *
 * ★ 自定义提示：想加第四种模式（比如 "readonly"），必须同时改三处：
 *   这里的白名单、submit.ts 的分支、comments-api.ts 的读路径 —— 少一处就是隐形 bug。
 */
export async function handleSetMode(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const body = await request.json() as { mode?: string };
  const mode = body.mode;
  if (!mode || !["on", "off", "paused"].includes(mode)) {
    return new Response("Invalid mode. Must be: on, off, paused", { status: 400 });
  }

  // meta 的 key 是主键，所以 INSERT OR REPLACE 在这里就是 upsert（不存在则插入）
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('comments_mode', ?)").bind(mode).run();
  await logModAction(env.DB, "mode_change", "admin", { reason: `mode → ${mode}` });
  return new Response(JSON.stringify({ ok: true, mode }), { status: 200, headers: JSON_HEADERS });
}

/**
 * GET /admin/mode —— 读当前模式，只回一个 { mode }。
 *
 * ⚠ 兜底值 "on" 在本文件、submit.ts、comments-api.ts 里【各自硬编码了一份】。
 *   任何一处改成别的默认值，都会出现"面板显示 on、写入端却按别的模式处理"
 *   的不一致。★ 要改默认行为，三处一起改。
 */
export async function handleGetMode(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'comments_mode'").first<{ value: string }>();
  const mode = row?.value ?? "on";
  return new Response(JSON.stringify({ mode }), { status: 200, headers: JSON_HEADERS });
}

/**
 * POST /admin/ban —— 按 ip_hash 封禁一个访客。
 *
 * 【作用点】submit.ts 在限流之后查 banned_ips，命中即 403 "Forbidden"。
 *   所以封禁【只拦后续提交】，不会隐藏已入库的评论、也不会撤销已批准的内容。
 *
 * ⚠ 封禁粒度是 ip_hash，不是 IP。而 ip_hash 是 IP 的加盐摘要（见 hashIp 实现）
 *   → 同一个出口 IP 下的所有人（NAT、公司、校园网、手机 CGNAT）会一起被拦。
 *   这是设计上无法避免的取舍，但【动手封之前要知道这一点】。
 *
 * ⚠ 没有对 ip_hash 做格式/长度校验（只判空）。它本该是十六进制摘要，
 *   但任意字符串都能写进去 —— 只是让封禁列表变脏，不构成注入（SQL 走 bind）。
 *   脏值的实际后果是：真正的访客永远匹配不上，这次"封禁"等于空操作。
 *
 * ⚠【审计缺口】logModAction 只记了 reason，【没记 ip_hash】——
 *   事后翻 mod_log 你查不出到底封了谁（对比 handleGdprDelete 把 ip_hash
 *   写进了 reason）。要补就把 ip_hash 放进 metadata（推荐）或 reason。
 *
 * ⚠ INSERT OR REPLACE 在 SQLite 里是"删旧行 + 插新行"：重复封禁同一个 ip_hash
 *   会把 banned_at 重置为当前时间（schema 默认值）、reason 被覆盖。
 *   想保留"首次封禁时间"就得改成 ON CONFLICT(ip_hash) DO UPDATE。
 *
 * ★ 自定义提示：想按 IP 段 / CIDR 封禁，需要先让 ip_hash 可逆（那就破坏了
 *   假名化，谨慎），或者在 submit.ts 里加第二层检查。
 */
export async function handleBanIp(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const body = await request.json() as { ip_hash?: string; reason?: string };
  if (!body.ip_hash) {
    return new Response("Missing ip_hash", { status: 400 });
  }

  // banned_at 交给 schema 的默认值（strftime(...'now')），所以这里不传；
  // 客户端也无法伪造封禁时间。★ 想支持"定时解封"就要在这里显式写时间。
  await env.DB.prepare("INSERT OR REPLACE INTO banned_ips (ip_hash, reason) VALUES (?, ?)").bind(body.ip_hash, body.reason ?? "").run();
  await logModAction(env.DB, "ban", "admin", { reason: body.reason ?? "" });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
}

/**
 * DELETE /admin/ban/:ip_hash —— 解封（幂等）。
 *
 * 【为什么不存在也返回 ok: true 而不是 404】
 *   对调用者来说"删完之后它没被封着"这个结果是对的，所以 changes = 0 也算成功。
 *   CLI 可以放心重复调用、批量调用，不必先查列表。
 *
 * ⚠ ipHash 直接来自 URL path。index.ts 的路由正则是
 *   /^\/admin\/ban\/([a-z0-9]+)\/?$/，字符集已限死，加上这里是 bind 参数化，
 *   所以不存在 path 注入。★ 以后改这条路由，别把这个字符集限制弄丢。
 *   ⚠ 但没有任何"格式/长度"校验（是 8 位还是 64 位十六进制？没人管）：
 *     传错格式只会静默删 0 行，你会以为解封成功。
 *   ⚠ 与 handleBanIp 相同的审计缺口：mod_log 里同样没记 ip_hash。
 *
 * ★ 自定义提示：index.ts 里这条路由是 DELETE，不是 POST —— 用 curl 测试时
 *   别写成 -X POST（会 404，因为没有任何 handler 匹配）。
 */
export async function handleUnbanIp(ipHash: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  await env.DB.prepare("DELETE FROM banned_ips WHERE ip_hash = ?").bind(ipHash).run();
  // ⚠ 这条日志也没带 ip_hash：审计里只能看到"有人解封了一次"，看不到解封了谁。
  await logModAction(env.DB, "unban", "admin");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
}

/**
 * GET /admin/bans —— 返回全部封禁记录（最近封的在前）。
 *
 * 【为什么不分页】封禁列表正常只有几十条，分页只会给面板和 CLI 添麻烦。
 *
 * ⚠ 但没有 LIMIT 就意味着：万一被刷成几万条（攻击者用大量 IP 逼你封禁），
 *   这一次响应会把它们全部读进内存。★ 真要加固就在这里加 LIMIT/OFFSET，
 *   并同步改 CLI 的展示（它目前假设拿到的是全量）。
 *
 * 契约：200 + JSON 数组 [{ ip_hash, reason, banned_at }]（ip_hash 属敏感数据，
 * 别把原始响应贴进公开 issue）。
 */
export async function handleListBans(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const { results } = await env.DB.prepare("SELECT ip_hash, reason, banned_at FROM banned_ips ORDER BY banned_at DESC").all();
  return new Response(JSON.stringify(results ?? []), { status: 200, headers: JSON_HEADERS });
}

/**
 * POST /admin/bulk/approve —— 把某个 slug 下【所有 pending】一次性批准。
 *
 * 【为什么是一条 UPDATE 而不是循环调 handleApprove】
 *   逐条批准会产生 N 次 D1 往返 + N 次重建派发；一条 UPDATE 只花一次往返，
 *   适合"某篇文章积压了 300 条"的场景。性能换来的代价见下面的 ⚠。
 *
 * ⚠【与 handleApprove（comments-api.ts）的四处差异 —— 踩坑高发区】
 *   1. 【不触发重建】handleApprove 会 triggerRebuild()，这个函数【不会】。
 *      所以批量批准后，静态站上的新评论要等下一次批准/提交，
 *      或手动 POST /admin/rebuild 才会出现。最容易被误当成 bug 的行为。
 *   2. 【不写 mod_log】没有任何审计痕迹 —— 事后查不到"谁批量批准了哪篇的多少条"。
 *      ★ 要补就在 run() 成功后加 logModAction(..., "bulk_approve", "admin", {...})。
 *   3. 【不逐条走业务逻辑】不重新过 AI、不限流、不去重。
 *   4. 【幂等】重复调用第二次 changes = 0，依然返回 ok: true。
 *
 * ⚠ 只校验 slug 非空，【不校验 slug 是否存在】：批准 0 条也返回 200 + count: 0。
 *   调用方要靠 count 判断"这次到底动了没有"。
 *
 * ⚠ approved_at 用 strftime('%Y-%m-%dT%H:%M:%SZ','now') 手写，是为了和
 *   schema.sql 里 created_at 的默认值保持【同一种格式】（UTC、秒级、带 Z）。
 *   ★ 改格式要连 schema、面板的 created_at.slice(0, 10) 一起考虑。
 *
 * 契约：POST JSON { slug } → 200 { ok: true, count: <批准条数> }。
 *       count 取自 D1 的 meta.changes（SQLite changes() 语义 = 被 UPDATE
 *       匹配到的行数，新旧值相同也算），所以它确实是"这次批准了多少条"。
 *
 * ★ 自定义提示：想"批准全站 pending"就把 SQL 里的 `AND slug = ?` 去掉；
 *   想加"批量拒绝/批量标垃圾"就把 status 也参数化（记得 status 同样要白名单校验）。
 *   ——无论怎么改，请顺手补上上面第 1、2 条缺失的行为。
 */
export async function handleBulkApprove(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const body = await request.json() as { slug?: string };
  if (!body.slug) {
    return new Response("Missing slug", { status: 400 });
  }

  // 一次 UPDATE 覆盖该 slug 下所有 pending；已被 rejected/spam 的【不会】被复活
  // （WHERE 里的 status = 'pending' 就是防止误伤已处理内容的那道闸）。
  const result = await env.DB.prepare(
    "UPDATE comments SET status = 'approved', approved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE slug = ? AND status = 'pending'",
  ).bind(body.slug).run();

  return new Response(JSON.stringify({ ok: true, count: result.meta.changes }), { status: 200, headers: JSON_HEADERS });
}

/**
 * GET /admin/export —— 一次性把整个数据库导出成 JSON（备份 / 迁移）。
 *
 * 【做什么】四张表并行读出来拼成一个对象：
 *     { comments: [...], modLog: [...], bans: [...], meta: { mode } }
 *
 * 【为什么不做分页】
 *   这是"备份"语义：分页导出会让调用方面对"备份到一半时库还在变"的一致性问题，
 *   而且拼不出一个自洽的文件。一次给完最简单，也正好能被 handleImport 直接吃回去。
 *
 * ⚠【规模上限 —— 真会炸】整个结果必须装进 Worker 内存，并受单次响应体上限约束。
 *   几万条评论没问题；到百万级（D1 免费档能存到这个量级）会 OOM / 超时。
 *   ★ 那个量级应该用 `wrangler d1 export`，或把它改成分页 + 流式响应。
 *
 * ⚠【这是敏感数据】导出内容包含：
 *     - comments.ip_hash（假名化访客标识）
 *     - mod_log.reason —— handleGdprDelete 把 ip_hash 明文写进了里面
 *   所以【别把导出文件提交进 git、别丢进公开 bucket、别贴进 issue/聊天】。
 *
 * ⚠ 导出的是【入库时已转义】的 author/body（html.ts 的存储不变量），形如 `&lt;b&gt;`。
 *   于是 handleExport → handleImport 的往返【不是无损的】：
 *   导入端会再转义一层，文本多包一层实体。详见 handleImport 的 ⚠。
 *
 * 契约：200 + JSON。注意它【不是文件下载】——没设 Content-Disposition，
 *   浏览器打开只会显示 JSON 文本；要存盘得自己复制，或用 CLI 的 export 命令。
 *   ★ 加新表 / 新 meta 键时，handleImport 的对应分支要一起改，否则备份会丢字段。
 */
export async function handleExport(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  // 四条读并行（互不依赖）。meta 只导出 comments_mode 一个键 ——
  // ★ slug_paused:<slug> 这类键【不在导出范围内】，恢复后"按页暂停"会丢。
  const [comments, modLog, bans, modeRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM comments ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT * FROM mod_log ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT * FROM banned_ips ORDER BY banned_at DESC").all(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'comments_mode'").first<{ value: string }>(),
  ]);

  // `?? []`：D1 在"没有行"时 results 可能是 undefined，统一兜成空数组，
  // 保证备份文件的形状稳定（导入端依赖这个形状）。
  return new Response(JSON.stringify({
    comments: comments.results ?? [],
    modLog: modLog.results ?? [],
    bans: bans.results ?? [],
    meta: { mode: modeRow?.value ?? "on" },
  }), { status: 200, headers: JSON_HEADERS });
}

// status 白名单。★ 加新状态（比如 "shadow"）时，除了这里，
// 还要同步：schema 的默认值、handleGetStats 的初值、dashboard 的统计卡片。
const VALID_STATUSES = ["pending", "approved", "rejected", "spam"];

/**
 * POST /admin/import —— 从 handleExport 的备份恢复数据。
 *
 * 【做什么】
 *   接受 { comments?, bans?, modLog? } 三个可选数组，校验后按 100 条一批写进 D1，
 *   最后记一条汇总 mod_log（action=import），返回各表写入条数。
 *
 * 【为什么 100 条一批】
 *   D1 单次 batch 的语句数 / 绑定参数有上限，整批塞进去会失败；分批同时让大导入
 *   不必把全部 prepared statement 一次性驻留在内存里。
 *
 * ⚠⚠【最重要的一条：导出 → 导入不是无损往返，会二次转义】
 *   comments 分支对 author/body 调了 escHtml()，而备份里的值【本来就是转义过的】：
 *       库里（存储不变量）  `&lt;b&gt;`
 *       → 导出             `&lt;b&gt;`
 *       → 导入后存成        `&amp;lt;b&amp;gt;`
 *   → 渲染出来是【字面的 &lt;b&gt;】，用户原本的 <b> 变成了可见实体。
 *   也就是说这条恢复路径会把所有含 & < > " ' 的评论"多包一层"。
 *   ★ 修之前先想清楚哪一端是"原始文本"：要么导入端不再转义（理由是备份来源
 *     已是转义形态），要么导出端额外给出原始文本。这是既有行为，
 *     改动会影响所有已发布的备份文件 —— 别顺手改。
 *
 * ⚠【校验强度不一致】
 *   - comments：逐条校验必需字段 + status 白名单 ✅
 *   - bans / modLog：【完全不校验】❌
 *   后果举例：bans 里某条缺 ip_hash → bind(undefined) 在 D1 上抛 TypeError
 *   → 整个请求 500，而前面已写入的批次【不会回滚】（见下一条）。
 *   ★ 要加固就照 comments 的写法给 bans/modLog 补必需字段校验。
 *
 * ⚠【没有事务、没有 dry-run】
 *   分批之间不共享事务：第 3 批失败时前 2 批已经落库，你会得到"半个备份"。
 *   而 INSERT OR REPLACE 会【按 id 覆盖现有行】—— 拿旧备份往生产库倒，
 *   会把已批准的评论覆盖回 pending / spam。
 *   ★ 想安全点：加 ?dryRun=1 只校验不写，或加"只插不覆盖"的 INSERT OR IGNORE 模式。
 *
 * ⚠【导入后不会自动更新静态站】本函数【不触发 triggerRebuild】，
 *   需要手动 POST /admin/rebuild，否则线上看到的还是导入前的页面。
 *
 * ⚠ ip_hash 是【原样导入】的，不会重新加盐/重算。这是好事（封禁、限流、GDPR
 *   擦除都依赖它稳定），但也意味着换机器恢复备份时，必须同时恢复原来的
 *   hash 盐（见 hashIp 实现），否则新提交的评论和旧评论对不上同一个人。
 *
 * ★ 自定义提示：想支持 merge/skip 策略、想把 meta 的其它键也导入
 *   （比如 slug_paused:*，目前 handleExport 也没导出它）、
 *   想调整批量大小（改 i += 100 的步长），都在这个函数里。
 */
export async function handleImport(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  let payload: { comments?: unknown; bans?: unknown; modLog?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const comments = payload.comments;
  const bans = payload.bans;
  const modLogEntries = payload.modLog;

  // 只做"整体是不是数组"的粗校验；元素级校验在各自的导入分支里，且强度不一（见函数头 ⚠）。
  if (comments !== undefined && !Array.isArray(comments)) {
    return new Response("comments must be an array", { status: 400 });
  }
  if (bans !== undefined && !Array.isArray(bans)) {
    return new Response("bans must be an array", { status: 400 });
  }

  // Validate and import comments
  // 先【全量校验再写】：这样"格式错"的备份不会污染数据库（但"写入中途失败"
  // 仍然会留下半个导入 —— 无事务，见函数头 ⚠）。
  let commentCount = 0;
  if (Array.isArray(comments)) {
    for (const c of comments as Record<string, unknown>[]) {
      if (!c.id || !c.slug || !c.author || !c.body || !c.status) {
        return new Response("Invalid comment: missing required fields", { status: 400 });
      }
      if (!VALID_STATUSES.includes(c.status as string)) {
        return new Response(`Invalid status: ${c.status}`, { status: 400 });
      }
    }

    // ⚠ 这里的 escHtml 就是"二次转义"的来源（见函数头第一条 ⚠）。
    // ⚠ 另外注意 bind 里的 c.id / c.slug 直接来自备份，类型没做 String() 包装，
    //   非字符串（数字/对象）会按原类型交给 D1。
    const batch = (comments as Record<string, unknown>[]).map((c) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO comments (id, slug, author, body, status, ip_hash, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        c.id, c.slug, escHtml(String(c.author)), escHtml(String(c.body)),
        c.status, c.ip_hash ?? "", c.created_at ?? new Date().toISOString(), c.approved_at ?? null,
      ),
    );
    // 每 100 条一批：D1 单次 batch 的语句数/参数有上限（★ 想调大批量改这个 100）
    for (let i = 0; i < batch.length; i += 100) {
      await env.DB.batch(batch.slice(i, i + 100));
    }
    commentCount = batch.length;
  }

  // Import bans
  // ⚠ 这一支【没有逐条校验】：缺 ip_hash 时 bind(undefined) 会抛错 → 整个请求 500，
  //   而上面已经写入的评论批次不会回滚。
  let banCount = 0;
  if (Array.isArray(bans)) {
    const batch = (bans as Record<string, unknown>[]).map((b) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO banned_ips (ip_hash, reason, banned_at) VALUES (?, ?, ?)",
      ).bind(b.ip_hash, b.reason ?? "", b.banned_at ?? new Date().toISOString()),
    );
    for (let i = 0; i < batch.length; i += 100) {
      await env.DB.batch(batch.slice(i, i + 100));
    }
    banCount = batch.length;
  }

  // Import mod_log
  // ⚠ 同样没有逐条校验。而且 mod_log.id 是主键 + INSERT OR REPLACE：
  //   导入的 id 若与现有审计行相同会【覆盖历史审计】，这一点在做合并式恢复时要小心。
  let modLogCount = 0;
  if (Array.isArray(modLogEntries)) {
    const batch = (modLogEntries as Record<string, unknown>[]).map((m) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO mod_log (id, action, actor, comment_id, slug, reason, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        m.id, m.action, m.actor ?? "admin", m.comment_id ?? null,
        m.slug ?? null, m.reason ?? "", m.metadata ?? "{}", m.created_at ?? new Date().toISOString(),
      ),
    );
    for (let i = 0; i < batch.length; i += 100) {
      await env.DB.batch(batch.slice(i, i + 100));
    }
    modLogCount = batch.length;
  }

  // 汇总审计：只记条数，不逐条记（这是唯一有 mod_log 的导入痕迹）
  await logModAction(env.DB, "import", "admin", {
    reason: `Imported ${commentCount} comments, ${banCount} bans, ${modLogCount} mod_log entries`,
  });

  return new Response(JSON.stringify({
    ok: true, comments: commentCount, bans: banCount, modLog: modLogCount,
  }), { status: 200, headers: JSON_HEADERS });
}

/**
 * DELETE /admin/gdpr/:ip_hash —— GDPR "被遗忘权"擦除。
 *
 * 【做什么】
 *   拿一个 ip_hash，一次 batch 删掉它在三张表里的全部痕迹：
 *     comments（他的评论）、rate_limits（他的限流计数）、banned_ips（他的封禁）
 *   返回各表实际删除的行数。
 *
 * 【为什么用 env.DB.batch】
 *   batch 在 D1 上是【单事务】执行的：三条 DELETE 要么都生效要么都不生效，
 *   不会留下"评论删了但限流计数还在"的半成品状态。
 *   返回数组的顺序 = 传入 prepare 的顺序，所以下面能按下标安全取值。
 *
 * ⚠【删除并不完整 —— 这条最值得注意】
 *   ① mod_log 里的行【不删】。而且本函数紧接着写入的那条审计，
 *      把 ip_hash 【明文】写进了 reason：
 *        "GDPR erasure for ip_hash <hash>: N comments, ..."
 *      于是被遗忘者的假名标识符依然留在库里，只是散落在审计表；
 *      handleExport 还会把它一起导出。
 *      这是"审计留痕"与"彻底遗忘"的真实冲突，当前代码选择审计优先。
 *      ★ 要真做干净：reason 里去掉 ip_hash（或换成不可逆的短摘要），
 *      并考虑对 mod_log 做匿名化 —— 但那样就丢掉了"谁被删过"的追溯能力，
 *      这是产品决策，别当成 bug 顺手改。
 *   ② ip_hash 是 hashIp() 产出的【假名】而不是原始 IP：严格说擦除的是假名。
 *      只要盐还在，理论上仍可能被反查，所以别把它当"已匿名"数据。
 *   ③ 已经烘焙进静态 HTML 的评论，Worker【删不掉】。
 *      ⚠ 必须再 POST /admin/rebuild 让站点重建，否则被删的评论在线上仍然
 *      公开可见，直到下一次构建。这是整条擦除流程里最容易漏的一步。
 *
 * ⚠ 路由正则 /^\/admin\/gdpr\/([^/]+)\/?$/ 比别处宽松（任意非斜杠字符），
 *   路径里能塞进奇怪字符；好在是 bind 参数化，不构成注入。
 *   ★ 想收紧就要求它是十六进制摘要，例如 /([a-f0-9]{8,64})/。
 *
 * ★ 自定义提示：想按别的标识擦除（邮箱、评论 id、slug），在这里加一条 DELETE
 *   并保持 batch 的原子性；同时想清楚 handleExport / handleImport 要不要跟着动。
 */
export async function handleGdprDelete(ipHash: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  // ⚠ 顺序敏感：下面按下标 [0][1][2] 取结果，D1 的 batch 返回值与 prepare 顺序一一对应。
  // ★ 想再删一类数据（比如 mod_log），加在这里并同步下面的解构与响应字段。
  const [commentsResult, rateLimitsResult, bansResult] = await env.DB.batch([
    env.DB.prepare("DELETE FROM comments WHERE ip_hash = ?").bind(ipHash),
    env.DB.prepare("DELETE FROM rate_limits WHERE ip_hash = ?").bind(ipHash),
    env.DB.prepare("DELETE FROM banned_ips WHERE ip_hash = ?").bind(ipHash),
  ]);

  // meta.changes = 这条 DELETE 实际删掉的行数（0 表示本来就没有，不算错误）
  const deletedComments = commentsResult.meta.changes;
  const deletedRateLimits = rateLimitsResult.meta.changes;
  const deletedBans = bansResult.meta.changes;

  // ⚠ 这条审计 reason 里带了 ip_hash 明文 —— 见函数头 ⚠ ①：它让"擦除"留了尾巴。
  await logModAction(env.DB, "gdpr_delete", "admin", {
    reason: `GDPR erasure for ip_hash ${ipHash}: ${deletedComments} comments, ${deletedRateLimits} rate_limits, ${deletedBans} bans deleted`,
  });

  return new Response(JSON.stringify({
    ok: true,
    comments: deletedComments,
    rateLimits: deletedRateLimits,
    bans: deletedBans,
  }), { status: 200, headers: JSON_HEADERS });
}
