export type GitHostKind =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "azuredevops"
  | "selfhosted"
  | "unknown";

export interface RemoteInfo {
  kind: GitHostKind;
  owner: string;
  repo: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  remoteUrl: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  token: string;
}

export interface CreatePullRequestResult {
  url: string;
  number?: number;
  id?: string;
}

/**
 * Host-specific adapter for opening merge/pull requests.
 * Add Bitbucket / GitLab / Azure DevOps / self-hosted implementations later.
 */
export interface GitHostAdapter {
  readonly kind: GitHostKind;
  createPullRequest(
    remote: RemoteInfo,
    input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult>;
}
