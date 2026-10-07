/**
 * ============================================================================
 * embed/src/index.ts —— npm 包 `ziscus` 的主入口（SSG 用户 import 的就是它）
 * ============================================================================
 *
 * 【这个文件在系统里的位置】
 *
 *   embed/ 被 tsdown 打包成 npm 包 `ziscus`。一个包名，三个入口
 *   （见 embed/package.json 的 exports 字段）：
 *
 *     "ziscus"            → dist/index.js    ← 本文件。构建时给 SSG 用
 *     "ziscus/worker"     → dist/worker.js   ← Worker 本体，跑在 Cloudflare 边缘
 *     "ziscus/schema.sql" → dist/schema.sql  ← D1 建表语句
 *
 *   所以本文件是【构建时运行的那一半读者 API】。典型用法：
 *
 *     import { fetchComments, renderCommentsSection, ziscusStyles } from "ziscus";
 *
 *     const comments = await fetchComments("my-post", endpoint);   // fetch.ts
 *     const html = renderCommentsSection(comments, "my-post", `${endpoint}/submit`);
 *     const css  = ziscusStyles();                                 // styles.ts
 *
 *   ⚠ 这三步全部发生在【你的构建机器上】，产出的是一段静态 HTML 字符串。
 *     访客的浏览器【不会下载这个包】，也不会执行这里的任何代码。
 *     这就是"访客端零 JavaScript"的实现方式 —— 不是不写 JS，
 *     而是把 JS 全部挪到构建期。
 *
 * 【为什么导出面故意很窄】
 *   这里只暴露"读路径"需要的三样东西：转义工具、渲染器、取数函数。
 *   其余模块【都不从这里导出】：
 *     · cli/*        —— 只能在 Node 里跑，入口是 bin 的 dist/cli.js
 *     · cli/deploy   —— 部署脚手架，属于 CLI 专属细节
 *     · styles/themes —— ⚠ 见下
 *
 *   ⚠ `styles/themes.ts` 的 `generateThemeCss()` / `THEMES` 【没有被导出】。
 *     也就是说主题只能通过 `npx ziscus init --theme dark` 在脚手架阶段使用，
 *     想在自己的构建脚本里【以函数形式】调用主题是做不到的：
 *     package.json 的 exports 也没有开放 `ziscus/styles/themes` 这样的子路径，
 *     所以连 deep import 都走不通（会被 Node 的 exports 校验拦下）。
 *     ★ 想支持：在下面补一行 export，并接受"多一个需要长期兼容的公开 API"。
 *
 * 【为什么 `ziscusStyles` 要同时别名成 `commentStyles`】
 *   历史包袱：早期版本这个函数叫 `commentStyles`，改名时保留了别名，
 *   以免老站点升级后【构建直接失败】（import 不到就报错，属于硬失败）。
 *   这属于兼容层。⚠ 别删，除非你确定要发 breaking change；
 *   ★ 想清理：发大版本时移除别名，并在 CHANGELOG 里写明迁移方式。
 */
export { type Comment, escHtml, unescapeHtml, renderComment, renderCommentList, renderCommentForm, renderCommentsSection } from "./render.js";
export { ziscusStyles, ziscusStyles as commentStyles } from "./styles.js";
export { fetchComments } from "./fetch.js";
