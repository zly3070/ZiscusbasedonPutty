#!/usr/bin/env node
/**
 * ============================================================================
 * embed/src/cli.ts —— CLI 总入口（`npx ziscus …` 的全部子命令）
 * ============================================================================
 *
 * 【这个文件在系统里的位置】
 *
 *   package.json 的 `bin.ziscus → dist/cli.js`，指的就是本文件。
 *   它是【部署 + 运维面】的唯一入口，和"读路径"（embed/src/fetch.ts、
 *   embed/src/render.ts）完全不重叠：
 *
 *     npx ziscus deploy       建 D1 + 写 wrangler.toml/worker.ts + 建表
 *                             + 设 ADMIN_SECRET + 部署 + 生成 SSG 模板
 *     npx ziscus init         只为 SSG 生成模板 + GitHub workflow
 *     npx ziscus fetch        拉评论落成 JSON（给 Hugo/Jekyll 模板读）
 *     npx ziscus migrate      从 giscus（GitHub Discussions）导入历史评论
 *     npx ziscus dashboard    打印 Bearer 头 + 打开管理面板
 *     npx ziscus comments     列评论（含正文）
 *     npx ziscus mod-log      看 moderation 审计日志
 *     npx ziscus export       备份（--format json|csv、--redact-ip）
 *     npx ziscus import       从备份目录恢复
 *     npx ziscus pause/open   按页关闭/恢复评论
 *     npx ziscus rebuild      触发站点重建，并验证 GitHub token 是否有效
 *     npx ziscus ai-mod …     enable / disable / status / test
 *
 *   ★ 本文件【只负责"解析命令行 + 打印结果 + 选退出码"】。
 *     真正的逻辑都在 ./cli/*.ts 里 —— 要改行为优先改那些模块，
 *     改这里通常只是改提示文案。
 *
 * 【⚠ 本文件最大的结构性问题：endpoint 解析逻辑被复制了 7 遍】
 *
 *   下面这段在除 init/deploy 外的每个子命令里都抄了一份：
 *
 *       let endpoint = opts.endpoint;
 *       if (!endpoint) {
 *         try { endpoint = JSON.parse(await readFile("ziscus.config.json","utf-8")).endpoint; }
 *         catch { console.error(…); process.exit(1); }
 *       }
 *
 *   而且 7 个副本【互不一致】：
 *
 *     · migrate / export / import / dashboard / comments / mod-log
 *         → catch 里报错 + exit(1)，行为一致
 *     · pause / open
 *         → ⚠ 只 catch "文件读不到/解析失败"，【不检查 endpoint 是否为空】。
 *           如果 ziscus.config.json 存在但里面没有 endpoint 字段，
 *           endpoint 就是 undefined，接着
 *           `fetch("undefined/admin/pause/x")` 抛 "Failed to parse URL"
 *           —— 用户看到的是一条原始栈，而不是"请先运行 npx ziscus init"
 *     · rebuild
 *         → 既 catch，又额外做了 `if (!endpoint)` 检查（唯一写对的）
 *     · ai-mod status / test
 *         → 又一份，且错误文案不同
 *
 *   ★ 建议抽一个 `resolveEndpoint(opts)` 帮助函数（含一份正确的空值校验），
 *     7 处全部换掉。这能一次性消灭上面这一整类不一致。
 *     ⚠ 这也是"加新子命令时最容易忘记更新"的地方。
 *
 * 【密钥处理：本文件是全项目唯一会打印明文密钥的地方】
 *
 *   · 密钥统一来自环境变量 `ZISCUS_ADMIN_SECRET`，由文件顶部那句
 *     `loadEnvFile(resolve(process.cwd(), ".env"))` 从项目根的 .env 注入。
 *   · 所有管理端点调用都走 `Authorization: Bearer ${secret}`（见 auth.ts）。
 *   ⚠ 【secret 永远不进 URL】—— 这是项目的一条硬纪律（理由见
 *     worker/src/auth.ts 和 worker/src/index.ts 的注释：URL 里的密钥会进
 *     浏览器历史、Referer、CDN/代理日志、搜索引擎索引）。
 *   ⚠ 唯一的例外是 `ziscus dashboard`：它【故意】把
 *     `Authorization: Bearer <明文密钥>` 打印到 stdout，因为浏览器无法给
 *     普通导航设自定义请求头，用户得靠 ModHeader 之类扩展手工粘贴。
 *     副作用：密钥会留在【终端回滚缓冲、CI 日志、以及你发给别人的截图】里。
 *     ★ 在 CI 里跑 dashboard 前先想清楚，或者干脆别在 CI 里跑。
 *
 * 【退出码约定】
 *   0 = 成功；1 = 任何失败（配置缺失、鉴权失败、上游报错）。
 *   ⚠ 本文件【没有顶层错误处理】：异步 action 里未捕获的异常会以
 *     Node 的 unhandled rejection 形式炸出来（打印栈 + 退出码 1）。
 *     所以用户经常看到的是原始栈，而不是友好提示。
 *   ⚠ 更值得警惕的副作用：**"✓"只代表"这一步没有抛异常"，
 *     不代表业务上成功。** 例如：
 *       · `ziscus fetch --all`：某个页面 404 时会静默写出空 JSON 并打印 ✓
 *       · `ziscus ai-mod test`：AI 完全没配好时也会打印
 *         "AI moderation is working."（见该子命令的 ⚠）
 *     ★ 把 CI 的成功判据只建立在"退出码为 0"上是不够的。
 *
 * 【⚠ 版本号写死在这里】
 *   `.version("0.7.0")` 和 package.json 的 version 是两份独立拷贝，
 *   源码里只靠一行注释提醒"Keep in sync with package.json version"。
 *   发布时忘记改，就会出现 `npx ziscus --version` 报旧版本、
 *   而 npm registry 上是新版本的情况。
 *   ★ 想根治：构建时用 tsdown 的 define/replace 从 package.json 注入。
 */
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInit } from "./cli/init.js";
import { runFetch, extractSlugsFromSitemap } from "./cli/fetch.js";
import { runAiModEnable, runAiModDisable, runAiModStatus } from "./cli/ai-mod.js";
import { runExport } from "./cli/export.js";
import { runModLog } from "./cli/mod-log.js";
import { runMigrate } from "./cli/migrate.js";
import { runListComments } from "./cli/comments.js";
import { runRebuild } from "./cli/rebuild.js";
import { loadEnvFile } from "./cli/load-env.js";
import {
  checkWranglerVersion,
  checkWranglerAuth,
  createD1Database,
  applySchema,
  generateSecret,
  setWranglerSecret,
  deployWorker,
  resolveWorkerDir,
  resolveSchemaPath,
  scaffoldWorker,
  detectGitHubRepo,
} from "./cli/deploy.js";

// Auto-load .env from project root (does not override existing vars)
//
// ⚠ 【为什么必须放在 Command 构造之前】commander 的 action 回调虽然后跑，
//   但 `program.parse()` 会先做参数校验（比如 requiredOption 缺失就退 1）。
//   放在最前面能保证【任何】子命令执行时 process.env 都已就绪。
//
// ⚠ 取的是 `process.cwd()`，不是本脚本所在目录 —— 所以
//   "在哪个目录跑 npx ziscus，就读哪个目录的 .env"。
//   在 monorepo 的子包目录里跑，就会读到子包的 .env（通常不存在），
//   表现成"明明配了密钥却报未设置"。★ 这是最容易踩的坑之一。
//
// ⚠ loadEnvFile 【不覆盖】已存在的环境变量（见 cli/load-env.ts），
//   所以在 CI 里用真实环境变量可以盖住 .env —— 这是好设计，别改。
// ⚠ 它也不做任何语法处理：值两侧的引号会被【原样读进来】
//   （`ZISCUS_ADMIN_SECRET="abc"` → 值含引号 → Bearer 校验失败报 401）。
//   ★ 写 .env 时不要加引号。
loadEnvFile(resolve(process.cwd(), ".env"));

/**
 * 根命令定义。
 *
 * ⚠ `name("ziscus")` 会影响 commander 生成的用法提示文本（`npx ziscus <cmd>`）。
 * ⚠ `.version("0.7.0")` 是硬编码的，漂移风险见文件头说明。
 * ★ 若不希望"不带子命令时什么都不发生"，可以显式加
 *   `program.action(() => program.help())`。
 */
const program = new Command()
  .name("ziscus")
  .description("Zero-JavaScript anonymous comment system")
  .version("0.7.0"); // Keep in sync with package.json version

