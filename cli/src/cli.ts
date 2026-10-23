// A.2 spike: the stub `fab0 attempt` protocol a routine session runs. It reports what it can see, so the
// Findings of MIGRATION-P1 can be answered: push, PR, identity, usage and models. No secret is ever printed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type Saved = { ref: string; worker: string; token: string; skill: string; branch: string; startedAt: string };

const VERSION = "0.0.0-spike.2";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function need(args: string[], name: string): string {
  const v = arg(args, name);
  if (!v) fail(`missing --${name}`);
  return v!;
}

function fail(message: string): never {
  process.stderr.write(`fab0: ${message}\n`);
  process.exit(2);
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim().slice(-2000) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(-2000) || err.message };
  }
}

const has = (cmd: string) => run("sh", ["-c", `command -v ${cmd}`]).ok;
const savedPath = (ref: string) => join(tmpdir(), `fab0-attempt-${ref}.json`);

async function post(worker: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${worker}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

// What the session can see, without values: names of variables, tools on PATH, the remote without credentials.
function probe() {
  const names = Object.keys(process.env)
    .filter((k) => /CLAUDE|ANTHROPIC|GITHUB|GH_|GIT_|OTEL/i.test(k))
    .sort();
  const remote = run("git", ["remote", "get-url", "origin"]).out.replace(/\/\/[^@/]+@/, "//<credentials>@");
  return {
    cli: VERSION,
    node: process.version,
    envNames: names,
    tools: Object.fromEntries(["git", "gh", "claude", "curl"].map((t) => [t, has(t)])),
    remote,
    gitUser: run("git", ["config", "user.name"]).out,
    gitEmail: run("git", ["config", "user.email"]).out,
    ghAuth: has("gh") ? run("gh", ["auth", "status"]).out.replace(/(token:\s*)\S+/gi, "$1<hidden>") : null,
  };
}

// Usage from the session's own transcripts: every assistant message carries its model and token counts.
function usageSince(startedAt: string) {
  const root = join(homedir(), ".claude", "projects");
  const since = Date.parse(startedAt) - 60_000;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  const models = new Set<string>();
  const files: string[] = [];
  const costs: number[] = [];
  if (!existsSync(root)) return { found: false, root };
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(d, f);
      if (statSync(p).mtimeMs < since) continue;
      files.push(`${dir}/${f}`);
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof entry.costUSD === "number") costs.push(entry.costUSD);
        const m = entry.message;
        if (entry.type !== "assistant" || !m?.usage) continue;
        if (entry.timestamp && Date.parse(entry.timestamp) < since) continue;
        if (m.model) models.add(m.model);
        totals.messages++;
        totals.input += m.usage.input_tokens ?? 0;
        totals.output += m.usage.output_tokens ?? 0;
        totals.cacheRead += m.usage.cache_read_input_tokens ?? 0;
        totals.cacheWrite += m.usage.cache_creation_input_tokens ?? 0;
      }
    }
  }
  return {
    found: true,
    files,
    models: [...models],
    tokens: totals,
    costUSD: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

async function start(args: string[]) {
  const ref = need(args, "ref");
  const worker = need(args, "worker").replace(/\/$/, "");
  const token = need(args, "token");
  const startedAt = new Date().toISOString();
  const res = await post(worker, `/attempts/${ref}/start`, token, { startedAt, probe: probe() });
  const { skill, branch } = res.brief as { skill: string; branch: string };
  const sw = run("git", ["switch", "-C", branch]);
  if (!sw.ok) fail(`git switch ${branch}: ${sw.out}`);
  const saved: Saved = { ref, worker, token, skill, branch, startedAt };
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(savedPath(ref), JSON.stringify(saved));
  process.stdout.write(
    [
      `fab0 attempt ${ref} started on branch ${branch}.`,
      "",
      `Invoke the skill \`${skill}\` now, with the attempt reference \`${ref}\`. Do only what it says.`,
      `Then run: npx --yes @fab0/cli@spike attempt finish --ref ${ref}`,
      `If something fails, run: npx --yes @fab0/cli@spike attempt fail --ref ${ref} --reason "<what failed>"`,
      "",
    ].join("\n"),
  );
}

function openPr(saved: Saved) {
  const title = `Spike attempt ${saved.ref}`;
  const body = `Draft PR opened by \`fab0 attempt finish\` for attempt \`${saved.ref}\` (A.2 spike).`;
  const tried: { method: string; ok: boolean; out: string }[] = [];
  if (has("gh")) {
    const r = run("gh", ["pr", "create", "--draft", "--base", "main", "--head", saved.branch, "--title", title, "--body", body]);
    tried.push({ method: "gh pr create", ...r });
    if (r.ok) return { url: r.out.split("\n").pop(), tried };
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = run("git", ["remote", "get-url", "origin"]).out.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  // REST through `gh api`, which sessions allow where `gh pr create` (GraphQL) is refused.
  if (has("gh") && repo) {
    const r = run("gh", [
      "api", "-X", "POST", `repos/${repo}/pulls`,
      "-f", `title=${title}`, "-f", `body=${body}`, "-f", `head=${saved.branch}`, "-f", "base=main", "-F", "draft=true",
      "--jq", ".html_url",
    ]);
    tried.push({ method: "gh api POST pulls", ...r });
    if (r.ok && r.out.includes("/pull/")) return { url: r.out, tried };
  }
  if (token && repo) {
    const r = run("curl", [
      "-sS", "-X", "POST", `https://api.github.com/repos/${repo}/pulls`,
      "-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/vnd.github+json",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ title, body, head: saved.branch, base: "main", draft: true }),
    ]);
    const url = r.out.match(/"html_url":\s*"([^"]+\/pull\/\d+)"/)?.[1];
    tried.push({ method: "REST with GH_TOKEN/GITHUB_TOKEN", ok: Boolean(url), out: r.out.slice(0, 500) });
    if (url) return { url, tried };
  } else {
    tried.push({ method: "REST", ok: false, out: token ? "no github.com remote" : "no GH_TOKEN or GITHUB_TOKEN" });
  }
  return { url: null, tried };
}

