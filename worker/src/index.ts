/**
 * ============================================================================
 * worker/src/index.ts —— Cloudflare Worker 的总入口（路由表 + 全局中间件）
 * ============================================================================
 *
 * 【这个文件在整个系统里的位置】
 *
 *   ┌──────────────┐  ① 访客用纯 HTML 表单 POST /submit
 *   │ 访客的浏览器 │ ─────────────────────────────────────┐
 *   └──────────────┘                                     ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │              这个 Worker（Cloudflare 边缘节点）                │
 *   │                                                              │
 *   │   export default.fetch()      ← 本文件，唯一对外入口           │
 *   │         └─ route()            ← 本文件，路由分发               │
 *   │              ├─ /submit        → submit.ts      写评论        │
 *   │              ├─ /comments/:slug→ comments-api.ts 读已批准评论  │
 *   │              ├─ /admin/*       → admin-api.ts / dashboard.ts  │
 *   │              └─ 其它            → 静态资源（可选）+ 注释预览    │
 *   └───────────────────────────┬──────────────────────────────────┘
 *                               ▼
 *                        Cloudflare D1（SQLite）
 *
 *   ┌─────────────────┐  ② 构建时：SSG 调 fetchComments() 把评论烘焙进 HTML
 *   │ 你的静态站点生成器│ ────────────────────────────────────────────┐
 *   └─────────────────┘                                              ▼
 *                                                         发布的静态 HTML
 *                                              （访客读到的是纯静态页面，零 JS）
 *
 * 【设计要点，读代码前先知道这三条】
 *
 *   1. 读路径上没有数据库查询。
 *      评论是构建时被"烘焙"进 HTML 的，所以线上读评论 = 读静态文件，
 *      快且永远不会被 D1 拖慢。D1 只在【写评论】和【后台管理】时被访问。
 *
 *   2. Worker 同时也是可选的文件服务器。
 *      如果 wrangler.toml 里配了 [assets]，Worker 会顺便托管你的静态站。
 *      好处是访客提交完评论能【立刻看到自己的评论】（见 html-rewriter.ts），
 *      而不必等下一次重建。不配也能跑，只是少了这个即时预览。
 *
 *   3. 管理面和公开面共用同一个 Worker，靠 URL 前缀 /admin/ 区分。
 *      addSecurityHeaders() 会根据这个前缀施加不同的安全策略（见下），
 *      所以【新增管理端点时，路径必须放在 /admin/ 下】，否则拿不到那些保护。
 */
import type { Env } from "./types.js";
import { handleSubmit } from "./submit.js";
import { serveWithFreshComments } from "./html-rewriter.js";
import { classifyComment } from "./classify.js";
import { requireAuth } from "./auth.js";
import { handleGetModLog } from "./mod-log.js";
import { handleDashboard } from "./dashboard.js";
import {
  handleGetComments,
  handleApprove,
  handleReject,
  handleSpam,
  handleUnapprove,
  handleDeleteComment,
} from "./comments-api.js";
import {
  handleGetStats,
  handleListComments,
  handleSetMode,
  handleGetMode,
  handleBanIp,
  handleUnbanIp,
  handleListBans,
  handleBulkApprove,
  handleExport,
  handleImport,
  handleGdprDelete,
  handleRebuild,
} from "./admin-api.js";

/**
 * 管理动作之后，决定"回 JSON 还是跳回面板"。
 *
 * 【解决什么问题】
 * 同一个端点要被两类调用者使用：
 *   - 浏览器里的 <form>（管理面板上的"批准 / 垃圾 / 拒绝"按钮）
 *   - API / CLI 调用者（fetch、npx ziscus）
 *
 * 两边的期望不同：浏览器希望跳回面板看到刷新后的列表，
 * CLI 希望拿到原始 JSON 自己处理。
 *
 * 【怎么区分】
 * 靠 Accept 请求头，而不是靠 URL 参数：
 *   浏览器导航  → Accept 里含 text/html
 *   fetch/CLI  → Accept 是 *／* 或 application/json
 *
 * ⚠ 源码注释特意提到：以前是用 ?token= 参数区分的，
 *   但那样【密钥会出现在 URL 里】—— 会被写进浏览器历史、Referer、
 *   服务器日志。所以改成看 Accept 头，密钥只走 Authorization 头。
 *   ★ 你要自定义时别把这个改回 URL 参数。
 *
 * @param alsoOn 额外允许重定向的状态码判断。比如"重建失败"对浏览器来说
 *               也算"这次操作结束了"，应该跳回面板看失败原因（面板会显示），
 *               而不是把一段 JSON 糊在屏幕上。
 */
