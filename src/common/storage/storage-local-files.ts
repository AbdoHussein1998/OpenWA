




import * as fs from 'fs';
import * as path from 'path';

import {
  isPathWithin,
} from '../utils/path-safety';

/**
 * Max number of local files a single traversal enumerates.
 *
 * Bounds a count DoS on a huge media directory.
 */
const DEFAULT_LIST_MAX_FILES =
  100_000;

/**
 * Max directory depth a local traversal descends.
 *
 * Prevents a pathological directory tree from running unbounded.
 */
const LOCAL_TRAVERSAL_MAX_DEPTH =
  20;

/**
 * Read a positive integer from the environment.
 *
 * Invalid, missing, zero, or negative values fall back to the provided
 * default.
 */
function positiveIntFromEnv(
  name: string,
  fallback: number,
): number {
  const parsed =
    Number.parseInt(
      process.env[name] ?? '',
      10,
    );

  return (
    Number.isInteger(parsed) &&
    parsed > 0
  )
    ? parsed
    : fallback;
}

/**
 * Enumerate local files under the storage root, capped at
 * STORAGE_LIST_MAX_FILES.
 *
 * This cap is a per-call DoS guard, not a completeness contract.
 *
 * Callers that need to reconcile against the entire store must use
 * iterateLocalFiles().
 *
 * IMPORTANT:
 *
 * Returned values are STORAGE KEYS, not host filesystem paths.
 *
 * Storage keys are always represented with forward slashes so local
 * storage behaves identically to S3 on every operating system.
 *
 * In particular, Windows' path.join() produces backslashes:
 *
 *   chat-media\sess-1\file.png
 *
 * while S3 and the rest of OpenWA use:
 *
 *   chat-media/sess-1/file.png
 *
 * Allowing OS-native separators to escape this storage adapter breaks:
 *
 * - prefix comparisons
 * - local/S3 deduplication
 * - orphan-media reconciliation
 * - any persisted storage-key comparison
 */
export async function listLocalFiles(
  localPath: string,
): Promise<string[]> {
  const maxFiles =
    positiveIntFromEnv(
      'STORAGE_LIST_MAX_FILES',
      DEFAULT_LIST_MAX_FILES,
    );

  const files: string[] = [];

  for await (
    const file of iterateLocalFiles(
      localPath,
    )
  ) {
    files.push(file);

    if (
      files.length >=
      maxFiles
    ) {
      break;
    }
  }

  return files;
}

/**
 * Full local enumeration as a stream.
 *
 * Unlike listLocalFiles(), this traversal has no file-count cap.
 *
 * It is asynchronous and iterative so large/deep media trees:
 *
 * - do not block the event loop with synchronous traversal
 * - do not recurse through the JavaScript call stack
 *
 * Directory depth is still bounded by LOCAL_TRAVERSAL_MAX_DEPTH.
 *
 * `prefix` may identify a storage subtree. A trailing slash means the
 * traversal starts directly inside that subtree instead of walking the
 * complete storage root and filtering afterwards.
 *
 * Example:
 *
 *   prefix = "chat-media/"
 *
 * starts at:
 *
 *   <localPath>/chat-media
 *
 * Every value yielded from this function is a provider-neutral STORAGE
 * KEY using "/" separators, regardless of the host operating system.
 *
 * Host filesystem paths continue to use path.join() internally.
 */
