import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectServerManager } from '../project-server-manager.js';
import type { AppConfig } from '../config.js';

let tempDir: string | undefined;

function config(dataDir: string): AppConfig {
  return {
    opencodeServerUrl: 'http://localhost:4096',
    opencodeServerPassword: '',
    dingtalkAppKey: 'key',
    dingtalkAppSecret: 'secret',
    dingtalkBotName: 'OpenCode',
    requestTimeoutMs: 600_000,
    rateLimitMax: 20,
    rateLimitWindowMs: 60_000,
    logLevel: 'SILENT',
    dataDir,
    projectsConfigPath: 'projects.json',
    allowedProjectRoots: [],
    projectServerPortStart: 4100,
    projectServerHostname: '127.0.0.1',
    projectServerIdleMs: 7_200_000,
    projectSwitchRequired: false,
    maxMessagesPerSession: 0,
  };
}

function makeTempDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-server-manager-'));
  return tempDir;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('ProjectServerManager', () => {
  it('should restore persisted running server when health check passes', async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'project-servers.json'), JSON.stringify([
      {
        projectId: 'qt',
        projectPath: '/tmp/qt',
        port: 4100,
        baseUrl: 'http://127.0.0.1:4100',
        startedAt: 1,
        lastUsedAt: 2,
        status: 'running',
      },
    ]));
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const manager = new ProjectServerManager(config(dataDir));
    const instance = await manager.getHealthy('qt');

    expect(instance?.status).toBe('running');
    expect(instance?.port).toBe(4100);
  });

  it('should stop restored server by persisted pid', () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'project-servers.json'), JSON.stringify([
      {
        projectId: 'qt',
        projectPath: '/tmp/qt',
        port: 4100,
        baseUrl: 'http://127.0.0.1:4100',
        pid: 12345,
        startedAt: 1,
        lastUsedAt: 2,
        status: 'running',
      },
    ]));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const manager = new ProjectServerManager(config(dataDir));
    manager.stopAll();

    expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'project-servers.json'), 'utf-8'))).toEqual([]);
  });

  it('should mark restored server stopped when health check fails', async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'project-servers.json'), JSON.stringify([
      {
        projectId: 'qt',
        projectPath: '/tmp/qt',
        port: 4100,
        baseUrl: 'http://127.0.0.1:4100',
        startedAt: 1,
        lastUsedAt: 2,
        status: 'running',
      },
    ]));
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    const manager = new ProjectServerManager(config(dataDir));
    const instance = await manager.getHealthy('qt');

    expect(instance?.status).toBe('stopped');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'project-servers.json'), 'utf-8'))).toEqual([]);
  });
});
