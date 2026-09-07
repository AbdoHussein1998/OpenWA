


/**
 * Post-install hook (npm `postinstall`).
 *
 * Nine conditional steps, each skipped when its own script/target is absent so the hook remains a
 * no-op for pieces that are not part of a particular installation:
 *
 *   1. `npm ci` inside dashboard/ when dashboard/ exists. Failure is fatal.
 *   2. `node scripts/patch-wwebjs-201832.js --best-effort` when present.
 *   3. `node scripts/patch-wwebjs-newsletter-preview.js --best-effort` when present.
 *   4. `node scripts/patch-wwebjs-status.js --best-effort` when present.
 *   5. `node scripts/patch-wwebjs-ready-sync.js --best-effort` when present.
 *      For this critical readiness repair, --best-effort permits ONLY an absent whatsapp-web.js
 *      target; an installed unsupported or half-patched Client.js exits non-zero and this hook
 *      propagates that failure.
 *   6. `node scripts/patch-wwebjs-participant-arity.js --best-effort` when present.
 *   7. `node scripts/patch-wwebjs-block.js --best-effort` when present.
 *   8. `node scripts/patch-baileys-appstate.js --best-effort` when present.
 *   9. `node scripts/patch-baileys-newsletter-create.js --best-effort` when present.
 *
 * Every spawned step is checked. A non-zero exit, spawn error, or terminating signal stops the
 * sequence and makes the root install fail instead of silently shipping an incomplete dependency
 * repair.
 *
 * Structured as pure planning + injectable spawn so scripts/postinstall.spec.js can exercise every
 * branch without running a real npm install.
 */
'use strict';

const fs =
  require('fs');

const path =
  require('path');

const {
  spawnSync,
} =
  require('child_process');

const ROOT =
  path.join(
    __dirname,
    '..',
  );

/**
 * Sanitize an environment object for child invocations.
 *
 * npm 11 rejects `--allow-scripts` in project-scoped installs (`npm ci`, `npm install`) when it
 * originates from the environment (`npm_config_allow_scripts`) rather than `.npmrc` or
 * `package.json`.
 *
 * Strip that inherited environment variable for nested npm executions while preserving the rest of
 * the caller's environment.
 */
function sanitizeEnv(
  env = process.env,
) {
  const clean = {
    ...env,
  };

  for (
    const key
    of Object.keys(
      clean,
    )
  ) {
    if (
      /^npm_config_allow[_-]scripts$/i.test(
        key,
      )
    ) {
      delete clean[
        key
      ];
    }
  }

  return clean;
}

/**
 * Build one conditional patch-script execution.
 *
 * Returns null when the patcher does not exist in this checkout.
 */
function patchStep(
  root,
  cleanEnv,
  filename,
  label,
) {
  const patcher =
    path.join(
      root,
      'scripts',
      filename,
    );

  if (
    !fs.existsSync(
      patcher,
    )
  ) {
    return null;
  }

  return {
    name:
      `${label} (scripts/${filename} --best-effort)`,

    command:
      process.execPath,

    args: [
      patcher,
      '--best-effort',
    ],

    options: {
      stdio:
        'inherit',

      cwd:
        root,

      env:
        cleanEnv,
    },
  };
}

/**
 * The steps to run for a given repo root, in order.
 */
function planSteps(
  root,
  env = process.env,
) {
  const cleanEnv =
    sanitizeEnv(
      env,
    );

  const steps =
    [];

  /*
   * The dashboard has its own package-lock.json.
   *
   * If the directory exists, its dependency install is mandatory: a failed nested npm ci must abort
   * the root install rather than surfacing later as a dashboard build/runtime failure.
   */
  if (
    fs.existsSync(
      path.join(
        root,
        'dashboard',
      ),
    )
  ) {
    steps.push({
      name:
        'dashboard dependencies (npm ci)',

      command:
        'npm ci',

      options: {
        stdio:
          'inherit',

        shell:
          true,

        cwd:
          path.join(
            root,
            'dashboard',
          ),

        env:
          cleanEnv,
      },
    });
  }

  const patchers = [
    [
      'patch-wwebjs-201832.js',
      'whatsapp-web.js backport',
    ],
    [
      'patch-wwebjs-newsletter-preview.js',
      'whatsapp-web.js newsletter preview backport',
    ],
    [
      'patch-wwebjs-status.js',
      'whatsapp-web.js status send repair',
    ],
    [
      'patch-wwebjs-ready-sync.js',
      'whatsapp-web.js ready-sync repair',
    ],
    [
      'patch-wwebjs-participant-arity.js',
      'whatsapp-web.js participant batch truth',
    ],
    [
      'patch-wwebjs-block.js',
      'whatsapp-web.js block/unblock LID repair',
    ],
    [
      'patch-baileys-appstate.js',
      'Baileys app-state resync bound',
    ],
    [
      'patch-baileys-newsletter-create.js',
      'Baileys newsletter-create parse fix',
    ],
  ];

  for (
    const [
      filename,
      label,
    ]
    of patchers
  ) {
    const step =
      patchStep(
        root,
        cleanEnv,
        filename,
        label,
      );

    if (
      step
    ) {
      steps.push(
        step,
      );
    }
  }

  return steps;
}

/**
 * Human-readable failure cause from a spawnSync result.
 */
function failureReason(
  res,
) {
  if (
    res &&
    res.error
  ) {
    return `failed to start — ${res.error.message}`;
  }

  if (
    res &&
    typeof res.status ===
      'number' &&
    res.status !==
      0
  ) {
    return `exit code ${res.status}`;
  }

  if (
    res &&
    res.signal
  ) {
    return `killed by ${res.signal}`;
  }

  return null;
}

/**
 * Run the planned steps, stopping at the first failure.
 *
 * Returns:
 *   0 = every planned step succeeded, or there were no applicable steps
 *   1 = a child command failed, could not start, threw, or was killed
 */
function run(
  root = ROOT,
  spawn = spawnSync,
  env = process.env,
) {
  const steps =
    planSteps(
      root,
      env,
    );

  if (
    !steps.length
  ) {
    console.log(
      'postinstall: no dashboard/ or patch script present — nothing to do.',
    );

    return 0;
  }

  for (
    const step
    of steps
  ) {
    let res;

    /*
     * spawnSync normally reports startup errors through result.error rather than throwing, but the
     * injected test seam may throw and a future wrapper could as well. Treat both forms identically.
     */
    try {
      res =
        spawn(
          step.command,
          step.args,
          step.options,
        );
    } catch (
      error
    ) {
      console.error(
        `postinstall: ${step.name} failed ` +
          `(spawn threw — ${
            error instanceof Error
              ? error.message
              : String(error)
          }). ` +
          'The install is INCOMPLETE — fix the error above and re-run `npm install`.',
      );

      return 1;
    }

    const reason =
      failureReason(
        res ?? {},
      );

    if (
      reason
    ) {
      console.error(
        `postinstall: ${step.name} failed (${reason}). ` +
          'The install is INCOMPLETE — fix the error above and re-run `npm install`.',
      );

      return 1;
    }
  }

  return 0;
}

if (
  require.main ===
  module
) {
  process.exitCode =
    run();
}

module.exports = {
  sanitizeEnv,
  patchStep,
  planSteps,
  failureReason,
  run,
  ROOT,
};