/**
 * `npx ziscus init` —— 只为 SSG 生成模板文件 + GitHub workflow。
 *
 * 【产出三个文件】（实际由 cli/init.ts 写）
 *   ziscus.config.json                     SSG 后续靠它找 endpoint
 *   <各 SSG 的模板路径>                     渲染评论区的那段模板
 *   .github/workflows/rebuild-comments.yml 收到 repository_dispatch 后重建
 *
 * ⚠ 【会静默覆盖已存在的文件】init.ts 用的是 `writeFile`，不是"存在则跳过"。
 *   第二次跑 init（或改了 --theme 再跑）会【直接盖掉你手改过的模板】。
 *   ★ 跑之前先 commit，或先备份。
 *
 * ⚠ 【交互提问的触发条件有点绕】
 *   只有 `!endpoint || !ssg` 时才开 readline。但进了这个分支之后，
 *   主题那一问的条件是 `if (!theme || theme === "light")` ——
 *   也就是说【显式传了 `--theme light` 也会被再问一次】，
 *   用户会以为自己传的参数没生效。属于交互体验上的小毛病。
 *
 * ⚠ 【合法主题名没有校验】`--theme` 是自由字符串，拼错（如 `--theme Dark`）
 *   不会报错，只会在 themes.ts 里静默回退到 light。
 *   而这里连提示文案里的合法值清单都没打印。
 *   ★ 建议照 validSSGs 的做法给 theme 加白名单。
 *
 * ⚠ 【validSSGs 白名单在本文件里出现了两次】（init 和 deploy 各一份），
 *   另外还在三处 `--ssg` 选项描述文本、InitOptions 的联合类型、
 *   以及 init.ts 的 SSG_CONFIG 键里各出现一次 —— 一共 5~6 处需要同步。
 *   ★ 想做成一件事：把名单提到一个共享常量里，描述文本也从它生成。
 *
 * ⚠ 【`--endpoint` 不做 URL 校验】这里直接把它写进 ziscus.config.json。
 *   打错一个字（漏了 https、多了末尾斜杠）不会在这里报错，
 *   而是在【构建时】表现为评论区静默为空 —— 见 embed/src/fetch.ts 的 ⚠。
 */
program
  .command("init")
  .description("Set up ziscus for your static site")
  .option("--endpoint <url>", "Worker endpoint URL")
  .option("--ssg <name>", "Static site generator (hugo, astro, eleventy, jekyll, nextjs)")
  .option("--theme <name>", "Theme (light, dark, terminal)", "light")
  .action(async (opts) => {
    let { endpoint, ssg, theme } = opts;

    if (!endpoint || !ssg) {
      const rl = createInterface({ input: stdin, output: stdout });
      if (!endpoint) endpoint = await rl.question("Worker endpoint URL: ");
      if (!ssg) ssg = await rl.question("SSG (hugo / astro / eleventy / jekyll / nextjs): ");
      if (!theme || theme === "light") {
        const t = await rl.question("Theme (light / dark / terminal) [light]: ");
        if (t) theme = t;
      }
      rl.close();
    }

    const validSSGs = ["hugo", "astro", "eleventy", "jekyll", "nextjs"];
    if (!validSSGs.includes(ssg)) {
      console.error(`Unknown SSG: "${ssg}". Must be one of: ${validSSGs.join(", ")}`);
      process.exit(1);
    }

    await runInit({ endpoint, ssg, theme, dir: "." });
    console.log(`\n✓ ziscus initialized for ${ssg} with ${theme} theme`);
    console.log(`✓ Created ziscus.config.json`);
    console.log(`\nSee the generated files for usage instructions.`);
  });

/**
 * `npx ziscus deploy` —— 一键部署：项目从零到"评论可用"。
 *
 * 【执行顺序（8 步，任何一步失败都 exit(1) 中止）】
 *   1. 检查 wrangler 存在且版本 >= 4          （checkWranglerVersion）
 *   2. 检查已登录 Cloudflare                   （checkWranglerAuth）
 *   3. 收集 ssg / site-url（缺了就走交互提问）
 *   4. `wrangler d1 create <dbName>`           → 拿到 database_id
 *   5. scaffoldWorker：写 wrangler.toml + 一行 worker.ts
 *   6. `wrangler d1 execute … --file=schema.sql`  建表
 *   7. 生成 ADMIN_SECRET → `wrangler secret put` → 同时写本地 .env
 *   8. `wrangler deploy` → 拿到 workers.dev URL
 *   9. 调 runInit 生成 SSG 模板 + workflow
 *
 * ⚠⚠ 【不可重入：第二次跑 deploy 会在第 4 步直接死掉】
 *   `wrangler d1 create` 对【已存在的库名】会报错，而这里 catch 后
 *   直接 `process.exit(1)`。于是"部署完发现 site-url 填错了、想再跑一次"
 *   这个最常见的场景，会得到 "Failed to create D1 database" 并中止，
 *   【哪怕后面所有步骤其实都能正常完成】。
 *   ★ 修法：catch 到"已存在"时不要退出，改成 `wrangler d1 list --json`
 *     把已有的 id 查出来继续走下去。这样 deploy 才真正幂等。
 *
 * ⚠⚠ 【`.env` 被整体覆盖 —— 会摧毁你已有的其它密钥】
 *   第 7 步附近执行的是：
 *       const envContent = `ZISCUS_ADMIN_SECRET=${adminSecret}\n`;
 *       await writeF(".env", envContent);          // writeFile，不是 append
 *   所以只要你的 .env 里还有 `GITHUB_TOKEN=…` 或任何其它变量，
 *   **跑一次 deploy 就全没了**，而且没有任何备份或提示。
 *   ⚠ README 的 Key management 一节让用户把 ADMIN_SECRET 放 .env，
 *     而"重建触发用的 GITHUB_TOKEN"通常也放在同一个 .env 里 ——
 *     两个用法直接冲突。
 *   ★ 修法（按推荐顺序）：
 *     ① 只更新/追加自己那一行（读现有内容 → 替换或追加 ZISCUS_ADMIN_SECRET）；
 *     ② 至少先写 `.env.bak`；
 *     ③ 至少在覆盖前检测到文件已存在时打印警告并让用户确认。
 *
 * ⚠⚠ 【生成的 endpoint 用的是 siteUrl，不是 Worker 自己的 URL】
 *   第 9 步传下去的是 `siteUrl.replace(/\/$/, "")`，
 *   而 Worker 的真实地址 `workerUrl`（第 8 步拿到）【只被打印，没被使用】。
 *
 *   后果分两种情况：
 *     · 同源部署（wrangler.toml 里配了 [assets]，Worker 顺便托管静态站）
 *       → 正确。ziscus.com 走的就是这条，所以维护者很难发现下面的问题。
 *     · 跨域部署（静态站托管在 GitHub Pages/Netlify，Worker 在
 *       *.workers.dev）→ **坏掉**：
 *         - ziscus.config.json 里 endpoint = https://myblog.com
 *         - 构建时 fetchComments 请求 https://myblog.com/comments/<slug>
 *           → 静态服务器返回 404 → 静默空数组 → 评论区全空
 *         - 表单 action  = https://myblog.com/submit → 404
 *       而且【构建和部署全都显示成功】，只有人肉打开页面才发现没评论。
 *
 *   ★ 修法：`endpoint = workerUrl || siteUrl`（并在同源场景下允许用户
 *     用 --endpoint 覆盖）。这是本次注释工作中发现的【最影响用户的一条】。
 *
 * ⚠ 【GITHUB_REPO 可能被写成占位符】
 *   `detectGitHubRepo() ?? "you/your-site-repo"` —— 在非 GitHub remote
 *   （或没配 remote）的项目里，wrangler.toml 会写入这个占位符。
 *   它不会导致 deploy 失败，但之后每次"批准评论触发重建"都会 404，
 *   表现为 `npx ziscus rebuild` 报 GitHub 404、面板上 Rebuild 卡片变红。
 *   用户很难联想到"是 deploy 时填了个假仓库名"。
 *   ★ 修法：检测不到就留空并明确提示用户手填，而不是塞一个假值。
 *
 * ⚠ 【全流程没有回滚】第 5 步已经写了 wrangler.toml / worker.ts，
 *   第 6 步建了表，第 7 步设了密钥 —— 如果第 8 步部署失败，
 *   前面所有副作用都留在磁盘和 Cloudflare 上。重跑又会撞上
 *   上面那条"D1 已存在"。所以失败后【必须人工收拾】。
 *
 * ⚠ 【所有外部命令都是通过 `exec()` 拼接字符串执行的】
 *   dbName / workerName 直接插进命令串。因为它们来自用户自己的
 *   `--db-name` / `--worker-name`，属于"自己注入自己"，不算漏洞；
 *   ★ 但如果你把这个 CLI 包进一个接受外部参数的 wrapper（比如 Web 服务），
 *     那就是命令注入。届时必须先做白名单校验。
 *   ⚠ 另外 `applySchema` 里的 `--file=${schemaPath}` 没有加引号，
 *     路径含空格时会拆成两个参数。工程路径带空格时就会踩到。
 *
 * ⚠ 【为什么这么多 try/catch 只打印一句话就 exit(1)】
 *   设计意图是"失败时明确告诉用户该手敲哪条命令"（每条 catch 都带了
 *   可复制的 wrangler 命令）。这是好体验，★ 但代价是丢掉了原始错误 ——
 *   排查 Cloudflare 侧问题时你反而需要那条原始错误信息。
 *   ★ 建议：把 `err` 也打印出来（至少 `--verbose` 时）。
 */
