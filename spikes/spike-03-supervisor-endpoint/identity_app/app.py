"""
Spike-03 Step 0 (App/Agent-Server pivot) -- OBO identity micro-test. NO LLM.

The feasibility gate for the whole agentic-write path, re-homed onto a Databricks
App (the pivot decision in PIVOT.md). It answers ONE question empirically:

    When a real human hits this App through their browser/SSO session, does the
    forwarded user token (`x-forwarded-access-token`) let the App mint a Lakebase
    credential AS THE CALLER, so that Postgres session_user == the calling human
    (L0 -- full OBO) -- or only the App's service principal (L1 -- needs a broker)?

It contains no LLM and no financial tools. It reports, side by side:
  - sp_identity          : the App service principal (baseline / negative control)
  - sp_pg_session_user   : session_user via the DEFAULT injected PGUSER/PGPASSWORD
                           (this is the App-SP Postgres role -> the L1 baseline)
  - obo_identity         : who the forwarded user token resolves to
  - pg_session_user      : THE answer -- who Postgres thinks is connected on the
                           user-token-minted credential

Verdicts:
  - L0_full_obo                     : pg_session_user == human == obo_identity, != SP. Build commit in the App.
  - L1_session_user_is_sp           : user-minted path still lands as the SP role.
  - L1_cannot_mint_lakebase_cred_obo: user token cannot mint a Lakebase cred; record exact error.
  - FAIL_CLOSED_no_user_token       : no forwarded token -> we REFUSE to fall back to the SP.

NEVER "fix" an L1 result by trusting a caller-supplied identity string -- that reopens GA010.
The whole point is that identity is proven by the platform, not asserted by the caller.
"""
import os
import uuid

from fastapi import FastAPI, Request

app = FastAPI(title="genie-automations OBO identity micro-test")

# Lakebase coordinates (see app.yaml). LAKEBASE_HOST falls back to the injected PGHOST.
LAKEBASE_HOST = os.environ.get("LAKEBASE_HOST") or os.environ.get("PGHOST", "")
LAKEBASE_ENDPOINT = os.environ.get("LAKEBASE_ENDPOINT", "")   # projects/.../endpoints/primary
LAKEBASE_INSTANCE = os.environ.get("LAKEBASE_INSTANCE", "genie-automations")
PGDATABASE = os.environ.get("PGDATABASE", "databricks_postgres")


