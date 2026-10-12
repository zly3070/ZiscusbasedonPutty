# 第 5 课：反垃圾第一层 —— 「检查站链」这个通用模式

> 主文件：`worker/src/structural-filter.ts`（59 行）
> 前置：第 1 课（函数）、第 2 课（类型）、第 3 课（正则入门、纯函数）

---

## 5.0 这一课讲的是什么「概念」

**人家把课程从"逐文件"改成"逐概念"** —— 因为概念会跨文件复用，
学会一个能看懂好几处。

**本课的概念是：**

> **「检查站链」（validation chain / early-return chain）**
>
> **一个函数，用一串 `if` 依次检查。每一项检查失败就【立刻返回】，
> 全部通过才走到最后。**

**它在项目里到处都是：**

| 文件 | 检查站链在干什么 |
| --- | --- |
| `structural-filter.ts` | 6 条规则筛掉"不可能是人写的内容" |
| `submit.ts` | 方法 → 开关 → 字段 → 格式 → 长度 → CSRF → 限流 → 封禁 → AI |
| `safeRedirect()`（submit.ts 内） | 相对路径 → 绝对 URL → 协议 → 主机白名单 |
| `rate-limit.ts` | 算窗口 → 原子自增 → 比阈值 |

**⭐ 学会这一个模式，你能读上表中所有地方。**

---

## 5.1 模式长什么样

**典型形状：**

```ts
export function 检查(x): 结果 {
  if (第一条不通过) return 失败("原因一");
  if (第二条不通过) return 失败("原因二");
  if (第三条不通过) return 失败("原因三");
  return 成功();                    // ← 全部通过才到这里
}
```

**⭐ 三个特征：**

| 特征 | 好处 |
| --- | --- |
| **按顺序检查** | 顺序可以安排成"最确定的问题放前面"，报错更准 |
| **立刻 return**（叫 early return） | 不用嵌套 `else`，读起来是平的一行行往下 |
| **失败带原因** | 调用方能把原因直接展示给用户 |

**⚠️ 对比一下【不用】early return 的写法**（反例）：

```ts
if (第一条通过) {
  if (第二条通过) {
    if (第三条通过) {
      return 成功();          // ❌ 越写越往右缩进，叫"箭头形代码"
    } else { return 失败("三"); }
  } else { return 失败("二"); }
} else { return 失败("一"); }
```

**⭐ early return 的价值就是把上面那种嵌套"拍平"。**

---

## 5.2 看真实例子：`structuralFilter`

```ts
export function structuralFilter(author: string, body: string): FilterResult {
  const combined = author + body;

  // 1. 空字节 —— 注入向量
  if (combined.includes("\0")) {
    return { blocked: true, reason: "Null bytes are not allowed" };
  }

  // 2. 不可见 unicode 滥用 —— 文本混淆
  const invisibleCount = (combined.match(INVISIBLE_RE) ?? []).length;
  if (invisibleCount > MAX_INVISIBLE_CHARS) {
    return { blocked: true, reason: "Too many invisible unicode characters" };
  }

  // 3. 字符重复 —— 填充 / 噪声
  if (REPETITION_RE.test(author) || REPETITION_RE.test(body)) {
    return { blocked: true, reason: "Excessive character repetition" };
  }

  // 4. 没有像词的内容 —— 纯符号 / 乱码
  if (!HAS_WORD_RE.test(body)) {
    return { blocked: true, reason: "Comment must contain word-like content" };
  }

  // 5. 超长不断开的 token —— 编码 / 二进制载荷（URL 除外）
  const tokens = body.split(/\s+/);
  for (const token of tokens) {
    if (token.length > MAX_TOKEN_LENGTH && !URL_PREFIX_RE.test(token)) {
      return { blocked: true, reason: "Unusually long token detected" };
    }
  }

  return { blocked: false, reason: "" };       // ← 5 关全过
}
```

**⭐ 一眼就能看出这是"5 个检查站"的结构 —— 这就是这个模式的价值：读起来像清单。**

---

## 5.3 ⭐ 最重要的设计思想：它不判断"内容好不好"

**文件开头的注释把这个说得很清楚（值得原文引用）：**

