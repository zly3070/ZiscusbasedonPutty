/**
 * ============================================================================
 * embed/src/render.ts —— 评论渲染器（把评论对象拼成静态 HTML 字符串）
 * ============================================================================
 *
 * 【这个文件在整个系统里的位置】
 *
 *   这是【读路径的最后一站】，只在【构建时】执行，永远不进浏览器：
 *
 *     访客提交评论 ──> Cloudflare Worker ──> D1
 *                                              │
 *     你的 SSG 构建（Hugo / Astro /      ①      │  ① fetch.ts 的 fetchComments()
 *     Eleventy / Jekyll / Next.js）  <──────────┘     从 GET /comments/:slug 拉已批准评论
 *              │                                  （JSON → 反转义成纯文本）
 *              │  ② 本文件 renderCommentsSection()
 *              │     拼成一段 HTML 字符串
 *              │  ③ SSG 把它写进 .html 文件
 *              ▼
 *        发布的静态页面（访客看到的是一片纯 HTML，零 JavaScript）
 *
 *   ⚠ 本文件所有导出函数都是【纯字符串拼接：无 I/O、无网络、无副作用】。
 *     不要在这里加 fetch、不要读文件、不要读环境变量 —— 它必须能在
 *     SSG 的任何模板、任何构建钩子里被随手调用，且结果可复现。
 *
 * 【动手改之前必须先知道的三个约定】
 *
 *   ── 约定 1（★ 最重要）：class / id 名字是跨包契约，被 worker 端硬编码依赖 ──
 *
 *     `renderCommentsSection()` 输出的结构必须一直满足：
 *
 *       · 评论列表外层      id="comments"（或 id="ziscus"）
 *       · 提交表单          class="comment-form"
 *       · 表单内必须有      <input name="slug">，且要落在 .comment-form 内部
 *       · 包住输入框的      必须是 <div>
 *       · 提交控件          必须是 <button>
 *
 *     因为：
 *       · worker/src/html-rewriter.ts 用
 *             .on("#comments", handler).on("#ziscus", handler)
 *         配合 setInnerContent() 【现场整个替换评论列表】，实现
 *         "评论者提交后立刻看到自己的评论"（不必等下一次重建）。
 *       · worker/src/index.ts 用
 *             .on(".comment-form input[name='slug']", …)
 *             .on(".comment-form div, .comment-form button", …)
 *         实现【按页暂停评论】：命中被暂停的 slug 时把表单的输入框和
 *         按钮删掉，换成一句"评论已暂停"。
 *
 *     ⚠ 后果很隐蔽：【用户自定义模板时只要改了这些 id/class 名，
 *       "评论即时预览"和"按页暂停"就会静默失效】—— 页面照样构建成功、
 *       评论照样能提交，没有任何报错，只是那个功能不再工作。
 *     ★ 要改名的话，必须【同步修改】worker/src/html-rewriter.ts 和
 *       worker/src/index.ts 里的选择器，并补上跨包测试。
 *
 *   ── 约定 2：转义只做一次，分工是「fetch 负责反转义、render 负责转义」 ──
 *
 *     数据库里存的是【已经 HTML 转义过】的文本
 *     （存储不变量，见 worker/src/html.ts 的注释）
 *            │
 *            │  fetch.ts 的 fetchComments() 调 unescapeHtml() 恰好一次
 *            ▼
 *     Comment.author / Comment.body 是【纯文本】
 *            │
 *            │  renderComment() 调 escHtml() 恰好一次
 *            ▼
 *     安全的 HTML
 *
 *     ⚠ 所以 renderComment() 里【不能】写成 escHtml(unescapeHtml(x))：
 *       输入已经是纯文本，再反转义一次会把用户输入的 `&lt;` 变成真的 `<`
 *       —— 这是 XSS。反过来，如果你【绕过 fetchComments()】直接把 D1 的
 *       原始行、或 `npx ziscus export` 出来的 JSON 喂给 renderComment()，
 *       那就会【双重转义】，用户看到字面的 `&amp;quot;` 之类。
 *       ★ 走 `npx ziscus fetch` 那条 CLI 通路时要特别注意，见 cli/fetch.ts。
 *
 *   ── 约定 3：escHtml / unescapeHtml 在这里【有一份自己的拷贝】，这是刻意的 ──
 *
 *     worker/ 和 embed/ 是【两个独立构建、独立发布、互不 import 的产物】：
 *       · worker/ 由 wrangler/esbuild 打成跑在 Cloudflare 边缘的 bundle
 *       · embed/  由 tsdown 打成给 Node 构建期用的 npm 包 `ziscus`
 *     如果让 embed 去 import worker 的源码，npm 包里就会拖进整个 Worker
 *     （连带 Cloudflare 专有 API）；反过来 Worker 也不该依赖 npm 包。
 *     所以这十几行是"为了能独立发布而付的重复税"。
 *
 *     ⚠ 【维护纪律】两份实现必须逐字符保持一致。只改一边会造成最难查的
 *       那类 bug：同一个页面上，"构建时烘焙的旧评论"和"提交后即时预览的
 *       新评论"由两套代码渲染，转义层数不同，看起来就是有的评论正常、
 *       有的评论显示成 `&amp;lt;`。
 *     ★ 想根治：把这两个函数抽到第三个包（如 @ziscus/shared）由两边依赖，
 *       或者加一条 CI 断言两个文件的函数体哈希相同。
 *       **目前仓库里没有任何这样的保护。**
 *
 * 【本文件导出一览】
 *   escHtml / unescapeHtml  两个转义工具（见约定 3）
 *   Comment                 渲染器的输入契约
 *   renderComment           单条评论 → <article>
 *   renderCommentList       评论数组 → <section id="comments">
 *   renderCommentForm       → <form class="comment-form">
 *   renderCommentsSection   上面两者拼接（★ SSG 用户最常用的入口）
 */

