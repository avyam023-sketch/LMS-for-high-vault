import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { runMaintenance } from './lib/maintenance.js';
import { bootstrap } from './lib/bootstrap.js';

await migrate();
await bootstrap();
await runMaintenance();
setInterval(runMaintenance, 6 * 60 * 60 * 1000).unref();
const server = createApp().listen(config.PORT, config.HOST, () => {
  console.log(`THVFoodSafe listening on ${config.appUrl} (port ${config.PORT})`);
});

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
