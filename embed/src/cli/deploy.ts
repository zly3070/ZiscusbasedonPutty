/**
 * ============================================================================
 * embed/src/cli/deploy.ts —— 部署工具箱（wrangler / git 的薄封装 + 脚手架生成）
 * ============================================================================
 *
 * 【这个文件在系统里的位置】
 *
 *   它是 `npx ziscus deploy`（见 cli.ts）的"零件库"：
 *   本文件提供【一个个可单独调用、可单独测试】的小步骤，
 *   cli.ts 负责按顺序编排它们、打印进度、决定退出码。
 *
 *     cli.ts 的 deploy 命令
 *        ├─ checkWranglerVersion()     本文件
 *        ├─ checkWranglerAuth()        本文件
 *        ├─ createD1Database()         本文件
 *        ├─ scaffoldWorker()           本文件 ─┬─ renderWranglerToml()
 *        │                                     └─ writeDatabaseId()
 *        ├─ resolveSchemaPath()        本文件
 *        ├─ applySchema()              本文件
 *        ├─ generateSecret()           本文件
 *        ├─ setWranglerSecret()        本文件
 *        ├─ deployWorker()             本文件
 *        └─ runInit()                  cli/init.ts
 *
 *   ★ 另外 `resolveWorkerDir()` 作为公共工具，被 ai-mod 子命令复用
 *     （用来定位 wrangler.toml）。
 *
 * 【设计上的一个亮点：exec 可替换】
 *   所有对外部命令的调用都经过模块级的 `exec`，而 `exec` 可以被
 *   `setExec()` 替换 —— 这是整个 CLI 里【最容易测试】的模块，
 *   deploy.test.ts 就是靠它把 wrangler/git 全部 mock 掉的。
 *   ⚠ 代价是"模块级可变状态"：它是全局的，测试之间必须自己重置，
 *     而且测试并行时会互相干扰（vitest 默认按文件隔离模块，
 *     所以同文件内顺序执行时没问题）。
 *   ⚠ `export let exec` 导出的是可写绑定；其它模块拿到的引用是只读视图，
 *     想改只能通过 `setExec()`。★ 保持这个约束，别让外部直接赋值。
 *
 * 【⚠ 跨平台：这个文件是 macOS/Linux 优先的】
 *   最明显的一处是 `setWranglerSecret()` 里写死了 `shell: "/bin/sh"`，
 *   在 Windows 上一定失败（见该函数的 ⚠）。
 *   另外 `wrangler` 的调用都假设它在 PATH 上（`npm i -g wrangler`）。
 */