program
  .command("deploy")
  .description("Deploy the ziscus Worker to Cloudflare (creates D1 database, sets secrets, deploys)")
  .option("--ssg <name>", "Static site generator (hugo, astro, eleventy, jekyll, nextjs)")
  .option("--site-url <url>", "Your site URL (e.g. https://myblog.com)")
  .option("--db-name <name>", "D1 database name", "ziscus-comments")
  .option("--worker-name <name>", "Worker name on Cloudflare", "ziscus-comments")
  .option("--worker-dir <path>", "Directory holding wrangler.toml (default: ./worker if present, else .)")
  .action(async (opts) => {
    console.log("Deploying ziscus...\n");

    // Step 1: Check wrangler
    try {
      checkWranglerVersion();
      console.log("✓ wrangler found");
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    try {
      checkWranglerAuth();
      console.log("✓ Authenticated with Cloudflare");
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Step 2: Gather inputs
    let { ssg, siteUrl } = opts;
    const { dbName, workerName } = opts;
    const workerDir = resolveWorkerDir(opts.workerDir);
    const validSSGs = ["hugo", "astro", "eleventy", "jekyll", "nextjs"];

    if (!ssg || !siteUrl) {
      const rl = createInterface({ input: stdin, output: stdout });
      if (!siteUrl) siteUrl = await rl.question("Site URL (e.g. https://myblog.com): ");
      if (!ssg) ssg = await rl.question("SSG (hugo / astro / eleventy / jekyll / nextjs): ");
      rl.close();
    }

    if (!validSSGs.includes(ssg)) {
      console.error(`Unknown SSG: "${ssg}". Must be one of: ${validSSGs.join(", ")}`);
      process.exit(1);
    }

    // Step 3: Create D1 database
    let dbId: string;
    try {
      console.log(`\nCreating D1 database "${dbName}"...`);
      dbId = createD1Database(dbName);
      console.log(`✓ D1 database created (${dbId.slice(0, 8)}...)`);
    } catch (err) {
      console.error(`Failed to create D1 database. Run manually: wrangler d1 create ${dbName}`);
      process.exit(1);
    }

    // Step 3b: Make the project deployable (dependency model: wrangler.toml + worker.ts)
    let siteHost = siteUrl;
    try { siteHost = new URL(siteUrl).hostname; } catch { /* keep as typed */ }
    const created = scaffoldWorker(workerDir, {
      name: workerName, dbName, dbId, siteHost,
      githubRepo: detectGitHubRepo() ?? "you/your-site-repo",
    });
    for (const f of created) console.log(`✓ Created ${f}`);
    if (created.length === 0) console.log(`✓ wrangler.toml database_id set`);

    // Step 4: Apply schema
    const schemaPath = resolveSchemaPath(workerDir);
    try {
      console.log("Applying database schema...");
      applySchema(dbName, schemaPath);
      console.log("✓ Schema applied");
    } catch (err) {
      console.error(`Schema failed. Run manually: wrangler d1 execute ${dbName} --remote --file=${schemaPath}`);
      process.exit(1);
    }

    // Step 5: Generate and set admin secret
    const adminSecret = generateSecret();
    try {
      console.log("Setting admin secret...");
      setWranglerSecret("ADMIN_SECRET", adminSecret, workerDir);
      console.log("✓ Admin secret set");
    } catch (err) {
      console.error(`Failed to set secret. Run manually: cd ${workerDir} && wrangler secret put ADMIN_SECRET`);
      process.exit(1);
    }

    // Step 6: Deploy worker
    let workerUrl = "";
    try {
      console.log("Deploying Worker...");
      workerUrl = deployWorker(workerDir);
      console.log(`✓ Worker deployed${workerUrl ? ` → ${workerUrl}` : ""}`);
    } catch (err) {
      console.error(`Deploy failed. Run manually: cd ${workerDir} && wrangler deploy`);
      process.exit(1);
    }

    // Step 7: Save .env
    // ⚠⚠ 这一组三行会【整体覆盖】.env，不是追加、不是合并、没有备份。
    //   如果 .env 里还有 GITHUB_TOKEN 或别的变量，跑一次 deploy 就全丢了。
    //   详见本子命令注释里的「.env 被整体覆盖」。
    // ⚠ 这里用了动态 import 而不是文件顶部的静态 import，只是为了让
    //   "只有走到这一步才加载 fs/promises"——收益极小，但让本文件顶部
    //   的 import 列表看起来"没有文件写入"，容易误导读者。★ 可考虑改成静态 import。
    const { writeFile: writeF } = await import("node:fs/promises");
    const envContent = `ZISCUS_ADMIN_SECRET=${adminSecret}\n`;
    await writeF(".env", envContent);
    console.log("✓ Admin secret saved to .env");

    // Step 8: Run init for SSG
    // ⚠⚠ endpoint 取的是【站点地址】而不是 Worker 地址（workerUrl 上面刚拿到，
    //   却只用来打印）。跨域部署时这个值指向静态服务器 → 构建期拉评论 404
    //   → 评论区静默全空，且表单 action 也是错的。详见子命令注释。
    const endpoint = siteUrl.replace(/\/$/, "");
    try {
      await runInit({ endpoint, ssg, theme: "light", dir: "." });
      console.log(`✓ SSG templates generated for ${ssg}`);
    } catch (err) {
      console.error(`Init failed. Run manually: npx ziscus init --endpoint ${endpoint} --ssg ${ssg}`);
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log("Done. Comments are live.");
    console.log(`  Worker:  ${workerUrl || "(check wrangler output)"}`);
    console.log(`  Secret:  saved to .env`);
    console.log(`  AI mod:  npx ziscus ai-mod enable`);
    console.log(`  Rebuild: set GITHUB_REPO in wrangler.toml, then: cd ${workerDir} && wrangler secret put GITHUB_TOKEN`);
    console.log(`\nBack up your admin secret somewhere safe.`);
    console.log(`Cloudflare secrets are write-only — you cannot retrieve them later.`);
  });

/**
 * `npx ziscus migrate` —— 从 giscus（即 GitHub Discussions）导入历史评论。
 *
 * 【为什么值得有这个命令】
 *   从 giscus 迁移到 ziscus 的人，最舍不得的就是多年积累的评论线程。
 *   手工搬运不现实，所以这里直接读 GitHub GraphQL 把 Discussions 拉下来，
 *   拍平成 ziscus 的评论，再 POST 到 `/admin/import`。
 *   实现见 cli/migrate.ts。
 *
 * 【需要两把不同的钥匙 —— 这是最容易卡住用户的地方】
 *   · `--token` / `GITHUB_TOKEN`：读 GitHub Discussions 用。
 *     ⚠ 是一个【fine-grained PAT】，需要 `Discussions: Read` 权限。
 *       注意和"重建用的 GITHUB_TOKEN"（需要 Contents: Read and write）
 *       权限要求【不同】。如果你的 .env 里已经有一个为重建配的 token，
 *       它很可能没有 Discussions 权限 —— 于是这里报的是 GitHub 的
 *       权限错误，而不是"你没配 token"。★ 提示文案已经写了需要的权限，很好。
 *   · `ZISCUS_ADMIN_SECRET`：写进 ziscus 用（/admin/import 是管理端点）。
 *
 * ⚠ 【`--repo` 只取前两段，多余部分被静默忽略】
 *   `opts.repo.split("/")` 之后只解构 `[owner, repo]`。
 *   所以 `--repo user/blog/extra` 会变成 owner=user、repo=blog，
 *   然后去查一个不存在的仓库（或恰好存在的同名仓库）。
 *   ★ 建议校验 `split("/").length === 2`。
 *
 * ⚠ 【`--from` 目前只有 giscus 一个合法值】传入别的值会报错退出。
 *   将来加新来源时，这里和 cli/migrate.ts 都要改。
 *
 * ⚠ 【失败时的表现】runMigrate 会抛（比如 /admin/import 非 2xx），
 *   这里 catch 后打印 "Migration failed: …" 并 exit(1)。
 *   ⚠ 但注意 runMigrate 是【先全部构造好再一次性 POST】，所以
 *     中途失败不会留下"导入了一半"的状态 —— 这是好的设计。
 *   ⚠ 反过来：重复跑 migrate 会【重复导入】（migrate.ts 里给每条评论
 *     生成随机的 id，`/admin/import` 也没有幂等键）。
 *     ★ 想安全重跑，只能先用 `npx ziscus export` 备份、失败后手工回滚。
 */
program
  .command("migrate")
  .description("Import comments from another system")
  .requiredOption("--from <source>", "Source system (giscus)")
  .requiredOption("--repo <owner/repo>", "GitHub repository (e.g. user/blog)")
  .option("--token <token>", "GitHub PAT (reads from GITHUB_TOKEN env if not set)")
  .option("--endpoint <url>", "Worker endpoint (reads from ziscus.config.json if not set)")
  .action(async (opts) => {
    if (opts.from !== "giscus") {
      console.error(`Unsupported source: "${opts.from}". Currently supported: giscus`);
      process.exit(1);
    }

    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment.");
      process.exit(1);
    }

    const ghToken = opts.token || process.env.GITHUB_TOKEN;
    if (!ghToken) {
      console.error("Error: Provide --token or set GITHUB_TOKEN in .env or environment.");
      console.error("Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new");
      console.error("  Repository access: select your repo");
      console.error("  Permissions: Discussions → Read");
      process.exit(1);
    }

    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("Error: No --endpoint and no ziscus.config.json. Run `npx ziscus init` first.");
        process.exit(1);
      }
    }

    const [owner, repo] = opts.repo.split("/");
    if (!owner || !repo) {
      console.error("Error: --repo must be in owner/repo format (e.g. user/blog)");
      process.exit(1);
    }

    console.log(`Migrating comments from giscus (${opts.repo})...\n`);

    try {
      const count = await runMigrate({ owner, repo, token: ghToken, endpoint, secret });
      if (count === 0) {
        console.log("No comments found in GitHub Discussions.");
      } else {
        console.log(`✓ Imported ${count} comments from giscus`);
        console.log(`\nRun \`npx ziscus mod-log\` to see the import in the moderation log.`);
      }
    } catch (err) {
      console.error(`Migration failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

/**
 * `npx ziscus fetch` —— 拉评论并落成 JSON 文件（给"读数据文件"的 SSG 用）。
 *
 * ★ 这是 Hugo / Jekyll 模板的配套命令：它们的模板不能发网络请求，
 *   所以由这个命令先把评论变成 `data/comments/<slug>.json`，
 *   模板再从 `site.Data` / `site.data` 里读。
 *   `npx ziscus init` 给 Hugo、Jekyll 生成的 workflow 里自动带了这一步。
 *   Astro / Next.js 不需要它（它们直接在组件里 await fetchComments()）。
 *
 * 两种用法（二选一，都不给就报错退出）：
 *   --slug <slug>                只抓一个页面
 *   --all --sitemap <url>        从 sitemap 抽出所有 slug 批量抓
 *
 * ⚠⚠ 【这个命令的"✓"非常不可靠 —— 它会写出空文件并报告成功】
 *   底层 `runFetch` 把非 2xx 折成空数组照常落盘（详见 cli/fetch.ts），
 *   而这里不看返回值，直接打印：
 *       ✓ Fetched comments for "${slug}" → ${output}/${slug}.json
 *   于是 404 / 500 / 503 全都表现为"✓ + 一个内容为 [] 的文件"。
 *   ⚠ 在重建流水线里这会【用空数据覆盖上一次的好数据】，
 *     重建后评论区清空，而 CI 全绿。
 *   ★ 这是本 CLI 里最值得优先修的一处：非 2xx 应当抛错且不写文件。
 *
 * ⚠ 【`--all` 的 sitemap 抓取完全不检查响应状态】
 *   `const res = await fetch(opts.sitemap); const xml = await res.text();`
 *   —— 没有 `res.ok` 检查。如果 sitemap 地址写错，拿回来的是一页 HTML 错误页；
 *   `extractSlugsFromSitemap` 从中抽不到 `<loc>` → 返回空数组 →
 *   循环零次 → 打印 `✓ Fetched comments for 0 pages → data/comments/`。
 *   【看起来完全成功】，实际上什么都没做。
 *   ★ 建议：sitemap 非 2xx、或抽出的 slug 数为 0 时，都应该报错退出。
 *
 * ⚠ 【串行 + 无重试 + 无并发】`--all` 是 for-await 一个个抓的。
 *   几千个页面的站点会很慢，而且任何一个网络异常都会中断整个循环
 *   （runFetch 没有 try/catch），留下"一半新一半旧"的输出目录。
 *   详见 cli/fetch.ts 的注释。
 *
 * ⚠ 【输出目录默认 `data/comments`，是【Hugo 的数据目录约定】】
 *   Hugo 的 `site.Data` 会自动读 `data/`；Jekyll 读 `_data/`（不是 data/！）。
 *   ⚠ 所以 Jekyll 用户必须手写 `--output _data/comments`，
 *     否则模板里 `site.data.comments` 取不到东西 —— 而错误表现是
 *     "评论区永远为空"，没有任何报错。
 *   ★ 建议按 --ssg 自动选择默认目录（从 ziscus.config.json 读）。
 */
program
  .command("fetch")
  .description("Fetch comments from the API and write JSON data files")
  .option("--slug <slug>", "Fetch comments for a single slug")
  .option("--all", "Fetch comments for all slugs")
  .option("--sitemap <url>", "Sitemap URL to extract slugs from")
  .option("--output <dir>", "Output directory for JSON files", "data/comments")
  .option("--endpoint <url>", "Worker endpoint (reads from ziscus.config.json if not set)")
  .action(async (opts) => {
    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("No --endpoint provided and no ziscus.config.json found.");
        process.exit(1);
      }
    }

    if (opts.slug) {
      await runFetch({ endpoint, slug: opts.slug, outputDir: opts.output });
      console.log(`✓ Fetched comments for "${opts.slug}" → ${opts.output}/${opts.slug}.json`);
    } else if (opts.all && opts.sitemap) {
      const res = await fetch(opts.sitemap);
      const xml = await res.text();
      const slugs = extractSlugsFromSitemap(xml);
      for (const slug of slugs) {
        await runFetch({ endpoint, slug, outputDir: opts.output });
      }
      console.log(`✓ Fetched comments for ${slugs.length} pages → ${opts.output}/`);
    } else {
      console.error("Provide --slug <slug> or --all --sitemap <url>");
      process.exit(1);
    }
  });

/**
 * `npx ziscus export` —— 备份：评论 + mod log + 封禁列表 + meta，写成文件。
 *
 * ★ 【`--redact-ip` 是给"备份会被提交到公开仓库"这个场景准备的。】
 *   项目自己的重建 workflow 就是这么干的（导出脱敏备份 → 上传 artifact）。
 *   ⚠ 为什么必须脱敏：`ip_hash` 是 IP 的【无盐】SHA-256 前缀 ——
 *     IPv4 空间只有 2^32，暴力枚举一张彩虹表就能反查出真实 IP。
 *     所以"发布了 ip_hash"等同于"发布了 IP 地址"。
 *     理由在 cli/export.ts 的类型注释里已经写清楚了。
 *
 * ⚠ 【`--format csv` 导出的东西【无法用 import 恢复】】
 *   csv 模式只写 `comments.csv` 和 `mod-log.csv`，
 *   而 `npx ziscus import` 读的是 `comments.json` / `banned-ips.json` /
 *   `mod-log.json`。【备份和恢复不闭环】。
 *   ⚠ 更糟的是：无论哪种 format，`banned-ips.json` 和 `meta.json`
 *     都只写 JSON —— 也就是说 csv 导出【一半是 csv 一半是 json】。
 *   ★ 想修：要么让 import 支持 csv，要么在 csv 模式下打印一行
 *     "⚠ csv 导出仅用于人工查看，不能用于恢复"。
 *
 * ⚠ 【打印的路径有个小 bug】`✓ Exported to ${opts.output}/${opts.redactIp ? " (ip_hash redacted)" : ""}`
 *   → 会话成 `✓ Exported to backups/ (ip_hash redacted)`，
 *   把"说明文字"拼进了"路径"里。纯文案问题，但会让人以为生成了
 *   一个叫 `backups/ (ip_hash redacted)` 的目录。
 *
 * ⚠ 【没有 try/catch】runExport 抛出的错误（含 401）会以
 *   unhandled rejection 形式冒出来。错误信息本身是可读的
 *   （"Authentication failed (401). Check your ZISCUS_ADMIN_SECRET."），
 *   但会附带一大段 Node 栈。
 *
 * ⚠ 【会静默覆盖同名旧备份】写的是固定文件名（comments.json 等），
 *   没有时间戳、没有轮转。跑两次 export 到同一目录，第一次的备份就没了。
 *   ★ 建议默认加日期子目录（`backups/2025-06-01/`）。
 */
program
  .command("export")
  .description("Export all comments, mod log, bans, and settings to JSON files")
  .option("--output <dir>", "Output directory", "backups")
  .option("--format <fmt>", "Output format: json or csv", "json")
  .option("--endpoint <url>", "Worker endpoint (reads from ziscus.config.json if not set)")
  .option("--redact-ip", "Strip ip_hash from every record — required when the export is committed to a public repo (a published ip_hash is a published IP)")
  .action(async (opts) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment.");
      process.exit(1);
    }

    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("Error: No --endpoint and no ziscus.config.json. Run `npx ziscus init` first.");
        process.exit(1);
      }
    }

    await runExport({ endpoint, secret, outputDir: opts.output, format: opts.format, redactIpHashes: !!opts.redactIp });
    console.log(`✓ Exported to ${opts.output}/${opts.redactIp ? " (ip_hash redacted)" : ""}`);
  });

/**
 * `npx ziscus import` —— 从 `export` 产出的备份目录恢复数据。
 *
 * 【为什么这条命令直接内联在 cli.ts 里，而没有对应的 cli/import.ts】
 *   ⚠ 它是唯一一个【没有抽到 ./cli/ 模块】的子命令，逻辑就写在 action 里。
 *   结果：它没法被单元测试覆盖（./cli/ 下每个模块都有 .test.ts，
 *   而这里没有），也和其它子命令的组织方式不一致。
 *   ★ 建议抽成 cli/import.ts，顺便把下面的三个 ⚠ 修掉。
 *
 * 【读三个文件，但只有两个是必需的】
 *   comments.json      必需（没有 try/catch，缺了直接抛）
 *   banned-ips.json    必需（同上）
 *   mod-log.json       可选（有 try/catch，缺了就当空数组）
 *   ⚠ 这个"必需/可选"的不对称没有道理。而且 `--format csv` 导出的备份
 *     里【没有 comments.json】，所以 csv 备份在这里直接抛错。
 *     详见 export 子命令注释里"备份和恢复不闭环"的 ⚠。
 *
 * ⚠ 【整批导入没有事务、没有去重、没有幂等键】
 *   服务端 `/admin/import` 收到后一次性写入。重复执行本命令会把
 *   同一批评论【再插一遍】，产生重复评论（id 由 migrate/export 决定，
 *   如果备份里的 id 已存在，服务端可能跳过也可能报错 —— 取决于
 *   它用的是 INSERT 还是 INSERT OR REPLACE）。
 *   ★ 恢复前先 `npx ziscus export` 存一份现状，是最低成本的安全网。
 *
 * ⚠ 【`${opts.from}/...` 的路径拼接不校验】
 *   `--from` 由用户自己给，所以不算漏洞；但如果将来把它接到
 *   "从 artifact 目录自动恢复"这类自动化里，就要先规范化路径。
 *
 * ⚠ 【成功时的输出不可信】`result.comments` 等服务端返回的数字会
 *   被原样打印。如果服务端在导入过程中跳过了一部分（比如 id 冲突），
 *   而返回的数字是"尝试数"而不是"实际写入数"，用户会以为全导进去了。
 *   ★ 恢复后建议用 `npx ziscus comments --limit 5000 | wc -l` 之类的
 *     方式独立核对一次条数。
 */
program
  .command("import")
  .description("Restore comments from a backup directory")
  .requiredOption("--from <dir>", "Directory containing backup JSON files")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (opts) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment.");
      process.exit(1);
    }

    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("Error: No --endpoint and no ziscus.config.json. Run `npx ziscus init` first.");
        process.exit(1);
      }
    }

    const comments = JSON.parse(await readFile(`${opts.from}/comments.json`, "utf-8"));
    const bans = JSON.parse(await readFile(`${opts.from}/banned-ips.json`, "utf-8"));
    let modLog: unknown[] = [];
    try { modLog = JSON.parse(await readFile(`${opts.from}/mod-log.json`, "utf-8")); } catch { /* optional */ }

    const res = await fetch(`${endpoint}/admin/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comments, bans, modLog }),
    });

    if (!res.ok) {
      console.error(`Error: Import failed (${res.status}): ${await res.text()}`);
      process.exit(1);
    }

    const result = await res.json() as { comments: number; bans: number; modLog: number };
    console.log(`✓ Imported ${result.comments} comments, ${result.bans} bans, ${result.modLog} mod log entries`);
  });

