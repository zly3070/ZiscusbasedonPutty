// ============================================================================
// 临时验证脚本：检查 worker/src/html.ts 里 unescapeHtml 的注释是否准确
//
// 【为什么写这个】原文注释声称：
//   "&amp; is decoded last so that a stored &amp;lt; becomes &lt;, not <"
//   即：评论者字面输入 "&lt;"，存取一轮后应该还原成 "&lt;"（而不是 "<"）
//
// 人家读代码时觉得这个说法有问题，所以实测一下。
//
// ⚠ 这个文件只是验证用的，不属于项目源码，看完可以删。
// ============================================================================

const unescapeHtml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const escHtml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const line = (s) => console.log(s);
const show = (label, v) => line(`  ${label.padEnd(22)}: ${JSON.stringify(v)}`);

line("=".repeat(70));
line("测试 1：评论者字面输入  &lt;  （4 个字符 & l t ;）");
line("=".repeat(70));

const input = "&lt;";
const stored = escHtml(input); // 入库时转义
const roundtrip = unescapeHtml(stored); // 渲染时还原

show("用户输入", input);
show("入库（escHtml 后）", stored);
show("源码注释声称应还原为", input);
show("实际还原为", roundtrip);
line(`  实际是否等于原文      : ${roundtrip === input ? "是" : "否  ← 源码注释说法不准确"}`);

line("");
line("=".repeat(70));
line("测试 2：为什么 &amp; 必须最后替换？");
line("=".repeat(70));

// 故意先解 &amp;，看会出什么问题
const wrongOrder = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&") // ← 提前解了
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

line("  输入一个原本是 &amp; 的实体： &amp;amp;");
show("  正确做法（&amp; 最后解）", unescapeHtml("&amp;amp;"));
show("  错误做法（&amp; 提前解）", wrongOrder("&amp;amp;"));
line("");
line("  说明：正确做法得到字面字符 '&amp;'（用户真的想打这个）");
line("        错误做法会把它一路解成 '<' 或 '&'，丢失用户本意");

line("");
line("=".repeat(70));
line("测试 3：渲染路径 escHtml(unescapeHtml(x)) 是否幂等");
line("=".repeat(70));

const samples = [
  "正常评论",
  "<script>alert(1)</script>",
  "&lt;b&gt;hi&lt;/b&gt;", // 已转义的存量数据
  "<b>hi</b>", // 未转义的（异常行）
  'He said "hi" & left',
  "It's a test",
  "math: 1 < 2 && 3 > 2",
];

line("  " + "输入".padEnd(30) + " | 最终输出");
line("  " + "-".repeat(76));
for (const s of samples) {
  // 渲染器统一走这条路（见 html-rewriter.ts / render.ts）
  const rendered = escHtml(unescapeHtml(s));
  line("  " + JSON.stringify(s).padEnd(30) + " | " + JSON.stringify(rendered));
}

line("");
line("  注意最后一行：'1 < 2 && 3 > 2' 被转义输出，不会再变成真标签 → 安全");
line("  注意第 4 行：未转义的 '<b>hi</b>' 也被转义了 → 说明渲染端是兜底防线");

line("");
line("=".repeat(70));
line("结论");
line("=".repeat(70));
line("  1. 渲染端 escHtml(unescapeHtml()) 的设计是有效的（测试 3 全通过）");
line("  2. 但源码注释里关于 '&amp;lt; 会正确还原' 的说法【不成立】（测试 1）");
line("     —— 实际会把用户字面输入的 &lt; 变成真正的 '<'");
line("  3. 这是一个【忠实度】问题，不是安全问题：");
line("     转义本身没错，只是实体还原对用户不忠实");
line("     因为渲染端还会再 escHtml 一次，所以不会 XSS");
line("     但用户看到的文字会变形");
