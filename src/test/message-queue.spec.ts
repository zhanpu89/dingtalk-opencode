import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../message-queue.js';

describe('MessageQueue', () => {
  it('TC-QUEUE-UNIT-001 | 依次入队 2 个相同 key——第 2 个在第 1 个完成后执行', async () => {
    const q = new MessageQueue();
    const order: string[] = [];
    await q.enqueue('key1', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push('A');
    });
    await q.enqueue('key1', async () => {
      order.push('B');
    });
    expect(order).toEqual(['A', 'B']);
  });

  it('TC-QUEUE-UNIT-002 | 第 1 个失败——第 2 个仍执行', async () => {
    const q = new MessageQueue();
    const order: string[] = [];
    await q.enqueue('key1', async () => {
      throw new Error('fail');
    }).catch(() => {});
    await q.enqueue('key1', async () => {
      order.push('B');
    });
    expect(order).toEqual(['B']);
  });

  it('TC-QUEUE-UNIT-003 | 并发入队不同 key——并行执行', async () => {
    const q = new MessageQueue();
    const order: number[] = [];
    const p1 = q.enqueue('key1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = q.enqueue('key2', async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toContain(2);
    expect(order[order.length - 1]).toBe(1);
  });

  it('TC-QUEUE-UNIT-004 | pendingCount——入队后返回正确计数', async () => {
    const q = new MessageQueue();
    expect(q.pendingCount()).toBe(0);
    q.enqueue('key1', async () => {});
    expect(q.pendingCount()).toBe(1);
    q.enqueue('key2', async () => {});
    expect(q.pendingCount()).toBe(2);
  });

  it('TC-QUEUE-UNIT-005 | pendingCount——空队列返回 0', async () => {
    const q = new MessageQueue();
    expect(q.pendingCount()).toBe(0);
  });
});
