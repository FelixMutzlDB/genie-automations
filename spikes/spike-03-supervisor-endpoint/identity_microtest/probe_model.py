"""
Spike-03 Step 0 — OBO identity micro-test (NO LLM).

The feasibility gate for the whole agentic-write path. This pyfunc model, when invoked
on a Model Serving endpoint, answers ONE question empirically:

    Does ModelServingUserCredentials() inside a serving endpoint yield a CALLER-scoped
    WorkspaceClient that can mint a Lakebase credential for the caller, so that
    Postgres session_user == the calling human (L0) — or only the endpoint's service
    principal (forcing the L1 broker fallback)?

It deliberately contains no LLM and no financial tools. It reports, side by side:
  - the endpoint SP identity        (baseline / negative control)
  - the OBO caller identity          (what ModelServingUserCredentials resolves to)
  - the Postgres session_user        (THE answer — who the DB thinks is connected)

Interpretation:
  - pg_session_user == obo_identity == calling human   -> L0 holds. Full OBO. Build commit in endpoint.
  - pg_session_user == sp_identity (not the caller)     -> L1. Move commit to a trusted broker/App-BFF.
  - obo_identity resolves but generate_database_credential fails -> L1 (serving cannot mint
        a Lakebase cred on-behalf-of-user); record the exact error.

NEVER "fix" an L1 result by trusting a caller-supplied actor_id — that reopens GA010.
"""
import os
import mlflow
from mlflow.pyfunc import PythonModel


class OboIdentityProbe(PythonModel):
    def predict(self, context, model_input, params=None):
        result = {}

        # 1) Endpoint service-principal identity (baseline / negative control).
        try:
            from databricks.sdk import WorkspaceClient
            w_sp = WorkspaceClient()
            result["sp_identity"] = w_sp.current_user.me().user_name
        except Exception as e:  # noqa: BLE001
            result["sp_identity_error"] = f"{type(e).__name__}: {e}"

        # 2) OBO caller identity via ModelServingUserCredentials.
        w_user = None
        try:
            from databricks.sdk import WorkspaceClient
            from databricks.sdk.credentials_provider import ModelServingUserCredentials
            w_user = WorkspaceClient(credentials_strategy=ModelServingUserCredentials())
            result["obo_identity"] = w_user.current_user.me().user_name
        except Exception as e:  # noqa: BLE001
            result["obo_identity_error"] = f"{type(e).__name__}: {e}"

        # 3) THE crux: mint a Lakebase credential as the CALLER and read session_user.
        if w_user is not None and "obo_identity" in result:
            try:
                import psycopg
                endpoint = os.environ["LAKEBASE_ENDPOINT"]  # projects/.../endpoints/...
                host = os.environ["LAKEBASE_HOST"]
                pg_user = result["obo_identity"]
                token = w_user.postgres.generate_database_credential(endpoint=endpoint).token
                conn = psycopg.connect(
                    host=host, dbname="databricks_postgres",
                    user=pg_user, password=token, sslmode="require",
                    connect_timeout=10,
                )
                with conn.cursor() as cur:
                    cur.execute("SELECT session_user, current_user")
                    su, cu = cur.fetchone()
                result["pg_session_user"] = su
                result["pg_current_user"] = cu
                conn.close()
            except Exception as e:  # noqa: BLE001
                result["pg_error"] = f"{type(e).__name__}: {e}"

        # 4) Verdict helper (the harness re-checks; this is a convenience field).
        su = result.get("pg_session_user")
        obo = result.get("obo_identity")
        sp = result.get("sp_identity")
        if su and obo and su == obo and su != sp:
            result["verdict"] = "L0_full_obo"
        elif su and su == sp:
            result["verdict"] = "L1_session_user_is_sp"
        elif "pg_error" in result:
            result["verdict"] = "L1_cannot_mint_lakebase_cred_obo"
        else:
            result["verdict"] = "inconclusive"
        return result


# --- local sanity: the model imports and instantiates (no Databricks needed) ---
if __name__ == "__main__":
    m = OboIdentityProbe()
    print("OboIdentityProbe constructs OK; predict() runs only inside a serving endpoint.")
