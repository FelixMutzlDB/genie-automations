import { createApp, lakebase, server } from '@databricks/appkit';
import { setupWhoamiRoute } from './routes/whoami';
import { setupReconRoutes } from './routes/recon';
import { setupTaskRoutes } from './routes/tasks';

createApp({
  plugins: [lakebase(), server()],
  onPluginsReady(appkit) {
    setupWhoamiRoute(appkit);
    setupTaskRoutes(appkit);
    setupReconRoutes(appkit);
  },
}).catch(console.error);
