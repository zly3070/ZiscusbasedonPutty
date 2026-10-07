/**
 * ============================================================================
 * embed/src/styles.ts —— 评论区的默认 CSS（★ 用户自定义样式的第一入口）
 * ============================================================================
 *
 * 【这个文件在系统里的位置】
 *
 *   构建时由 SSG 调 `ziscusStyles()` 拿到一段 CSS 字符串，再由你决定
 *   往哪儿塞：
 *
 *     const css = ziscusStyles();
 *     // ① 内联进页面 <style>${css}</style>      ← README 示例的用法
 *     // ② 或写到 assets/ziscus.css 再 <link>    ← ★ 更推荐
 *
 *   它和 render.ts 一样是【纯字符串函数：无 I/O、无副作用】。
 *
 * 【选择器是跨包契约的一部分】
 *   下面的 `#comments` / `.comment` / `.comment-form` 必须和
 *   `render.ts` 输出的 class 名一一对应；而 `#comments` 和 `.comment-form`
 *   同时还被 worker 端 HTMLRewriter 依赖（见 render.ts 文件头的「约定 1」）。
 *   ⚠ 改这三个名字要同时动三个文件：render.ts、styles.ts、
 *     worker/src/html-rewriter.ts（外加 worker/src/index.ts 的暂停逻辑）。
 *
 * 【★ 主题机制：两级 CSS 变量回退链】
 *
 *   每个颜色都写成
 *
 *       var(--ziscus-text, var(--color-text, #1a1a1a))
 *            ↑ 第一级          ↑ 第二级       ↑ 最后兜底
 *
 *   1. `--ziscus-*` —— ziscus 专用命名空间，优先级最高。要显式定制就用它。
 *   2. `--color-*`  —— ★【这是给"站点已经有一套设计系统"的情况准备的】。
 *      如果你的站点在 :root 上定义了 `--color-text` / `--color-bg` /
 *      `--color-border` / `--color-muted`，那么【什么都不用做】，
 *      评论区会自动跟随站点配色、亮暗主题切换也能跟着走。
 *      这是本文件最重要的设计意图，也是它不写死颜色的唯一理由。
 *   3. 硬编码值 —— 独立使用（没有设计系统）时也有能看的观感。
 *
 *   ⚠ 能被识别的变量【只有这 4 个】：text / bg / border / muted。
 *     字号、行高、间距、圆角、按钮形状【全部没有变量化】。
 *     要改这些只有两个办法：覆盖下面的 CSS 规则（可能被特异性反噬），
 *     或者干脆不用这个函数、自己写一份样式表。
 *   ★ 想扩展：把字号等也提成变量，但注意这是公开 API，加变量容易、删变量难。
 *
 *   ★ 【README 的 Theming 示例有个坑，务必注意】
 *     README 给的自定义示例是：
 *
 *         #ziscus { --ziscus-text: #1a1a1a; --ziscus-bg: #fff; }
 *
 *     ⚠ 但 `#ziscus` 是一个 **id** 选择器，而本文件里的规则挂在 `#comments` 上，
 *       `render.ts` 也只输出 `id="comments"` 和 `class="comments-section"`，
 *       【整个仓库里没有任何地方会输出 id="ziscus"】
 *       （只有 worker 的一个测试夹具里手工写了 `<section id="ziscus">`）。
 *     所以照抄 README 那段 CSS，在标准用法下【不会生效】——
 *     CSS 变量只是定义了没人用，颜色还是默认值。
 *
 *     ★ 可靠的写法是挂到根元素或你自己的容器上：
 *         :root { --ziscus-text: #1a1a1a; --ziscus-bg: #fff; }
 *       或者把你的容器（比如 <main>）加上这段变量定义 ——
 *       变量沿 DOM 继承，容器内的 #comments 就能读到。
 *     顺便说：`#ziscus` 这个 id 只在"独立嵌入"场景有意义，
 *     worker 的 HTMLRewriter 也认它（`.on("#ziscus", handler)`），
 *     那是给不用本渲染器、自己手写裸 HTML 的用户留的兼容通道。
 *
 * ⚠ 【CSP（内容安全策略）】
 *   本函数返回的是【纯文本 CSS，不含 <style> 标签】。
 *   如果你的站点有严格 CSP：
 *     · 内联 <style> 需要 `style-src 'unsafe-inline'`（或 nonce/hash）
 *     · ★ 落成独立 .css 文件用 <link> 引入则没有这个问题，
 *       还能被 CDN 缓存、不重复传输 —— 长页面多评论时收益明显。
 *
 * ⚠ 【本文件不做任何 CSS 转义/校验】
 *   返回值全部是硬编码字面量，没有任何外部输入拼接进来，所以目前是安全的。
 *   ★ 但如果你以后加了"从配置读颜色"的功能，务必先校验格式 ——
 *     见 styles/themes.ts 里 `generateThemeCss()` 的同类风险提示。
 *
 * 【导出】`ziscusStyles`（在 index.ts 里同时别名导出为 `commentStyles`）。
 */

/**
 * 返回评论区的默认样式表（纯 CSS 文本，不含 `<style>` 标签）。
 *
 * @returns 一段可直接插入 `<style>` 或写进 `.css` 文件的 CSS 字符串。
 *          ⚠ 每次调用都会重新构造字符串，没有缓存 —— 在"每个页面都调一次"
 *          的循环里会产生很多等价的字符串对象。SSG 里建议只调一次、
 *          复用同一个变量。
 */
export function ziscusStyles(): string {
  return `
#comments { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--ziscus-border, var(--color-border, #e0e0e0)); }
#comments h2 { font-size: 1.2rem; margin-bottom: 1rem; }
.comment { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--ziscus-border, var(--color-border, #e0e0e0)); }
.comment-header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.25rem; }
.comment-author { color: var(--ziscus-text, var(--color-text, #1a1a1a)); }
.comment-header time { font-size: 0.85rem; color: var(--ziscus-muted, var(--color-muted, #6b6b6b)); }
.comment-body { margin: 0; color: var(--ziscus-text, var(--color-text, #1a1a1a)); }
.comment-form { margin-top: 1.5rem; }
.comment-form label { display: block; margin-bottom: 0.25rem; font-size: 0.9rem; color: var(--ziscus-muted, var(--color-muted, #6b6b6b)); }
.comment-form input[type="text"], .comment-form textarea { width: 100%; padding: 0.5rem; margin-bottom: 0.75rem; border: 1px solid var(--ziscus-border, var(--color-border, #e0e0e0)); background: var(--ziscus-bg, var(--color-bg, #fff)); color: var(--ziscus-text, var(--color-text, #1a1a1a)); font: inherit; box-sizing: border-box; }
.comment-form textarea { resize: vertical; }
.comment-form button { padding: 0.5rem 1.25rem; border: 1px solid var(--ziscus-border, var(--color-border, #e0e0e0)); background: var(--ziscus-text, var(--color-text, #1a1a1a)); color: var(--ziscus-bg, var(--color-bg, #fff)); font: inherit; cursor: pointer; min-height: 44px; }
.comment-form button:hover { opacity: 0.85; }
`;
}
