import { createServer } from 'node:http';
import { createApp } from './app.js';
import { TaskRepository } from './repositories/task-repository.js';
import { createDexRuntime } from './dex/runtime.js';

const rawPort = process.env.PORT ?? '3000';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT 必须是 1..65535 的整数');
const repository = await TaskRepository.open(process.env.DATA_FILE || null);
let dexRuntime;
let app;
try {
  if (process.env.DEX_DEMO_ENABLED === 'true') dexRuntime = await createDexRuntime({ file: process.env.DEX_DATA_FILE || undefined });
  app = createApp({ repository, dexRuntime, dexToken: process.env.DEX_DEMO_TOKEN });
} catch (error) { await dexRuntime?.close(); await repository.close(); throw error; }
const server = createServer(app);
server.requestTimeout = 15000; server.headersTimeout = 10000;
const closeStores = async () => { await dexRuntime?.close(); await repository.close(); };
server.on('error', async (error) => { console.error(`服务监听失败: ${error.code ?? 'UNKNOWN'}`); await closeStores(); process.exitCode = 1; });
server.listen(Number(rawPort), '127.0.0.1', () => {
  console.log(`Teaching API: http://127.0.0.1:${rawPort} (${process.env.DATA_FILE ? 'file' : 'memory'})`);
  if (dexRuntime) {
    console.log('DEX Demo: /api/dex/market (仅本地模拟，不连接真实链)');
    if (process.env.DEX_AUTO_TICK !== 'false') dexRuntime.start();
  }
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return; closing = true;
  const timer = setTimeout(() => { server.closeAllConnections(); }, 5000); timer.unref();
  server.close(async () => { clearTimeout(timer); await closeStores(); });
});