function dashboardRedirect(
  request: Request,
  res: Response,
  opts: { alsoOn?: (status: number) => boolean } = {},
): Response {
  const accept = request.headers.get("Accept") ?? "";
  if ((res.ok || opts.alsoOn?.(res.status)) && accept.includes("text/html")) {
    return new Response(null, {
      status: 303,
      headers: { Location: "/admin/dashboard" },
    });
  }
  return res;
}

/**
 * 给响应统一加安全头。返回一个【新的 Response】，不改原对象。
 *
 * 为什么要 `new Response(res.body, ...)` 而不是 `res.headers.set(...)`：
 * Worker 里某些 Response（尤其从 ASSETS 拿到的）其 headers 是只读的，
 * 直接 set 会抛异常。重建一个是最稳的写法。
 *
 * 【管理面 vs 公开面，策略不同】
 *
 *                   公开页（评论页等）        管理页（/admin/*）
 *   X-Frame-Options      SAMEORIGIN              DENY
 *                        （允许同源 iframe 嵌入）  （完全禁止被 iframe）
 *   Referrer-Policy      strict-origin-...       no-referrer
 *                                                 （连域名都不外泄）
 *   X-Robots-Tag         —                       noindex, nofollow
 *   Cache-Control        —                       no-store
 *
 * 管理面的策略是"纵深防御"：
 *   管理页已鉴权，所以不希望它被搜索引擎收录、不希望出现在共享缓存里、
 *   也不希望它作为 Referer 泄露给任何外部链接。
 *
 * @param isAdmin 由调用方根据 pathname 是否以 /admin/ 开头判断
 */