async function finish(args: string[], failed?: string) {
  const ref = need(args, "ref");
  if (!existsSync(savedPath(ref))) fail(`no started attempt ${ref} on this machine`);
  const saved = JSON.parse(readFileSync(savedPath(ref), "utf8")) as Saved;
  const finishedAt = new Date().toISOString();
  let push = null;
  let pr = null;
  let commit = null;
  if (!failed) {
    run("git", ["add", "-A"]);
    const c = run("git", ["commit", "-m", `Spike attempt ${ref}`]);
    commit = { ok: c.ok, out: c.out.slice(0, 300), author: run("git", ["log", "-1", "--format=%an <%ae>"]).out };
    push = run("git", ["push", "-u", "origin", `HEAD:refs/heads/${saved.branch}`]);
    pr = push.ok ? openPr(saved) : null;
  }
  const report = {
    outcome: failed ? "failed" : "finished",
    reason: failed ?? null,
    startedAt: saved.startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(saved.startedAt),
    commit,
    push,
    pr,
    usage: usageSince(saved.startedAt),
  };
  await post(saved.worker, `/attempts/${ref}/finish`, saved.token, report);
  process.stdout.write(`fab0 attempt ${ref} ${report.outcome}.${pr?.url ? ` PR: ${pr.url}` : ""}\n`);
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (cmd === "--version") return void process.stdout.write(`${VERSION}\n`);
  if (cmd !== "attempt") fail("usage: fab0 attempt start|finish|fail --ref <ref> [...]");
  if (sub === "start") return start(rest);
  if (sub === "finish") return finish(rest);
  if (sub === "fail") return finish(rest, arg(rest, "reason") ?? "no reason given");
  fail(`unknown command: attempt ${sub ?? ""}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
