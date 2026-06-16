import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');

import { ProjectRegistry } from '../project-registry.js';

describe('ProjectRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => true });
    (fs.realpathSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: string) => p);
  });

  it('should load and find projects by id or name', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify([
      { id: 'stock', name: '量化系统', path: '/root/project/stock' },
    ]));
    const registry = new ProjectRegistry('/tmp/projects.json', ['/root/project']);
    expect(registry.list()).toHaveLength(1);
    expect(registry.find('stock')?.name).toBe('量化系统');
    expect(registry.find('量化系统')?.id).toBe('stock');
  });

  it('should reject project outside allowed roots', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify([
      { id: 'bad', name: '坏项目', path: '/tmp/bad' },
    ]));
    const registry = new ProjectRegistry('/tmp/projects.json', ['/root/project']);
    expect(registry.list()).toHaveLength(0);
  });
});
