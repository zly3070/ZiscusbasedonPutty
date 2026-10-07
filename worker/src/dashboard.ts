/**
 * ============================================================================
 * worker/src/dashboard.ts —— 管理面板（一整个服务端渲染的 HTML 页面）
 * ============================================================================
 *
 * 【这个文件在整个系统里的位置】
 *
 *   浏览器 GET /admin/dashboard
 *          ▼
 *   index.ts  route()  →  本文件 handleDashboard()
 *          ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 纯 HTML 页面，零 JavaScript（和访客端同一个哲学）             │
 *   │   所有按钮都是普通 <form method="POST">，直接打管理端点：      │
 *   │     /approve/:id  /spam/:id  /reject/:id   → comments-api.ts │
 *   │     /admin/rebuild                          → admin-api.ts   │
 *   │   分页与搜索是纯 <a href> / GET 表单                          │
 *   └──────────────────────────────────────────────────────────────┘
 *
 *   页面上的数据（8 条查询并行发出）：
 *     comments → 各状态计数 / Top10 页面 / 最近活动 5 条
 *                / pending 队列（分页 20 条 + 子串搜索）/ 最近 5 条 spam
 *     meta     → comments_mode（on / off / paused）
 *     meta.last_rebuild_result（getLastRebuildResult）→ 重建管线卡片
 *
 * 【三条设计取舍】
 *   1. 定位是"快速清空待审队列"，不是全功能后台：每页 20 条 + 一个搜索框。
 *      要复杂筛选 / 批量操作，请用 /admin/comments（JSON）+ CLI。
 *   2. 鉴权靠 Authorization: Bearer（requireAuth），【密钥绝不进 URL】——
 *      分页/搜索链接里只有 q 和 page。代价见下面的 ⚠。
 *   3. 输出是模板字符串拼 HTML，没有模板引擎。所有动态值都要过
 *      esc() / esc(unescapeHtml(...))，见安全小节。
 *
 * 【⚠ 转义纪律 —— 这个文件最危险的地方】
 *   库里的 author/body 是【入库时已转义】的（见 html.ts 的存储不变量），
 *   所以每个输出点都必须写成 esc(unescapeHtml(stored))：
 *       unescapeHtml 还原成人读文本 → esc 再转义一次交给 HTML
 *   漏掉任一半的后果：
 *       只 esc 不 unescape → 用户看到 &lt;b&gt; 字面实体（功能 bug）
 *       只 unescape 不 esc → XSS（安全 bug，而且库里的转义救不了这条路径）
 *
 *   ⚠ 本文件的 esc() 是【本地副本】：只处理 & < > "，不处理 ' 也不剔除 NUL，
 *     与 html.ts 的 escHtml() 并不完全相同。当前之所以安全：
 *     模板里所有属性都用双引号（' 在双引号属性里无需转义），正文在文本节点里。
 *     ★ 但如果以后你在这里用【单引号】包属性，必须改用 escHtml()，
 *       否则就是一个属性逃逸点。
 *
 * 【⚠ 面板按钮的一个前提】
 *   所有 <form method="POST"> 都发不出 Authorization 头，而每个管理端点都要
 *   Bearer 鉴权 → 浏览器必须装了会注入请求头的扩展（ModHeader / Requestly）
 *   才能点得动。这是项目已知的体验痛点（README / auth.ts 也提到了）。
 *   ★ 想改善：加一个 /admin/login，用 HttpOnly Cookie 换 token（记得自己处理 CSRF）。
 *
 * ★ 自定义提示：
 *   - 改外观 → 直接改下面的内联 <style>（无外部 CSS，保持零 JS）
 *   - 改每页条数 → PAGE_SIZE
 *   - 加状态筛选 / 批量操作按钮 → 模板和查询一起改，并确认新按钮指向的端点在
 *     index.ts 路由表里真实存在且已鉴权（否则点了就是 404 或 401）
 */
import type { Env } from "./types.js";
import { requireAuth } from "./auth.js";
import { getLastRebuildResult } from "./debounce.js";
import { unescapeHtml } from "./html.js";

