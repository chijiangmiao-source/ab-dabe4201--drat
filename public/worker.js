// Web Worker：把复核移出主线程，长回放期间按步让出事件循环并汇报进度。
import { review } from './lib/review.js';

let token = 0;

function defer(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg?.type !== 'review') return;
  const myToken = ++token;
  try {
    const result = await review(msg.cnf, msg.drat, {
      yieldEvery: 200,
      onStep: async ({ processed, total }) => {
        if (myToken !== token) throw new Error('cancelled');
        self.postMessage({ type: 'progress', processed, total });
        await defer(0); // 让出事件循环，使进度/中止保持响应
      },
    });
    if (myToken !== token) return;
    self.postMessage({ type: 'done', result });
  } catch (err) {
    if (myToken !== token) return;
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
