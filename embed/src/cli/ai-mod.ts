/**
 * ============================================================================
 * embed/src/cli/ai-mod.ts —— `ziscus ai-mod` 子命令（开关 Workers AI 反垃圾）
 * ============================================================================
 *
 * 【这个命令做的事很"物理"：直接改 wrangler.toml 文本】
 *   enable  → 往 wrangler.toml 末尾追加
 *                [ai]
 *                binding = "AI_MOD"
 *   然后用 wrangler 重新部署。
 *
 *   为什么用文本追加而不是解析 TOML：
 *     · 避免引入 TOML 解析/序列化依赖（CLI 工具在意体积）
 *     · **保留用户原有的注释和格式** —— 解析再写回会把注释全丢掉
 *   代价是判断"是否已经启用"只能靠 `toml.includes("[ai]")` 这种字符串匹配。
 *
 *   ⚠ 这个字符串匹配有两个误判可能：
 *     · 用户在注释里写了 `# [ai]` → 会被当成"已启用"而跳过追加
 *     · 用户已有一个【别的用途】的 [ai] 段 → 同样被跳过
 *   ★ 如果你手动配过 wrangler.toml，建议直接手改而不是用这个命令。
 *
 * 【★ disable 只是"打印说明"而不是真的改文件】
 *   看 runAiModDisable() —— 它【返回一段提示文本】，让你自己去注释掉。
 *   这是有意的保守设计（不替用户改配置），但和 enable 的行为不对称：
 *   **enable 自动改、disable 要手改**。知道这个差异能省你找半天。
 *
 * 【和 Worker 侧的关系】
 *   绑定名 `AI_MOD` 必须和 `worker/src/types.ts` 里的 `AI_MOD?: Ai;` 一致。
 *   一旦绑定生效，submit.ts 里的 status 解析就会**走 AI 优先分支，
 *   忽略 MODERATION 设置**（见 classify.ts 的注释）。
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";

export interface EnableOptions {
  dir: string;
  wranglerPath: string;
  deploy: boolean;
}

export interface EnableResult {
  ok: boolean;
  error?: string;
  alreadyEnabled?: boolean;
}

/**
 * 启用 AI 反垃圾：往 wrangler.toml 追加 `[ai]` 绑定。
 *
 * 前置检查（都返回 ok:false 而不抛异常）：
 *   ① 当前目录有 ziscus.config.json（否则说明没 init 过）
 *   ② wrangler.toml 存在且可读
 *
 * @param options.dir           项目目录（找 ziscus.config.json 用）
 * @param options.wranglerPath  wrangler.toml 的路径
 * @param options.deploy        是否顺便重新部署
 *                              ⚠ 注意这个参数在【这个函数里没被使用】！
 *                                调用方（cli.ts）拿到 ok 之后再自己决定要不要部署。
 *                                API 签名上留着它有点误导。
 * @returns alreadyEnabled=true 表示检测到 `[ai]` 已存在、什么都没做
 */
export async function runAiModEnable(options: EnableOptions): Promise<EnableResult> {
  const { dir, wranglerPath, deploy } = options;

  // Check ziscus.config.json exists
  try {
    await access(`${dir}/ziscus.config.json`, constants.R_OK);
  } catch {
    return { ok: false, error: "No ziscus.config.json found. Run `npx ziscus init` first." };
  }

  // Check wrangler.toml exists
  try {
    await access(wranglerPath, constants.R_OK);
  } catch {
    return { ok: false, error: `wrangler.toml not found at ${wranglerPath}` };
  }

  // Read and check if [ai] already present
  const toml = await readFile(wranglerPath, "utf-8");
  if (toml.includes("[ai]")) {
    return { ok: true, alreadyEnabled: true };
  }

  // Append [ai] binding
  const binding = '\n[ai]\nbinding = "AI_MOD"\n';
  await writeFile(wranglerPath, toml + binding);

  return { ok: true };
}

export function runAiModDisable(): string {
  return `To disable AI moderation, remove or comment out the [ai] section from your worker/wrangler.toml:

  # [ai]
  # binding = "AI_MOD"

Then redeploy: cd worker && wrangler deploy

Comments will use your MODERATION setting instead.`;
}

export async function runAiModStatus(
  endpoint: string,
  secret: string,
): Promise<{ pending: number; approved: number; rejected: number; spam: number }> {
  const res = await fetch(`${endpoint}/admin/stats`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return res.json() as Promise<{ pending: number; approved: number; rejected: number; spam: number }>;
}
