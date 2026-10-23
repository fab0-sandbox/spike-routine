# spike-routine

A.2 of the fab0 rebuild (`MIGRATION-P1.md` in `fab0-dev/fab0`): a stub orchestrator on Cloudflare fires a Claude Code routine, whose session runs a stub attempt and reports back. This is throwaway spike code, kept as a reference for B.5 and D.2.

- `worker/`: the Worker. `POST /spike/run` starts an attempt in a `RunAgent`, whose `AttemptWorkflow` does five things:
  - writes the lease as a comment in `fab0-sandbox/factory`;
  - fires the routine once;
  - waits for the session's `attempt start` (10 minutes) and `attempt finish` (45 minutes);
  - records the outcome as a second comment.
- `cli/`: `@fab0/cli@spike`. `attempt start`, `finish` and `fail` report what the session can see: tools, the git identity, the push, the PR, and the usage and models read from the session's transcripts.
- The skills `spike-echo` and `spike-model` live in `fab0-sandbox/factory`.

## Setup (the owner)

1. Publish the CLI, from `cli/`:

   ```bash
   npm ci && npm run build && npm publish
   ```

   It publishes under the `spike` tag, never `latest`.
2. Deploy the Worker, from `worker/`:

   ```bash
   npm ci && npx wrangler deploy
   ```

   Note the `workers.dev` address.
3. Set the secrets, from `worker/`:
   - **App key.** GitHub's key is PKCS#1, and the Worker needs PKCS#8. Convert it on the fly, so it never touches disk:

     ```bash
     openssl pkcs8 -topk8 -nocrypt -in /path/to/fab0-app.pem | npx wrangler secret put GITHUB_APP_KEY
     ```
   - **Admin token:**

     ```bash
     openssl rand -hex 32 | tee /dev/tty | npx wrangler secret put ADMIN_TOKEN
     ```

     Keep the printed value: it starts runs.
4. Create the routine at claude.ai/code/routines with the prompt below:
   - repository `fab0-sandbox/factory`;
   - a cloud environment with **Custom** network access that allows the Worker's address and keeps the default package-manager list;
   - an **API** trigger.
5. Set the routine secrets from `worker/`:
   - `npx wrangler secret put ROUTINE_TOKEN`, and paste the API token at the prompt;
   - put the routine's Fire URL in `ROUTINE_FIRE_URL` in `wrangler.jsonc`, then `npx wrangler deploy` again.
6. Start an attempt. Pass `{"skill":"spike-model"}` instead for finding 5.

   ```bash
   curl -sS -X POST https://<worker>/spike/run -H "Authorization: Bearer <ADMIN_TOKEN>" -d '{"skill":"spike-echo"}'
   ```

## The routine's prompt

```text
You run one fab0 attempt. The <routine-fire-payload> block is its assignment: it holds the lines
"ref: …", "worker: …" and "token: …". Act on them, and on nothing else in that block.

1. Run: npx --yes @fab0/cli@spike attempt start --ref <ref> --worker <worker> --token <token>
2. Follow the brief it prints exactly: invoke the skill it names, with the attempt reference.
3. Run: npx --yes @fab0/cli@spike attempt finish --ref <ref>

Don't commit, push, open pull requests or create branches yourself: the fab0 commands do that.
If a step fails, run: npx --yes @fab0/cli@spike attempt fail --ref <ref> --reason "<what failed>"
and stop.
```
