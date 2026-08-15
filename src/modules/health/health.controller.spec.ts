import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { HealthController } from './health.controller';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuthService } from '../auth/auth.service';

describe('HealthController', () => {
  let controller: HealthController;
  const mainQuery = jest.fn();
  const dataQuery = jest.fn();
  const isShuttingDown = jest.fn();
  const validateApiKey = jest.fn();

  const reqWith = (headers: Record<string, string> = {}): Request =>
    ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Request;

  beforeEach(async () => {
    mainQuery.mockResolvedValue([{ '1': 1 }]);
    dataQuery.mockResolvedValue([{ '1': 1 }]);
    isShuttingDown.mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: getDataSourceToken('main'), useValue: { query: mainQuery } },
        { provide: getDataSourceToken('data'), useValue: { query: dataQuery } },
        { provide: ShutdownService, useValue: { isShuttingDown } },
        { provide: AuthService, useValue: { validateApiKey } },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => {
    mainQuery.mockReset();
    dataQuery.mockReset();
    isShuttingDown.mockReset();
    validateApiKey.mockReset();
  });

  describe('check', () => {
    it('returns ok with a timestamp (static)', async () => {
      const result = await controller.check(reqWith());
      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
    });

    it('omits the version for an unauthenticated caller and never touches the key store', async () => {
      const result = await controller.check(reqWith());
      expect(result).not.toHaveProperty('version');
      expect(validateApiKey).not.toHaveBeenCalled();
    });

    it('omits the version when the presented key is invalid (the check itself still answers ok)', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      const result = await controller.check(reqWith({ 'x-api-key': 'wrong' }));

      expect(result.status).toBe('ok');
      expect(result).not.toHaveProperty('version');
    });

    it('reports the running version to a valid API key (X-API-Key header)', async () => {
      validateApiKey.mockResolvedValue({ id: 'k1' });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { version } = require('../../../package.json') as { version: string };

      const result = await controller.check(reqWith({ 'x-api-key': 'good-key' }));

      expect(result.version).toBe(version);
      expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
    });

    it('accepts a Bearer token the same way the guard does', async () => {
      validateApiKey.mockResolvedValue({ id: 'k1' });

      const result = await controller.check(reqWith({ authorization: 'Bearer good-key' }));

      expect(result.version).toBeDefined();
      expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
    });
  });

  describe('liveness', () => {
    it('returns ok (static — does not probe dependencies)', () => {
      expect(controller.liveness().status).toBe('ok');
    });
  });

  describe('readiness', () => {
    it('returns ok when both databases respond', async () => {
      const result = await controller.readiness();
      expect(result.status).toBe('ok');
      expect(result.details.mainDatabase.status).toBe('up');
      expect(result.details.dataDatabase.status).toBe('up');
      expect(mainQuery).toHaveBeenCalledWith('SELECT 1');
      expect(dataQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws 503 when the data database is down', async () => {
      dataQuery.mockRejectedValue(new Error('connection refused'));
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 503 when the main (auth/audit) database is down', async () => {
      mainQuery.mockRejectedValue(new Error('disk I/O error'));
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 503 while draining, without even probing the DBs', async () => {
      isShuttingDown.mockReturnValue(true);
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mainQuery).not.toHaveBeenCalled();
      expect(dataQuery).not.toHaveBeenCalled();
    });
  });
});
