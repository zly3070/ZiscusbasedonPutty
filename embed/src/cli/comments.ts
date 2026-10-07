/**
 * ============================================================================
 * embed/src/cli/comments.ts —— `ziscus comments` 的数据获取与文本格式化
 * ============================================================================
 *
 * 【这个文件只做两件事】
 *   ① 调 Worker 的 `GET /admin/comments` 拉评论（runListComments）
 *   ② 把一条评论格式化成终端可读的多行文本（formatComment）
 *
 *   注意它【不负责打印】—— 返回 string[]，由 cli.ts 决定怎么输出。
 *   这个分层让它可以被单测覆盖，也方便以后换输出格式（JSON/CSV）。
 *
 * 【⚠ 和 worker 侧的 Comment 类型不是同一个】
 *   这里叫 AdminComment，字段是【数据库的蛇形命名】（created_at）。
 *   而 embed/src/render.ts 里的 Comment 是【驼峰命名】（createdAt），
 *   用于给 SSG 渲染。**两个接口名字相近但用途不同，别搞混。**
 *
 * 【★ 自定义提示：改 CLI 输出格式就改 formatComment】
 *   这是 `ziscus comments` 命令显示效果的唯一来源。
 */
export interface AdminComment {
  id: string;
  slug: string;
  author: string;
  body: string;
  status: string;
  created_at: string;
}

export interface ListCommentsOptions {
  endpoint: string;
  secret: string;
  status?: string;
  slug?: string;
  limit?: number;
}

/**
 * 把一条评论格式化成终端可读的多行文本。
 *
 * 输出形态（用于对齐时的参考）：
 *     [pending] 张三 — posts/hello (2026-10-07T01:23:45Z)
 *       ID: a1b2c3d4e5f6a7b8
 *       这是评论正文……
 *
 * ⚠ 第一行把 status 放在最前面（方括号里）—— 这是刻意的：
 *   管理员扫一眼输出就能挑出 pending 的条目去处理。
 *   ★ 如果你要改格式，保留 status 在最前面会比较实用。
 */
export function formatComment(c: AdminComment): string {
  return `[${c.status}] ${c.author} — ${c.slug} (${c.created_at})
  ID: ${c.id}
  ${c.body}`;
}

/**
 * 调 `GET /admin/comments`（带筛选参数），返回格式化后的字符串数组。
 *
 * @param opts.endpoint Worker 的基地址（⚠ 尾部斜杠未做处理，调用方保证格式）
 * @param opts.secret   ADMIN_SECRET，走 Authorization: Bearer
 * @param opts.status/slug/limit 可选的筛选条件，会变成 query string
 *
 * ⚠ 【这个函数不检查 res.ok】
 *   如果 Worker 返回 401 或 500，`res.json()` 会抛异常（因为响应体是纯文本
 *   "Unauthorized" 而不是 JSON），错误信息会比较难懂。
 *   ★ 想改进的话，在这里加一层 `if (!res.ok) throw new Error(...)`，
 *     能给出"密钥不对"这种明确提示。注意 rebuild.ts 就做了这种处理
 *     （它读 text 再尝试 JSON.parse），可以参照。
 */
export async function runListComments(opts: ListCommentsOptions): Promise<string[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.slug) params.set("slug", opts.slug);
  if (opts.limit) params.set("limit", String(opts.limit));

  const qs = params.toString();
  const url = `${opts.endpoint}/admin/comments${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.secret}` },
  });

  const comments = (await res.json()) as AdminComment[];
  return comments.map(formatComment);
}
