/**
 * ============================================================================
 * worker/src/mod-log.ts —— 操作审计日志（写 + 读）
 * ============================================================================
 *
 * 【为什么一个评论系统需要审计日志】
 *   管理动作是**破坏性且不可撤销**的（删评论、标垃圾、封 IP）。
 *   出问题时你需要能回答："这条评论是谁在什么时候删的？为什么？"
 *   另外 AI 的自动判定也要留痕 —— 否则你无法评估 AI 的准确率。
 *
 * 【写入点遍布全项目】logModAction() 被这些地方调用：
 *   · submit.ts         AI 判定结果（actor: 'ai'）
 *   · comments-api.ts   人工审核动作（actor: 'admin'）
 *   · admin-api.ts      导入、批量批准、封禁等
 *   · debounce.ts       重建成功/失败（rebuild_dispatched / rebuild_failed）
 *
 * 【⚠ 日志和评论没有外键约束】
 *   schema.sql 里 mod_log.comment_id 是普通列，没有 FOREIGN KEY。
 *   所以**删掉评论后日志仍然保留**，但 comment_id 变成悬空引用。
 *   这是有意的设计（审计要留痕），代价是查询时不能盲目 join。
 *
 * 【actor 的三种取值】
 *   'admin'  人工在面板/CLI 操作
 *   'ai'     Workers AI 自动判定
 *   'system' 系统自动行为（比如防抖触发的重建）
 *   ★ 想做"只看人工操作"或"评估 AI 准确率"，就按 actor 过滤。
 */
import { requireAuth } from "./auth.js";
import type { Env } from "./types.js";

export async function logModAction(
  db: D1Database,
  action: string,
  actor: "ai" | "admin" | "system",
  opts?: { commentId?: string; slug?: string; reason?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.prepare(
    "INSERT INTO mod_log (action, actor, comment_id, slug, reason, metadata) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    action,
    actor,
    opts?.commentId ?? null,
    opts?.slug ?? null,
    opts?.reason ?? "",
    JSON.stringify(opts?.metadata ?? {}),
  ).run();
}

export async function handleGetModLog(request: Request, env: Env): Promise<Response> {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const actor = url.searchParams.get("actor");
  const slug = url.searchParams.get("slug");
  const since = url.searchParams.get("since");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  if (action) { conditions.push("action = ?"); binds.push(action); }
  if (actor) { conditions.push("actor = ?"); binds.push(actor); }
  if (slug) { conditions.push("slug = ?"); binds.push(slug); }
  if (since) { conditions.push("created_at >= ?"); binds.push(since); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM mod_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return new Response(JSON.stringify(results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
