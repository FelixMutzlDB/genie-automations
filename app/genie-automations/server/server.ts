import { createApp, files, genie, jobs, lakebase, server } from '@databricks/appkit';
import { isIngestAppKit, setupIngestRoutes } from './routes/ingest';
import { setupWhoamiRoute } from './routes/whoami';
import { setupReconRoutes } from './routes/recon';
import { setupTaskRoutes } from './routes/tasks';
import { setupConfigRoutes } from './routes/config';
import { setupChaseRoutes } from './routes/chase';
import { configureTaskConfigResolver } from './config/resolveTaskConfig';

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
    genie(),
    server(),
  ],
  onPluginsReady(appkit) {
    configureTaskConfigResolver(appkit);
    setupWhoamiRoute(appkit);
    setupTaskRoutes(appkit);
    setupConfigRoutes(appkit);
    setupChaseRoutes(appkit);
    setupReconRoutes(appkit);
    if (!isIngestAppKit(appkit)) throw new Error('Ingest plugins are unavailable');
    setupIngestRoutes(appkit);
  },
}).catch(console.error);