/**
 * `npx ziscus dashboard` —— 打开管理面板，并打印你需要手工加的请求头。
 *
 * 【为什么不能"点一下就直接登录"】
 *   管理面【只认 Authorization: Bearer】这一个凭证（见 worker/src/auth.ts），
 *   而浏览器【无法给一次普通导航设置自定义请求头】。
 *   项目明确拒绝把密钥放进 URL（`?token=`），理由是 URL 会泄漏到
 *   浏览器历史、Referer、CDN 日志、搜索引擎索引 —— 见 auth.ts 的注释。
 *   两个约束夹在一起，就只剩"用浏览器扩展手工加请求头"这条路。
 *
 *   ⚠ 这是本项目在开发者体验上最粗糙的一处：每次换浏览器 / 换机器 /
 *     清了扩展配置，都要重新粘贴一遍 64 位密钥。
 *   ★ 想改善（auth.ts 注释里也提了）：加一个"用密钥换 HttpOnly Cookie"
 *     的登录端点，之后浏览器就靠 cookie 访问面板。
 *     ⚠ 代价是必须自己处理 CSRF（cookie 会自动随请求发送，
 *       而 Bearer 头不会 —— 这正是现在这套方案安全性好的原因）。
 *
 * ⚠ 【它会把明文密钥打印到 stdout】
 *   这是全项目唯一一处打印密钥的地方，且是有意为之。
 *   后果：密钥会进入终端回滚缓冲、CI 日志、shell 历史（如果被重定向到文件）、
 *   以及你发给别人看的截图。
 *   ⚠ 在 CI 里跑这个命令等于把密钥写进构建日志。
 *   ★ 建议：CI 环境下检测到非 TTY 就拒绝执行，或只打印头名不打印值。
 *
 * ⚠ 【`open "${url}"` 是 macOS 专属】
 *   用 `execSync('open "…"')` 打开浏览器，非 macOS 会抛异常，
 *   然后被空 catch 吞掉（注释说"URL 已经打印在上面了"）。
 *   所以 Linux / Windows 用户实际上只能手动复制 URL —— 行为可接受，
 *   但 `open` 这个词会让人以为跨平台都行。
 *   ★ 想修：按 platform 分支（win32 → `start`、linux → `xdg-open`）。
 *
 * ⚠ 【`execSync` 走 shell，url 被拼进命令串】
 *   url 来自 ziscus.config.json 的 endpoint（你自己写的文件）。
 *   如果那个文件里的 endpoint 含 `"` 和 `;`，就能在你的机器上执行命令。
 *   当前威胁模型下（只读自己的配置）不构成漏洞，
 *   ★ 但如果 config 是从别处生成/同步的，这里必须改成不经 shell 的调用。
 *
 * ⚠ 注意 `host` 的兜底：`new URL(base)` 失败时 `host = base`（整个字符串）。
 *   于是 URL 写错时打印的是 `request header for https://typo…`，
 *   提示仍然可读 —— 这个兜底是对的。
 */
