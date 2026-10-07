/**
 * ============================================================================
 * embed/src/cli/load-env.ts —— 极简 .env 读取器（零依赖）
 * ============================================================================
 *
 * 【为什么自己写而不装 dotenv】
 *   `ziscus` 是个命令行工具，用户 `npx ziscus ...` 直接跑。
 *   每多一个运行时依赖，npx 首次执行的下载量就大一点。
 *   这段逻辑只有 20 行，自己写能省掉一个依赖 —— 这是 CLI 工具常见的选择。
 *
 * 【⚠ 三条"有意为之"的局限，你要知道】
 *
 *   ① 【不覆盖已存在的变量】
 *      `if (!process.env[key]) process.env[key] = value;`
 *      所以**真实环境变量优先于 .env 文件**。
 *      这是正确的优先级（部署环境能覆盖本地配置），但反直觉 ——
 *      如果你在 CI 里设了 ZISCUS_ENDPOINT，.env 里的同名项会被忽略。
 *
 *   ② 【文件不存在时静默返回】
 *      不报错、不提示。所以"我明明写了 .env 却不生效"时，
 *      先确认路径传对没有（调用方传的是绝对路径还是相对路径）。
 *
 *   ③ 【解析能力很弱，不支持】
 *      · 值里的引号不会剥离           ZISCUS_SECRET="abc" → 值里带引号！
 *      · 不支持 ${VAR} 插值
 *      · 不支持 export 前缀           `export FOO=bar` 会被当成 key "export FOO"
 *      · 不支持多行值
 *      如果密钥里含引号或特殊字符，**建议直接用环境变量而不是 .env**。
 *
 * ★ 自定义提示：这是可以放心替换成 dotenv 的地方 ——
 *   如果你需要引号剥离或插值，换掉它不会有别的副作用。
 */
import { readFileSync } from "node:fs";

/**
 * Load a .env file into process.env. Does not override existing vars.
 * Silently does nothing if the file is missing.
 */
export function loadEnvFile(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
