/**
 * ============================================================================
 * embed/src/cli/rebuild.ts —— `ziscus rebuild`（手动触发站点重建）
 * ============================================================================
 *
 * 【什么时候需要它】
 *   正常流程是"批准评论 → Worker 自动触发 GitHub 重建"。
 *   但下面这些情况自动触发不会发生（或失效），必须手动重建：
 *     · GITHUB_TOKEN 过期了 —— **最常见的线上故障**
 *     · 你在后台直接改了 D1，没有走 Workers 的批准接口
 *     · 批量批准（worker 侧的 handleBulkApprove **不触发重建**，见其注释）
 *     · GDPR 删除后想让被删评论从线上消失
 *     · 改了站点模板/样式，想重新发布
 *
 * 【这个文件最值得学习的地方：HTTP 错误【不抛异常】】
 *
 *   看源码注释：
 *     "HTTP-level failures (401, 502, 503, a non-JSON body) **never throw** —
 *      they are reported through the returned outcome.
 *      Genuine network errors propagate."
 *
 *   也就是把错误分成了两类：
 *     · **服务端答复了但答复是错的**（401/502/503/非 JSON）
 *       → 打包成 RebuildOutcome 返回。调用方能看到 httpStatus 和 error 文案，
 *         打印出"token 过期了"这种有用信息，然后正常退出。
 *     · **根本没连上**（DNS 失败、超时）
 *       → 让异常往上抛，这是真正的意外。
 *
 *   为什么这么分：CLI 的职责是**把问题说清楚**，而不是用栈追踪淹没用户。
 *   ★ 你在 comments.ts 里能看到【没做】这种处理的对照 —— 那边响应非 JSON
 *     时会抛出难懂的 json 解析错误。一好一坏，正好可以对照着学。
 */

/** `ziscus rebuild` 的入参 */
export interface RebuildOptions {
  endpoint: string;
  secret: string;
  /** Page slug to rebuild. Omitted → the Worker defaults to "all". */
  slug?: string;
}

/**
 * 一次重建尝试的结果。
 *
 * ⚠ 注意有【两个】状态要区分，这是本接口容易看混的地方：
 *     httpStatus —— Worker 本身怎么答复的（200/401/502/503）
 *     status     —— Worker 去调 GitHub 时，GitHub 怎么答复的（204/401/…）
 *   所以 httpStatus=200 且 status=401 是完全可能的：
 *   **Worker 正常工作，但它手里的 GITHUB_TOKEN 被 GitHub 拒了。**
 *   这正是 token 过期时的表现。★ 排查时先看 status，再看 httpStatus。
 */
export interface RebuildOutcome {
  /** GitHub accepted the repository_dispatch. */
  ok: boolean;
  dispatched: boolean;
  slug?: string;
  /** GitHub's HTTP status for the dispatch call (204 on success, 401 on a bad token, ...). */
  status?: number;
  error?: string;
  /** HTTP status of the Worker response itself (200, 401, 502, 503, ...). */
  httpStatus: number;
}

function toOutcome(body: Record<string, unknown>, httpStatus: number): RebuildOutcome {
  const outcome: RebuildOutcome = {
    ok: body.ok === true,
    dispatched: body.dispatched === true,
    httpStatus,
  };
  if (typeof body.slug === "string") outcome.slug = body.slug;
  if (typeof body.status === "number") outcome.status = body.status;
  if (typeof body.error === "string") outcome.error = body.error;
  return outcome;
}

/**
 * Ask the Worker to trigger a site rebuild via GitHub repository_dispatch.
 *
 * HTTP-level failures (401, 502, 503, a non-JSON body) never throw — they are
 * reported through the returned outcome. Genuine network errors propagate.
 */
export async function runRebuild(opts: RebuildOptions): Promise<RebuildOutcome> {
  const base = opts.endpoint.replace(/\/$/, "");
  const res = await fetch(`${base}/admin/rebuild`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(opts.slug === undefined ? {} : { slug: opts.slug }),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (res.status === 401 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const fallback = res.status === 401 ? "Unauthorized" : `HTTP ${res.status}`;
    return { ok: false, dispatched: false, httpStatus: res.status, error: text.trim() || fallback };
  }

  return toOutcome(parsed as Record<string, unknown>, res.status);
}
