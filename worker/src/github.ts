// Writes to GitHub as the fab0 App: a JWT signed with the App's key, exchanged for an installation token.

const API = "https://api.github.com";

function b64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function appJwt(appId: string, pkcs8Pem: string): Promise<string> {
  if (!pkcs8Pem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("GITHUB_APP_KEY must be PKCS#8: convert it with `openssl pkcs8 -topk8 -nocrypt`");
  }
  const der = Uint8Array.from(atob(pkcs8Pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

export class GitHub {
  private constructor(private token: string) {}

  static async asInstallation(env: Env): Promise<GitHub> {
    const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_KEY);
    const res = await fetch(`${API}/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
      method: "POST",
      headers: headers(jwt),
    });
    if (!res.ok) throw new Error(`installation token: ${res.status} ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    return new GitHub(token);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: headers(this.token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // The run's root issue: one per run, found by title so a retried step creates nothing new.
  async runIssue(repo: string, run: number): Promise<number> {
    const title = `Spike run ${run}`;
    const open = await this.call<{ number: number; title: string; pull_request?: unknown }[]>(
      "GET",
      `/repos/${repo}/issues?state=open&per_page=100`,
    );
    const found = open.find((i) => i.title === title && !i.pull_request);
    if (found) return found.number;
    const made = await this.call<{ number: number }>("POST", `/repos/${repo}/issues`, {
      title,
      body: "Root item of an A.2 spike run. Its comments hold the attempt's lease and outcome.",
    });
    return made.number;
  }

  async comment(repo: string, issue: number, body: string): Promise<string> {
    const made = await this.call<{ html_url: string }>("POST", `/repos/${repo}/issues/${issue}/comments`, {
      body,
    });
    return made.html_url;
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fab0-spike-routine",
  };
}
