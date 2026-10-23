// A.2 spike: a stub orchestrator. POST /spike/run starts one attempt; the routine session reports through
// POST /attempts/:ref/{start,finish}. Nothing here is product code: it answers MIGRATION-P1's A.2 findings.

import { Agent, getAgentByName } from "agents";
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { GitHub } from "./github";

// Secrets, set with `wrangler secret put`; `wrangler types` only sees the vars.
declare global {
  interface __BaseEnv_Env {
    GITHUB_APP_KEY: string;
    ROUTINE_TOKEN: string;
    ADMIN_TOKEN: string;
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type EventBody = { body: string };
type AttemptParams = { ref: string; run: number; step: string; skill: string; token: string; worker: string };
type AttemptRow = { ref: string; workflow_id: string; token_hash: string; skill: string; status: string; result: string | null };

const BRANCH = (run: number, step: string) => `fab0/${run}/${step}`;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// In-flight attempts live in the Agent's SQL. In the product this is only a cache of the attempt comments (D134).
export class RunAgent extends Agent<Env> {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS attempts (
      ref TEXT PRIMARY KEY, workflow_id TEXT, token_hash TEXT, skill TEXT, status TEXT, result TEXT)`;
  }

  async startAttempt(run: number, step: string, skill: string, worker: string) {
    const ref = `r${run}-${step}-${Date.now().toString(36)}`;
    const token = randomToken();
    const params: AttemptParams = { ref, run, step, skill, token, worker };
    const tokenHash = await sha256(token);
    const workflowId = await this.runWorkflow("ATTEMPT_WORKFLOW", params, { id: ref });
    this.sql`INSERT INTO attempts (ref, workflow_id, token_hash, skill, status)
      VALUES (${ref}, ${workflowId}, ${tokenHash}, ${skill}, 'launched')`;
    return { ref, workflowId };
  }

  // A session's `attempt start` or `attempt finish`: check the attempt token, then wake the workflow.
  async attemptEvent(ref: string, token: string, kind: "started" | "finished", payload: Json) {
    const [attempt] = this.sql<AttemptRow>`SELECT * FROM attempts WHERE ref = ${ref}`;
    if (!attempt || attempt.token_hash !== (await sha256(token))) return { ok: false as const, status: 403 };
    if (["finished", "recorded", "lost"].includes(attempt.status)) return { ok: false as const, status: 409 };
    await this.sendWorkflowEvent("ATTEMPT_WORKFLOW", attempt.workflow_id, {
      type: kind,
      payload: { body: JSON.stringify(payload) },
    });
    this.sql`UPDATE attempts SET status = ${kind} WHERE ref = ${ref}`;
    const [, run, step] = ref.match(/^r(\d+)-([^-]+)-/) ?? [];
    return { ok: true as const, brief: { skill: attempt.skill, branch: BRANCH(Number(run), step) } };
  }

  attemptStatus(ref: string) {
    const [attempt] = this.sql<AttemptRow>`SELECT ref, workflow_id, skill, status, result FROM attempts WHERE ref = ${ref}`;
    return attempt ?? null;
  }

  async onWorkflowComplete(_name: string, workflowId: string, result?: unknown) {
    this.sql`UPDATE attempts SET status = 'recorded', result = ${JSON.stringify(result ?? null)}
      WHERE workflow_id = ${workflowId}`;
  }

  async onWorkflowError(_name: string, workflowId: string, error: string) {
    this.sql`UPDATE attempts SET status = 'lost', result = ${JSON.stringify({ error })} WHERE workflow_id = ${workflowId}`;
  }
}

export class AttemptWorkflow extends AgentWorkflow<RunAgent, AttemptParams> {
  async run(event: AgentWorkflowEvent<AttemptParams>, step: AgentWorkflowStep) {
    const { ref, run, step: stepName, skill, token, worker } = event.payload;
    const repo = this.env.LEASE_REPO;

    // 1. The lease, as a comment on the run's root item (D134), before anything is fired.
    const lease = await step.do("prepare", async () => {
      const gh = await GitHub.asInstallation(this.env);
      const issue = await gh.runIssue(repo, run);
      const leasedAt = new Date().toISOString();
      const url = await gh.comment(
        repo,
        issue,
        [
          `Attempt \`${ref}\` leased: step \`${stepName}\`, revision 1, skill \`${skill}\`.`,
          "",
          "```yaml",
          `fab0: {attempt: ${ref}, run: ${run}, step: ${stepName}, revision: 1, state: leased, at: ${leasedAt}}`,
          "```",
        ].join("\n"),
      );
      return { issue, leasedAt, url };
    });

    // 2. One fire, never retried blind: /fire has no idempotency key.
    const fire = await step.do("fire", { retries: { limit: 0, delay: "1 second" } }, async () => {
      const text = [
        "fab0 attempt",
        `ref: ${ref}`,
        `worker: ${worker}`,
        `token: ${token}`,
      ].join("\n");
      const res = await fetch(this.env.ROUTINE_FIRE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.ROUTINE_TOKEN}`,
          "anthropic-beta": "experimental-cc-routine-2026-04-01",
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      const body = await res.text();
      return {
        status: res.status,
        retryAfter: res.headers.get("retry-after"),
        firedAt: new Date().toISOString(),
        body: body.slice(0, 2000),
      };
    });
    if (fire.status !== 200) {
      await this.record(step, ref, repo, lease.issue, { outcome: "launch refused", fire });
      return;
    }

    // 3. and 4. The session's `attempt start`, then its `attempt finish`.
    // Event payloads travel as a JSON string, so the workflow's types stay flat.
    let started: unknown;
    try {
      started = JSON.parse(
        (await step.waitForEvent<EventBody>("started", { type: "started", timeout: "10 minutes" })).payload.body,
      );
    } catch {
      await this.record(step, ref, repo, lease.issue, { outcome: "never started", fire });
      return;
    }
    let finished: unknown;
    try {
      finished = JSON.parse(
        (await step.waitForEvent<EventBody>("finished", { type: "finished", timeout: "45 minutes" })).payload.body,
      );
    } catch {
      await this.record(step, ref, repo, lease.issue, { outcome: "timed out", fire, started });
      return;
    }

    // 5. The outcome, as the attempt's comment.
    await this.record(step, ref, repo, lease.issue, { outcome: "finished", lease, fire, started, finished });
  }

  private async record(step: AgentWorkflowStep, ref: string, repo: string, issue: number, outcome: unknown) {
    const result = await step.do("record", async () => {
      const gh = await GitHub.asInstallation(this.env);
      const recordedAt = new Date().toISOString();
      const url = await gh.comment(
        repo,
        issue,
        [
          `Attempt \`${ref}\` recorded at ${recordedAt}.`,
          "",
          "```json",
          JSON.stringify(outcome, null, 2).slice(0, 60000),
          "```",
        ].join("\n"),
      );
      return { recordedAt, url };
    });
    await step.reportComplete({ ...result, outcome: (outcome as { outcome: string }).outcome });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function bearer(request: Request): string {
  return (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
}

const agentName = (run: number) => `fab0-sandbox-factory-${run}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/spike/run") {
      if (!env.ADMIN_TOKEN || bearer(request) !== env.ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
      if (!env.ROUTINE_FIRE_URL) return json({ error: "ROUTINE_FIRE_URL is not set" }, 500);
      const { run = 1, step = "spike", skill = "spike-echo" } = (await request.json().catch(() => ({}))) as {
        run?: number;
        step?: string;
        skill?: string;
      };
      const agent = await getAgentByName(env.RUN_AGENT, agentName(run));
      return json(await agent.startAttempt(run, step, skill, url.origin));
    }

    const attempt = url.pathname.match(/^\/attempts\/(r(\d+)-[\w-]+)(?:\/(start|finish))?$/);
    if (attempt) {
      const [, ref, run, action] = attempt;
      const agent = await getAgentByName(env.RUN_AGENT, agentName(Number(run)));
      if (request.method === "GET" && !action) {
        if (bearer(request) !== env.ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
        return json(await agent.attemptStatus(ref));
      }
      if (request.method === "POST" && action) {
        const payload = (await request.json().catch(() => ({}))) as Json;
        const kind = action === "start" ? "started" : "finished";
        const res = await agent.attemptEvent(ref, bearer(request), kind, payload);
        return res.ok ? json(res) : json({ error: "refused" }, res.status);
      }
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
