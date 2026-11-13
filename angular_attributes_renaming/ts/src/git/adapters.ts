import { BitbucketAdapter, AzureDevOpsAdapter, GitLabAdapter, SelfHostedAdapter } from "./stubs";
import { GitHubAdapter } from "./github";
import { GitHostAdapter, GitHostKind } from "./types";

const github = new GitHubAdapter();

export function getAdapter(kind: GitHostKind): GitHostAdapter {
  switch (kind) {
    case "github":
      return github;
    case "gitlab":
      return GitLabAdapter;
    case "bitbucket":
      return BitbucketAdapter;
    case "azuredevops":
      return AzureDevOpsAdapter;
    case "selfhosted":
      return SelfHostedAdapter;
    default:
      return SelfHostedAdapter;
  }
}
