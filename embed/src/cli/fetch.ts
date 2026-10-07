/**
 * ============================================================================
 * embed/src/cli/fetch.ts —— CLI 子命令 `npx ziscus fetch`（拉评论落成 JSON 文件）
 * ============================================================================
 *
 * 【这个文件在系统里的位置】
 *
 *   ⚠ 它和 `embed/src/fetch.ts` 是【两条完全不同的取数通路】，同名但不同命：
 *
 *   ┌─ 库通路：embed/src/fetch.ts ─────────────────────────────────────┐
 *   │   你的构建脚本里 `await fetchComments(slug, endpoint)`            │
 *   │     → 返回 Comment[]（已反转义成【纯文本】）                      │
 *   │     → 直接交给 render.ts 拼 HTML                                 │
 *   │   ★ 不落盘，评论从 API 直达 HTML                                 │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ CLI 通路：本文件 ───────────────────────────────────────────────┐
 *   │   npx ziscus fetch --slug post                                    │
 *   │   npx ziscus fetch --all --sitemap https://site/sitemap.xml       │
 *   │     → GET {endpoint}/comments/{slug}                              │
 *   │     → 【原样】JSON.stringify 写进 {output}/<slug>.json            │
 *   │     → SSG 再从这些 JSON 文件里读                                  │
 *   │       （Hugo 的 .Site.Data.comments、Jekyll 的 site.data.comments）│
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ★ 为什么需要"先落盘"这条通路：Hugo / Jekyll / Eleventy 这类模板引擎的
 *     工作方式是"读数据文件 → 渲染模板"，模板里不方便 await 网络请求
 *     （Hugo 的模板根本不能发请求）。所以本通路把数据先变成静态 JSON，
 *     模板只做纯本地渲染。
 *     证据：`npx ziscus init` 给 Hugo 和 Jekyll 生成的 workflow 里就带了
 *     `npx ziscus fetch --all` 这一步（见 cli/init.ts 的 workflowPreBuild）。
 *     Astro 和 Next.js 的模板则直接用 fetchComments()，不需要本文件。
 *
 * ⚠⚠ 【两条通路对"转义"的处理不一致 —— 这是本文件最大的坑】
 *
 *   `embed/src/fetch.ts` 的 `fetchComments()` 会调 `unescapeHtml()`，
 *   把 author / body 还原成【纯文本】。
 *   而【本文件完全不反转义】，写进 JSON 的就是 API 返回的【已转义文本】。
 *
 *   于是 CLI 通路上出现了双重转义：
 *
 *     用户输入     <b>hi</b> & "x"
 *     D1 里存的    &lt;b&gt;hi&lt;/b&gt; &amp; &quot;x&quot;
 *     JSON 文件    同上（本文件没反转义）
 *     模板渲染     {{ .body }} —— Go template / Liquid / Nunjucks
 *                  【都会自动再转义一次】
 *     页面显示     &lt;b&gt;hi&lt;/b&gt; &amp; &quot;x&quot;
 *                  ↑ 访客看到的是一堆实体字符，不是正文
 *
 *   ⚠ 影响面：评论正文里出现 `&`、引号、`<` 极其常见，所以这个 bug
 *     一旦触发就非常显眼。而且它是【部分坏】的：同一份 `npx ziscus init`
 *     产出五个 SSG 模板，Hugo / Eleventy / Jekyll 三个坏，
 *     Astro / Next.js 两个好（它们走 fetchComments()）——
 *     所以很容易被误判成"某个 SSG 的问题"。
 *
 *   ★ 修法（二选一，⚠ 这属于改逻辑，不在本次"只加注释"的范围内）：
 *     (a) 写 JSON 之前对 author / body 各调一次 `unescapeHtml()`，
 *         让两条通路的输出语义统一为"纯文本" —— 模板自动转义一次即正确。
 *     (b) 保持 JSON 里是转义文本，把三个模板改成不转义输出
 *         （Go 的 `{{ .body | safeHTML }}`）。
 *     ⚠ 强烈建议 (a)：方案 (b) 把"必须转义"的责任推给了每个模板，
 *       一旦将来 JSON 里混进未转义内容就是 XSS，而且 safeHTML 这类
 *       标记还会影响摘要/检索等其它用途。
 *     ⚠ 无论选哪个，都要先确认备份通路 `cli/export.ts`（同样是原样导出）
 *       是否需要一起改 —— 否则"导出 JSON 再 import 回去"会把转义
 *       层数越叠越多（每来回一次多一层 `&amp;`）。
 *
 * ⚠ 【本文件没有"成功/失败"的概念】
 *   `runFetch()` 返回 void，失败时也正常返回（写一个 `[]` 文件）；
 *   `cli.ts` 里也不看返回值，直接打印 `✓ Fetched comments for "…"`。
 *   所以【"✓"只代表循环跑完了，不代表数据对】。详见 runFetch 的注释。
 *
 * 【导出】runFetch（单页面抓取）、extractSlugsFromSitemap（--all 用的 slug 来源）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `npx ziscus fetch` 的参数，全部来自命令行选项（组装逻辑在 cli.ts）。
 *
 * ⚠ `slug` 不只是查询参数，它【还会被当成文件名】：
 *   `join(outputDir, `${slug}.json`)`。
 *   所幸 Worker 的读路由只接受 `^[a-z0-9-]+$`，字符集里没有 `/`、`\`、
 *   `.`、`..`，所以目前【没有路径穿越（path traversal）风险】。
 *
 *   ⚠ 但这份安全是【间接得来的】：它依赖"调用方只传合法 slug"这个前提，
 *     而不是本文件的显式校验。今天安全是因为 `cli.ts` 传的是
 *     `opts.slug`（用户手输）或从 sitemap 抽出来的末段路径 ——
 *     后者恰好也不会含 `/`。
 *   ★ 建议在这里显式校验一次（`/^[a-z0-9-]+$/`），成本极低，
 *     而且能把"文件名安全"变成本模块自己的不变式，
 *     不再依赖上游所有调用点都记得校验。
 */
