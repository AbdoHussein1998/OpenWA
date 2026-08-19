// e2e boot environment. Set BEFORE AppModule is imported (setupFiles phase) so the
// app boots against local SQLite with no Redis/queue and no production boot guard.
//
// These suites run ONE AT A TIME (`maxWorkers: 1` in jest-e2e.json). That began as a fix for
// parallel workers fighting over one plugin registry, and the measurement below records it. Serial
// execution did not close the whole hole: the registry was shared SEQUENTIALLY too. Each suite
// boots a real application, and closing it disables every enabled plugin, which writes
// `status: disabled` into the registry the NEXT suite then boots against. Measured directly:
// set the whatsapp-web.js engine to `enabled`, run one AppModule-booting suite, and it comes back
// `disabled`. The same write landed in the DEVELOPER's `./data/plugins/registry.json`.
// PLUGIN_STATE_DIR below redirects it, the way the databases and the key file are redirected.
// Measured on one parallel run: 52 writes from 12 processes, 30 of them landing within 500ms of a
// write by a different process. Each individual write is atomic, but the read-modify-write cycle
// is not, so workers overwrote and re-read each other's plugin state.
//
// The result was a roughly one-in-ten failure that moved between suites — a 403 where a 200 was
// expected, a 404 where a 403 was, a rate-limit window behaving oddly — and never reproduced when a
// suite was run on its own, which is what made it read as flakiness. Serially it does not happen:
// 11 consecutive clean runs against a measured failure rate of about one in twelve in parallel.
//
// Restoring parallelism means giving each worker its own data root, not just its own database.
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

process.env.NODE_ENV = 'test';
// The plugin registry + per-plugin storage: the last state a suite could not isolate.
const e2ePluginState = join(tmpdir(), `openwa-e2e-plugins-${process.pid}`);
rmSync(e2ePluginState, { force: true, recursive: true });
process.env.PLUGIN_STATE_DIR = e2ePluginState;
process.env.DATABASE_TYPE = 'sqlite';
// Isolate the e2e data DB to a throwaway temp file so suites never pollute the developer's
// ./data/openwa.sqlite. e2e creates sessions/webhooks and doesn't self-clean, so without this they
// pile up across runs. Start each run from a fresh file.
const e2eDataDb = join(tmpdir(), `openwa-e2e-${process.pid}.sqlite`);
rmSync(e2eDataDb, { force: true });
process.env.DATABASE_NAME = e2eDataDb;
// Likewise isolate the auth/audit (main) DB, so e2e api-keys don't accumulate in ./data/main.sqlite.
const e2eMainDb = join(tmpdir(), `openwa-e2e-main-${process.pid}.sqlite`);
rmSync(e2eMainDb, { force: true });
process.env.MAIN_DATABASE_NAME = e2eMainDb;
// The bootstrap key file is written on first boot (no keys yet — which every e2e run is) and unlinked
// when that key is revoked or deleted. Without a lever it resolves under the repo root, so an e2e run
// rewrote the DEVELOPER'S ./data/.api-key. Point it at the same throwaway temp dir as the databases.
const e2eKeyFile = join(tmpdir(), `openwa-e2e-key-${process.pid}`);
rmSync(e2eKeyFile, { force: true });
process.env.BOOTSTRAP_KEY_FILE = e2eKeyFile;
process.env.QUEUE_ENABLED = 'false';
// Likewise force Redis off per suite: queue-on.e2e-spec.ts flips REDIS_ENABLED=true at module
// load and can't restore it when it self-skips, so without this reset later suites in the same
// jest worker would boot with Redis-backed throttling/cache.
process.env.REDIS_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
// Keep the auth/audit + data schema zero-config for the test boot.
process.env.MAIN_DATABASE_SYNCHRONIZE = 'true';
process.env.DATABASE_SYNCHRONIZE = 'true';
// e2e suites burst many requests at the API; relax the per-second rate limit so the
// ThrottlerGuard (still wired) doesn't 429 a normal test run.
process.env.RATE_LIMIT_SHORT_LIMIT = '100000';
process.env.RATE_LIMIT_MEDIUM_LIMIT = '100000';
process.env.RATE_LIMIT_LONG_LIMIT = '100000';