// 待审队列每页条数。★ 改这里就够了：SQL 的 LIMIT 和分页计算都用它，
// 但注意它被【插值进 SQL 模板】（见 handleDashboard 的 ⚠）。
const PAGE_SIZE = 20;

/**
 * GET /admin/dashboard —— 渲染管理面板这一整页 HTML。
 *
 * 【做什么】8 条查询（Promise.all 并行）→ 拼一个字符串 → 返回 text/html。
 *   唯一的动态输入是 query string：?page=N&q=关键词（page 非法时回落到 1）。
 *
 * 【为什么 8 条查询敢并行 / 为什么不做成一次聚合】
 *   这些都是小结果集的读操作，P95 都在毫秒级；并行比串行省 7 个往返。
 *   代价是"面板一次刷新 = 8 个 D1 查询"，所以★别在 panel 上做轮询自动刷新。
 *
 * ⚠ 分页只作用于 pending 队列：Top pages / Latest activity / Recent spam
 *   是固定条数（10 / 5 / 5），不受 page 影响。加筛选时注意别让用户以为
 *   上下两部分是同一个分页。
 *
 * ⚠ 搜索是 LIKE '%q%' 子串匹配，【没有转义 % 和 _】：
 *   搜 "%" 会匹配所有行，搜 "a_b" 里的 _ 会被当成"任意单字符"。
 *   这不是注入（值走 bind），是语义偏差；而且只搜 pending 队列、只搜 body 和 author。
 *
 * ⚠ LIMIT / OFFSET 是【模板字符串直接插值】进 SQL 的，没走 bind。
 *   当前安全的原因：offset 由 page * PAGE_SIZE 算出，而 page 已经过
 *   Number.isFinite + >= 1 归一，所以插进去的一定是数字。
 *   ★ 一旦有【来自 URL 的字符串】被插进这两个查询模板，这里立刻变成注入点。
 *
 * ⚠ page 可以超过总页数（?page=999 → 空列表 + "Page 999 of N"），不做夹取、
 *   不报错。调用方（CLI/脚本）不要假设返回的行数和页号一致。
 *
 * ⚠ likeVal 要为两个占位符（body / author）各 bind 一次 —— 也就是必须
 *   bind(likeVal, likeVal)。★ 以后往 searchFilter 里加一个 LIKE 条件，
 *   就要多加一个 bind 参数，少一个就会报绑定数量不匹配。
 *
 * 返回：200 text/html + Cache-Control: no-store。
 *   index.ts 之后还会再给它套一层管理面安全头（noindex / DENY / no-referrer），
 *   所以这里加的那份不是唯一防线。
 */
