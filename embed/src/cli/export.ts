/**
 * ============================================================================
 * embed/src/cli/export.ts —— `ziscus export`（备份全部数据到本地文件）
 * ============================================================================
 *
 * 【产物是一组文件，不是一个包】
 *   <outputDir>/
 *     comments.json  或 comments.csv   评论
 *     mod-log.json   或 mod-log.csv    审计日志
 *     banned-ips.json                  封禁名单
 *     meta.json                        配置（评论开关等）
 *
 *   ⚠ 注意 json/csv 只影响 comments 和 mod-log；**bans 和 meta 永远是 JSON**。
 *   ⚠ 而且【不导出 meta 里的 `slug_paused:*`】—— 也就是说恢复备份后
 *     "按页暂停"的状态会丢。这是子代理读代码时发现的一处遗漏。
 *
 * 【★★ 最重要的一个选项：redactIpHashes —— 这是全项目最好的隐私设计之一】
 *
 *   源码注释把理由写得非常清楚，值得完整理解：
 *
 *     "ip_hash is an unsalted 64-bit prefix of SHA-256(ip) — the IPv4 space
 *      is only 2^32, so **a published hash is a published IP**."
 *
 *   推导过程：
 *     · 全 IPv4 只有 2^32 ≈ 43 亿个
 *     · 算一遍全部 IPv4 的 SHA-256 在现代机器上是**分钟级**的事
 *     · 所以 ip_hash 根本不是匿名化的，它只是"编码过的 IP"
 *     · 因此**导出的备份只要公开，就等于公开了所有访客的 IP**
 *
 *   ★ 什么场景必须开这个选项：
 *     · 备份要提交到 git 仓库（比如 rebuild workflow 自动存档）
 *     · 备份要放到共享盘、云盘、发给别人
 *     · 任何"不是只有你自己能看到"的地方
 *
 *   开启后 redactIpHashes() 会：
 *     ① 从 comments 和 bans 里删掉 ip_hash 字段
 *     ② 把 mod-log 的 reason 里的 "ip_hash abc123..." 替换成 "[redacted]"
 *        （因为 GDPR 删除动作会把 ip_hash 写进 reason，见 worker 侧 admin-api）
 *   ⚠ 但它【不动 meta】—— meta 里理论上不含 IP，但如果你自己往里写了
 *     带 IP 的配置值，redact 不会救你。
 *
 * 【和 import 的配合 —— 这里有个已知的真 bug】
 *   ⚠ 导出 → 导入【不是幂等的】：worker 侧的 handleImport 会对
 *     author/body 再调一次 escHtml()，而备份里本来就是转义后的形态。
 *     结果凡是含 & < > " ' 的评论，恢复后会被多包一层实体
 *     （`&lt;b&gt;` 变成 `&amp;lt;b&amp;gt;`），渲染出来是字面文本。
 *     **反复导出导入会每次再包一层，且不可逆。**
 *   → 结论：**在真正依赖这套备份恢复之前，先用一条含 `<` 的评论验证一遍。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExportOptions {
  endpoint: string;
  secret: string;
  outputDir: string;
  format?: "json" | "csv";
  /**
   * Strip every `ip_hash` before writing. ip_hash is an unsalted 64-bit prefix
   * of SHA-256(ip) — the IPv4 space is only 2^32, so a published hash is a
   * published IP. Use this whenever the export lands somewhere public (e.g.
   * committed to a repo by the rebuild workflow).
   */
  redactIpHashes?: boolean;
}

export interface ExportData {
  comments: Record<string, unknown>[];
  modLog: Record<string, unknown>[];
  bans: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

export async function runExport(options: ExportOptions): Promise<void> {
  const { endpoint, secret, outputDir, format = "json" } = options;

  const res = await fetch(`${endpoint}/admin/export`, {
    headers: { Authorization: `Bearer ${secret}` },
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Authentication failed (401). Check your ZISCUS_ADMIN_SECRET.");
    }
    throw new Error(`Export failed: ${res.status} ${await res.text()}`);
  }

  const raw = (await res.json()) as ExportData;
  const data = options.redactIpHashes ? redactIpHashes(raw) : raw;

  await mkdir(outputDir, { recursive: true });

  if (format === "csv") {
    await writeFile(join(outputDir, "comments.csv"), toCsv(data.comments));
    await writeFile(join(outputDir, "mod-log.csv"), toCsv(data.modLog));
  } else {
    await writeFile(join(outputDir, "comments.json"), JSON.stringify(data.comments, null, 2) + "\n");
    await writeFile(join(outputDir, "mod-log.json"), JSON.stringify(data.modLog, null, 2) + "\n");
  }

  await writeFile(join(outputDir, "banned-ips.json"), JSON.stringify(data.bans, null, 2) + "\n");
  await writeFile(join(outputDir, "meta.json"), JSON.stringify(data.meta, null, 2) + "\n");
}

/** Remove `ip_hash` fields and scrub ip_hash mentions from mod-log reasons. */
export function redactIpHashes(data: ExportData): ExportData {
  const strip = (rows: Record<string, unknown>[]) =>
    rows.map(({ ip_hash: _omit, ...rest }) => rest);
  return {
    comments: strip(data.comments),
    bans: strip(data.bans),
    modLog: data.modLog.map((row) =>
      typeof row.reason === "string"
        ? { ...row, reason: row.reason.replace(/ip_hash [0-9a-f]+/g, "ip_hash [redacted]") }
        : row,
    ),
    meta: data.meta,
  };
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(String(row[h] ?? ""))).join(","));
  }
  return lines.join("\n") + "\n";
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
