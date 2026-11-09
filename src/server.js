import { createServer } from 'node:http';
import { createApp } from './app.js';
import { TaskRepository } from './repositories/task-repository.js';

const rawPort = process.env.PORT ?? '3000';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT 必须是 1..65535 的整数');
const repository = await TaskRepository.open(process.env.DATA_FILE || null);
const server = createServer(createApp({ repository }));
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.on('error', async (error) => { console.error(`服务监听失败: ${error.code ?? 'UNKNOWN'}`); await repository.close(); process.exitCode = 1; });
server.listen(Number(rawPort), '127.0.0.1', () => console.log(`Teaching API: http://127.0.0.1:${rawPort} (${process.env.DATA_FILE ? 'file' : 'memory'})`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return; closing = true;
  const timer = setTimeout(() => { server.closeAllConnections(); }, 5000); timer.unref();
  server.close(async () => { clearTimeout(timer); await repository.close(); });
});
