import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';

/** Deletes exam ID photos, room scans and snapshots once the retention period has passed. */
async function purgeProctorMedia() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM proctor_media WHERE created_at < now() - make_interval(days => $1)`,
      [config.PROCTOR_RETENTION_DAYS],
    );
    if (rowCount) console.log(`Purged ${rowCount} proctoring files older than ${config.PROCTOR_RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('Proctoring media purge failed', err);
  }
}

await migrate();
await purgeProctorMedia();
setInterval(purgeProctorMedia, 6 * 60 * 60 * 1000).unref();
const server = createApp().listen(config.PORT, () => {
  console.log(`High Vault Academy listening on ${config.appUrl} (port ${config.PORT})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
