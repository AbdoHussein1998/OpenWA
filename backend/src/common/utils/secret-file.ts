import { writeFileSync, chmodSync, existsSync } from 'fs';

/**
 * Write a secret file (e.g. the generated `.env`, the raw admin key) with owner-only permissions.
 *
 * `writeFileSync`'s `mode` is honored only when the file is CREATED — on an overwrite it keeps the
 * existing permissions. So we chmod to 0o600 BEFORE writing too: if the file already exists with
 * looser perms, the new secret content is never briefly world-readable during the rewrite. The
 * post-write chmod is a backstop. Both chmods are best-effort (a mount that can't chmod, or an
 * absent file on the pre-write call, shouldn't break the write — create-mode covers new files).
 */
export function writeSecretFile(filePath: string, content: string): void {
  // An absent destination is the normal first-run case, not a permissions failure. Avoid emitting
  // a misleading ENOENT warning before creating data/.env.generated or data/.api-key.
  if (existsSync(filePath)) {
    try {
      chmodSync(filePath, 0o600);
    } catch (error) {
      // The path may have disappeared in the race between existsSync/chmodSync. That is harmless:
      // writeFileSync below will create it using the restrictive mode. Real failures matter.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[al-hakim] pre-write chmod 0o600 failed for ${filePath}: ${(error as Error).message}`);
      }
    }
  }
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    console.warn(`[al-hakim] post-write chmod 0o600 failed for ${filePath}: ${(error as Error).message}`);
  }
}
