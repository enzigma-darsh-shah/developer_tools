import { RemoteInfo, GitHostKind } from "./types";

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}

export function parseRemoteUrl(remoteUrl: string): RemoteInfo | null {
  const url = remoteUrl.trim();
  if (!url) {
    return null;
  }

  // git@github.com:owner/repo.git
  let m = /^git@([^:]+):([^/]+)\/(.+?)$/i.exec(url);
  if (m) {
    return fromHost(m[1], m[2], stripGitSuffix(m[3]), url);
  }

  // ssh://git@github.com/owner/repo.git
  m = /^ssh:\/\/(?:git@)?([^/]+)\/([^/]+)\/(.+?)$/i.exec(url);
  if (m) {
    return fromHost(m[1], m[2], stripGitSuffix(m[3]), url);
  }

  // https://github.com/owner/repo.git
  m = /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)$/i.exec(url);
  if (m) {
    return fromHost(m[1], m[2], stripGitSuffix(m[3]), url);
  }

  return null;
}

function fromHost(
  host: string,
  owner: string,
  repo: string,
  remoteUrl: string
): RemoteInfo {
  const h = host.toLowerCase();
  let kind: GitHostKind = "unknown";
  let apiBaseUrl = `https://${host}`;
  let webBaseUrl = `https://${host}`;

  if (h === "github.com" || h.endsWith(".github.com")) {
    kind = "github";
    apiBaseUrl = "https://api.github.com";
    webBaseUrl = "https://github.com";
  } else if (h === "gitlab.com" || h.includes("gitlab")) {
    kind = "gitlab";
    apiBaseUrl = `https://${host}/api/v4`;
    webBaseUrl = `https://${host}`;
  } else if (h === "bitbucket.org" || h.includes("bitbucket")) {
    kind = "bitbucket";
    apiBaseUrl = "https://api.bitbucket.org/2.0";
    webBaseUrl = "https://bitbucket.org";
  } else if (h.includes("dev.azure.com") || h.includes("visualstudio.com")) {
    kind = "azuredevops";
    apiBaseUrl = `https://${host}`;
    webBaseUrl = `https://${host}`;
  } else {
    // Unknown / self-hosted — treat as selfhosted placeholder.
    kind = "selfhosted";
    apiBaseUrl = `https://${host}`;
    webBaseUrl = `https://${host}`;
  }

  return { kind, owner, repo, apiBaseUrl, webBaseUrl, remoteUrl };
}
