/**
 * ============================================================================
 * worker/src/debounce.ts —— 站点重建的防抖与触发
 * ============================================================================
 *
 * 【这个文件解决的现实问题】
 *
 *   静态站的评论靠"重建"才更新。而重建的代价很高：
 *     · 触发 GitHub Actions（有配额，公有仓库免费但有并发限制）
 *     · 跑一遍完整的 SSG 构建（可能几十秒到几分钟）
 *     · 部署到 CDN
 *
 *   如果没有防抖，在管理面板里**批量批准 20 条评论 = 触发 20 次重建**，
 *   20 个 Actions 排队跑，既慢又浪费。
 *
 *   所以：**30 秒内的多次重建请求合并成一次。**
 *
 * 【防抖怎么实现的（关键在"原子性"）】
 *
 *   Cloudflare Worker 是【多实例并发】的。如果用"读时间戳 → 判断 → 写时间戳"，
 *   两个并发请求会同时读到旧值、同时决定"我该触发"，于是发出两次 dispatch。
 *
 *   解法是把"判断"和"抢占"合成一条原子 SQL（compare-and-swap）：
 *
 *     UPDATE meta SET value = <now>
 *      WHERE key = 'last_rebuild' AND CAST(value AS INTEGER) < <now - windowMs>
 *
 *   · 更新成功（changes > 0）→ 说明窗口已过期，**我抢到了**，去触发
 *   · 更新失败（changes == 0）→ 说明别人刚抢过，**我跳过**（返回 debounced）
 *   · 还没有那一行（第一次重建）→ 用 `INSERT OR IGNORE` 抢占 ——
 *     IGNORE 保证并发时**恰好一个**调用者插入成功
 *
 *   ⚠ 这套 CAS 是整个防抖正确性的核心。★ 改动时务必保持"判断+写入"在
 *     同一条语句里，拆成两步就会重新引入竞态。
 *
 * 【★ 最值得学习的设计原则：这个函数【从不抛异常】】
 *
 *   源码注释写得很明确：
 *     "**Never fails the caller** — a comment submission must succeed
 *      even if GitHub is down"
 *
 *   也就是说：访客发评论时，即使 GitHub 完全挂了、token 过期了、
 *   网络超时了，**评论依然要写入成功**，只是站点晚点重建而已。
 *
 *   代价是失败会被"吞掉"，所以它做了三件事保证可观测性：
 *     ① 结果写进 `meta.last_rebuild_result` → 管理面板显示红/绿卡片
 *     ② 真实尝试记进 mod_log（rebuild_dispatched / rebuild_failed）
 *     ③ 失败打 console.error → `wrangler tail` 能看到
 *     ④ 失败时【释放防抖窗口】，让下一次批准能立刻重试
 *        （而不是傻等 30 秒）
 *
 * 【⚠ GITHUB_TOKEN 会过期，这是最常见的线上故障】
 *   README 里专门有一节讲这个：细粒度 PAT 最多一年、默认更短。
 *   token 一死，评论照收但**每次重建都被 GitHub 401 拒绝**，
 *   站点停止更新直到你用 `npx ziscus rebuild` 手动重建。
 *   ★ 症状识别：面板上"Rebuild pipeline"卡片变红、
 *     mod_log 里出现 rebuild_failed、HTTP 401。
 */
import type { Env, RebuildResult } from "./types.js";
import { logModAction } from "./mod-log.js";

/** meta.key holding the JSON-encoded outcome of the most recent dispatch attempt. */
export const LAST_REBUILD_RESULT_KEY = "last_rebuild_result";

/** Default debounce window: bulk approvals within 30s collapse into one rebuild. */
const DEFAULT_WINDOW_MS = 30_000;

export interface TriggerRebuildOptions {
  /** Debounce window in milliseconds. Default 30s. */
  windowMs?: number;
  /** Bypass the debounce window (used by POST /admin/rebuild). */
  force?: boolean;
  /** Who initiated the rebuild — recorded in mod_log. Default "system". */
  actor?: "system" | "admin";
}

/**
 * Claim the debounce window. Atomic compare-and-swap so concurrent Workers
 * that read the same stale timestamp can't all fire dispatches. Returns true
 * if this caller won the window.
 */