/**
 * 转义 5 个 HTML 敏感字符，并剔除 NUL 字节。
 *
 * ⚠ 与 `worker/src/html.ts` 的同名函数是【两份必须保持一致的拷贝】，
 *   原因见文件头「约定 3」。
 *
 * 【输入契约】`s` 必须是【纯文本】（即已经被 `fetch.ts` 的 `unescapeHtml()`
 * 处理过一次）。传入已转义的文本 → 结果是双重转义，用户看到字面实体。
 *
 * 为什么 `\0` 是【删掉】而不是转义成实体：NUL 在 HTML 里是非法字符，
 * 某些语言/解析器会把它当字符串结尾（截断后续内容），删掉比留下更安全。
 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\0/g, "");
}

/**
 * `escHtml` 的精确逆运算 —— 只覆盖它产出的那 5 种实体。
 *
 * ⚠ 【`&amp;` 必须放在最后替换，顺序真的会影响结果】
 *
 *   评论者字面输入的 `&lt;` 存进库里是 `&amp;lt;`。解码时：
 *     · 先解 `&amp;` → 变成 `&lt;` → 立刻被下一条 `&lt;` 规则命中 → `<`   ❌ 多剥一层
 *     · 最后解 `&amp;` → 全程不匹配其它规则 → 最终得到 `&lt;`             ✅ 正确
 *
 *   之所以存在这种陷阱，是因为 `&amp;lt;` 的字符序列里【不含】`&lt;` 子串
 *   （`l` 前面是 `;` 不是 `&`），所以"最后解 &amp;"实际上是在
 *   "其它规则都不动它"的前提下才成立的 —— 两条规则是配合关系，别单独改。
 *   （`worker/src/html.ts` 的注释里有 120 种排列的穷举验证结论，
 *    并且仓库 notes/ 下有三个 verify-*.mjs 脚本可以复现。）
 *
 * ⚠ 【只能调用一次】本函数【非幂等】。调两次会连剥两层实体：
 *     "&amp;amp;" --第1次--> "&amp;" --第2次--> "&"   ← 用户内容被吞掉
 *   本文件内部【不调用它】；整个包里唯一的调用点是
 *   `fetch.ts` 的 `fetchComments()`。这也是为什么约定 2 要求
 *   "fetch 反转义、render 转义"，而不是两边都做一遍。
 */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 渲染器的输入契约：一条评论。
 *
 * ⚠ `author` / `body` 的语义是【纯文本、未转义】——
 *   这个类型正是 `fetchComments()` 的返回值类型，而它已经在返回前
 *   做过一次 `unescapeHtml()`（见文件头「约定 2」）。
 *   别把这个类型当成"数据库那一行的形状"：D1 里存的是已转义文本。
 *
 * `status` 类型上是四态，但 `GET /comments/:slug` 【只返回已批准的评论】。
 * 其余三态只会出现在管理端 API（`/admin/comments`）和备份 JSON 里。
 * ★ 想做"评论预览""待审列表"之类的功能，可以直接复用这个类型 + 自己过滤。
 */