program
  .command("dashboard")
  .description("Open the admin dashboard in your browser")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (opts) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment.");
      process.exit(1);
    }

    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("Error: No --endpoint and no ziscus.config.json. Run `npx ziscus init` first.");
        process.exit(1);
      }
    }

    // The dashboard authenticates via the Authorization header only — the secret
    // is never placed in a URL (it would leak into history, logs, and Referer).
    // A browser can't set that header on a plain navigation, so configure a
    // request-header extension (ModHeader, Requestly, etc.) once for this host.
    const base = endpoint.replace(/\/$/, "");
    const url = `${base}/admin/dashboard`;
    let host: string;
    try {
      host = new URL(base).host;
    } catch {
      host = base;
    }

    console.log(`Admin dashboard: ${url}\n`);
    console.log("This dashboard is header-authenticated. In your browser, add a");
    console.log(`request header for ${host} (e.g. with the ModHeader extension):\n`);
    console.log(`  Authorization: Bearer ${secret}\n`);
    console.log("Then open the dashboard URL. From the terminal you can instead use:");
    console.log(`  curl -H "Authorization: Bearer $ZISCUS_ADMIN_SECRET" ${url}\n`);

    const { execSync } = await import("node:child_process");
    try {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } catch {
      // Fallback for non-macOS — URL already printed above.
    }
  });

/**
 * `npx ziscus comments` —— 列出评论（含正文），支持按状态/slug 过滤。
 * 这是审核时最常用的命令：`--status pending` 看待审队列、
 * `--status spam` 看被拦下的垃圾，然后去面板上批准/拒绝。
 * 格式化逻辑在 cli/comments.ts 的 formatComment()。
 *
 * ⚠ 【`parseInt(opts.limit, 10)` 不校验，非法值会变成 "NaN"】
 *   用户敲 `--limit abc` 时，`parseInt` 返回 NaN，
 *   然后被 `params.set("limit", "NaN")` 原样发给 Worker。
 *   表现取决于服务端：可能 400、可能忽略该参数并返回默认条数
 *   （⚠ 那样你会以为"只有这么多评论"）。
 *   ★ 建议在这里校验并给一个友好的报错。
 *
 * ⚠ 【`--limit` 没有上限保护】传 `--limit 100000` 会拉回全部评论正文，
 *   在终端里刷几千屏。★ 建议加提示或分页。
 *
 * ⚠ 【`runListComments` 不检查 HTTP 状态】
 *   cli/comments.ts 里直接 `await res.json()`。401（密钥错）时
 *   服务端返回的是纯文本 "Unauthorized"，`res.json()` 抛解析错误
 *   → 用户看到的是 "Unexpected token 'U'…" 而不是"鉴权失败"。
 *   ★ 这是本项目 CLI 的通病：错误信息在若干处都依赖"服务端一定返回 JSON"。
 *
 * ⚠ 【本地 `.env` 里的密钥如果是错的，这里不会告诉你是"密钥错"】
 *   同上：表现为 JSON 解析错误。★ 建议在 catch 里加上状态码。
 */
program
  .command("comments")
  .description("List comments with full content")
  .option("--status <status>", "Filter by status (approved, pending, spam, rejected)")
  .option("--slug <slug>", "Filter by page slug")
  .option("--limit <n>", "Number of comments to show", "20")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (opts) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment.");
      process.exit(1);
    }

    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("Error: No --endpoint and no ziscus.config.json. Run `npx ziscus init` first.");
        process.exit(1);
      }
    }

    const lines = await runListComments({
      endpoint,
      secret,
      status: opts.status,
      slug: opts.slug,
      limit: parseInt(opts.limit, 10),
    });

    if (lines.length === 0) {
      console.log("No comments found.");
      return;
    }

    for (const line of lines) {
      console.log(line);
      console.log();
    }
  });