> *"Catches payloads that **no legitimate comment would ever produce**.
> Does NOT filter on content (that's the AI's job)."*
>
> **中文：它拦的是"任何正常评论都不可能长成这样"的东西。
> 它【不】判断内容（那是 AI 的活）。**

**人家的解读 —— 这条分界是反垃圾设计的核心：**

| 层 | 判断的问题 | 判错了会怎样 |
| --- | --- | --- |
| **规则层**（本课） | "这**可能**是人写的吗？" | 误杀率必须极低 |
| AI 层 | "这**像**垃圾吗？" | 允许一定误差，有人工兜底 |

**⭐ 为什么规则层必须保守？**

> **因为规则层是【强制】的，没有人工过一遍的机会。**
> 一旦规则写得太激进，就**永久拒掉了合法评论**，用户不会来申诉，直接走人。
>
> **而 AI 判错了，最坏结果是进待审队列，你能人工放出来。**

**这个原则可以推广：**

> **越靠前的自动拦截面，越要保守；越靠后的，容错空间越大。**

---

## 5.4 逐个检查站的技术细节

### 站 1：空字节

```ts
if (combined.includes("\0")) {
```

**新语法：`.includes()`** —— 判断字符串里有没有某段内容，返回 `true`/`false`。

```ts
"hello".includes("ell")    // true
"hello".includes("xyz")    // false
```

**⚠️ 注意 `combined` 是 `author + body`** —— 因为这两处都要检查，
**先用 `+` 拼起来，只检查一遍。** 这是"先合并再处理"的常见手法。

---

### 站 2：不可见字符计数

```ts
const invisibleCount = (combined.match(INVISIBLE_RE) ?? []).length;
if (invisibleCount > MAX_INVISIBLE_CHARS) {
```

**拆成两块看：**

```ts
combined.match(INVISIBLE_RE)
//        ↑ 找【所有】匹配的地方，返回一个数组（或 null）

?? []
// ↑ "如果左边是 null，就用右边"
//
// ⚠ 为什么需要这个？因为 .match() 找不到时返回【null】，
//   而 null.length 会报错。?? 提供了兜底值。
//
// ⭐ ?? 叫「空值合并运算符」（nullish coalescing）：
//    只对 null / undefined 生效（不像 || 会被 0 和 "" 触发）

.length
// ↑ 数组长度 = 匹配到几个
```

**⭐ 人家实测过这条的精确边界（用探针跑出来的真实数据）：**

```
不可见字符 1~5 个  → 放行
不可见字符 6 个起  → 拒绝
```

**⚠️ 注意 `>` 而不是 `>=`：** `MAX_INVISIBLE_CHARS = 5` 的含义是
**"最多允许 5 个，第 6 个触发拒绝"**。

**⭐ 这种"边界差一位"是读代码时最容易看错的地方。**
（第 4 课 `rate-limit.ts` 里也有同样的 `>` vs `>=` 问题。）

---

### 站 3：字符重复

```ts
if (REPETITION_RE.test(author) || REPETITION_RE.test(body)) {
```

**新语法：`.test()`** —— **只判断"有没有匹配"，返回 `true`/`false`。**

```ts
/abc/.test("xxabcxx")    // true
/abc/.test("xxxxx")      // false
```

**⭐ `.test()` vs `.match()` 的区别（实用记忆）：**

| | 返回什么 | 什么时候用 |
| --- | --- | --- |
| `.test(正则)` | `true` / `false` | **只想知道"有没有"** |
| `.match(正则)` | 匹配到的数组 / `null` | **还想知道"有几个/是什么"** |

**⚠️ `.test()` 有个容易踩的坑：如果正则带 `g` 标志，它会在多次调用间"记住位置"，
导致同样输入时而 true 时而 false。**

**人家核对了本文件的四个正则（这是真实的定义）：**

| 行号 | 正则 | 有 `g` 吗 | 怎么用的 |
| --- | --- | --- | --- |
| 50 | `INVISIBLE_RE` | ✅ **有** | `.match()` —— **安全** |
| 65 | `REPETITION_RE` | ❌ 无 | `.test()` —— 安全 |
| 75 | `HAS_WORD_RE` | ❌ 无 | `.test()` —— 安全 |
| 87 | `URL_PREFIX_RE` | ❌ 无 | `.test()` —— 安全 |