export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  slug: string;
  status: "pending" | "approved" | "rejected" | "spam";
}

/**
 * 把一条评论渲染成 `<article class="comment">`。
 *
 * 【为什么这里只 escHtml，不写 unescapeHtml】
 *   因为输入契约规定 `comment.author` / `comment.body` 已经是纯文本
 *   （`fetchComments()` 反转义过了，见文件头「约定 2」）。
 *   这里再反转义一次，用户输入的 `&lt;script&gt;` 就会变成真的 `<script>`
 *   —— 直接是 XSS。⚠ 不要"顺手"补上 unescapeHtml。
 *
 * ⚠ 【时区硬编码为 UTC，而且本函数不接受时区参数】
 *   后果：UTC+8 的读者看到的日期可能差一天（当地深夜发的评论会显示成前一天）。
 *   更别扭的是：worker 端的即时预览版本（`worker/src/html-rewriter.ts`）
 *   **是按访客真实时区渲染的**（从 `request.cf.timezone` 取）。
 *   于是同一个页面上，"构建进 HTML 的旧评论"和"刚提交后即时预览的新评论"
 *   日期口径不一致，刷新一下还会变。
 *   ★ 想统一：给本函数加一个 `timeZone` 参数，由 SSG 传入站点时区。
 *
 * ⚠ `datetime` 属性包了 `escHtml()`：这既是安全需要（属性值里的 `"`
 *   会逃逸出属性，导致 XSS/结构破坏），也顺带让非法日期仍能原样输出。
 *   但【可见文本】走 `toLocaleDateString()`，非法日期会渲染成
 *   "Invalid Date" —— 这里没有兜底，兜底在 `fetch.ts` 的 createdAt 回退逻辑。
 *
 * @param comment 一条【纯文本】评论（见 {@link Comment}）
 * @returns 单个 `<article>` 的 HTML 字符串，不含任何外层包裹
 */
export function renderComment(comment: Comment): string {
  const date = new Date(comment.createdAt);
  // en-US + UTC 都是硬编码：同一个站点在世界上任何地方构建，输出的 HTML 都必须
  // 逐字节一致（可复现构建）。想按读者本地时间显示只能靠前端 JS —— 而本项目没有。
  const formatted = date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return `<article class="comment">
        <header class="comment-header">
          <strong class="comment-author">${escHtml(comment.author)}</strong>
          <time datetime="${escHtml(comment.createdAt)}">${formatted}</time>
        </header>
        <p class="comment-body">${escHtml(comment.body)}</p>
      </article>`;
}

