# bundle — Databricks Asset Bundle

Env-promoted deploy (dev / prod) of the whole framework: the app, the supervisor serving
endpoint, the Lakebase project + synced tables, the capability UC functions, the scheduled
`chase` job, and the Genie space + dashboard over the governed target.

Deploy with an explicit profile, never auto-selected:

```
databricks bundle validate --profile <PROFILE>
databricks bundle deploy -t dev --profile <PROFILE>
```

Load `databricks-dabs` when implementing. Secrets via Databricks Secrets, never inline.