**⭐ 注意第 50 行那个带 `g` 的正则用的是 `.match()` 而不是 `.test()`** ——
**这正好避开了上面那个坑**（`.match()` 用 `g` 是正常用法，用来数"有几个"）。

**⚠️ 但这里有个隐藏的脆弱点：`INVISIBLE_RE` 是【模块级共享】的正则对象。
如果哪天有人把它改成 `.test()` 去用，就会因为 `g` 的"记住位置"行为出 bug。**
**这是个"知道就好"的坑，你以后写共享正则时留意。**

**还有那个正则本身（第 3 课见过）：**

```ts
/(.)\1{19,}/
```
**"同一个字符连续出现 20 次以上"。** 门槛取 20 而不是 5，
是为了不误杀"好—————"这种语气强化。

---

### 站 4：必须有"像词"的内容

```ts
if (!HAS_WORD_RE.test(body)) {
  return { blocked: true, reason: "Comment must contain word-like content" };
}
```

**⚠️ 注意这里有 `!`（取反），而且只检查 `body` 不检查 `author`。**

**为什么只查 body？** 因为昵称可以是任意短的（"A"、"1"），
但评论正文必须有实际内容。

**那个正则：**

```ts
/[\p{L}\p{N}]{2,}|[+]\d/u
```

| 部分 | 意思 |
| --- | --- |
| `[\p{L}\p{N}]` | **任意语言的字母或数字** |
| `{2,}` | 连续 2 个以上 |
| `\|` | **或者** |
| `[+]\d` | 一个 `+` 号后面跟数字（即 `+1` 这种网络用语） |
| 结尾的 `u` | **Unicode 模式标志**（见下） |

**⭐ `\p{L}` 和结尾那个 `u` 是配套的：**

> **`\p{L}` 这种"Unicode 属性类"必须开 `u` 标志才能用。**

**而它的作用是让中文、日文、韩文、俄文都算"词"** ——
如果用 `[a-zA-Z]`，**所有中文评论都会被误杀**。

**⚠️ 这是个很容易犯的错误，也是本项目做对的地方：**

```
用 [a-zA-Z]       → "这是一条评论" 被拒 ❌ 灾难
用 [\p{L}\p{N}]   → "这是一条评论" 通过 ✅
```

**最后那个 `|+\d` 是为 `+1` 开的口子** —— 否则纯 `+1` 的评论会因为不含两个连续字母而被拦。

---

### 站 5：超长 token（唯一用了循环的）

```ts
const tokens = body.split(/\s+/);
for (const token of tokens) {
  if (token.length > MAX_TOKEN_LENGTH && !URL_PREFIX_RE.test(token)) {
    return { blocked: true, reason: "Unusually long token detected" };
  }
}
```

**三个新东西：**

**① `.split(/\s+/)` —— 按空白切成数组**

```ts
"hello world  foo".split(/\s+/)
// → ["hello", "world", "foo"]
//    ↑ \s = 空白（空格、换行、Tab）；+ = 一个或多个
```

**⭐ 这教给你一个新正则符号：`\s` = 任意空白字符。**（对比 `\S` = 非空白）

**② `for (const token of tokens)` —— 遍历数组**

```ts
for (const token of tokens) {
     ↑       ↑     ↑
     ①       ②     ③
```
| # | 意思 |
| --- | --- |
| ① | **声明一个变量**，每轮循环代表"当前这一项" |
| ② | 变量名（随便叫） |
| ③ | 要遍历的数组 |

**⭐ 读法就一句：`for (const 每项 of 数组)` = "对数组里每一项，做下面的事"。**

**⚠️ 每次循环那个 `const` 都是一个【新变量】** —— 所以叫 `const` 也没问题，
别误以为"const 不能变就不能循环"。

**③ `&&` 组合两个条件**

```ts
token.length > MAX_TOKEN_LENGTH && !URL_PREFIX_RE.test(token)
//    ↑ 太长了              ↑ 而且  ↑ 不是 URL 开头
```

**⭐ 那个 `!URL_PREFIX_RE.test(token)` 是豁免条款** ——
长 URL 是正常的（长查询串很常见），所以排除掉。

**⚠️ 注意它只排除"以 http:// 或 https:// 开头"的 token。**
一个超长的、不以 http 开头的 base64 串仍然会被拦 —— 这正是设计意图。

---

