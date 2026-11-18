import { assertSqliteNativeDriverAvailable, SqliteNativeConstructor } from './native-dependency-preflight';

describe('assertSqliteNativeDriverAvailable', () => {
  it('checks an in-memory SQL query and closes the driver on success', () => {
    const close = jest.fn();
    const get = jest.fn().mockReturnValue({ healthy: 1 });
    const prepare = jest.fn().mockReturnValue({ get });
    const constructor = jest.fn().mockImplementation(() => ({ prepare, close }));
    assertSqliteNativeDriverAvailable(() => constructor as unknown as SqliteNativeConstructor);
    expect(constructor).toHaveBeenCalledWith(':memory:');
    expect(prepare).toHaveBeenCalledWith('SELECT 1 AS healthy');
    expect(get).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('converts a missing native binding into a useful no-retry startup error', () => {
    const load = () => {
      throw new Error('Could not locate the bindings file. Tried:\n  build/Release/better_sqlite3.node');
    };
    expect(() => assertSqliteNativeDriverAvailable(load)).toThrow(/SQLITE_NATIVE_DRIVER_UNAVAILABLE/);
    expect(() => assertSqliteNativeDriverAvailable(load)).toThrow(/npm --prefix backend rebuild better-sqlite3/);
    expect(() => assertSqliteNativeDriverAvailable(load)).toThrow(/Node=/);
    expect(() => assertSqliteNativeDriverAvailable(load)).toThrow(/Could not locate the bindings file/);
  });

  it('fails closed when the driver opens but cannot run SQL, and closes it', () => {
    const close = jest.fn();
    const driver = jest.fn().mockImplementation(() => ({
      prepare: () => ({ get: () => ({ healthy: 0 }) }),
      close,
    }));
    expect(() => assertSqliteNativeDriverAvailable(() => driver as unknown as SqliteNativeConstructor)).toThrow(
      /SQLITE_NATIVE_DRIVER_UNAVAILABLE/,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