export interface FetchOptions {
  endpoint: string;
  slug: string;
  outputDir: string;
}

/**
 * 拉取某个 slug 的评论，写成 `{outputDir}/{slug}.json`。
 *
 * 【输入输出契约】
 *   endpoint   Worker origin（⚠ 本文件同样没有去掉末尾斜杠，
 *              见 embed/src/fetch.ts 文件头同类问题）
 *   slug       页面标识，同时决定输出文件名（见 FetchOptions 的 ⚠）
 *   outputDir  输出目录，不存在会自动创建（`mkdir` 的 `recursive: true`）
 *   副作用     写一个 JSON 文件 —— ⚠【失败时也照写】
 *   返回       `void`。**没有成功/失败信号**，调用方无法判断结果。
 *
 * ⚠⚠ 【失败会被伪装成"这个页面没有评论"】
 *
 *   `const comments = res.ok ? await res.json() : [];`
 *   —— 非 2xx 响应被折成空数组，然后【照常写文件、照常 return】。
 *   于是下面这些完全不同的故障，在磁盘上留下的产物一模一样（内容为 `[]`）：
 *     · 404 —— slug 写错 / 大小写不一致 / 含非法字符
 *     · 500 —— D1 查询失败
 *     · 503 —— Worker 挂了或被 Cloudflare 限流
 *     · 401/403 —— 基本不会发生（读接口是公开的）
 *
 *   ⚠ 最糟的后果是【用坏数据覆盖好数据】。这在重建流水线里是常态路径：
 *       第 1 次 fetch 成功 → post.json 有 12 条评论 → 站点正常
 *       第 2 次 fetch 撞上 503 → post.json 被写成 []  → 重建后评论全没了
 *     全程【没有任何报错】，构建成功，workflow 显示绿色，
 *     评论"人间蒸发"，而且 git history 里只有一行 `[]` 的 diff。
 *
 *   ★ 想变安全，按优先级：
 *     ① 非 2xx 时【抛错且不写文件】—— 保住上一次的好数据，
 *        让构建失败（"构建失败"远好于"发布一份内容缺失的页面"）。
 *     ② 至少写之前把旧文件备份成 `<slug>.json.bak`，让人能人工恢复。
 *     ③ 在 JSON 里加一个元数据字段记录抓取状态，让模板/CI 能察觉。
 *     ⚠ 改动 ③ 会破坏"JSON 就是评论数组"这条事实契约（模板在用），
 *       属于 breaking change。
 *
 * ⚠ 【没有 try/catch —— 网络异常会直接冒泡出去】
 *   这是和库通路（`embed/src/fetch.ts` 的"吞掉一切并返回 []"）
 *   完全相反的取向。好处是网络问题不会被静默；坏处是：
 *   在 `--all` 模式下，一次网络抖动会让循环【中途死掉】
 *   （`cli.ts` 里是 `for (const slug of slugs) await runFetch(...)`），
 *   磁盘上处于【半新半旧】的状态，而已经写好的那部分文件是有效的 ——
 *   你无法从产物本身看出哪些页面是这次抓的、哪些是上次的。
 *   ★ 要做健壮的全量抓取：要么"全部抓到内存里、最后统一落盘"，
 *     要么收集失败清单、打印出来并让进程以非 0 退出。
 *
 * ⚠ 【串行、无重试、无并发控制】
 *   10 秒超时（比库通路的 5 秒宽，因为 CLI 是交互场景，用户能等）。
 *   但 `--all` 是纯串行的：sitemap 里 3000 个页面 × 每个 ~100ms
 *   就是 5 分钟；如果站点稍慢，CI 的 job 超时上限会被撞到。
 *   ★ 想提速：加一个有并发上限的批量版本（比如 5~10 并发），
 *     ⚠ 但要注意 Cloudflare 的速率限制和 D1 的并发读配额 ——
 *     并发太高会被当成攻击，反而更慢。
 *
 * ⚠ 【写入的 JSON 是 API 的原始形态】，这是事实上的公开契约：
 *     · 字段是 snake_case（`created_at`，不是 `createdAt`）
 *     · 文本是【已转义】的（见文件头的双重转义 ⚠）
 *     · 顶层就是一个数组，没有包装对象
 *   所以 `cli/init.ts` 生成的模板里写的是 `{{ .created_at }}`。
 *   ⚠ 改这里的输出形状会同时打断所有已经 init 过的项目 ——
 *     而它们的模板在这次升级里【不会自动更新】。
 *
 * @param options 见 {@link FetchOptions}
 * @returns 无返回值。⚠ 它【不是】成功信号：失败时也正常返回。
 */