/**
 * 把评论数组渲染成 `<section id="comments">`（小标题 + 所有评论）。
 *
 * 【为什么标题文案要分三种情况】
 *   `count === 0` 时输出 "Comments" 加一句引导语（"还没有评论，来做第一个"），
 *   而不是 "0 Comments"。空评论区是【新访客看到的第一屏】，
 *   "0 Comments" 会让站点显得没人气。这是刻意的产品取舍，不是漏写。
 *
 * ⚠ 【这里会静默丢弃所有非 approved 的评论】
 *   即使调用方传进来 pending / spam，它们也不会出现在输出里，
 *   而且【不会有任何警告】。
 *   对 `GET /comments/:slug` 的返回值来说这只是冗余保险（接口本来就只
 *   返回已批准评论）；但如果你自己拼 `Comment[]`（比如从
 *   `npx ziscus export` 的 JSON 里读），忘了把 status 置成 `"approved"`，
 *   评论就会【静默消失】，页面显示"还没有评论"。
 *   ★ 排查此类问题时，先在构建脚本里 `console.log(comments.map(c => c.status))`。
 *
 * ⚠ 输出里的 `id="comments"` 是 worker 端 HTMLRewriter 依赖的选择器，
 *   与 `renderCommentForm()` 的 `.comment-form` 一起构成跨包契约
 *   —— 见文件头「约定 1」，改名之前先读那里。
 *
 * ⚠ 本函数【不产出外层容器元素】（没有 <div> 包裹 section），
 *   样式钩子完全依赖 `#comments` 这个 id。`styles.ts` 的规则就挂在它上面。
 *
 * @param comments 任意评论数组；只有 `status === "approved"` 的会被渲染
 * @returns `<section id="comments">…</section>` 完整 HTML 字符串
 */
export function renderCommentList(comments: Comment[]): string {
  // 防御性过滤：既是"只渲染已批准评论"这条安全策略的落点，
  // 也是幂等保证 —— 同一个数组渲染两次结果相同。见函数注释的 ⚠。
  const approved = comments.filter((c) => c.status === "approved");
  const count = approved.length;

  const heading =
    count === 0
      ? `<h2>Comments</h2>\n      <p>No comments yet — be the first to comment.</p>`
      : `<h2>${count} ${count === 1 ? "Comment" : "Comments"}</h2>`;

  const items = approved.map((c) => renderComment(c)).join("\n      ");

  return `<section id="comments" class="comments-section">
      ${heading}
      ${items}
    </section>`;
}

/**
 * 渲染评论提交表单 `<form method="POST" class="comment-form">`。
 *
 * 【为什么是普通 <form method="POST"> 而不是 JS 提交】
 *   这是整个项目的立足点：访客端【零 JavaScript】。表单直接 POST 到 Worker，
 *   Worker 处理完返回 303 跳回原页面（PRG 模式，避免刷新导致重复提交）。
 *   ★ 想加"提交后不跳转 / 局部刷新"的体验就必须引入 JS，
 *     等于放弃项目的核心卖点（Lighthouse 满分、无 JS 可被追踪）。
 *     真要做，也建议用"渐进增强"：默认表单可用，JS 存在时才拦截。
 *
 * ⚠ 【部署陷阱：submitUrl 的 host 必须出现在 Worker 的 ALLOWED_ORIGINS 里】
 *   Worker 的 `handleSubmit()` 会校验请求的 Origin / Referer 是否属于
 *   ALLOWED_ORIGINS，不匹配直接 403（CSRF 防护，见 worker/src/submit.ts）。
 *   而浏览器对【跨域表单 POST 一定会带 Origin 头】。所以：
 *     · 同源部署（Worker 顺便托管静态站，wrangler.toml 里配了 [assets]）
 *       → 没问题
 *     · 跨域部署（表单在 myblog.com，Worker 在 *.workers.dev）
 *       → 必须在 ALLOWED_ORIGINS 里写上 myblog.com，否则访客点提交
 *         只会看到 403，而且【构建时完全看不出来，只有线上真人点击才发现】。
 *   `npx ziscus deploy --site-url https://myblog.com` 已经自动把这个 host
 *   填进生成的 wrangler.toml 了；手写配置的人容易漏。
 *
 * ⚠ 【`options.redirectUrl` 是不可信输入的通道，但服务端会兜住】
 *   它被写进隐藏字段，访客可以随手改成 `https://evil.com`。
 *   Worker 端有专门的开放重定向（open redirect）防护：只接受相对路径，
 *   或 hostname 命中 ALLOWED_ORIGINS 的绝对 URL。
 *   所以这里【只做属性转义、不做白名单校验】是安全的。
 *   ★ 但别把这个字段的设计搬到没有兜底的其它表单处理器上。
 *
 * ⚠ 【可用性限制：两个 id 是硬编码的】
 *   `id="comment-author"` / `id="comment-body"` 与 `label[for=...]` 写死了，
 *   所以【同一个页面上只能出现一个评论表单】，否则 id 重复、
 *   点 label 会聚焦到第一个表单的输入框（无障碍问题）。
 *   ★ 要做"每页多个评论区"，必须先把这些 id 参数化。
 *
 * ⚠ `required` 是唯一的客户端校验。服务端的长度/频率校验在 Worker 里
 *   （RATE_LIMIT 按 IP 每小时限流），本函数不做任何校验 —— 它是纯渲染。
 *
 * ⚠ 表单【没有 CSRF token 字段】，这是刻意的：项目无 session、无 cookie
 *   身份，靠 Origin/Referer 校验 + Bearer 只用于管理面。别在这里加
 *   "看起来更安全"的 token 字段，它没有可绑定的身份。
 *
 * @param slug       页面标识，写进隐藏字段 `slug`（Worker 靠它给评论归类）
 * @param submitUrl  Worker 提交地址，通常 `${endpoint}/submit`
 * @param options.redirectUrl 提交成功后的回跳地址（可选；服务端会做安全过滤）
 * @returns `<form class="comment-form">` 完整 HTML 字符串
 */