/**
 * `npx ziscus pause <slug>` —— 【按页】暂停评论（其它页面不受影响）。
 *
 * 【语义：暂停提交，但保留展示】
 *   暂停后：已有评论【继续显示】在页面上（历史内容不会被抹掉），
 *   新提交被静默丢弃。这正是"某篇文章被刷垃圾了，先关掉它的评论区"
 *   这个真实需求。
 *   对比一下三个层级：
 *     · `POST /admin/mode`（全局）  on / paused / off   —— 影响整站
 *     · 本命令（按页）              pause / open        —— 影响单页
 *     · wrangler.toml 的 MODERATION  on / off           —— 只影响"是否待审"
 *
 * 【实现机制：Worker 侧动态删表单，而不是拒绝请求】
 *   Worker 把 `slug_paused:<slug>` 记在 meta 表里。之后每次有人访问该页面：
 *     · 若是静态资源请求，用 HTMLRewriter 把 `.comment-form` 里的
 *       输入框和按钮【删掉】，换成一句"评论已暂停"
 *       （见 worker/src/index.ts 的 formIsPaused 逻辑）
 *   ⚠ 这段重写【依赖 render.ts 输出的 class 名和 id】——
 *     详见 embed/src/render.ts 文件头的「约定 1」。如果页面不是用
 *     renderCommentsSection() 生成的（比如用了 `npx ziscus init` 的模板，
 *     那是 `.ziscus-form`），选择器命中不了，**表单不会被删掉**，
 *     用户仍会看到可提交的表单。服务端最后会拒绝提交，
 *     但访客的体验是"填了半天，提交后什么都没发生"。
 *
 * ⚠ 【这里的 endpoint 解析缺少空值校验】
 *   只 catch 了"文件读不到/JSON 解析失败"，【没有检查 endpoint 是否为空】。
 *   如果 ziscus.config.json 存在但没有 endpoint 字段，就会
 *   `fetch("undefined/admin/pause/x")` → 抛 "Failed to parse URL"。
 *   对比 `rebuild` 子命令，那里是唯一做了空值校验的。
 *   ★ 详见文件头「endpoint 解析被复制了 7 遍」。
 *
 * ⚠ 【这里用 POST】对应的 `open` 用 DELETE，是 REST 风格的对称设计
 *   （Worker 侧：POST 写 meta 行，DELETE 删 meta 行）。
 *   两者的路径完全相同，只靠 method 区分。
 *
 * ⚠ 【没有 --dry-run / 没有确认】敲错 slug 也不会报错（Worker 只是
 *   写一条 meta 记录，即使这个 slug 从来没有过评论）。所以
 *   `npx ziscus pause typo-slug` 会返回 ✓ 但实际什么也没暂停。
 */
program
  .command("pause <slug>")
  .description("Pause comments on a specific page (existing comments stay visible)")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (slug: string, opts: { endpoint?: string }) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) { console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment."); process.exit(1); }
    let endpoint = opts.endpoint;
    if (!endpoint) {
      try { endpoint = JSON.parse(await readFile("ziscus.config.json", "utf-8")).endpoint; }
      catch { console.error("Error: No --endpoint and no ziscus.config.json."); process.exit(1); }
    }
    const res = await fetch(`${endpoint}/admin/pause/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) { console.error(`Failed (${res.status})`); process.exit(1); }
    console.log(`✓ Comments paused on "${slug}". Existing comments are still visible.`);
    console.log(`  New submissions will be silently rejected.`);
    console.log(`  To reopen: npx ziscus open ${slug}`);
  });

/**
 * `npx ziscus open <slug>` —— 恢复某个被 `pause` 暂停的页面上的评论。
 *
 * 与 `pause` 严格对称：同一个 URL，只把 method 从 POST 换成 DELETE
 * （Worker 侧删掉 `slug_paused:<slug>` 这条 meta 记录）。
 * 语义细节、"为什么暂停不删表单"、以及 endpoint 解析的 ⚠
 * 都和 `pause` 完全一样，见上一条注释。
 *
 * ⚠ 【它是幂等的】对一个本来就没暂停的 slug 执行 open，也会返回 ✓。
 *   所以【不能靠这条命令的返回值判断"之前是否处于暂停状态"】。
 *   ★ 想知道当前有哪些页面被暂停，目前【没有 CLI 命令】——
 *     只能直接查 D1（`SELECT key FROM meta WHERE key LIKE 'slug_paused:%'`）
 *     或看管理面板。这是 CLI 的一个功能缺口。
 */
program
  .command("open <slug>")
  .description("Reopen comments on a paused page")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (slug: string, opts: { endpoint?: string }) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) { console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment."); process.exit(1); }
    let endpoint = opts.endpoint;
    if (!endpoint) {
      try { endpoint = JSON.parse(await readFile("ziscus.config.json", "utf-8")).endpoint; }
      catch { console.error("Error: No --endpoint and no ziscus.config.json."); process.exit(1); }
    }
    const res = await fetch(`${endpoint}/admin/pause/${slug}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) { console.error(`Failed (${res.status})`); process.exit(1); }
    console.log(`✓ Comments reopened on "${slug}".`);
  });

/**
 * `npx ziscus rebuild [slug]` —— 触发一次站点重建，并【验证 GitHub token 是否有效】。
 *
 * 【为什么值得单独做一个命令】
 *   项目的发布链路是：批准评论 → Worker 发 GitHub `repository_dispatch`
 *   → 你的站点仓库跑 workflow → 烘焙新评论并部署。
 *   这条链路上最容易坏的一环是 **GITHUB_TOKEN 过期**
 *   （GitHub 的 fine-grained PAT 最长一年，默认更短），
 *   而它坏掉时【Worker 仍然正常接受评论，只是永远不再发布】——
 *   典型"静默瘫痪"。
 *   所以这个命令的价值不是"触发重建"，而是
 *   **"主动把 GitHub 的判决结果打印出来"**：
 *       ✓ Rebuild dispatched (GitHub 204)          ← 链路通
 *       ✗ Rebuild failed: GitHub 401: Bad credentials ← token 死了
 *   返回结构见 cli/rebuild.ts 的 RebuildOutcome。
 *
 * 【两层状态码，别混淆】
 *   `result.status`      ← 【GitHub】对 dispatch 调用的响应（204 成功 / 401 / 403 / 404）
 *   `result.httpStatus`  ← 【ziscus Worker】自己的响应（200 / 401 / 502 / 503）
 *   下面这段分支正是靠区分这两者才给出准确建议：
 *     · httpStatus === 503 → Worker 根本没配重建（没有 GITHUB_REPO 或 token）
 *     · status 是 401/403/404 → Worker 配了，但 GitHub 拒了 token
 *   ★ 这个区分做得很好，是同类 CLI 里少见的细节。
 *
 * ⚠ 【503 分支打的修复命令写死了 `worker` 目录】
 *   `cd worker && wrangler secret put GITHUB_TOKEN`
 *   —— 只对"克隆了本仓库"的布局成立。走 npm 依赖模型
 *   （`npx ziscus deploy` 生成的那种，wrangler.toml 在项目根）时，
 *   这个路径是错的。★ 应该用 `resolveWorkerDir()` 生成路径。
 *   ⚠ 同一文件里 dashboard 的提示没有这个问题（它只打印 URL）。
 *
 * ⚠ 【`result.ok` 为真只代表"GitHub 接受了 dispatch 请求"】
 *   它【不代表 workflow 跑成功了】—— 你的 workflow 可能随后失败
 *   （依赖装不上、构建报错、GITHUB_TOKEN 的仓库权限不够 push）。
 *   所以这个命令能证明的是"token 与仓库可达"，
 *   真正的成败要去仓库的 Actions 标签页看。
 *
 * ⚠ 【`--endpoint` 的分支顺序】这里先做空值校验再调用，
 *   是全文件唯一写对的地方（见文件头的「7 遍复制」）。
 */
program
  .command("rebuild [slug]")
  .description("Trigger a site rebuild (GitHub repository_dispatch) and report whether GitHub accepted it")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (slug: string | undefined, opts: { endpoint?: string }) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) { console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment."); process.exit(1); }
    let endpoint = opts.endpoint;
    if (!endpoint) {
      try { endpoint = JSON.parse(await readFile("ziscus.config.json", "utf-8")).endpoint; }
      catch { console.error("Error: No --endpoint and no ziscus.config.json."); process.exit(1); }
    }
    if (!endpoint) { console.error("Error: ziscus.config.json has no \"endpoint\"."); process.exit(1); }

    const result = await runRebuild({ endpoint, secret, slug });

    if (result.ok) {
      console.log(`✓ Rebuild dispatched for "${result.slug ?? slug ?? "all"}" (GitHub ${result.status})`);
      console.log(`  The rebuild workflow should appear in your repo's Actions tab within ~30s.`);
      return;
    }

    if (result.httpStatus === 503) {
      console.error(`✗ Rebuild not configured: ${result.error}`);
      console.error(`  Set GITHUB_REPO in wrangler.toml and: cd worker && wrangler secret put GITHUB_TOKEN`);
      process.exit(1);
    }

    console.error(`✗ Rebuild failed: ${result.error}`);
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      console.error(`  GitHub rejected the token. Rotate it: cd worker && wrangler secret put GITHUB_TOKEN`);
    }
    process.exit(1);
  });

