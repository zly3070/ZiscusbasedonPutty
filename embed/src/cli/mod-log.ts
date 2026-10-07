/**
 * ============================================================================
 * embed/src/cli/mod-log.ts —— `ziscus mod-log`（看审计日志）
 * ============================================================================
 *
 * 【这个命令做了两件请求，为什么】
 *   `GET /admin/mod-log` 返回的日志行只有 `comment_id`（一个随机 id），
 *   人看不懂。所以这里【并行】再拉一次 `GET /admin/comments`，
 *   建一个 id → {作者, 正文} 的 Map，把日志里的 id 翻译成可读内容。
 *
 *   ⚠ 代价是：**每次看日志都会把所有评论拉下来**。
 *     评论上万条时这会很慢、很占内存。
 *     ★ 想优化的话，应该在 Worker 侧让 mod-log 接口直接 join comments
 *       返回作者和正文摘要，而不是在客户端补齐。
 *
 * 【★ 自动化与人工操作的区分】
 *   actor 列会显示 'ai' / 'admin' / 'system'，这是评估 AI 反垃圾效果的关键：
 *     只看 actor='ai' 的行 → AI 做了什么判断
 *     看 actor='admin' 的 spam 行 → 有多少是人工后来纠正 AI 的
 *   用 `--actor ai` / `--action spam` 之类的筛选参数组合即可。
 */
export interface ModLogEntry {
  id: string;
  action: string;
  actor: string;
  comment_id: string | null;
  slug: string | null;
  reason: string;
  metadata: string;
  created_at: string;
}

export interface CommentInfo {
  id: string;
  author: string;
  body: string;
  status: string;
}

export interface ModLogOptions {
  endpoint: string;
  secret: string;
  action?: string;
  actor?: string;
  slug?: string;
  limit?: number;
}

const MAX_BODY_DISPLAY = 50;

/**
 * 把一行审计日志格式化成【固定宽度的单行文本】。
 *
 * 输出形态（各列对齐，便于扫读）：
 *     2026-10-07T01:23:45Z  admin  spam           posts/hello 12ms     张三: "买粉丝私信我..."
 *
 * 列依次是：时间 / actor / action / slug / 延迟 / 评论摘要
 *
 * 【两个细节】
 *   ① `latency` 来自 metadata 里的 latency_ms —— 只有 **AI 判定**才有这个字段
 *      （worker 侧 classify.ts 记录），人工操作是空的。
 *      所以这一列空着 = 这行是人工操作。
 *   ② 正文被压成单行（换行替换成空格）并截断到 50 字符 ——
 *      否则一条多行评论会把表格撑破。
 *
 * ⚠ `JSON.parse(entry.metadata)` 【没有 try/catch】：
 *   如果 metadata 不是合法 JSON（理论上不会，因为写入端总是 JSON.stringify），
 *   这里会抛异常让整个命令失败。
 *
 * @param comments 可选的 id→评论 映射；不给就只显示 id 前 8 位
 */
export function formatModLogEntry(
  entry: ModLogEntry,
  comments?: Map<string, CommentInfo>,
): string {
  const meta = JSON.parse(entry.metadata) as Record<string, unknown>;
  const latency = meta.latency_ms ? `${meta.latency_ms}ms` : "";

  let commentInfo = "";
  if (entry.comment_id && comments) {
    const c = comments.get(entry.comment_id);
    if (c) {
      const clean = c.body.replace(/[\n\r]+/g, " ").trim();
      const body = clean.length > MAX_BODY_DISPLAY ? clean.slice(0, MAX_BODY_DISPLAY) + "..." : clean;
      commentInfo = `${c.author}: "${body}"`;
    } else {
      commentInfo = entry.comment_id.slice(0, 8);
    }
  } else if (entry.comment_id) {
    commentInfo = entry.comment_id.slice(0, 8);
  }

  return `${entry.created_at}  ${entry.actor.padEnd(6)} ${entry.action.padEnd(14)} ${(entry.slug ?? "").padEnd(10)} ${latency.padEnd(8)} ${commentInfo}`;
}

export async function runModLog(opts: ModLogOptions): Promise<string[]> {
  const params = new URLSearchParams();
  if (opts.action) params.set("action", opts.action);
  if (opts.actor) params.set("actor", opts.actor);
  if (opts.slug) params.set("slug", opts.slug);
  if (opts.limit) params.set("limit", String(opts.limit));

  const qs = params.toString();
  const logUrl = `${opts.endpoint}/admin/mod-log${qs ? `?${qs}` : ""}`;
  const commentsUrl = `${opts.endpoint}/admin/comments`;
  const headers = { Authorization: `Bearer ${opts.secret}` };

  const [logRes, commentsRes] = await Promise.all([
    fetch(logUrl, { headers }),
    fetch(commentsUrl, { headers }),
  ]);

  const entries = (await logRes.json()) as ModLogEntry[];
  if (entries.length === 0) return [];

  const allComments = (await commentsRes.json()) as CommentInfo[];
  const commentMap = new Map(allComments.map((c) => [c.id, c]));

  return entries.map((e) => formatModLogEntry(e, commentMap));
}