async function claimDebounceWindow(db: D1Database, now: number, windowMs: number): Promise<boolean> {
  const threshold = (now - windowMs).toString();
  const updated = await db
    .prepare(
      "UPDATE meta SET value = ? WHERE key = 'last_rebuild' AND CAST(value AS INTEGER) < CAST(? AS INTEGER)",
    )
    .bind(now.toString(), threshold)
    .run();
  if (updated.meta.changes > 0) return true;

  // No row yet (first rebuild ever) — INSERT OR IGNORE is atomic: exactly one caller wins.
  const inserted = await db
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('last_rebuild', ?)")
    .bind(now.toString())
    .run();
  return inserted.meta.changes > 0;
}

/**
 * Give the window back after a failed dispatch so the very next approval
 * retries instead of waiting for `windowMs`. CAS on our own timestamp so we
 * never clobber a claim made by a later, successful caller.
 */
async function releaseDebounceWindow(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("UPDATE meta SET value = '0' WHERE key = 'last_rebuild' AND value = ?")
    .bind(now.toString())
    .run();
}

async function recordResult(db: D1Database, result: RebuildResult): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
    .bind(LAST_REBUILD_RESULT_KEY, JSON.stringify(result))
    .run();
}

/** Outcome of the most recent dispatch attempt, or null if none has been recorded. */
export async function getLastRebuildResult(db: D1Database): Promise<RebuildResult | null> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(LAST_REBUILD_RESULT_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RebuildResult;
  } catch {
    return null;
  }
}

/** Extract a short, human-readable reason from a GitHub error response. */
async function describeGitHubError(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 500);
  let message = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON — keep the raw (truncated) body
  }
  return `GitHub ${res.status}${message ? `: ${message}` : ""}`;
}

/**
 * Trigger a GitHub `repository_dispatch` so the static site rebuilds `slug`.
 *
 * - Debounced (30s window, atomic CAS) so bulk approvals collapse into one run.
 * - **Never fails the caller** — a comment submission must succeed even if
 *   GitHub is down — but every attempt is observable: the outcome is written to
 *   `meta.last_rebuild_result` (surfaced on the dashboard and `/admin/stats`),
 *   real attempts are logged to `mod_log` as `rebuild_dispatched` /
 *   `rebuild_failed`, and failures go to `console.error` for `wrangler tail`.
 * - On failure the debounce window is released so the next approval retries.
 */
export async function triggerRebuild(
  db: D1Database,
  env: Env,
  slug: string,
  opts: TriggerRebuildOptions = {},
): Promise<RebuildResult> {
  const { windowMs = DEFAULT_WINDOW_MS, force = false, actor = "system" } = opts;
  const now = Date.now();
  const at = new Date(now).toISOString();

  if (!force) {
    const claimed = await claimDebounceWindow(db, now, windowMs);
    if (!claimed) return { dispatched: false, debounced: true, slug, at };
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    // Dev / not-yet-wired deployments: record so the dashboard says "not configured",
    // but don't spam mod_log — nothing was actually attempted.
    const result: RebuildResult = {
      dispatched: false, debounced: false, slug, at,
      code: "not_configured",
      error: "GITHUB_TOKEN or GITHUB_REPO not configured",
    };
    await recordResult(db, result);
    return result;
  }

  let result: RebuildResult;
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ziscus-comments",
      },
      body: JSON.stringify({ event_type: "rebuild-comments", client_payload: { slug } }),
    });
    if (res.status === 204) {
      result = { dispatched: true, debounced: false, slug, at, status: 204 };
    } else {
      result = {
        dispatched: false, debounced: false, slug, at,
        status: res.status,
        code: "github_rejected",
        error: await describeGitHubError(res),
      };
    }
  } catch (err) {
    result = {
      dispatched: false, debounced: false, slug, at,
      code: "network",
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.dispatched) {
    // A forced dispatch still counts as "just rebuilt" for subsequent debouncing.
    if (force) {
      await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_rebuild', ?)").bind(now.toString()).run();
    }
  } else {
    console.error(`[ziscus] rebuild dispatch failed for slug "${slug}": ${result.error}`);
    if (!force) await releaseDebounceWindow(db, now);
  }

  await recordResult(db, result);
  await logModAction(db, result.dispatched ? "rebuild_dispatched" : "rebuild_failed", actor, {
    slug,
    reason: result.error ?? "",
    metadata: { status: result.status ?? null, code: result.code ?? null, forced: force },
  });

  return result;
}