/**
 * `npx ziscus mod-log` —— 查看 moderation 审计日志（谁、什么时候、对哪条评论做了什么）。
 *
 * 【为什么审计日志值得一个专属命令】
 *   这个项目有两类"裁判"：人和 AI。一旦 AI 误判（把正常评论标成 spam），
 *   你必须能事后回溯"这条是谁处理的、依据是什么"。
 *   所以 Worker 把每次批准/拒绝/标垃圾/删除/AI 判定都写进 mod_log 表，
 *   带 actor（`ai` / `admin`）、action、reason 和元数据（如 AI 延迟）。
 *   治理 AI 自动化的前提是它【可审计】—— 这个命令就是那个出口。
 *
 * 【为什么它要额外拉一次 /admin/comments】
 *   日志里只存 `comment_id`，直接打印一串 id 人根本看不懂。
 *   所以 cli/mod-log.ts 会并发拉一次评论列表，建一个
 *   `id → {author, body}` 的 Map，把日志行渲染成
 *   `时间  actor  action  slug  延迟  作者: "正文前 50 字"`。
 *   ⚠ 注意它拉的是【全部评论】（`/admin/comments` 不带 limit 参数），
 *     所以日志表引用了一条已经被【永久删除】的评论时，
 *     Map 里找不到，会退化成打印 id 前 8 位（见 mod-log.ts 的 else 分支）。
 *     这是正确的降级行为 —— 删除评论后日志不应该跟着消失。
 *   ⚠ 代价：评论量大时（几万条）这个命令会拉回整个评论表，
 *     比 logs 本身大得多。★ 建议改成按日志里出现的 id 批量查。
 *
 * ⚠ 【`parseInt(opts.limit, 10)` 同样不校验】传非数字会变成 "NaN"
 *   发给服务端，同 `comments` 子命令的 ⚠。
 *
 * ⚠ 【表头与数据宽度是硬编码的】`"─".repeat(100)` 和
 *   `padEnd(6/14/10/8)`。slug 超过 10 字符、action 超过 14 字符时
 *   列会错位（例如 `bulk_approve`、`rebuild_failed` 这类长 action）。
 *   ★ 建议用最大宽度动态计算。纯显示问题，不影响数据。
 *
 * ⚠ 【不检查 HTTP 状态】和 `comments` 一样，401 时会抛出
 *   "Unexpected token 'U'…"（服务端返回的是纯文本 "Unauthorized"）。
 *   见 cli/mod-log.ts 里直接 `await logRes.json()` 的写法。
 */
program
  .command("mod-log")
  .description("View the moderation log")
  .option("--action <action>", "Filter by action (ai_spam, ai_approve, approve, reject, spam, delete)")
  .option("--actor <actor>", "Filter by actor (ai, admin)")
  .option("--slug <slug>", "Filter by page slug")
  .option("--limit <n>", "Number of entries to show", "20")
  .option("--endpoint <url>", "Worker endpoint")
  .action(async (opts) => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET in .env or environment.");
      process.exit(1);
    }

    let endpoint = opts.endpoint;
    if (!endpoint) {
      try {
        const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
        endpoint = config.endpoint;
      } catch {
        console.error("Error: No --endpoint and no ziscus.config.json. Run `npx ziscus init` first.");
        process.exit(1);
      }
    }

    const lines = await runModLog({
      endpoint,
      secret,
      action: opts.action,
      actor: opts.actor,
      slug: opts.slug,
      limit: parseInt(opts.limit, 10),
    });

    if (lines.length === 0) {
      console.log("No mod log entries found.");
      return;
    }

    console.log("Timestamp             Actor  Action         Slug       Latency  Comment");
    console.log("─".repeat(100));
    for (const line of lines) {
      console.log(line);
    }
  });

/**
 * `npx ziscus ai-mod …` —— 管理"AI 垃圾评论过滤"。
 *
 * 【它做了什么】
 *   给 wrangler.toml 加一个 Workers AI binding：
 *
 *       [ai]
 *       binding = "AI_MOD"
 *
 *   Worker 侧（worker/src/classify.ts）在收到评论时调用它做二分类；
 *   判为 spam 的直接不进待审队列。
 *   ★ 免费额度约 3,000 次分类/天（Workers AI 免费层），超出需要
 *     Workers Paid（$5/月）。不加这个 binding 时用的是纯规则/人工审核，
 *     不额外花钱。这段取舍文案在下面 enable 的输出里也提到了，很好。
 *
 * ⚠ 【这是唯一用"子命令组"形式的命令】（`aiMod.command(...)` 而不是
 *   `program.command(...)`）。所以 enable/disable/status/test 都是
 *   `npx ziscus ai-mod <子命令>`。新增子命令时记得挂在 aiMod 上，
 *   挂到 program 上会变成顶层命令。
 *
 * ⚠ 【默认行为不一致】`npx ziscus ai-mod` 不带子命令时会打印
 *   ai-mod 的帮助（commander 对子命令组的默认行为），
 *   而 `npx ziscus` 不带子命令时什么都不做。★ 不一致但影响很小。
 *
 * ⚠ 【四个子命令的正确性都依赖 `ziscus.config.json`】除了 enable，
 *   都从它读 endpoint。所以你必须先 init 才能用 ai-mod。
 */
const aiMod = program
  .command("ai-mod")
  .description("Manage AI-powered spam classification");

/**
 * `ai-mod enable` —— 往 wrangler.toml 追加 `[ai]` binding。
 *
 * 实现见 cli/ai-mod.ts 的 `runAiModEnable()`。
 * 已经存在 `[ai]` 段时是幂等的（返回 alreadyEnabled，打印"已启用"）。
 *
 * ⚠⚠ 【`--no-deploy` 是【完全无效的】开关 —— 因为【从来就没有部署过】】
 *   这里传下去的 `deploy: opts.deploy !== false` 被 `runAiModEnable()`
 *   **整个忽略**（看 cli/ai-mod.ts：函数只用到了 `dir` 和 `wranglerPath`，
 *   `EnableOptions.deploy` 从未被读取）。
 *   所以：
 *     · 加了 binding 之后【不会自动部署】，
 *       即使不加 `--no-deploy` 也一样（要自己跑 `wrangler deploy`）
 *     · `--no-deploy` 因此是个"安慰剂开关"
 *   ⚠ 而下面打印的最后一句话恰好是 "Deploy your worker to activate:
 *     wrangler deploy" —— 这句是对的，但它和 `--no-deploy` 这个选项
 *     同时存在，会让人以为默认会自动部署。
 *   ★ 修法二选一：(a) 真正实现部署（读 `deploy` 后调 `wrangler deploy`），
 *     (b) 删掉这个选项，只保留"打印下一步命令"的行为。
 *     ⚠ 我倾向 (b) —— 部署是有副作用的操作，让用户显式执行更安全。
 *
 * ⚠ 【`wranglerPath` 的兜底拼接可能产生双斜杠】
 *   `opts.wrangler ?? `${resolveWorkerDir()}/wrangler.toml``
 *   —— `resolveWorkerDir()` 在依赖模型下返回 `"."`，
 *   于是路径是 `./wrangler.toml`（没问题）；
 *   但如果显式传了 `--worker-dir worker/`（带末尾斜杠），
 *   就会拼出 `worker//wrangler.toml`。多数文件系统能容忍，
 *   但 `access()` 失败时的错误信息会让人困惑。
 *   ★ 建议用 `join()` 而不是字符串拼 `/`。
 *
 * ⚠ 【它【不校验】wrangler.toml 的内容是否是合法 TOML】
 *   只是简单地"在文件末尾追加两行"。如果文件末尾没有换行符，
 *   或者最后一行是没闭合的数组/表，追加后可能产生非法 TOML。
 *   `binding` 变量开头的 `\n` 就是为了防"末尾没换行"这一种情况。
 *   ★ 更稳的做法是用 TOML 解析器（但会引入依赖，是个取舍）。
 *
 * ⚠ 【会修改用户的 wrangler.toml 但没有备份】
 *   注释行、格式、以及用户自己写的 `[ai]` 相关配置都可能被追加内容影响。
 *   ★ 建议写之前生成 `wrangler.toml.bak`。
 */
aiMod
  .command("enable")
  .description("Add Workers AI spam classification to your Worker")
  .option("--wrangler <path>", "Path to wrangler.toml (default: ./worker/wrangler.toml if present, else ./wrangler.toml)")
  .option("--no-deploy", "Skip deployment after adding binding")
  .action(async (opts) => {
    const result = await runAiModEnable({
      dir: ".",
      wranglerPath: opts.wrangler ?? `${resolveWorkerDir()}/wrangler.toml`,
      deploy: opts.deploy !== false,
    });

    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    if (result.alreadyEnabled) {
      console.log("AI moderation is already enabled ([ai] binding found).");
      return;
    }

    console.log("✓ Added [ai] binding to wrangler.toml");
    console.log("\nNote: Workers AI free tier supports ~3,000 classifications/day.");
    console.log("For higher volume: Workers Paid ($5/mo). Without AI: unlimited, no cost.");
    console.log("\nDeploy your worker to activate: wrangler deploy");
  });