export async function* iterateLocalFiles(
  localPath: string,
  prefix = '',
): AsyncGenerator<string> {
  /*
   * Storage-key representation is deliberately POSIX-style.
   *
   * `prefix` originates from storage-key callers such as:
   *
   *   chat-media/
   *   statuses/
   *
   * A prefix ending in "/" identifies a subtree, so remove only that
   * trailing separator before resolving it against the local filesystem.
   */
  const root =
    prefix.endsWith('/')
      ? prefix.slice(
          0,
          -1,
        )
      : '';

  /*
   * Prevent a crafted prefix from escaping the configured media root.
   *
   * isPathWithin() resolves using the host platform, which is correct
   * here because this check protects a real local filesystem path.
   */
  if (
    root &&
    !isPathWithin(
      localPath,
      root,
    )
  ) {
    return;
  }

  /*
   * `dir` is a STORAGE-KEY-relative directory and therefore uses "/".
   *
   * When accessing the filesystem below we pass it through path.join(),
   * which converts it into the appropriate host filesystem path.
   */
  const queue: Array<{
    dir: string;
    depth: number;
  }> = [
    {
      dir: root,
      depth: 0,
    },
  ];

  while (
    queue.length > 0
  ) {
    const {
      dir,
      depth,
    } = queue.shift()!;

    if (
      depth >=
      LOCAL_TRAVERSAL_MAX_DEPTH
    ) {
      continue;
    }

    /*
     * This is a real filesystem path, so use the platform-specific
     * path.join().
     *
     * On Windows, for example:
     *
     *   localPath = C:\data\media
     *   dir       = chat-media/sess-1
     *
     * becomes a valid Windows path internally.
     *
     * We do NOT return this value to callers.
     */
    const fullPath =
      path.join(
        localPath,
        dir,
      );

    let entries:
      fs.Dirent[];

    try {
      entries =
        await fs.promises.readdir(
          fullPath,
          {
            withFileTypes:
              true,
          },
        );
    } catch {
      /*
       * The directory may have disappeared between queueing and reading,
       * or it may temporarily be unreadable.
       *
       * One bad directory must not abort reconciliation of the rest of
       * the media store.
       */
      continue;
    }

    for (
      const entry of entries
    ) {
      /*
       * CRITICAL:
       *
       * Do NOT use path.join() here.
       *
       * `relativePath` is not a host filesystem path; it becomes a
       * storage key returned to StorageService callers.
       *
       * path.join() on Windows would generate:
       *
       *   chat-media\sess-1\file.png
       *
       * That breaks canonical storage-key semantics because OpenWA and
       * S3 use:
       *
       *   chat-media/sess-1/file.png
       *
       * path.posix.join() guarantees the same key representation on
       * Linux, macOS, and Windows.
       */
      const relativePath =
        dir
          ? path.posix.join(
              dir,
              entry.name,
            )
          : entry.name;

      if (
        entry.isDirectory()
      ) {
        queue.push({
          dir:
            relativePath,

          depth:
            depth + 1,
        });

        continue;
      }

      if (
        entry.isFile()
      ) {
        yield relativePath;
      }
    }
  }
}

/**
 * Read one local-storage object.
 */
export function getLocalFile(
  localPath: string,
  filePath: string,
): Promise<Buffer> {
  if (
    !isPathWithin(
      localPath,
      filePath,
    )
  ) {
    throw new Error(
      `Refusing to read outside storage root: ${filePath}`,
    );
  }

  /*
   * `filePath` is a provider-neutral storage key.
   *
   * path.join() converts its "/" separators into a valid host path when
   * necessary.
   */
  const fullPath =
    path.join(
      localPath,
      filePath,
    );

  /*
   * Asynchronous read so export/reconciliation workflows yield the
   * event loop rather than synchronously reading every media object.
   */
  return fs.promises.readFile(
    fullPath,
  );
}

/**
 * Write one local-storage object.
 */
export async function putLocalFile(
  localPath: string,
  filePath: string,
  data: Buffer,
): Promise<void> {
  if (
    !isPathWithin(
      localPath,
      filePath,
    )
  ) {
    throw new Error(
      `Refusing to write outside storage root: ${filePath}`,
    );
  }

  const fullPath =
    path.join(
      localPath,
      filePath,
    );

  /*
   * mkdir({ recursive: true }) is idempotent and also handles the case
   * where the parent hierarchy does not exist yet.
   */
  await fs.promises.mkdir(
    path.dirname(
      fullPath,
    ),
    {
      recursive:
        true,
    },
  );

  await fs.promises.writeFile(
    fullPath,
    data,
  );
}

/**
 * Delete one local-storage object.
 *
 * Missing files are intentionally treated as success so deletion remains
 * idempotent, matching S3 DeleteObject semantics.
 */
export async function deleteLocalFile(
  localPath: string,
  filePath: string,
): Promise<void> {
  if (
    !isPathWithin(
      localPath,
      filePath,
    )
  ) {
    throw new Error(
      `Refusing to delete outside storage root: ${filePath}`,
    );
  }

  const fullPath =
    path.join(
      localPath,
      filePath,
    );

  try {
    await fs.promises.unlink(
      fullPath,
    );
  } catch (error: unknown) {
    if (
      (
        error as
          NodeJS.ErrnoException
      ).code !==
      'ENOENT'
    ) {
      throw error;
    }
  }
}