export async function runFetch(options: FetchOptions): Promise<void> {
  const { endpoint, slug, outputDir } = options;

  // 10 秒超时：没有这个上界，一个挂住的连接会让 CI job 一直挂到超时被杀。
  const res = await fetch(`${endpoint}/comments/${slug}`, {
    signal: AbortSignal.timeout(10000),
  });

  // ⚠ 这一行把"抓取失败"折叠成了"这个页面没有评论"，而且【不会留下任何痕迹】。
  //   详见函数注释里"用坏数据覆盖好数据"的说明。★ 这是本文件最该修的一行。
  const comments = res.ok ? await res.json() : [];

  await mkdir(outputDir, { recursive: true });
  // 末尾补 "\n" 是为了让 git diff 不出现 "\ No newline at end of file"，
  // 也避免某些工具读最后一行时漏掉。对 JSON 解析没有影响。
  // ⚠ 没有原子写（没有先写临时文件再 rename），所以进程在写一半时被杀
  //   会留下一个【残缺的 JSON】—— 那个文件会让 SSG 直接报解析错误。
  await writeFile(
    join(outputDir, `${slug}.json`),
    JSON.stringify(comments, null, 2) + "\n",
  );
}

/**
 * 从 sitemap XML 里抽出所有页面 slug —— `--all` 模式的 slug 来源。
 *
 * 【为什么用 sitemap】
 *   它是唯一一个"SSG 一定会生成、且列出了站点全部页面"的文件。
 *   相比让用户手写列表或自己爬站，sitemap 是最省事也最可靠的入口。
 *
 * ⚠⚠ 【本函数用"路径最后一段"当 slug —— 会产生大量碰撞，进而静默丢数据】
 *
 *   举例：
 *     /2024/01/hello-world   → "hello-world"
 *     /2025/06/hello-world   → "hello-world"    ← 撞了
 *     /blog/tags/hugo        → "hugo"
 *     /blog/categories/hugo  → "hugo"           ← 又撞了
 *
 *   后果（按严重程度排序）：
 *     ① 同一个 slug 被 fetch 多次 —— 后面的覆盖前面的，
 *        `data/comments/hello-world.json` 最终只包含其中一个页面的评论，
 *        **另一个页面的评论永久丢失**，而且没有任何警告。
 *     ② 浪费请求（重名越多越浪费）。
 *     ③ 更隐蔽的版本：两个页面本该有各自的评论区，但页面上表单里的
 *        slug（由模板决定）如果用的是**完整路径**，那么
 *        fetch 出来的文件名（末段）和表单提交的 slug（完整路径）
 *        【对不上】—— 评论抓回来了，但页面上永远显示不出来。
 *
 *   ⚠ 这个 bug 只在"站点存在末段重名的路径"时才暴露。小型博客可能
 *     一辈子踩不到，一旦踩到就是静默数据丢失 —— 属于最难排查的一类。
 *
 *   ★ 正确做法：slug 的生成规则必须在【三个地方共用同一个函数】：
 *       ① 模板里写进 `<input type="hidden" name="slug" value="…">`
 *       ② 本函数从 sitemap 抽取时
 *       ③ 调用 `fetchComments()` / `runFetch()` 时
 *     典型规则是"用完整 pathname，去掉首尾斜杠，把 `/` 换成 `-`"。
 *     ★ 强烈建议抽一个 `slugify()` 并给它写单元测试（含"两年同名文章"
 *       这种碰撞用例）。目前仓库里【没有这样的共享函数】。
 *
 * ⚠ 【不做 decodeURIComponent】
 *   sitemap 里的 URL 可能含百分号编码（Hugo 对中文/空格标题会生成
 *   `/posts/%E4%B8%AD%E6%96%87/`）。抽出来的 slug 就是
 *   `%E4%B8%AD%E6%96%87`：
 *     · 它不可能和页面表单里的 slug 一致（除非模板也输出编码后的形式）
 *     · 也不匹配 Worker 读路由的 `^[a-z0-9-]+$`（`%` 和大写字母都不合法）
 *   所以只会拿到 404 → 被 runFetch 折成空文件（见 runFetch 的 ⚠）。
 *   ★ 同时也要注意：**即使解码**，中文 slug 依然过不了 Worker 的正则。
 *     想支持非 ASCII slug，必须放宽 Worker 侧的路由正则（那是更深的改动）。
 *
 * ⚠ 【没有 try/catch：`new URL(url)` 对非法输入会抛】
 *   sitemap 里偶尔会出现相对路径、没被替换的模板占位符
 *   （`{{ .Permalink }}`）、或注释里的示例 URL。
 *   任何一个抛错都会让整个 `--all` 循环死掉（因为 cli.ts 里没有兜）。
 *   ★ 建议：把解析失败的 URL 收集起来统一报告，跳过而不是中断。
 *   （注：`new URL()` 本身会按 URL 规范忽略首尾空白，所以
 *     `<loc>` 前后有空格或换行是没问题的。）
 *
 * ⚠ 【正则假设标签就是 `<loc>`，没有命名空间前缀】
 *   标准 sitemap 是 `<loc>`，但有些工具会输出 `<sitemap:loc>`。
 *   那种情况下本函数返回空数组，`--all` 会"成功地抓取了 0 个页面"
 *   并打印 `✓ … 0 pages`，看起来像正常完成。
 *   ★ 至少在结果为 0 时警告一次。
 *
 * ⚠ 【结果不去重】同一个 slug 出现 N 次，就会 fetch N 次。
 *   去重（`[...new Set(slugs)]`）是一行的事，能直接缓解上面的 ① 的一部分
 *   （但解决不了"两个不同页面共用同一个 slug"这个根本问题）。
 *
 * @param xml sitemap.xml 的完整文本
 * @returns slug 数组；⚠ 可能含重复项，顺序与 sitemap 中出现顺序一致
 */
export function extractSlugsFromSitemap(xml: string): string[] {
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  return urls
    .map((url) => {
      // 去掉末尾的 "/"，让 "/blog/" 和 "/blog" 得到同一个结果。
      const path = new URL(url).pathname.replace(/\/+$/, "");
      const segments = path.split("/").filter(Boolean);
      // 只取最后一段 —— ⚠ 这就是上面"碰撞丢数据"的根源。
      // 首页（path 为 ""）会得到 undefined，再用 ?? "" 兜住，
      // 最后被 .filter(Boolean) 剔除，所以主页不会产生一个空文件名。
      return segments[segments.length - 1] ?? "";
    })
    .filter(Boolean);
}
