import {
  CreatePullRequestInput,
  CreatePullRequestResult,
  GitHostAdapter,
  GitHostKind,
  RemoteInfo,
} from "./types";

class UnsupportedHostAdapter implements GitHostAdapter {
  constructor(readonly kind: GitHostKind) {}

  async createPullRequest(
    _remote: RemoteInfo,
    _input: CreatePullRequestInput
  ): Promise<CreatePullRequestResult> {
    throw new Error(
      `Pull/merge request creation for '${this.kind}' is not implemented yet. ` +
        `Add an adapter in ts/src/git/. Push succeeded; create the PR manually for now.`
    );
  }
}

export const GitLabAdapter = new UnsupportedHostAdapter("gitlab");
export const BitbucketAdapter = new UnsupportedHostAdapter("bitbucket");
export const AzureDevOpsAdapter = new UnsupportedHostAdapter("azuredevops");
export const SelfHostedAdapter = new UnsupportedHostAdapter("selfhosted");
