// Bootstrapping the trial: this process is the entrypoint the harness starts, and its whole job is
// The conversation with the environment runs in five moves:
//   1. Read MAKEFUN_ENV_URL. It points at the environment's origin (inside a trial container that
//      is something like http://store:8080). With no URL there is nobody to talk to, so bail out
//      with exit code 1 right away.
//   2. Build the forge server and let it listen on port 0, so the operating system hands it a free
//      port. Port 8080 belongs to the environment itself; never try to claim it.
//   3. Tell the environment which port was chosen: POST {"port": N} to $MAKEFUN_ENV_URL/register.
//      The environment pairs the port with the address the request arrived from and uses that as the
//      base URL for the rest of the trial. Only the first registration counts — a 409 answer means
//      someone else already registered, and this process simply carries on waiting.
//   4. Ask GET $MAKEFUN_ENV_URL/done over and over until the answer is {"done": true}. The
//      environment replies immediately every time ({"done": false} while the suite is still
//      running), so polling is the right shape here, not a long-lived request. A poll that errors
//      or times out is retried after a short wait that grows exponentially; the process never
//      gives up and never exits early.
//   5. Shut the server down and exit 0. The harness then stops the environment, which writes the
//      export the scorer reads. Only the server built by app.ts is imported here — no
// third-party packages, no Node built-ins beyond what the runtime already provides, and no
// model calls.

import { createApp } from './app.ts';

/** The environment's origin, without trailing slashes. Exits 1 when the variable is unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  return trimmed;
}

const ENV_URL = envOrigin();

/** Longest time a single register or done request is allowed to run before it is dropped. */
const HTTP_TIMEOUT_MS = 30_000;
/** First pause between attempts, and the ceiling the pause grows to. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

/** Resolve after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Pause after `failures` consecutive failures: doubling from BACKOFF_FIRST_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

// One registration attempt. True when the environment accepted this process: a 200, or a 409
// meaning the first registration already happened. A 400 or 405 is a contract violation and
// raises; any other status just means "not yet", reported as false.
async function attemptRegister(port: number): Promise<boolean> {
  const reply = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (reply.status === 200 || reply.status === 409) return true;
  if (reply.status === 400 || reply.status === 405) {
    throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
  }
  return false;
}

// A registration failure is fatal only when it carries the contract-error marker: anything else
// is a transient failure worth retrying.
function isFatalRegisterError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('register answered HTTP ');
}

// Keep registering until the environment accepts. Network failures and unexpected statuses are
// retried — the environment may still be coming up. A contract error (400/405) is fatal.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    const accepted = await attemptRegister(port).catch((err: unknown) => {
      if (isFatalRegisterError(err)) throw err;
      return false;
    });
    if (accepted) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** One poll of GET /done: true only when the environment answers {"done": true}. */
async function pollDoneOnce(): Promise<boolean> {
  const reply = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!reply.ok) return false;
  const payload = (await reply.json()) as { done?: unknown };
  return payload.done === true;
}

// Poll /done until the trial is over. A failed poll just means "not done yet".
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    // An unreachable environment, a timed-out poll, or a misparsed body all mean "not done".
    const done = await pollDoneOnce().catch(() => false);
    if (done) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Bind the server to a free port chosen by the kernel and report that port. A bind error, or an
// address that is not a TCP port, rejects.
function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  const waitForBind = (
    resolve: (value: number | PromiseLike<number>) => void,
    reject: (reason?: unknown) => void,
  ): void => {
    server.once('error', (cause: Error) => reject(cause));
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  };
  return new Promise<number>(waitForBind);
}

// The whole life of the process: bind, register, wait for done, shut down.
async function runTrial(): Promise<void> {
  const forge = createApp();
  const port = await bindEphemeral(forge);
  process.stdout.write(`[entry] forge server listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered with the env; waiting for the trial to finish\n');

  await waitUntilDone();
  forge.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

runTrial()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
