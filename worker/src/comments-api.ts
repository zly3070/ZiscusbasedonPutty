/**
 * ============================================================================
 * worker/src/comments-api.ts —— 评论的"读"接口 + 单条审核动作
 * ============================================================================
 *
 * 【两类端点，权限完全不同，别混】
 *
 *   ① GET /comments/:slug     —— 【公开】。给你的 SSG 在构建时调用，
 *                                只返回 approved 的评论，任何人可读。
 *                                所以它带 `Access-Control-Allow-Origin: *`
 *                                和 `Cache-Control: max-age=60`。
 *
 *   ② 其余（approve/reject/spam/unapprove/delete）—— 【管理】，都必须过
 *                                requireAuth()。且它们都会写审计日志。
 *                                ⚠ 注意这些端点的路径【不在 /admin/ 下】
 *                                  （历史原因），所以它们拿不到 index.ts
 *                                  里给 /admin/ 加的 no-store / noindex
 *                                  那套安全头。这是可以改进的地方。
 *
 * 【★ 一个贯穿全文件的关键模式：什么时候要触发重建】
 *
 *   审核动作会改变"已批准评论集合"，但静态站是构建时烘焙的，
 *   所以**只有影响到线上显示的动作才需要重建**：
 *
 *     动作         是否需要重建    代码怎么判断
 *     ─────────────────────────────────────────────────────────
 *     approve      需要           直接调
 *     unapprove    需要           直接调（从显示中撤下）
 *     spam         仅当原本是 approved    `wasApproved` 判断
 *     delete       仅当原本是 approved    `wasApproved` 判断
 *     reject       不需要           —— 从未显示过，改了也不影响线上
 *
 *   ⚠ 为什么删除/spam 要先判断 wasApproved：
 *     把一条本来就是 pending 的评论删掉，线上 HTML 里根本没有它，
 *     触发重建就是白白消耗 GitHub Actions 配额和构建时间。
 *     **这个"只在必要时重建"的优化如果没有，站点会被无效重建淹没。**
 *   ★ 如果你新增了审核动作，记得想清楚它是否需要重建，以及条件是什么。
 *
 * 【返回值约定】
 *   所有动作返回 `{ok: true}` 的 JSON。浏览器表单提交的情况会被
 *   index.ts 的 dashboardRedirect() 拦截并改成 303 跳回面板 ——
 *   所以这里只管返回 JSON，不用操心重定向。
 */
import type { Env } from "./types.js";
import { requireAuth } from "./auth.js";
import { triggerRebuild } from "./debounce.js";
import { logModAction } from "./mod-log.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const OK_RESPONSE = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });

/**
 * GET /comments/:slug —— 返回该页**已批准**评论的 JSON。【公开端点】
 *
 * 这是 `ziscus` 包的 `fetchComments()` 在 SSG 构建时打的接口。
 *
 * ⚠ 【一个刻意的设计：关评论时返回空数组，而不是报错】
 *   如果全站 `mode` 是 'off' 或 'paused'，这里返回 `[]`。
 *   目的是让【已经烘焙了评论的旧页面】在下次重建时变成"没有评论"，
 *   而不是让构建失败。
 *   ★ 但注意副作用：**这不会立刻清掉线上已有评论**，
 *     要等站点重建才生效。如果你希望"暂停 = 立刻隐藏"，需要另做机制。
 *
 * ⚠ 【缓存 60 秒 + 通配 CORS】**：
 *   · `max-age=60`：构建时可能并发调多次，缓存能省 D1 读取行数
 *   · `*`：允许任意站点读取。这【不是漏洞】—— 评论本来就是公开内容，
 *     而且真正需要防的是**写入**（那有 CSRF 校验）。
 *     ★ 但如果你希望评论只在自己域名下可见，就要收紧这个头。
 *
 * ⚠ 查询用 `ORDER BY created_at ASC`（正序，老的在前）——
 *   和 html-rewriter.ts 里的 DESC+reverse 不同。两处都要留意顺序语义。
 */
export async function handleGetComments(
  slug: string,
  env: Env,
): Promise<Response> {
  // Check mode — if off or paused, return empty
  const modeRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'comments_mode'").first<{ value: string }>();
  const mode = modeRow?.value ?? "on";
  if (mode === "off" || mode === "paused") {
    return new Response("[]", { status: 200, headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
  }

  const { results } = await env.DB.prepare(
    "SELECT id, slug, author, body, status, created_at, approved_at FROM comments WHERE slug = ? AND status = 'approved' ORDER BY created_at ASC",
  )
    .bind(slug)
    .all();

  return new Response(JSON.stringify(results ?? []), {
    status: 200,
    headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" },
  });
}

/** Helper: find comment or return 404 */
async function findComment(id: string, env: Env): Promise<{ slug: string; status: string } | Response> {
  const comment = await env.DB.prepare("SELECT slug, status FROM comments WHERE id = ?").bind(id).first<{ slug: string; status: string }>();
  if (!comment) return new Response("Not found", { status: 404 });
  return comment;
}

/** POST /approve/:id */
export async function handleApprove(id: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const comment = await findComment(id, env);
  if (comment instanceof Response) return comment;

  await env.DB.prepare("UPDATE comments SET status = 'approved', approved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").bind(id).run();
  await logModAction(env.DB, "approve", "admin", { commentId: id, slug: comment.slug });
  await triggerRebuild(env.DB, env, comment.slug);
  return OK_RESPONSE();
}

/** POST /reject/:id */
export async function handleReject(id: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const comment = await findComment(id, env);
  if (comment instanceof Response) return comment;

  await env.DB.prepare("UPDATE comments SET status = 'rejected' WHERE id = ?").bind(id).run();
  await logModAction(env.DB, "reject", "admin", { commentId: id, slug: comment.slug });
  return OK_RESPONSE();
}

/** POST /spam/:id */
export async function handleSpam(id: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const comment = await findComment(id, env);
  if (comment instanceof Response) return comment;

  const wasApproved = comment.status === "approved";
  await env.DB.prepare("UPDATE comments SET status = 'spam' WHERE id = ?").bind(id).run();
  await logModAction(env.DB, "spam", "admin", { commentId: id, slug: comment.slug });
  if (wasApproved) await triggerRebuild(env.DB, env, comment.slug);
  return OK_RESPONSE();
}

/** POST /unapprove/:id */
export async function handleUnapprove(id: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const comment = await findComment(id, env);
  if (comment instanceof Response) return comment;

  await env.DB.prepare("UPDATE comments SET status = 'pending', approved_at = NULL WHERE id = ?").bind(id).run();
  await logModAction(env.DB, "unapprove", "admin", { commentId: id, slug: comment.slug });
  await triggerRebuild(env.DB, env, comment.slug);
  return OK_RESPONSE();
}

/** DELETE /comments/:id */
export async function handleDeleteComment(id: string, request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const comment = await findComment(id, env);
  if (comment instanceof Response) return comment;

  const wasApproved = comment.status === "approved";
  await logModAction(env.DB, "delete", "admin", { commentId: id, slug: comment.slug });
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  if (wasApproved) await triggerRebuild(env.DB, env, comment.slug);
  return OK_RESPONSE();
}