import { execSync as nodeExecSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type ExecFn = (cmd: string, opts?: object) => Buffer;

/**
 * 实际执行外部命令的函数。★ 唯一允许被替换的接缝（测试用）。
 *
 * ⚠ `stdio` 被显式设成三个 "pipe"，**然后才**展开 `...opts` ——
 *   顺序很关键：调用方可以用 `{ stdio: "inherit" }` 覆盖它。
 *   ★ `setWranglerSecret()` 就是靠这个机制自定义 `shell` 和 `cwd` 的。
 *
 * ⚠ 返回 `Buffer`（不是 string）。所以每个调用点都要自己 `.toString()`；
 *   忘了加就会出现 `output.match is not a function` 这种难懂的报错。
 *   ★ 类型上更安全的做法是让 ExecFn 返回 string。
 */
export let exec: ExecFn = (cmd, opts) => nodeExecSync(cmd, { stdio: ["pipe", "pipe", "pipe"], ...opts });

/**
 * 替换 `exec` 的实现。★ 仅供测试使用。
 *
 * ⚠ 【不是线程/测试隔离安全的】它改的是模块级变量，影响该模块的
 *   【所有】调用方。测试里必须在 afterEach 恢复成真实实现，
 *   否则后续测试会拿着上一个 mock 继续跑（症状是"单独跑通过、
 *   一起跑失败"）。
 * ⚠ 类型签名 `ExecFn` 要求返回 Buffer，mock 时容易忘记
 *   （返回 string 会在调用点 `.toString()` 时静默成功，
 *    但在 `.match()` 处爆炸）。
 */
export function setExec(fn: ExecFn): void { exec = fn; }

/**
 * 部署到"依赖模型"时需要的全部上下文。
 *
 * ⚠ 【这个接口目前没有任何地方在使用】—— 搜遍仓库，没有任何函数
 *   接收 `DeployContext`。它是重构的残留（大概原本想把 8 个步骤
 *   串成一个 `deploy(ctx)` 函数）。
 *   ★ 这是死代码：要么删掉，要么按它把 cli.ts 里那段编排真正收进来。
 */
export interface DeployContext {
  siteUrl: string;
  ssg: string;
  dbName: string;
  dbId: string;
  adminSecret: string;
  workerUrl: string;
  workerDir: string;
}

export function checkWranglerVersion(): void {
  let output: string;
  try {
    output = exec("wrangler --version").toString();
  } catch {
    throw new Error(
      "wrangler not found. Install it: npm install -g wrangler\n" +
      "Then authenticate: wrangler login",
    );
  }

  const match = output.match(/(\d+)\.\d+\.\d+/);
  if (!match) {
    throw new Error(`Could not parse wrangler version from: ${output.trim()}`);
  }

  const major = parseInt(match[1]!, 10);
  if (major < 4) {
    throw new Error(
      `wrangler ${match[0]} is too old. ziscus deploy requires >= 4.0.0.\n` +
      "Upgrade: npm install -g wrangler@latest",
    );
  }
}

export function checkWranglerAuth(): void {
  try {
    exec("wrangler whoami");
  } catch {
    throw new Error("Not authenticated with Cloudflare. Run: wrangler login");
  }
}

export function createD1Database(name: string): string {
  const output = exec(`wrangler d1 create ${name} --json`).toString();
  const parsed = JSON.parse(output) as { uuid: string };
  return parsed.uuid;
}

export function applySchema(dbName: string, schemaPath: string): void {
  exec(`wrangler d1 execute ${dbName} --remote --file=${schemaPath}`);
}

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

export function setWranglerSecret(name: string, value: string, cwd: string = "."): void {
  exec(`echo "${value}" | wrangler secret put ${name}`, { shell: "/bin/sh", cwd });
}

/**
 * Where the Worker config lives. Explicit `--worker-dir` wins; a cloned-repo
 * layout (`worker/wrangler.toml`) is honoured; otherwise the project root —
 * the dependency model, where `worker.ts` re-exports `ziscus/worker`.
 */
export function resolveWorkerDir(explicit?: string): string {
  if (explicit) return explicit;
  if (existsSync(join("worker", "wrangler.toml"))) return "worker";
  return ".";
}

/** The D1 schema: a cloned repo's copy if present, else the one shipped in this package. */
export function resolveSchemaPath(workerDir: string): string {
  const local = join(workerDir, "src", "schema.sql");
  if (existsSync(local)) return local;
  return fileURLToPath(new URL("./schema.sql", import.meta.url));
}

/** `owner/repo` from the git remote, for the GITHUB_REPO var. Null if not a GitHub remote. */
export function detectGitHubRepo(): string | null {
  try {
    const url = exec("git remote get-url origin").toString().trim();
    const m = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export interface ScaffoldOptions {
  /** Worker name on Cloudflare. */
  name: string;
  dbName: string;
  dbId: string;
  /** Hostname allowed to POST /submit (CSRF check). */
  siteHost: string;
  /** owner/repo that receives rebuild dispatches. */
  githubRepo: string;
}

export function renderWranglerToml(o: ScaffoldOptions): string {
  return `name = "${o.name}"
main = "worker.ts"
compatibility_date = "2025-09-27"

[[d1_databases]]
binding = "DB"
database_name = "${o.dbName}"
database_id = "${o.dbId}"

[vars]
ALLOWED_ORIGINS = "${o.siteHost}"   # comma-separated hosts allowed to POST /submit
MODERATION = "off"                  # "on" holds new comments for review
RATE_LIMIT = "30"                   # comments per IP per hour
GITHUB_REPO = "${o.githubRepo}"     # receives repository_dispatch rebuild triggers

# Optional: serve your static site from this Worker. Enables the instant
# "see your own comment" preview. Point \`directory\` at your build output.
# [assets]
# directory = "_site"
# binding = "ASSETS"
# run_worker_first = true

# Optional: AI spam filtering — \`npx ziscus ai-mod enable\` adds this.
# [ai]
# binding = "AI_MOD"

# Secrets (\`wrangler secret put\`): ADMIN_SECRET, GITHUB_TOKEN
`;
}

/** Point the first `database_id = "..."` in a wrangler.toml at `dbId`. Returns false if none found. */
export function writeDatabaseId(tomlPath: string, dbId: string): boolean {
  const s = readFileSync(tomlPath, "utf8");
  const next = s.replace(/^(\s*database_id\s*=\s*)"[^"]*"/m, `$1"${dbId}"`);
  if (next === s) return false;
  writeFileSync(tomlPath, next);
  return true;
}

/**
 * Make `dir` deployable: write wrangler.toml if missing (else just set its
 * database_id), and a one-line worker.ts unless a Worker entry already exists.
 * Returns the files it created.
 */
export function scaffoldWorker(dir: string, o: ScaffoldOptions): string[] {
  const created: string[] = [];
  const toml = join(dir, "wrangler.toml");
  if (existsSync(toml)) {
    writeDatabaseId(toml, o.dbId);
  } else {
    writeFileSync(toml, renderWranglerToml(o));
    created.push(toml);
  }
  const entry = join(dir, "worker.ts");
  if (!existsSync(entry) && !existsSync(join(dir, "src", "index.ts"))) {
    writeFileSync(entry, 'export { default } from "ziscus/worker";\n');
    created.push(entry);
  }
  return created;
}

export function deployWorker(workerDir: string): string {
  const output = exec("wrangler deploy", { cwd: workerDir }).toString();
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  return match ? match[0] : "";
}