/**
 * `ai-mod disable` —— 【只打印操作说明】，不实际修改任何文件。
 *
 * ★ 这是一个刻意"不做自动化"的命令：它只输出"请自己去
 *   wrangler.toml 里删掉 / 注释掉 `[ai]` 段，然后重新部署"。
 *
 * 【为什么这里选择不动手，而 enable 会动手】
 *   删配置是【破坏性】操作（可能删掉用户自己加在 `[ai]` 段里的其它键，
 *   比如 `[ai] binding` 之外的配置），而追加是相对安全的。
 *   让自动化只做"加法"、把"减法"留给用户，是一条保守但合理的边界。
 *   ★ 想做成自动化的话，务必用 TOML 解析器 + 先备份。
 *
 * ⚠ 文案里的路径写的是 `worker/wrangler.toml`，同样只对"克隆本仓库"
 *   的布局成立（依赖模型下它在项目根）。同 `rebuild` 的 ⚠。
 */
aiMod
  .command("disable")
  .description("Instructions to remove AI classification")
  .action(() => {
    console.log(runAiModDisable());
  });

/**
 * `ai-mod status` —— 打印评论数量统计。
 *
 * ⚠ 【命令描述是 "Show AI moderation state and comment stats"，
 *   但它【完全没有显示 AI 的状态】】
 *   它只调 `/admin/stats` 并打印：
 *       Comments: N approved, M spam, P pending
 *   没有任何地方检查 `[ai]` binding 是否存在、Workers AI 是否真的在工作、
 *   今天的免费额度用了多少。
 *   ⚠ 也就是说：**描述里承诺的一半功能没有实现。** 用户会以为
 *     "status 说正常 = AI 在正常工作"，实际上它只是评论计数。
 *   ★ 想补齐：让 `/admin/stats` 返回一个 `ai` 字段（binding 是否存在、
 *     最近一次分类的时间/结果），在这里打印出来。
 *     `npx ziscus mod-log --actor ai` 是目前【唯一】能看出 AI 是否
 *     在工作的办法（但需要你先知道这条命令）。
 *
 * ⚠ 【`runAiModStatus` 不检查 HTTP 状态】见 cli/ai-mod.ts：
 *   直接 `res.json()`，401 时会抛 JSON 解析错误而不是"鉴权失败"。
 *   同 `comments` / `mod-log` 的通病。
 *
 * ⚠ 【它和其他子命令不一样，【不支持 --endpoint】】
 *   endpoint 只能从 ziscus.config.json 读（硬编码，没有覆盖选项）。
 *   想临时指向别的 Worker 做不到 —— 而 migrate/fetch/export/import/
 *   dashboard/comments/pause/open/rebuild/mod-log 【都有】--endpoint。
 *   ★ 一致性缺口，加一个选项即可修好。
 */
aiMod
  .command("status")
  .description("Show AI moderation state and comment stats")
  .action(async () => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET env var. Example: ZISCUS_ADMIN_SECRET=xxx npx ziscus ai-mod status");
      process.exit(1);
    }

    let endpoint: string;
    try {
      const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
      endpoint = config.endpoint;
    } catch {
      console.error("Error: No ziscus.config.json found. Run `npx ziscus init` first.");
      process.exit(1);
    }

    const stats = await runAiModStatus(endpoint, secret);
    console.log(`Comments: ${stats.approved} approved, ${stats.spam} spam, ${stats.pending} pending`);
  });

/**
 * `ai-mod test` —— 用两条样例评论验证 AI 分类是否在工作。
 *
 * 【思路（这是它设计得好的地方）】
 *   不依赖"有没有报错"来判断，而是打两条【预期结果已知】的样例：
 *     · "Buy cheap SEO services now!"  → 期望 spam
 *     · "Great article, thanks for sharing!" → 期望 approve
 *   然后对比实际返回值，用 ✓ / ✗ 逐条打出来。
 *   这比只看 HTTP 200 有意义得多 —— 后者只能证明"请求到达了"。
 *   它调的端点 `/admin/classify` 专门为此存在（见 worker/src/index.ts
 *   的路由表），它【不写库、不影响真实评论】，只返回分类结果。
 *
 * ⚠⚠ 【它有一个严重的假成功 bug：跑完总是打印 "AI moderation is working."】
 *
 *   `for` 循环结束后【无条件】执行：
 *       console.log("\nAI moderation is working.");
 *   而且在循环里：
 *     · 不检查 `res.ok`
 *     · `const { classification } = await res.json()`
 *       —— 如果 Worker 返回 400/500（比如 [ai] binding 没配、
 *         Workers AI 额度用尽、模型名写错），body 里根本没有
 *         `classification` 字段，解构得到 `undefined`
 *     · 于是打印 `✗ "Buy cheap SEO..." → undefined (12ms)`
 *     · 然后依然打印 "AI moderation is working."
 *
 *   ⚠ 后果：**AI 完全没工作、两条样例全 ✗ 的情况下，
 *     这个命令的结论行仍然是"工作正常"。** 只看最后一行会得出完全相反的结论。
 *   ★ 修法：统计 ✓ 的数量，全部通过才打印成功语；
 *     否则打印失败语并 `process.exit(1)`（让 CI 能靠退出码判定）。
 *     ⚠ 这是本次注释工作中发现的【最容易被误信的误导性输出】。
 *
 * ⚠ 【样例只有两条，且内容是英文的】
 *   两条样例只能证明"模型能区分最明显的垃圾"，证明不了误判率
 *   （把正常评论判成 spam）—— 而误判是这个功能真正的风险。
 *   ★ 想让测试更有价值：加几条边界样例（带链接的正常技术讨论、
 *     纯表情、非英文），并提示用户把误判反馈给 Worker 的 prompt。
 *   ⚠ 另外 `c.body.slice(0, 30)` 只打印前 30 字符，样例短所以够用；
 *     加长样例后输出会看起来像被截断。
 *
 * ⚠ 【不校验 endpoint / 不支持 --endpoint】同 status 子命令。
 *
 * ⚠ 【时间测量包含网络往返】`ms` 是端到端耗时，不是模型推理耗时。
 *   打印成 `(1200ms)` 容易让人误以为是模型慢，实际上可能是网络。
 *   真正的分类延迟记录在 mod_log 的 `metadata.latency_ms` 里
 *   （`npx ziscus mod-log` 会显示）。
 */
aiMod
  .command("test")
  .description("Verify AI classification is working")
  .action(async () => {
    const secret = process.env.ZISCUS_ADMIN_SECRET;
    if (!secret) {
      console.error("Error: Set ZISCUS_ADMIN_SECRET env var.");
      process.exit(1);
    }

    let endpoint: string;
    try {
      const config = JSON.parse(await readFile("ziscus.config.json", "utf-8"));
      endpoint = config.endpoint;
    } catch {
      console.error("Error: No ziscus.config.json found. Run `npx ziscus init` first.");
      process.exit(1);
    }

    const cases = [
      { author: "Spammer", body: "Buy cheap SEO services now!", expected: "spam" },
      { author: "Reader", body: "Great article, thanks for sharing!", expected: "approve" },
    ];

    for (const c of cases) {
      const start = Date.now();
      const res = await fetch(`${endpoint}/admin/classify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ author: c.author, body: c.body }),
      });
      const { classification } = await res.json() as { classification: string };
      const ms = Date.now() - start;
      const icon = classification === c.expected ? "✓" : "✗";
      console.log(`  ${icon} "${c.body.slice(0, 30)}..." → ${classification} (${ms}ms)`);
    }
    // ⚠⚠ 这一行是【无条件】执行的 —— 上面循环里两条样例全 ✗ 也一样会打印。
    //   AI 没配好时（binding 缺失 / Workers AI 额度用尽 / 模型名写错），
    //   /admin/classify 会返回错误，解构出的 classification 是 undefined，
    //   于是输出是 `✗ "Buy cheap SEO…" → undefined` 紧跟着
    //   "AI moderation is working." —— 自相矛盾，而只看最后一行会得出
    //   【完全相反】的结论。详见本子命令注释里的假成功 bug。
    //   ★ 修法：统计 ✓ 的数量，全过才打印这句，否则打印失败并 exit(1)。
    console.log("\nAI moderation is working.");
  });

// ⚠ 没有传任何参数，所以默认是 process.argv（commander 的默认行为）。
//   这也意味着本文件【被 import 就会立刻执行 CLI】——
//   单元测试不能直接 import 它，必须通过子进程调用 dist/cli.js。
//   ★ 想让 cli.ts 可测：把命令注册包进一个 `buildProgram()` 函数并导出，
//     只在"作为主模块运行时"调 `parse()`。
// ⚠ 这里也没有 `.showHelpAfterError()`，用户敲错子命令时
//   只看得到一行错误，得自己再敲一次 --help。
program.parse();
