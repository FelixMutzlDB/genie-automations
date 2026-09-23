import { createApp, lakebase, server } from '@databricks/appkit';
import { setupWhoamiRoute } from './routes/whoami';
import { setupReconRoutes } from './routes/recon';

createApp({
  plugins: [lakebase(), server()],
  async onPluginsReady(appkit) {
    setupWhoamiRoute(appkit);
    setupReconRoutes(appkit);
  },
}).catch(console.error);