export function renderCommentForm(
  slug: string,
  submitUrl: string,
  options?: { redirectUrl?: string },
): string {
  // 只在调用方真的传了 redirectUrl 时才输出这个隐藏字段：
  // 空字符串的 redirect 会在 Worker 里被当成"没有指定"，回退到 Referer 判断，
  // 所以留下空字段没有意义，反而让 HTML 更脏。
  const redirectField = options?.redirectUrl
    ? `\n      <input type="hidden" name="redirect" value="${escHtml(options.redirectUrl)}">`
    : "";

  // action 也要 escHtml：submitUrl 常来自配置/环境变量，含 & 或 " 时会破坏属性。
  return `<form method="POST" action="${escHtml(submitUrl)}" class="comment-form">
      <input type="hidden" name="slug" value="${escHtml(slug)}">${redirectField}
      <div>
        <label for="comment-author">Name</label>
        <input type="text" name="author" id="comment-author" required>
      </div>
      <div>
        <label for="comment-body">Comment</label>
        <textarea name="body" id="comment-body" rows="4" required></textarea>
      </div>
      <button type="submit">Post Comment</button>
    </form>`;
}

/**
 * 把「评论列表 + 提交表单」拼成一段可以整块塞进模板的 HTML。
 * ★ 这是 SSG 用户最常用的入口，也是 README Quick start 里演示的那个。
 *
 * 【为什么表单放在 `<section id="comments">` 的【外面】】
 *   不是随手排的，是被 worker 端的即时预览机制倒逼的：
 *   `worker/src/html-rewriter.ts` 对 `#comments` 调用的是
 *   `setInnerContent()`，会【整个替换掉该元素的全部子节点】。
 *   表单留在 section 外面才不会被一起换掉 ——
 *   否则访客提交完评论、重定向回来，页面上的表单就没了
 *   （第二个评论就发不出去，且看起来像页面坏了）。
 *   ⚠ 别为了"结构更好看"把表单挪进 `<section id="comments">` 里。
 *
 * ⚠ 本函数不产出外层包裹元素，返回的是两个顶层元素的拼接。
 *   如果你要把它塞进某个容器，容器上挂 CSS 变量的做法才有效
 *   （见 `styles.ts` 关于 `--ziscus-*` / `--color-*` 的说明）。
 *
 * @param comments   评论数组（同 `renderCommentList`，非 approved 的会被过滤）
 * @param slug       页面标识
 * @param submitUrl  Worker 提交地址
 * @param options    原样透传给 {@link renderCommentForm}
 * @returns 列表 + 表单拼接后的 HTML 字符串
 */
export function renderCommentsSection(
  comments: Comment[],
  slug: string,
  submitUrl: string,
  options?: { redirectUrl?: string },
): string {
  return `${renderCommentList(comments)}
    ${renderCommentForm(slug, submitUrl, options)}`;
}
