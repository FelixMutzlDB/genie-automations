import { createApp, files, jobs, lakebase, server } from '@databricks/appkit';
import { isIngestAppKit, setupIngestRoutes } from './routes/ingest';
import { setupWhoamiRoute } from './routes/whoami';
import { setupReconRoutes } from './routes/recon';
import { setupTaskRoutes } from './routes/tasks';

createApp({
  plugins: [
    lakebase(),
    files({
      volumes: {
        files: {
          auth: 'on-behalf-of-user',
          maxUploadSize: 25 * 1024 * 1024,
          policy: files.policy.allowAll(),
        },
      },
    }),
    jobs({ jobs: { default: { taskType: 'python_script' } } }),
    server(),
  ],
  onPluginsReady(appkit) {
    setupWhoamiRoute(appkit);
    setupTaskRoutes(appkit);
    setupReconRoutes(appkit);
    if (!isIngestAppKit(appkit)) throw new Error('Ingest plugins are unavailable');
    setupIngestRoutes(appkit);
  },
}).catch(console.error);
