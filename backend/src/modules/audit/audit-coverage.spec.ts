
import {
  readFileSync,
  readdirSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

import {
  AuditAction,
} from './entities/audit-log.entity';

import {
  INTENTIONALLY_UNEMITTED_ACTIONS,
} from './intentionally-unemitted-actions';

/**
 * Structural gate:
 *
 * Every AuditAction enum member must either:
 *
 * 1. be emitted somewhere in src/
 *    via an AuditAction.<NAME> literal at a real call site
 *
 * OR
 *
 * 2. be registered in INTENTIONALLY_UNEMITTED_ACTIONS
 *    with a documented reason.
 *
 * This keeps the audit vocabulary honest.
 *
 * Phase K adds a stricter rule for security-relevant tenant/management events:
 * those actions MUST have real emission sites and may NOT be hidden in the
 * intentionally-unemitted registry.
 */

const SRC_DIR =
  join(
    __dirname,
    '..',
    '..',
  );

/**
 * Phase K events that are part of the required security/audit contract.
 *
 * These are deliberately stricter than ordinary AuditAction members:
 *
 * - they MUST be emitted somewhere in src/
 * - they MUST NOT appear in INTENTIONALLY_UNEMITTED_ACTIONS
 *
 * This prevents someone from adding a new tenant-security event to the enum
 * and then silencing the coverage failure by documenting it as "not yet
 * emitted".
 */
const REQUIRED_EMITTED_ACTIONS:
  readonly AuditAction[] = [
    AuditAction.TEAM_LEADER_CREATED,

    AuditAction.TEAM_LEADER_DELETED,

    AuditAction.AGENT_CREATED,

    AuditAction.AGENT_DELETED,

    AuditAction.AGENT_SESSION_ASSIGNED,

    AuditAction.AGENT_SESSION_UNASSIGNED,

    AuditAction.AGENT_SESSION_REASSIGNED,

    AuditAction.TENANT_ACCESS_DENIED,
  ];

function listTsFiles(
  dir:
    string,

  out:
    string[] = [],
): string[] {
  for (
    const ent of readdirSync(
      dir,
      {
        withFileTypes:
          true,
      },
    )
  ) {
    if (
      ent.name ===
      'node_modules'
    ) {
      continue;
    }

    const full =
      join(
        dir,
        ent.name,
      );

    if (
      ent.isDirectory()
    ) {
      listTsFiles(
        full,
        out,
      );
    } else if (
      ent.name.endsWith(
        '.ts',
      )
    ) {
      out.push(
        full,
      );
    }
  }

  return out;
}

/**
 * Exclude tests and the audit vocabulary declarations themselves.
 *
 * Otherwise merely mentioning AuditAction.X in a spec or enum declaration
 * would incorrectly count as a production emission site.
 */
const isExcluded = (
  file:
    string,
): boolean =>
  file.endsWith(
    '.spec.ts',
  ) ||
  file.endsWith(
    '.test.ts',
  ) ||
  file.endsWith(
    'audit-coverage.spec.ts',
  ) ||
  file.endsWith(
    'audit-log.entity.ts',
  ) ||
  file.endsWith(
    'intentionally-unemitted-actions.ts',
  );

const sourceBodies =
  listTsFiles(
    SRC_DIR,
  )
    .filter(
      file =>
        !isExcluded(
          file,
        ),
    )
    .map(
      file =>
        readFileSync(
          file,
          'utf8',
        ),
    );

const memberKeys =
  Object.keys(
    AuditAction,
  ) as (
    keyof typeof AuditAction
  )[];

const isEmitted = (
  key:
    | keyof typeof AuditAction
    | undefined,
): boolean =>
  key !== undefined &&
  sourceBodies.some(
    body =>
      body.includes(
        `AuditAction.${key}`,
      ),
  );

const memberKeyForValue = (
  value:
    string,
):
  | keyof typeof AuditAction
  | undefined =>
  memberKeys.find(
    key =>
      AuditAction[
        key
      ] ===
      (
        value as AuditAction
      ),
  );

describe(
  'audit action emit coverage',
  () => {
    it.each(
      memberKeys,
    )(
      'AuditAction.%s is emitted somewhere in src/ or registered as intentionally unemitted',
      key => {
        const registered =
          Boolean(
            INTENTIONALLY_UNEMITTED_ACTIONS[
              AuditAction[
                key
              ]
            ],
          );

        expect(
          isEmitted(
            key,
          ) ||
            registered,
        ).toBe(
          true,
        );
      },
    );

    it(
      'Phase K security actions are all emitted by production code',
      () => {
        const missing =
          REQUIRED_EMITTED_ACTIONS
            .map(
              action =>
                ({
                  action,

                  key:
                    memberKeyForValue(
                      action,
                    ),
                }),
            )
            .filter(
              ({
                key,
              }) =>
                !isEmitted(
                  key,
                ),
            )
            .map(
              ({
                action,
              }) =>
                action,
            );

        expect(
          missing,
        ).toEqual(
          [],
        );
      },
    );

    it(
      'Phase K security actions cannot be registered as intentionally unemitted',
      () => {
        const incorrectlyRegistered =
          REQUIRED_EMITTED_ACTIONS
            .filter(
              action =>
                Boolean(
                  INTENTIONALLY_UNEMITTED_ACTIONS[
                    action
                  ],
                ),
            );

        expect(
          incorrectlyRegistered,
        ).toEqual(
          [],
        );
      },
    );

    it(
      'intentionally-unemitted registry has no stale entries (none is actually emitted)',
      () => {
        const stale =
          Object.keys(
            INTENTIONALLY_UNEMITTED_ACTIONS,
          )
            .map(
              value =>
                memberKeyForValue(
                  value,
                ),
            )
            .filter(
              (
                key,
              ): key is keyof typeof AuditAction =>
                Boolean(
                  key,
                ) &&
                isEmitted(
                  key,
                ),
            );

        expect(
          stale,
        ).toEqual(
          [],
        );
      },
    );

    it(
      'intentionally-unemitted registry entries each carry a non-empty reason',
      () => {
        const empties =
          Object.entries(
            INTENTIONALLY_UNEMITTED_ACTIONS,
          )
            .filter(
              ([
                ,
                reason,
              ]) =>
                typeof reason !==
                  'string' ||
                reason
                  .trim()
                  .length ===
                  0,
            )
            .map(
              ([
                value,
              ]) =>
                value,
            );

        expect(
          empties,
        ).toEqual(
          [],
        );
      },
    );
  },
);


