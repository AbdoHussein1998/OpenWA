// Native Windows/NTFS does not expose POSIX chmod mode semantics through stat().mode.
// Mock fs so the test can verify the hardening calls on every platform while still delegating
// to the real filesystem implementation.
jest.mock('fs', () => {
  const actual =
    jest.requireActual<
      typeof import('fs')
    >('fs');

  return {
    ...actual,
    mkdirSync:
      jest.fn(
        actual.mkdirSync,
      ),
    chmodSync:
      jest.fn(
        actual.chmodSync,
      ),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensurePrivateDir,
} from './private-dir.util';

// Session credential directories (whatsapp-web.js profiles, baileys creds.json) hold everything
// needed to take over the linked WhatsApp account — read access to the volume must not be enough.
// The plugin registry already writes itself owner-only (plugin-storage.service); these tests pin
// the same guarantee for dirs created on the engine path.
describe('ensurePrivateDir', () => {
  let tmpRoot: string;

  const isWindows =
    process.platform ===
    'win32';

  beforeEach(() => {
    (
      fs.mkdirSync as jest.Mock
    ).mockClear();

    (
      fs.chmodSync as jest.Mock
    ).mockClear();

    tmpRoot =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          'private-dir-',
        ),
      );
  });

  afterEach(() => {
    fs.rmSync(
      tmpRoot,
      {
        recursive: true,
        force: true,
      },
    );
  });

  it('creates a fresh nested directory with owner-only permissions (0o700)', () => {
    const dir =
      path.join(
        tmpRoot,
        'baileys',
        'alice',
      );

    ensurePrivateDir(
      dir,
    );

    expect(
      fs.existsSync(
        dir,
      ),
    ).toBe(
      true,
    );

    /*
     * This is the portable security contract:
     *
     * - creation requests mode 0700
     * - the final directory is explicitly chmod'd to 0700
     *
     * mkdir's mode is important for a fresh directory; chmod covers upgraded
     * deployments where the directory already existed.
     */
    expect(
      fs.mkdirSync,
    ).toHaveBeenCalledWith(
      dir,
      {
        recursive: true,
        mode: 0o700,
      },
    );

    expect(
      fs.chmodSync,
    ).toHaveBeenCalledWith(
      dir,
      0o700,
    );

    /*
     * POSIX filesystems expose the resulting permission bits through stat().
     * Native Windows/NTFS does not, so the call assertions above are the
     * meaningful cross-platform guarantee there.
     */
    if (!isWindows) {
      expect(
        fs.statSync(
          dir,
        ).mode &
          0o777,
      ).toBe(
        0o700,
      );
    }
  });

  it('tightens a pre-existing world-readable directory back to 0o700', () => {
    // mkdir's `mode` only applies to directories it creates; an upgraded deployment reuses the
    // session dir it already has, so the re-chmod half is what protects existing installs.
    const dir =
      path.join(
        tmpRoot,
        'sessions',
        'session-alice',
      );

    fs.mkdirSync(
      dir,
      {
        recursive: true,
        mode: 0o755,
      },
    );

    /*
     * Ignore setup calls. We want to verify what ensurePrivateDir() itself
     * requests for an already-existing directory.
     */
    (
      fs.mkdirSync as jest.Mock
    ).mockClear();

    (
      fs.chmodSync as jest.Mock
    ).mockClear();

    ensurePrivateDir(
      dir,
    );

    expect(
      fs.mkdirSync,
    ).toHaveBeenCalledWith(
      dir,
      {
        recursive: true,
        mode: 0o700,
      },
    );

    expect(
      fs.chmodSync,
    ).toHaveBeenCalledWith(
      dir,
      0o700,
    );

    if (!isWindows) {
      expect(
        fs.statSync(
          dir,
        ).mode &
          0o777,
      ).toBe(
        0o700,
      );
    }
  });

  it('is best-effort: an unwritable location must not throw (the engine lib owns real failures)', () => {
    const file =
      path.join(
        tmpRoot,
        'blocker',
      );

    fs.writeFileSync(
      file,
      'not a directory',
    );

    expect(
      () =>
        ensurePrivateDir(
          path.join(
            file,
            'under-a-file',
          ),
        ),
    ).not.toThrow();
  });
});