export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
  // 归一化 page：NaN（?page=abc）和 <1 都回到第 1 页，避免算出负 OFFSET
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
  const q = (url.searchParams.get("q") ?? "").trim();
  const offset = (page - 1) * PAGE_SIZE;

  // Build pending query with optional search filter
  // 搜索片段是【常量字符串】，只有值（likeVal）走 bind —— 加条件时保持这个性质
  const searchFilter = q ? " AND (body LIKE ? OR author LIKE ?)" : "";
  const likeVal = q ? `%${q}%` : null;

  // pendingCountQuery 为两个 LIKE 占位符准备（下面 bind 两次）；
  // pendingDataQuery 里的 ${PAGE_SIZE} / ${offset} 是数字插值（见上面的 ⚠）
  const pendingCountQuery = `SELECT COUNT(*) as count FROM comments WHERE status = 'pending'${searchFilter}`;
  const pendingDataQuery = `SELECT id, slug, author, body, created_at FROM comments WHERE status = 'pending'${searchFilter} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  // 8 条查询【并行】发出（见函数头的取舍说明）。
  // ⚠ pending 相关的两条用三元表达式分别 bind 两次 likeVal：
  //   因为 SQL 里有两个 ? 占位符（body / author）。没有搜索词时不能 bind(null)，
  //   所以走的是不带 bind 的那一支 —— ★ 改这里时两支都要照顾到。
  const [statsResult, topPagesResult, latestPagesResult, pendingCountResult, pendingResult, spamResult, modeRow, lastRebuild] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) as count FROM comments GROUP BY status")
      .all<{ status: string; count: number }>(),
    env.DB.prepare("SELECT slug, COUNT(*) as count FROM comments WHERE status = 'approved' GROUP BY slug ORDER BY count DESC LIMIT 10")
      .all<{ slug: string; count: number }>(),
    env.DB.prepare("SELECT slug, COUNT(*) as count, MAX(created_at) as latest FROM comments WHERE status = 'approved' GROUP BY slug ORDER BY latest DESC LIMIT 5")
      .all<{ slug: string; count: number; latest: string }>(),
    likeVal !== null
      ? env.DB.prepare(pendingCountQuery).bind(likeVal, likeVal).first<{ count: number }>()
      : env.DB.prepare(pendingCountQuery).first<{ count: number }>(),
    likeVal !== null
      ? env.DB.prepare(pendingDataQuery).bind(likeVal, likeVal).all<{ id: string; slug: string; author: string; body: string; created_at: string }>()
      : env.DB.prepare(pendingDataQuery).all<{ id: string; slug: string; author: string; body: string; created_at: string }>(),
    // 最近 5 条被拦下的 spam，只展示不给操作（spam 在面板上被视为"已定案"）
    env.DB.prepare("SELECT id, slug, author, body, created_at FROM comments WHERE status = 'spam' ORDER BY created_at DESC LIMIT 5")
      .all<{ id: string; slug: string; author: string; body: string; created_at: string }>(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'comments_mode'").first<{ value: string }>(),
    // 重建管线的状态（由 debounce.ts 写入 meta.last_rebuild_result）
    getLastRebuildResult(env.DB),
  ]);

  const stats: Record<string, number> = { pending: 0, approved: 0, rejected: 0, spam: 0 };
  for (const row of statsResult.results ?? []) {
    stats[row.status] = row.count;
  }

  const topPages = topPagesResult.results ?? [];
  const latestPages = latestPagesResult.results ?? [];
  const pending = pendingResult.results ?? [];
  const recentSpam = spamResult.results ?? [];
  // ⚠ 兜底 "on" 在 admin-api.ts / submit.ts / comments-api.ts 里各有一份，
  //   几处必须一致，否则会出现"面板显示 on、但实际按别的模式处理"
  const commentsMode = modeRow?.value ?? "on";
  // 只表示"AI binding 配上了"。真正的 AI 降级行为（超时/异常 → review）在
  // classify.ts 里，⚠ 所以这个开关只说明"AI 会被调用"，不代表"AI 一定放行"
  const aiModEnabled = !!env.AI_MOD;

  // ── 重建管线卡片 ────────────────────────────────────────────────────────
  // 这是运维【唯一】能看出"GitHub dispatch 到底被接受没有"的地方
  // （过去一个失效的 token 只会静默失败，站点永远不更新而且没人知道原因）。
  // 三种终态：ok（派发成功）/ not configured（缺配置）/ failed（被拒或网络错），
  // 未跑过任何一次则是 muted 的 "never run"。
  // ⚠ rebuildClass / rebuildLabel 是写死的常量，安全；但 rebuildDetail 里
  //   拼了 lastRebuild.error（GitHub 的返回文案）和 slug，所以都过了 esc() ——
  //   ★ 加新字段进这条 detail 时别忘了同样处理。
  // Rebuild pipeline card — the one place an operator can see that the
  // GitHub dispatch is actually being accepted (a dead token used to fail silently).
  let rebuildClass = "muted";
  let rebuildLabel = "never run";
  let rebuildDetail = "Fires on the first approved comment.";
  if (lastRebuild) {
    // "2026-04-07T01:02:03Z" → "2026-04-07 01:02 UTC"（秒和 T 都截掉，好读）
    const when = `${lastRebuild.at.replace("T", " ").slice(0, 16)} UTC`;
    if (lastRebuild.dispatched) {
      rebuildClass = "on";
      rebuildLabel = "ok";
      rebuildDetail = `dispatched ${when} &middot; ${esc(lastRebuild.slug)}`;
    } else if (lastRebuild.code === "not_configured") {
      rebuildClass = "paused";
      rebuildLabel = "not configured";
      rebuildDetail = "Set GITHUB_REPO and GITHUB_TOKEN to rebuild automatically.";
    } else {
      rebuildClass = "off";
      rebuildLabel = "failed";
      rebuildDetail = `${esc(lastRebuild.error ?? "unknown error")} &middot; ${when} &middot; ${esc(lastRebuild.slug)}`;
    }
  }

  // ⚠ 待审计数只数 pending（不含 spam/rejected），所以"Pending"卡片数字
  //   和 totalPages 是同一口径；顶部的统计卡片是另一口径（全状态）。
  const totalPending = pendingCountResult?.count ?? 0;
  // Math.max(1, ...)：即使 0 条也显示"Page 1 of 1"，不会出现 "Page 1 of 0"
  const totalPages = Math.max(1, Math.ceil(totalPending / PAGE_SIZE));

  // ── 分页链接构造 ────────────────────────────────────────────────────────
  // 只带 q 和 page，【绝不带密钥】：鉴权始终走 Authorization 头。
  // ★ 如果以后要加新的筛选参数，必须在这里一起透传，否则翻页会丢掉筛选条件。
  // Build nav link helper — preserves the q param. The admin secret is never
  // placed in a URL; auth rides on the Authorization header for every request.
  function navHref(targetPage: number): string {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    p.set("page", String(targetPage));
    return `/admin/dashboard?${p.toString()}`;
  }

  // prev/next 为空时模板里就不渲染那个链接（而不是渲染一个 disabled 的假链接）
  const prevHref = page > 1 ? navHref(page - 1) : null;
  const nextHref = page < totalPages ? navHref(page + 1) : null;

  // ── 下面是整页 HTML（模板字符串）────────────────────────────────────────
  // ⚠ 模板字符串【内部不能写 // 注释】—— 那些字符会原样发给浏览器。
  //   所以关于这份模板的说明全部写在这里：
  //   ① 零 JS：没有 <script>，所有交互都是 <form> 和 <a>。★ 想加前端行为时
  //      请三思：零 JS 是这个项目最核心的卖点（见 README）。
  //   ② 样式是内联 <style>，无外部依赖：CSP 友好，也不会被第三方 CDN 拖慢。
  //   ③ 数据插值只有两种安全写法：
  //        esc(value)                  ← slug / 计数 / 自己拼的常量
  //        esc(unescapeHtml(stored))   ← 库里存的评论文本（author / body）
  //      ⚠ 例外（未过 esc() 的插值）：`class="setting-value ${commentsMode}"`
  //        以及 rebuildClass / rebuildLabel。它们当前安全，是因为
  //        commentsMode 的唯一写入口是 handleSetMode 的白名单（on/off/paused），
  //        另外两个全是本文件里的常量。
  //        ★ 换句话说这份安全性【依赖上游校验】：一旦有别的路径
  //          （handleImport 导入的 meta、或有人直接改 D1）写进带引号的值，
  //          这里就是一个存储型 XSS 落点。要加固就在插值处补 esc()。
  //   ④ 表单 action 都指向管理端点（/approve/:id、/admin/rebuild 等），
  //      提交后由 index.ts 的 dashboardRedirect() 303 跳回本页 —— 点按钮
  //      的感觉就是"原地刷新"。⚠ 这些表单发不出 Authorization 头，
  //      所以浏览器必须有注入请求头的扩展，否则每个按钮都是 401（见文件头 ⚠）。
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Admin Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem 1rem; background: #0d0d0d; color: #e0e0e0; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #fff; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: #aaa; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 1rem; }
  .stat-value { font-size: 2rem; font-weight: 700; color: #fff; }
  .stat-label { font-size: 0.85rem; color: #888; margin-top: 0.25rem; }
  .settings { display: flex; gap: 1.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .setting { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 0.75rem 1rem; }
  .setting-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
  .setting-value { font-size: 0.95rem; color: #fff; margin-top: 0.25rem; }
  .on { color: #4caf50; }
  .off { color: #f44336; }
  .paused { color: #ff9800; }
  .muted { color: #888; }
  .setting-detail { font-size: 0.8rem; color: #888; margin-top: 0.25rem; max-width: 340px; }
  .rebuild-form { margin-top: 0.4rem; }
  .rebuild { color: #4da6ff; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { text-align: left; padding: 0.5rem; border-bottom: 1px solid #333; color: #888; font-weight: normal; }
  td { padding: 0.5rem; border-bottom: 1px solid #1a1a1a; }
  .comment-body { max-width: 500px; }
  .spam-body { max-width: 500px; color: #888; white-space: pre-wrap; word-break: break-word; }
  a { color: #4da6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .actions a { margin-right: 0.75rem; font-size: 0.85rem; }
  .approve { color: #4caf50; }
  .spam-action { color: #f44336; }
  .reject { color: #ff9800; }
  .action-btn { background: none; border: none; cursor: pointer; font-size: 0.85rem; padding: 0; font-family: inherit; text-decoration: none; }
  .action-btn:hover { text-decoration: underline; }
  .search-form { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .search-form input[type="text"] { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; padding: 0.4rem 0.6rem; color: #e0e0e0; font-size: 0.9rem; }
  .search-form button { background: #333; border: 1px solid #555; border-radius: 4px; padding: 0.4rem 0.8rem; color: #e0e0e0; font-size: 0.9rem; cursor: pointer; }
  .search-form button:hover { background: #444; }
  .pagination { display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem; font-size: 0.9rem; color: #888; }
  .pagination a { color: #4da6ff; }
</style>
</head>
<body>
<h1>Admin Dashboard</h1>

<div class="settings">
  <div class="setting">
    <div class="setting-label">Comments</div>
    <div class="setting-value ${commentsMode}">${commentsMode}</div>
  </div>
  <div class="setting">
    <div class="setting-label">AI Mod</div>
    <div class="setting-value ${aiModEnabled ? "on" : "off"}">${aiModEnabled ? "on" : "off"}</div>
  </div>
  <div class="setting">
    <div class="setting-label">Moderation</div>
    <div class="setting-value">${aiModEnabled ? "AI decides (fail-closed)" : esc(env.MODERATION === "on" ? "manual review" : "auto-approve")}</div>
  </div>
  <div class="setting">
    <div class="setting-label">Rebuild pipeline</div>
    <div class="setting-value ${rebuildClass}">${rebuildLabel}</div>
    <div class="setting-detail">${rebuildDetail}</div>
    <form method="POST" action="/admin/rebuild" class="rebuild-form"><input type="hidden" name="slug" value="all"><button type="submit" class="rebuild action-btn">rebuild now</button></form>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-value">${stats.approved}</div><div class="stat-label">Approved</div></div>
  <div class="stat"><div class="stat-value">${stats.pending}</div><div class="stat-label">Pending</div></div>
  <div class="stat"><div class="stat-value">${stats.spam}</div><div class="stat-label">Spam blocked</div></div>
</div>

<h2>Top pages</h2>
<table>
  <tr><th>Page</th><th>Comments</th></tr>
  ${topPages.map((p) => `<tr><td><a href="${slugUrl(p.slug)}">${esc(p.slug)}</a></td><td>${p.count}</td></tr>`).join("\n  ")}
  ${topPages.length === 0 ? "<tr><td colspan=2>No comments yet</td></tr>" : ""}
</table>

<h2>Latest activity</h2>
<table>
  <tr><th>Page</th><th>Comments</th><th>Last comment</th></tr>
  ${latestPages.map((p: { slug: string; count: number; latest: string }) => `<tr><td><a href="${slugUrl(p.slug)}">${esc(p.slug)}</a></td><td>${p.count}</td><td>${p.latest.slice(0, 10)}</td></tr>`).join("\n  ")}
  ${latestPages.length === 0 ? "<tr><td colspan=3>No comments yet</td></tr>" : ""}
</table>

<h2>Pending queue</h2>
<form method="GET" action="/admin/dashboard" class="search-form">
  <input type="text" name="q" placeholder="Search by author or comment…" value="${esc(q)}">
  <button type="submit">Search</button>
</form>
<div class="pagination">
  <span>Showing ${pending.length} of ${totalPending} &middot; Page ${page} of ${totalPages}</span>
  ${prevHref ? `<a href="${prevHref}">&laquo; Prev</a>` : ""}
  ${nextHref ? `<a href="${nextHref}">Next &raquo;</a>` : ""}
</div>
<table>
  <tr><th>Author</th><th>Comment</th><th>Page</th><th>Date</th><th>Actions</th></tr>
  ${pending.map((c) => `<tr>
    <td>${esc(unescapeHtml(c.author))}</td>
    <td class="comment-body">${esc(unescapeHtml(c.body))}</td>
    <td>${esc(c.slug)}</td>
    <td>${c.created_at.slice(0, 10)}</td>
    <td class="actions">
      <form method="POST" action="/approve/${c.id}" style="display:inline"><button type="submit" class="approve action-btn">approve</button></form>
      <form method="POST" action="/spam/${c.id}" style="display:inline"><button type="submit" class="spam-action action-btn">spam</button></form>
      <form method="POST" action="/reject/${c.id}" style="display:inline"><button type="submit" class="reject action-btn">reject</button></form>
    </td>
  </tr>`).join("\n  ")}
  ${pending.length === 0 ? "<tr><td colspan=5>No pending comments</td></tr>" : ""}
</table>

<h2>Recent spam (${recentSpam.length})</h2>
<table>
  <tr><th>Author</th><th>Content</th><th>Date</th></tr>
  ${recentSpam.map((c) => `<tr>
    <td>${esc(unescapeHtml(c.author))}</td>
    <td class="spam-body">${esc(unescapeHtml(c.body))}</td>
    <td>${c.created_at.slice(0, 10)}</td>
  </tr>`).join("\n  ")}
  ${recentSpam.length === 0 ? "<tr><td colspan=3>No spam caught yet</td></tr>" : ""}
</table>

</body>
</html>`;

  // Cache-Control: no-store 是管理页的硬要求（不能进浏览器缓存、不能进共享缓存）。
  // index.ts 的 addSecurityHeaders() 之后还会再设一遍同样的头 —— 双保险，别删。
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * 本文件私有的 HTML 转义函数（转义 & < > " 四个字符）。
 *
 * 【为什么不直接用 html.ts 的 escHtml()】
 *   escHtml() 还额外处理 `'`（→ &#39;）并剔除 NUL 字节。本文件所有属性都用
 *   双引号包裹、评论正文都在文本节点里，所以少转义 `'` 是等价的 ——
 *   保持现状可以少一次 String.prototype.replace 链。
 *
 * ⚠ 正因为如此，它【不是】通用的安全工具：
 *   - 别 export 出去给别的模块用（它们可能用单引号包属性）；
 *   - ★ 如果以后这里出现单引号属性（attr='...'）或未加引号的属性，
 *     必须改用 escHtml()，否则就是一个属性逃逸点。
 *
 * ⚠ 另外它【不做 unescapeHtml】。调用方必须自己先 unescapeHtml 再 esc：
 *     esc(unescapeHtml(stored)) —— 见文件头的转义纪律。
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 把评论的 slug 映射成可点击的站点路径。
 *
 * ★ 这是本文件与你【静态站 URL 约定】耦合的唯一一处：
 *   演示站把首页的 slug 定为 "landing"，所以映射成 "/"；
 *   其它 slug 直接当作一级路径 "/<slug>"。
 *   换了 SSG 或改了 permalink（比如 /posts/<slug>/、/blog/<slug>.html），
 *   就要改这个函数，否则面板里的"Page"链接会 404。
 *
 * ⚠ 返回值【未做 URL 编码】，会直接进入 `href="${slugUrl(p.slug)}"`。
 *   当前安全是因为 slug 在写入端被限制为 ^[a-z0-9-]+$（见 submit.ts 的校验）；
 *   但如果通过 handleImport 导入脏数据（那个分支不做 slug 校验），
 *   带引号或空格的 slug 就能在这里逃出属性 → 属性注入。
 *   ★ 要稳妥：这里补 encodeURIComponent(slug)，或让导入端也校验 slug。
 */
function slugUrl(slug: string): string {
  return slug === "landing" ? "/" : `/${slug}`;
}
