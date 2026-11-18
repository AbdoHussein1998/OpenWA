import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { DeleteQueryBuilder, QueryDeepPartialEntity, Repository, UpdateQueryBuilder } from 'typeorm';
import { ApiKeyRole } from '../auth.levels.constants';
import { ApiKey } from '../entities/api-key.entity';
import { hashCredential } from './api-key-material';
import { assertApiKeyManager } from './api-key-management-authorization';

/**
 * Protects the "last usable admin" and tracks the "primary admin key".
 */
@Injectable()
export class ApiKeyAdminSafetyService {
  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  // ---------------------------------------------------------------------------
  // Primary admin key
  // ---------------------------------------------------------------------------

  /**
   * Make sure exactly one key is marked as the primary admin key.
   *
   * Which key becomes primary (in order):
   *   1. A key that is already marked
   *   2. The key from data/.api-key (the "bootstrap" key)
   *   3. The oldest ADMIN key
   *
   * The mark only identifies a key. It does not give extra permissions.
   */
  async ensurePrimaryAdminKey(bootstrapKey: string | null = null): Promise<ApiKey | null> {
    // 1. Already marked? Keep the oldest one and unmark any extras.
    const markedKeys = await this.apiKeyRepository.find({
      where: { isPrimaryAdminKey: true },
      order: { createdAt: 'ASC' },
    });

    if (markedKeys.length > 0) {
      const [primary, ...extras] = markedKeys;
      for (const extra of extras) {
        await this.applyUnguardedUpdate({ isPrimaryAdminKey: false }, extra.id);
      }
      return primary;
    }

    // 2 and 3. Nothing marked yet, so pick a candidate.
    const candidate =
      (await this.findBootstrapCandidate(bootstrapKey)) ??
      (await this.findOldestAdmin());

    if (!candidate) {
      return null;
    }

    await this.applyUnguardedUpdate({ isPrimaryAdminKey: true }, candidate.id);
    return this.findOne(candidate.id);
  }

  private async findBootstrapCandidate(bootstrapKey: string | null): Promise<ApiKey | null> {
    if (!bootstrapKey) {
      return null;
    }

    // Try the exact hash first.
    const byHash = await this.apiKeyRepository.findOne({
      where: { keyHash: hashCredential(bootstrapKey) },
    });
    if (byHash) {
      return byHash;
    }

    // Fallback: match by prefix (useful if the pepper changed).
    return this.apiKeyRepository.findOne({
      where: { keyPrefix: bootstrapKey.substring(0, 12) },
      order: { createdAt: 'ASC' },
    });
  }

  private findOldestAdmin(): Promise<ApiKey | null> {
    return this.apiKeyRepository.findOne({
      where: { role: ApiKeyRole.ADMIN },
      order: { createdAt: 'ASC' },
    });
  }

  // ---------------------------------------------------------------------------
  // Permission check
  // ---------------------------------------------------------------------------

  assertApiKeyDeletionAuthorized(actor: ApiKey, target: ApiKey): void {
    assertApiKeyManager(actor);

    const isOperatorDeletingPrimary =
      actor.role === ApiKeyRole.OPERATOR && target.isPrimaryAdminKey;
    if (isOperatorDeletingPrimary) {
      throw new ForbiddenException('Operators cannot delete the primary Admin API key');
    }
  }

  // ---------------------------------------------------------------------------
  // Database updates and deletes
  // ---------------------------------------------------------------------------

  /** Update a key with no last-admin protection. */
  async applyUnguardedUpdate(patch: QueryDeepPartialEntity<ApiKey>,id: string,): Promise<void> {
    const result = await this.apiKeyRepository
      .createQueryBuilder()
      .update(ApiKey)
      .set(patch)
      .where('"id" = :id', { id })
      .execute();

    if (!result.affected) {
      await this.findOne(id); // throws NotFoundException if the key is gone
    }
    
  }

  /** Update a key, but refuse if it would remove the last usable admin. */
  async guardedUpdate(id: string, patch: QueryDeepPartialEntity<ApiKey>): Promise<void> {
    const query = this.apiKeyRepository
      .createQueryBuilder()
      .update(ApiKey)
      .set(patch);

    const result = await this.addLastAdminGuard(query, id).execute();
    await this.assertMutationApplied(id, result.affected);
  }

  /** Delete a key, but refuse if it would remove the last usable admin. */
  async guardedDelete(id: string): Promise<void> {
    const query = this.apiKeyRepository
      .createQueryBuilder()
      .delete()
      .from(ApiKey);

    const result = await this.addLastAdminGuard(query, id).execute();
    await this.assertMutationApplied(id, result.affected);
  }

  // ---------------------------------------------------------------------------
  // Last-admin guard (runs inside the SQL statement itself)
  // ---------------------------------------------------------------------------

  /**
   * Adds a rule to the SQL: "only change this key if it is NOT a usable admin,
   * OR another usable admin exists."
   *
   * Doing this in one SQL statement (instead of "check, then change")
   * prevents race conditions between processes.
   */
  private addLastAdminGuard<T extends UpdateQueryBuilder<ApiKey> | DeleteQueryBuilder<ApiKey>>(
    query: T,
    id: string,
  ): T {
    const targetIsUsableAdmin = this.usableAdminSql();
    const otherUsableAdmin = this.usableAdminSql('other');

    return query
      .where('"id" = :id', { id })
      .andWhere(
        `(NOT (${targetIsUsableAdmin}) OR EXISTS (
          SELECT 1 FROM "api_keys" "other"
          WHERE "other"."id" <> :id AND ${otherUsableAdmin}
        ))`,
      )
      .setParameters({
        adminRole: ApiKeyRole.ADMIN,
        guardNow: this.currentSqliteUtcTime(),
      }) as T;
  }

  /**
   * SQL text meaning "this is a usable admin key":
   * ADMIN role, active, not expired, and not limited to specific sessions.
   *
   * Pass a table alias (e.g. 'other') when used inside a sub-query.
   */
  private usableAdminSql(alias = ''): string {
    const column = (name: string) => (alias ? `"${alias}"."${name}"` : `"${name}"`);

    const isAdmin = `${column('role')} = :adminRole`;
    const isActive = `${column('isActive')} = 1`;
    const notExpired = `(${column('expiresAt')} IS NULL OR ${column('expiresAt')} > :guardNow)`;
    const notSessionScoped = `(${column('allowedSessions')} = '' OR ${column('allowedSessions')} IS NULL)`;

    return [isAdmin, isActive, notExpired, notSessionScoped].join(' AND ');
  }

  /** Current UTC time in the format SQLite/TypeORM stores, e.g. "2026-11-15 10:30:00.123". */
  private currentSqliteUtcTime(): string {
    return new Date().toISOString().slice(0, 23).replace('T', ' ');
  }

  /**
   * Called when a guarded change affected 0 rows. Either the key doesn't
   * exist (NotFound) or the last-admin rule blocked it (Conflict).
   */
  private async assertMutationApplied(id: string, affected: number | null | undefined): Promise<void> {
    if (affected) {
      return;
    }

    await this.findOne(id); // throws NotFoundException if missing
    throw new ConflictException('Cannot remove the last active admin key');
  }

  private async findOne(id: string): Promise<ApiKey> {
    const key = await this.apiKeyRepository.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException(`API key with id '${id}' not found`);
    }
    return key;
  }
}