## 5.5 实验结果：改一个数字，看测试怎么反应

**这是本课的动手部分。人家先替你实测过，你照做即可。**

### 改什么

**`worker/src/structural-filter.ts` 第 58 行：**

```ts
const MAX_INVISIBLE_CHARS = 5;     ← 改成 6
```

### 跑什么

```powershell
cd C:\Users\asus\Desktop\ZiscusbasedonPutty\worker
.\node_modules\.bin\vitest.cmd run src/structural-filter.test.ts
```

### 人家的实测结果

```
 Test Files  1 failed (1)
      Tests  2 failed | 19 passed (21)

× structuralFilter > blocks body with mixed invisible unicode types
× structuralFilter > blocks author with excessive invisible unicode
```

**报错信息：**

```
→ expected false to be true // Object.is equality
```

**读法：** 这两条测试用的输入正好是 **6 个**不可见字符，
**期望被拒（`blocked: true`），但现在阈值放宽到 6 所以放行了，返回 `false`。**

**⭐ 为什么正好是这两条？** 因为：

| 那条测试用了几个 | 改前（阈值 5） | 改后（阈值 6） |
| --- | --- | --- |
| `blocks body with excessive invisible...` 用 **10 个** | 拒绝 ✅ | 拒绝 ✅（10 > 6） |
| `blocks body with mixed...` 用 **6 个** | 拒绝 ✅ | **放行 ❌** |
| `blocks author with excessive...` 用 **6 个** | 拒绝 ✅ | **放行 ❌** |

**⭐ 这个实验教给你两件很重要的事：**

**① `5` 这个数字的含义是"最多允许 5 个"（因为判断写的是 `>` 而不是 `>=`）**

**② 测试断言的是【边界】，所以改阈值必然打破边界断言**

**⚠️ 而且测试不会告诉你"你的阈值改错了" —— 它只告诉你"边界变了"。**

**决定"6 是否合理"是你的判断，不是测试的判断。** 这就是"测试保证一致性，
不保证正确性"的含义。

### 所以正确的改动流程是

```
1. 想清楚为什么放宽到 6（有理由吗？）
2. 改代码
3. 跑测试 → 看到 2 条挂了
4. 判断："是我的代码错了，还是测试的边界过时了？"
5. 若是后者 → 同步更新那两条测试的输入（改成 7 个字符，仍然超过新阈值）
6. 再跑 → 全绿
```

**⭐ 第 4 步的判断力，就是第 3 课和第 4 课一直在训练的东西。**

---

## 5.6 这一课你要记住的四件事

| # | 知识点 | 为什么重要 |
| --- | --- | --- |
| 1 | ⭐ **「检查站链」模式**：一串 `if` + 立刻 return | 项目里 5 处以上都用它，学会一个看懂一片 |
| 2 | **`.test()` 返回 true/false，`.match()` 返回数组/null** | 只想知道"有没有"就用 `.test()` |
| 3 | **`??` 空值合并** + `for (const x of 数组)` | 前者防 `null.length` 崩溃，后者是遍历的标准写法 |
| 4 | ⭐ **规则层必须保守：只拦"不可能是人写的"** | 因为规则层没有人工兜底，误杀就是永久损失 |

**⭐ 还有两条从 5.4、5.5 提炼的实战经验：**

> **① 看到阈值判断，先确认是 `>` 还是 `>=`。**
> 一个符号之差，"最多 5 个"和"最多 6 个"就不一样了。
>
> **② 改边界值会打破测试的边界断言 —— 那是正常的，
> 但你要判断"该改代码还是该改测试"。**

---

## 5.7 下一课预告

**第 6 课：查数据库（SQL + D1 的用法）**

你会学到：

- **SQL 基础**：`SELECT` / `INSERT` / `UPDATE` 长什么样
- **D1 的三件套**：`.prepare()` → `.bind()` → `.run()/.first()/.all()`
- **`await` 在数据库操作里的真实意义**（第 1 课学的终于用上）
- ⚠ **`bind` 为什么能防注入**（别人家改成字符串拼接）

**这一课会跨越最多文件** —— `submit.ts`、`comments-api.ts`、`admin-api.ts`、
`rate-limit.ts` 全都在做同一件事：查数据库。**学会这一课，你能读懂大半个后端。**
