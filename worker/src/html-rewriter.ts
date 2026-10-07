/**
 * ============================================================================
 * worker/src/html-rewriter.ts —— 用 HTMLRewriter 实现"访客立刻看到自己的评论"
 * ============================================================================
 *
 * 【这个文件解决什么问题】
 *
 *   本站的评论是【构建时烘焙】进静态 HTML 的。所以正常流程下：
 *     访客提交 → 写入 D1 → 触发重建 → 等几分钟 → 新 HTML 才有他的评论
 *   体验很差：他发完看不到自己的话，会以为失败了。
 *
 *   这个文件让 Worker 在【只有静态资源（env.ASSETS 存在）】时，
 *   于响应到达浏览器之前，用 HTMLRewriter 现场把 `#comments` 区块
 *   替换成"从 D1 现查的、最新的评论列表"。
 *
 * 【完整的链路（配合 index.ts 和 submit.ts 一起看）】
 *
 *   submit.ts 插入成功
 *        │  种 cookie: ziscus_posted=<slug>（120 秒）
 *        ▼
 *   303 重定向回原页面
 *        │
 *        ▼
 *   index.ts 读到 cookie  →  调本文件的 serveWithFreshComments()
 *        │
 *        ├─ 并行：① env.ASSETS.fetch(页面)  ② D1 查已批准评论
 *        │
 *        ├─ HTMLRewriter 把 #comments / #ziscus 区块替换成新列表
 *        │
 *        └─ 返回改写后的 HTML，并把 cookie 清掉
 *
 * 【⚠ 跨包契约 —— 这是最容易踩的坑】
 *
 *   下面第 88-89 行的选择器 `#comments` 和 `#ziscus`，
 *   必须和【渲染端产出的 HTML 结构】对得上：
 *     · `ziscus` 包的 renderCommentList() 产出 `<section id="comments" ...>`
 *       （见 embed/src/render.ts）
 *     · Worker 自带的静态站模板用的是 `#ziscus`
 *
 *   **如果你自定义了评论区的 id 或 class，这里的改写会静默失效** ——
 *   不报错，只是"访客看不到自己刚发的评论了"。改模板时务必同步改这里。
 */
import type { Env } from "./types.js";
import { escHtml, unescapeHtml } from "./html.js";

/** Max comments to query for the HTMLRewriter response. */
const REWRITER_COMMENT_LIMIT = 200;

/**
 * 把一条评论渲染成 HTML。**Worker 侧的渲染实现。**
 *
 * 【⚠ 这是本文件最需要看懂的一行】
 *
 *   `${escHtml(unescapeHtml(author))}`
 *      ↑ 转义    ↑ 先反转义
 *
 *   为什么要绕这一圈？因为存储不变量是"库里存的是已转义文本"
 *   （见 worker/src/html.ts 的说明）。所以正确的渲染是：
 *     先 unescapeHtml 拿回用户真正输入的字符 → 再 escHtml 输出到 HTML
 *   这个组合是幂等的，而且即使某行数据绕过了存储不变量（没转义就入库）
 *   也依然安全 —— 因为最后的 escHtml 是兜底防线。
 *
 * ⚠ 如果你不小心写成只 escHtml（不反转义），用户会看到字面的
 *   `&lt;b&gt;` 而不是 `<b>`。写成只 unescapeHtml（不转义）就是 XSS。
 *   两个函数必须成对出现，顺序不能反。
 *
 * 【和 embed/src/render.ts 的关系】
 *   那个包里有一个**几乎一样**的 renderComment()。这不是重复代码的疏忽，
 *   而是因为 worker 和 embed 是【两个独立构建、独立发布的产物】：
 *     · worker 跑在 Cloudflare，随 Worker 一起部署
 *     · embed 跑在你的 SSG 构建过程里，从 npm 装
 *   它们不能互相 import。**代价是改渲染样式要改两处** ——
 *   ★ 如果你想统一，抽出为一个共享包，但要注意 Worker 侧的打包约束。
 *
 * @param timeZone 用于格式化日期。Worker 会从 CF 的 request.cf 里取访客时区
 */
