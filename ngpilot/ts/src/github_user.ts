import { spawnSync } from "child_process";
import { loadUserConfig, saveUserConfig } from "./user_config";

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function ghLogin(): string | undefined {
  try {
    const result = spawnSync("gh", ["api", "user", "-q", ".login"], {
      encoding: "utf8",
      shell: true,
      windowsHide: true,
    });
    if (result.status === 0) {
      return firstNonEmpty(result.stdout);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function gitUserName(): string | undefined {
  try {
    const result = spawnSync("git", ["config", "user.name"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) {
      return firstNonEmpty(result.stdout);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Resolve GitHub username.
 * Priority: env NGPILOT_GITHUB_USER / GITHUB_USER → saved config → gh api →
 * (optional interactive callback) → git config user.name → empty string.
 *
 * Env overrides saved config without rewriting it.
 * When interactive callback returns a value, it is persisted.
 */
export async function resolveGithubUserName(options?: {
  prompt?: () => Promise<string | undefined>;
}): Promise<string> {
  const env = firstNonEmpty(
    process.env.NGPILOT_GITHUB_USER,
    process.env.GITHUB_USER
  );
  if (env) {
    return env;
  }

  const saved = firstNonEmpty(loadUserConfig().githubUserName);
  if (saved) {
    return saved;
  }

  const fromGh = ghLogin();
  if (fromGh) {
    saveUserConfig({ githubUserName: fromGh });
    return fromGh;
  }

  if (options?.prompt) {
    const prompted = firstNonEmpty(await options.prompt());
    if (prompted) {
      saveUserConfig({ githubUserName: prompted });
      return prompted;
    }
  }

  return gitUserName() || "";
}
