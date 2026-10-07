/**
 * ============================================================================
 * embed/src/cli/migrate.ts —— `ziscus migrate`（把 giscus 的评论搬过来）
 * ============================================================================
 *
 * 【这个命令解决什么现实问题】
 *   你原来用 giscus（评论存在 GitHub Discussions 里），现在想换到 ziscus。
 *   但评论是资产，不能丢。这个文件把 Discussions 拉下来、转成 ziscus 的
 *   评论格式、再灌进你的 D1。
 *
 * 【完整流程】
 *   GitHub GraphQL API
 *        │  fetchGiscusDiscussions()   翻页拉全部 discussion
 *        ▼
 *   GiscusDiscussion[]
 *        │  mapDiscussionsToComments() 拍平成 ziscus 评论
 *        ▼
 *   ImportComment[]
 *        │  POST /admin/import
 *        ▼
 *   你的 D1
 *
 * 【★★ 最关键的一个映射：slug = discussion.title】
 *
 *   看 mapDiscussionsToComments() 里：
 *       const slug = disc.title;
 *
 *   **这是整个迁移能不能成功的决定性一行。**
 *
 *   因为 ziscus 用 slug 把评论和页面关联起来，而 SSG 渲染时传给
 *   fetchComments() 的 slug 是站点自己决定的（通常就是 URL 路径）。
 *   而 giscus 把 discussion 的【标题】当作页面标识。
 *
 *   ⚠ 所以如果 giscus 那边用的是 "posts/hello-world" 这种路径式标题，
 *     而你的 ziscus 站点也用同样的 slug → 完美对应。
 *     如果标题格式不同（比如带前缀、带站点名）→ **评论会全部挂到错误的页面上**，
 *     而且不会报错，只是页面上一条评论都不显示。
 *
 *   ★ 迁移后第一件事：**抽几个页面检查评论数对不对**，别只看"导入了多少条"。
 *
 * 【⚠ 三个已知的局限】
 *
 *   ① 【回复被拍平，层级信息丢失】
 *      源码注释说得很直白："Threads are flattened"。
 *      回复被加上 `Re: <被回复人> — ` 前缀插在正文前面，变成同级评论。
 *      ziscus 的表结构根本没有 parent_id，**所以嵌套回复是架构上做不到的**，
 *      不是这里偷懒。
 *
 *   ② 【回复的时间顺序可能不对】
 *      评论和它的回复被顺序 push，但**没有按 created_at 排序**。
 *      如果 GitHub 返回的 replies 顺序和实际时间不一致，
 *      导入后评论在页面上会乱序（ziscus 按 created_at 排序显示）。
 *
 *   ③ 【HTML 转义状态未处理】
 *      giscus 的 body 是 Markdown **原文**（未转义），
 *      而 ziscus 的存储不变量要求入库前先 escHtml()。
 *      这里直接把原文传给了 /admin/import —— 由 worker 侧的
 *      handleImport 负责转义（它确实会调 escHtml）。
 *      ⚠ 但 Markdown 语法不会渲染，你会看到字面的 `**粗体**`。
 *      ★ 想保留 Markdown 效果，需要在导入前把 body 转成 HTML
 *        （那又要处理 XSS，比想象中麻烦）。
 *
 * 【★ 权限要求】
 *   需要一个 GitHub token，且该 token 必须能读【仓库的 Discussions】。
 *   只读权限即可（GraphQL 查询是只读的）。注意这和 Worker 用的
 *   GITHUB_TOKEN 是【不同的用途】，那边的需要 Contents: write。
 */
import { randomBytes } from "node:crypto";

export interface GiscusComment {
  author: { login: string } | null;
  body: string;
  createdAt: string;
  replies: {
    nodes: Array<{
      author: { login: string } | null;
      body: string;
      createdAt: string;
    }>;
  };
}

export interface GiscusDiscussion {
  title: string;
  url: string;
  createdAt: string;
  comments: {
    nodes: GiscusComment[];
  };
}

export interface ImportComment {
  id: string;
  slug: string;
  author: string;
  body: string;
  status: string;
  created_at: string;
}

const GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    discussions(first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        title
        url
        createdAt
        comments(first: 100) {
          nodes {
            author { login }
            body
            createdAt
            replies(first: 100) {
              nodes {
                author { login }
                body
                createdAt
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

/**
 * Fetch all discussions from a GitHub repository via GraphQL.
 * Handles pagination automatically.
 */
export async function fetchGiscusDiscussions(
  owner: string,
  repo: string,
  token: string,
): Promise<GiscusDiscussion[]> {
  const all: GiscusDiscussion[] = [];
  let cursor: string | null = null;

  while (true) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ziscus-migrate",
      },
      body: JSON.stringify({
        query: GRAPHQL_QUERY,
        variables: { owner, repo, cursor },
      }),
    });

    const json = (await res.json()) as {
      data: {
        repository: {
          discussions: {
            nodes: GiscusDiscussion[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };

    const discussions = json.data.repository.discussions;
    all.push(...discussions.nodes);

    if (!discussions.pageInfo.hasNextPage) break;
    cursor = discussions.pageInfo.endCursor;
  }

  return all;
}

/**
 * Map GitHub Discussions to flat ziscus comments.
 * Threads are flattened with "Re: [parent author]" prefix.
 */
export function mapDiscussionsToComments(discussions: GiscusDiscussion[]): ImportComment[] {
  const comments: ImportComment[] = [];

  for (const disc of discussions) {
    // ⚠⚠ 迁移成败的关键一行：用 discussion 的【标题】当 ziscus 的 slug。
    //    必须和你的站点传给 fetchComments() 的 slug 完全一致，
    //    否则评论会静默挂到不存在的页面上（不报错，但页面显示 0 条评论）。
    //    迁移后务必抽查几个页面的评论数。
    const slug = disc.title;

    for (const comment of disc.comments.nodes) {
      const authorName = comment.author?.login ?? "anonymous";

      comments.push({
        id: randomBytes(8).toString("hex"),
        slug,
        author: authorName,
        body: comment.body,
        status: "approved",
        created_at: comment.createdAt,
      });

      for (const reply of comment.replies.nodes) {
        comments.push({
          id: randomBytes(8).toString("hex"),
          slug,
          author: reply.author?.login ?? "anonymous",
          body: `Re: ${authorName} — ${reply.body}`,
          status: "approved",
          created_at: reply.createdAt,
        });
      }
    }
  }

  return comments;
}

export interface MigrateOptions {
  owner: string;
  repo: string;
  token: string;
  endpoint: string;
  secret: string;
}

/**
 * Run the full migration: fetch from GitHub, map, import to ziscus.
 * Returns the count of imported comments.
 */
export async function runMigrate(opts: MigrateOptions): Promise<number> {
  const discussions = await fetchGiscusDiscussions(opts.owner, opts.repo, opts.token);
  const comments = mapDiscussionsToComments(discussions);

  if (comments.length === 0) return 0;

  const res = await fetch(`${opts.endpoint}/admin/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ comments }),
  });

  if (!res.ok) {
    throw new Error(`Import failed (${res.status}): ${await res.text()}`);
  }

  const result = (await res.json()) as { comments: number };
  return result.comments;
}