function renderComment(author: string, body: string, createdAt: string, timeZone: string = "UTC"): string {
  const date = new Date(createdAt);
  const formatted = date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  });

  return `<article class="comment">
        <header class="comment-header">
          <strong class="comment-author">${escHtml(unescapeHtml(author))}</strong>
          <time datetime="${createdAt}">${formatted}</time>
        </header>
        <p class="comment-body">${escHtml(unescapeHtml(body))}</p>
      </article>`;
}

/**
 * 取静态页面 + 查最新评论，用 HTMLRewriter 把评论区块替换掉。
 *
 * 【设计原则：这个函数永远不会让访客看到错误页】
 *   评论**已经**成功写进 D1 了，所以这里【任何】失败都不该报错给用户。
 *   看代码结构：
 *     · 没有 ASSETS        → 退回重定向
 *     · 取页面或查库抛异常  → catch → 退回重定向
 *     · 页面 404           → 退回重定向
 *     · 一条评论都没有      → 原样返回页面（不注入，避免把"暂无评论"覆盖掉）
 *   也就是说**最坏情况退化成普通重定向**，用户仍然会觉得提交成功了。
 *   ★ 这是正确的容错取向，别改成"失败就 500"。
 *
 * 【实现细节】
 *   · 页面和评论用 Promise.all 并行取，省一次往返时间
 *   · 查询是 `ORDER BY created_at DESC LIMIT 200`，然后**在 JS 里 .reverse()**
 *     变成正序（老的在上）—— 这样 LIMIT 拿到的是最新的 200 条，
 *     而不是最老的 200 条。逻辑正确但很隐晦，容易改错。
 *     ⚠ 如果评论超过 200 条，这个页面看到的就【只有最近 200 条】，
 *       而构建时烘焙的静态版可能是全部。两者不一致是已知的取舍
 *       （即时预览用最近 200 条足够）。
 *   · 时区从 `request.cf.timezone` 取（Cloudflare 提供的访客时区）
 *
 * @param slug        当前页面的标识
 * @param redirectUrl 失败时跳回哪
 */
export async function serveWithFreshComments(
  slug: string,
  redirectUrl: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.ASSETS) return redirect(redirectUrl);
  try {
    const pageUrl = new URL(
      redirectUrl.startsWith("/") ? redirectUrl : new URL(redirectUrl).pathname || "/",
      request.url,
    ).toString();

    const [pageRes, commentsResult] = await Promise.all([
      env.ASSETS.fetch(new Request(pageUrl)),
      env.DB.prepare(
        "SELECT author, body, created_at FROM comments WHERE slug = ? AND status = 'approved' ORDER BY created_at DESC LIMIT ?",
      )
        .bind(slug, REWRITER_COMMENT_LIMIT)
        .all<{ author: string; body: string; created_at: string }>(),
    ]);

    if (!pageRes.ok) {
      return redirect(redirectUrl);
    }

    const comments = (commentsResult.results ?? []).reverse();

    if (comments.length === 0) {
      return new Response(pageRes.body, {
        status: 200,
        headers: htmlHeaders(),
      });
    }

    // Use the requester's timezone from Cloudflare, fall back to UTC
    const tz = (request.cf as Record<string, unknown>)?.timezone as string || "UTC";

    const total = comments.length;
    const heading = `<h2>${total} ${total === 1 ? "Comment" : "Comments"}</h2>`;
    const commentHtml = comments
      .map((c) => renderComment(c.author, c.body, c.created_at, tz))
      .join("\n      ");
    const freshSection = `${heading}\n      ${commentHtml}`;

    const handler = {
      element(el: Element) {
        el.setInnerContent(freshSection, { html: true });
      },
    };
    // ⚠ 跨包契约：这两个选择器必须和渲染端产出的 HTML 对上。
    //   `#comments`  ← embed/src/render.ts 的 renderCommentList()
    //   `#ziscus`    ← 本项目自带静态站的模板用的 id
    //   改了模板里的 id/class 而忘了改这里 → 即时预览静默失效（不报错）。
    const rewritten = new HTMLRewriter()
      .on("#comments", handler)
      .on("#ziscus", handler)
      .transform(pageRes);

    return new Response(rewritten.body, {
      status: 200,
      headers: htmlHeaders(),
    });
  } catch {
    return redirect(redirectUrl);
  }
}

function redirect(url: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: url },
  });
}

function htmlHeaders(): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  };
}
