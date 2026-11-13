import { httpRequest } from "./http";
import {
  CreatePullRequestInput,
  CreatePullRequestResult,
  GitHostAdapter,
  RemoteInfo,
} from "./types";

export class GitHubAdapter implements GitHostAdapter {
  readonly kind = "github" as const;

  async createPullRequest(
    remote: RemoteInfo,
    input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult> {
    const api = remote.apiBaseUrl.replace(/\/$/, "");
    const url = `${api}/repos/${remote.owner}/${remote.repo}/pulls`;
    const response = await httpRequest(
      "POST",
      url,
      {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "User-Agent": "angular-io-tool",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      })
    );

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    if (response.status < 200 || response.status >= 300) {
      const message =
        (data.message as string) ||
        response.body ||
        `GitHub API error ${response.status}`;
      if (
        response.status === 422 &&
        typeof message === "string" &&
        /already exists/i.test(JSON.stringify(data))
      ) {
        const existing = await this.findExistingPr(remote, input);
        if (existing) {
          return existing;
        }
      }
      throw new Error(message);
    }

    return {
      url: String(data.html_url || ""),
      number: typeof data.number === "number" ? data.number : undefined,
    };
  }

  private async findExistingPr(
    remote: RemoteInfo,
    input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult | null> {
    const api = remote.apiBaseUrl.replace(/\/$/, "");
    const head = `${remote.owner}:${input.head}`;
    const url =
      `${api}/repos/${remote.owner}/${remote.repo}/pulls` +
      `?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(
        input.base
      )}`;
    const response = await httpRequest("GET", url, {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "User-Agent": "angular-io-tool",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    let list: Array<Record<string, unknown>> = [];
    try {
      list = JSON.parse(response.body) as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }
    return {
      url: String(list[0].html_url || ""),
      number: typeof list[0].number === "number" ? list[0].number : undefined,
    };
  }
}