function addSecurityHeaders(res: Response, isAdmin: boolean): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", isAdmin ? "DENY" : "SAMEORIGIN");
  // Admin pages are authenticated and private: use the strictest referrer policy
  // (don't even leak the bare origin), and keep them out of any search index or
  // shared cache — defense in depth for the admin surface.
  headers.set(
    "Referrer-Policy",
    isAdmin ? "no-referrer" : "strict-origin-when-cross-origin",
  );
  if (isAdmin) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("Cache-Control", "no-store");
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * 路由分发。整个 Worker 的 URL 契约都在这一个函数里。
 *
 * 【完整路由表】（★ = 需要 Authorization Bearer 鉴权）
 * ⚠ 本表已逐条对照下方代码核对（含 index.test.ts 使用的路径）。
 *   早先版本的表写错了 /admin/bulk-approve、/admin/gdpr-delete、POST /admin/unban，
 *   与代码不符 —— 已修正。**改路由时请同步更新这张表。**
 *
 *   方法   路径                      作用                             处理函数
 *   ────────────────────────────────────────────────────────────────────────────
 *   OPTIONS 任意                     CORS 预检，直接 204               内联
 *   POST   /submit                   提交评论                          submit.ts
 *   GET    /submit                   误用（浏览器刷新）→ 302 回首页     内联
 *   GET    /comments/:slug           取已批准评论（JSON，供 SSG 构建）   comments-api.ts
 *   DELETE /comments/:id         ★   永久删除                          comments-api.ts
 *   POST   /approve/:id          ★   批准                              comments-api.ts
 *   POST   /reject/:id           ★   拒绝                              comments-api.ts
 *   POST   /spam/:id             ★   标记垃圾                          comments-api.ts
 *   POST   /unapprove/:id        ★   撤销批准                          comments-api.ts
 *   GET    /admin/dashboard      ★   管理面板（服务端渲染 HTML）         dashboard.ts
 *   GET    /admin/stats          ★   统计数字                          admin-api.ts
 *   GET    /admin/comments       ★   评论列表（分页/筛选）               admin-api.ts
 *   GET    /admin/mode           ★   读评论开关/待审模式                 admin-api.ts
 *   POST   /admin/mode           ★   改模式                            admin-api.ts
 *   POST   /admin/ban            ★   封 IP                             admin-api.ts
 *   GET    /admin/bans           ★   封禁列表                          admin-api.ts
 *   DELETE /admin/ban/:ip_hash   ★   解封                              admin-api.ts
 *   GET    /admin/mod-log        ★   操作审计日志                       mod-log.ts
 *   GET    /admin/export         ★   导出（备份/迁移）                   admin-api.ts
 *   POST   /admin/import         ★   导入                              admin-api.ts
 *   POST   /admin/bulk/approve   ★   批量批准                          admin-api.ts
 *   POST   /admin/rebuild        ★   手动触发重建                       admin-api.ts
 *   POST   /admin/classify       ★   试跑 AI 分类（调试用）              classify.ts
 *   DELETE /admin/gdpr/:ip_hash  ★   按 IP 删除（GDPR 被遗忘权）         admin-api.ts
 *   POST   /admin/pause/:slug    ★   暂停某一页的评论                   内联
 *   DELETE /admin/pause/:slug    ★   恢复某一页的评论                   内联
 *   其它   任意                      静态资源（有 ASSETS 时）+ 即时预览   html-rewriter.ts
 *
 * 【加新端点时的注意事项】
 *   - 要鉴权的端点【必须放在 /admin/ 下】，否则 addSecurityHeaders() 不会
 *     给它加 no-store / noindex / DENY 那套保护。
 *   - ⚠ 但 /approve /reject /spam /unapprove /comments 这几个管理端点挂在
 *     /admin/ 之外（历史原因），所以**拿不到那套安全头**。这是本项目一个
 *     可以改进的地方：把它们收敛到 /admin/ 下。
 *   - /admin/ 之下的端点各自负责调 requireAuth()（本文件里只有 /admin/rebuild
 *     和 /admin/classify 是内联处理的，其余在各自模块里鉴权）。
 *     ⚠ 新增管理端点时【极易忘记鉴权】—— 这是最需要小心的一类改动。
 *   - 路由是一长串手写的 if/match，端点多了会难维护。
 *     ★ 可以考虑改成 (method, pattern, handler) 的数组表。
 */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // ── CORS 预检 ───────────────────────────────────────────────────────────
  // 浏览器发跨域请求前会先发 OPTIONS，这里必须回 204 并声明允许的来源。
  //
  // ⚠ 公开端点用 "*"（谁都能读评论 JSON），
  //   而管理端点【只允许 ALLOWED_ORIGINS 里的第一个 host】——
  //   这实际上把管理 API 锁成了同源可用，是 CSRF 防护的一部分。
  if (request.method === "OPTIONS") {
    const isAdmin = path.startsWith("/admin/");
    const allowedOrigin = isAdmin
      ? ((env.ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean)[0] ?? "")
      : "*";
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // /submit — comment submission
  if (path === "/submit") {
    if (request.method === "POST") return handleSubmit(request, env);
    // GET /submit (e.g. browser refresh) → redirect to homepage
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }

  // GET /comments/:slug — approved comments as JSON
  // DELETE /comments/:id — permanent delete (admin)
  const commentsMatch = path.match(/^\/comments\/([a-z0-9-]+)\/?$/);
  if (commentsMatch) {
    if (request.method === "GET")
      return handleGetComments(commentsMatch[1]!, env);
    if (request.method === "DELETE")
      return handleDeleteComment(commentsMatch[1]!, request, env);
  }

  // POST /approve/:id
  const approveMatch = path.match(/^\/approve\/([a-z0-9]+)\/?$/);
  if (approveMatch && request.method === "POST") {
    const res = await handleApprove(approveMatch[1]!, request, env);
    return dashboardRedirect(request, res);
  }

  // POST /reject/:id
  const rejectMatch = path.match(/^\/reject\/([a-z0-9]+)\/?$/);
  if (rejectMatch && request.method === "POST") {
    const res = await handleReject(rejectMatch[1]!, request, env);
    return dashboardRedirect(request, res);
  }

  // POST /spam/:id
  const spamMatch = path.match(/^\/spam\/([a-z0-9]+)\/?$/);
  if (spamMatch && request.method === "POST") {
    const res = await handleSpam(spamMatch[1]!, request, env);
    return dashboardRedirect(request, res);
  }

  // POST /unapprove/:id
  const unapproveMatch = path.match(/^\/unapprove\/([a-z0-9]+)\/?$/);
  if (unapproveMatch && request.method === "POST") {
    return handleUnapprove(unapproveMatch[1]!, request, env);
  }

  // /admin/* — authenticated management endpoints
  if (path.startsWith("/admin/")) {
    if (path === "/admin/dashboard" && request.method === "GET")
      return handleDashboard(request, env);
    if (path === "/admin/stats" && request.method === "GET")
      return handleGetStats(request, env);
    if (path === "/admin/comments" && request.method === "GET")
      return handleListComments(request, env);
    if (path === "/admin/mode" && request.method === "POST")
      return handleSetMode(request, env);
    if (path === "/admin/mode" && request.method === "GET")
      return handleGetMode(request, env);
    if (path === "/admin/ban" && request.method === "POST")
      return handleBanIp(request, env);
    if (path === "/admin/bans" && request.method === "GET")
      return handleListBans(request, env);
    if (path === "/admin/mod-log" && request.method === "GET")
      return handleGetModLog(request, env);
    if (path === "/admin/export" && request.method === "GET")
      return handleExport(request, env);
    if (path === "/admin/import" && request.method === "POST")
      return handleImport(request, env);
    if (path === "/admin/bulk/approve" && request.method === "POST")
      return handleBulkApprove(request, env);
    if (path === "/admin/rebuild" && request.method === "POST") {
      const res = await handleRebuild(request, env);
      return dashboardRedirect(request, res, { alsoOn: (s) => s >= 500 });
    }

    if (path === "/admin/classify" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const { author, body } = (await request.json()) as {
        author?: string;
        body?: string;
      };
      if (!author || !body)
        return new Response("Missing author or body", { status: 400 });
      const classification = await classifyComment(author, body, env);
      return new Response(JSON.stringify({ classification }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const unbanMatch = path.match(/^\/admin\/ban\/([a-z0-9]+)\/?$/);
    if (unbanMatch && request.method === "DELETE")
      return handleUnbanIp(unbanMatch[1]!, request, env);

    const gdprMatch = path.match(/^\/admin\/gdpr\/([^/]+)\/?$/);
    if (gdprMatch && request.method === "DELETE")
      return handleGdprDelete(gdprMatch[1]!, request, env);

    // Per-slug pause: POST to pause, DELETE to reopen
    const pauseMatch = path.match(/^\/admin\/pause\/([a-z0-9-]+)\/?$/);
    if (pauseMatch) {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const pauseSlug = pauseMatch[1]!;
      if (request.method === "POST") {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')",
        )
          .bind(`slug_paused:${pauseSlug}`)
          .run();
        return new Response(
          JSON.stringify({ ok: true, slug: pauseSlug, paused: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM meta WHERE key = ?")
          .bind(`slug_paused:${pauseSlug}`)
          .run();
        return new Response(
          JSON.stringify({ ok: true, slug: pauseSlug, paused: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
  }

  // ── Flash cookie：让评论者立刻看到自己刚发的评论 ───────────────────────
  //
  // 【这是整个项目最巧的一个设计，值得理解】
  //
  // 问题：评论被写进 D1 了，但页面是【构建时烘焙的静态 HTML】，
  //       所以访客刷新看到的还是没有自己评论的旧页面，要等下次重建。
  //       体验很差。
  //
  // 解法（PRG 模式 + flash cookie + HTMLRewriter）：
  //   submit.ts 插入成功后  →  303 重定向并种一个 120 秒的 cookie
  //                          ziscus_posted=<slug>
  //   浏览器跟着重定向回来  →  命中这里
  //                          →  serveWithFreshComments() 从 D1 现查评论，
  //                             用 HTMLRewriter 现场替换掉 #comments 区块
  //                          →  顺手把 cookie 清掉（Max-Age=0）
  //
  // 所以"即时看到自己的评论"只在【Worker 同时托管静态站（env.ASSETS 存在）】
  // 时可用。不配 [assets] 就退化成普通的重定向。
  //
  // ★ 自定义提示：想改"提交后看到什么"，改 html-rewriter.ts 里的
  //   renderComment()，或者这里的 cookie 逻辑（比如延长到更久）。
  const cookies = request.headers.get("Cookie") ?? "";
  const flashMatch = cookies.match(/ziscus_posted=([a-z0-9-]+)/);
  if (flashMatch && env.ASSETS && request.method === "GET") {
    const slug = flashMatch[1]!;
    const original = await serveWithFreshComments(
      slug,
      url.pathname,
      request,
      env,
    );
    // Build new response with mutable headers to clear the flash cookie
    const headers = new Headers(original.headers);
    headers.set(
      "Set-Cookie",
      "ziscus_posted=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly",
    );
    return new Response(original.body, { status: original.status, headers });
  }

  // ── 没有 API 路由匹配 → 当作静态资源请求（可选功能）──────────────────
  // 只有当 wrangler.toml 配了 [assets] 时 env.ASSETS 才存在。
  //
  // 这里有一个"按页暂停评论"的处理：从 meta 表读出所有
  // slug_paused:<slug> 记录，如果当前这个 HTML 页面里评论表单的 slug
  // 命中，就把表单元素删掉、换成一句"评论已暂停"。
  //
  // ⚠ 注意 formIsPaused 是【闭包外的变量】，被三个 HTMLRewriter 处理器
  //   共享。它依赖 HTMLRewriter 按文档顺序调用处理器 —— 先处理
  //   input[name='slug']（此时确定是否暂停），再处理 div/button。
  //   **这是隐式时序依赖**：如果你往表单里加了新的元素或改了顺序，
  //   这段会失效。★ 想重构的话，建议改成先读出 slug 再决定，
  //   而不是依赖处理器调用顺序。
  if (env.ASSETS) {
    const assetRes = await env.ASSETS.fetch(request);
    // If this is an HTML page, check for paused slugs and hide comment forms
    const ct = assetRes.headers.get("Content-Type") ?? "";
    if (ct.includes("text/html") && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT key FROM meta WHERE key LIKE 'slug_paused:%'",
      ).all<{ key: string }>();
      if (results && results.length > 0) {
        const pausedSlugs = new Set(
          results.map((r) => r.key.replace("slug_paused:", "")),
        );
        let formIsPaused = false;
        const pausedMsg =
          '<p style="color: var(--color-muted, #888); font-style: italic; margin: 1rem 0;">Comments are paused on this page.</p>';
        const rewritten = new HTMLRewriter()
          .on(".comment-form input[name='slug']", {
            element(el) {
              const val = el.getAttribute("value") ?? "";
              formIsPaused = pausedSlugs.has(val);
              if (formIsPaused) el.remove();
            },
          })
          .on(".comment-form div, .comment-form button", {
            element(el) {
              if (formIsPaused) el.remove();
            },
          })
          .on(".comment-form", {
            element(el) {
              el.onEndTag((end) => {
                if (formIsPaused) end.before(pausedMsg, { html: true });
              });
            },
          })
          .transform(assetRes);
        return new Response(rewritten.body, {
          status: assetRes.status,
          headers: assetRes.headers,
        });
      }
    }
    return assetRes;
  }
  return new Response("Not found", { status: 404 });
}

/**
 * Cloudflare Worker 的模块入口。
 *
 * 【为什么这里只有薄薄一层】
 *   fetch() 只做两件与业务无关的事：
 *     1. OPTIONS 预检直接放行（不加安全头，保持最小响应）
 *     2. 其余请求先判断是不是 /admin/，交给 route() 后再统一裹上安全头
 *
 *   业务逻辑全部在 route() 及其调用的模块里。
 *   这样做的价值是：**安全头只在一个地方加**，不会漏。
 *   如果你以后新增了入口（比如 queue/scheduled 处理器），
 *   记得也要在那里考虑安全头。
 */
export default {
  // export default 将包含的内容作为本文件的默认导出
  // Cloudflare 规定：你的入口文件必须导出这样一个对象，里面含 fetch 方法。 这就是平台找你的方式。
  async fetch(request: Request, env: Env): Promise<Response> {
    // :Request是类型名，运行时不存在，所谓typescripts
    // CORS 预检：直接返回，不加安全头（预检响应越简单越好，避免多余的头干扰浏览器判断）
    if (request.method === "OPTIONS") return route(request, env);
    // === 严格相等，== 会做类型转换
    const isAdmin = new URL(request.url).pathname.startsWith("/admin/");
    const res = await route(request, env);
    // 因为route是async函数，不会立刻给答案，所以await等待
    return addSecurityHeaders(res, isAdmin);
  },
};