def _pg_session_user(host: str, user: str, password: str, dbname: str):
    """Open a short-lived Postgres connection and return (session_user, current_user)."""
    import psycopg

    conn = psycopg.connect(
        host=host, dbname=dbname, user=user, password=password,
        sslmode="require", connect_timeout=10,
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT session_user, current_user")
            return cur.fetchone()
    finally:
        conn.close()


def _mint_lakebase_cred(w):
    """Mint a Lakebase OAuth credential for whoever `w` is authenticated as.

    The exact SDK surface for Lakebase autoscale projects is not fully documented, so we
    try the known variants and report which one worked -- that discovery IS spike output.
    Returns (token, method). Raises RuntimeError aggregating all attempts on total failure.
    """
    errors = {}
    # Variant A: databricks-sdk DatabaseAPI (provisioned-style): instance_names.
    try:
        cred = w.database.generate_database_credential(
            request_id=str(uuid.uuid4()), instance_names=[LAKEBASE_INSTANCE]
        )
        return cred.token, "database.generate_database_credential(instance_names)"
    except Exception as e:  # noqa: BLE001
        errors["database.instance_names"] = f"{type(e).__name__}: {e}"
    # Variant B: endpoint-path style (what the walkthrough/pyfunc probe used).
    try:
        cred = w.database.generate_database_credential(
            request_id=str(uuid.uuid4()), instance_names=[LAKEBASE_ENDPOINT]
        )
        return cred.token, "database.generate_database_credential(endpoint-as-instance)"
    except Exception as e:  # noqa: BLE001
        errors["database.endpoint"] = f"{type(e).__name__}: {e}"
    # Variant C: legacy `postgres` namespace.
    try:
        cred = w.postgres.generate_database_credential(endpoint=LAKEBASE_ENDPOINT)  # type: ignore[attr-defined]
        return cred.token, "postgres.generate_database_credential(endpoint)"
    except Exception as e:  # noqa: BLE001
        errors["postgres.endpoint"] = f"{type(e).__name__}: {e}"
    raise RuntimeError(f"all mint variants failed: {errors}")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/whoami")
def whoami(request: Request):
    """The diagnostic. Returns the identity picture + a verdict; never raises to the client."""
    result: dict = {}
    from databricks.sdk.core import Config

    cfg = Config()
    result["host"] = cfg.host
    result["lakebase_host"] = LAKEBASE_HOST

    # 1) App service-principal identity (baseline / negative control).
    try:
        from databricks.sdk import WorkspaceClient

        w_sp = WorkspaceClient()
        result["sp_identity"] = w_sp.current_user.me().user_name
    except Exception as e:  # noqa: BLE001
        result["sp_identity_error"] = f"{type(e).__name__}: {e}"

    # 1b) SP Postgres session_user via the DEFAULT injected PG creds == the L1 baseline.
    if os.environ.get("PGUSER") and os.environ.get("PGPASSWORD"):
        try:
            su, cu = _pg_session_user(
                os.environ.get("PGHOST", LAKEBASE_HOST),
                os.environ["PGUSER"], os.environ["PGPASSWORD"], PGDATABASE,
            )
            result["sp_pg_session_user"] = su
            result["sp_pg_current_user"] = cu
        except Exception as e:  # noqa: BLE001
            result["sp_pg_error"] = f"{type(e).__name__}: {e}"

    # 2) The forwarded USER token -- the crux. FAIL CLOSED if absent.
    user_token = request.headers.get("x-forwarded-access-token")
    if not user_token:
        result["obo_error"] = (
            "no x-forwarded-access-token header -- user authorization not enabled, "
            "scopes not granted, or accessed outside an SSO browser session"
        )
        result["verdict"] = "FAIL_CLOSED_no_user_token"
        return result

    # 3) Resolve the caller identity from the user token.
    w_user = None
    try:
        from databricks.sdk import WorkspaceClient
        from databricks.sdk.core import Config as UserConfig

        # auth_type="pat" forces the user token to be the SOLE credential, so the SDK
        # ignores the ambient SP OAuth env vars (DATABRICKS_CLIENT_ID/SECRET) that would
        # otherwise trigger "more than one authorization method configured: oauth and pat".
        user_cfg = UserConfig(host=cfg.host, token=user_token, auth_type="pat")
        w_user = WorkspaceClient(config=user_cfg)
        result["obo_identity"] = w_user.current_user.me().user_name
    except Exception as e:  # noqa: BLE001
        result["obo_identity_error"] = f"{type(e).__name__}: {e}"

    # 4) THE crux: mint a Lakebase credential AS THE CALLER and read session_user.
    if w_user is not None and "obo_identity" in result:
        try:
            token, method = _mint_lakebase_cred(w_user)
            result["mint_method"] = method
            su, cu = _pg_session_user(LAKEBASE_HOST, result["obo_identity"], token, PGDATABASE)
            result["pg_session_user"] = su
            result["pg_current_user"] = cu
        except Exception as e:  # noqa: BLE001
            result["pg_error"] = f"{type(e).__name__}: {e}"

    # 5) Verdict.
    su = result.get("pg_session_user")
    obo = result.get("obo_identity")
    sp = result.get("sp_identity")
    if su and obo and su == obo and su != sp:
        result["verdict"] = "L0_full_obo"
    elif su and sp and su == sp:
        result["verdict"] = "L1_session_user_is_sp"
    elif "pg_error" in result:
        result["verdict"] = "L1_cannot_mint_lakebase_cred_obo"
    else:
        result["verdict"] = "inconclusive"
    return result
