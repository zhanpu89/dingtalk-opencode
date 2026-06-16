import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectContextStore } from '../project-context-store.js';

let tempDir: string | undefined;

function tempFile(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-'));
  return path.join(tempDir, 'context.json');
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('ProjectContextStore', () => {
  it('should persist project context immediately on set', () => {
    const file = tempFile();
    const store = new ProjectContextStore(file);

    store.set('conv:user', 'qt');

    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ 'conv:user': 'qt' });
  });

  it('should persist project context immediately on delete', () => {
    const file = tempFile();
    const store = new ProjectContextStore(file);

    store.set('conv:user', 'qt');
    store.delete('conv:user');

    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({});
  });
});
