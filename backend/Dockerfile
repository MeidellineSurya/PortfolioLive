FROM python:3.12-slim

WORKDIR /app

# Copied and installed before the rest of the source so `docker build`
# only re-runs `pip install` when dependencies actually change, not on
# every code edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser

# Railway assigns the listen port at runtime via $PORT and routes traffic
# to whatever that is — it is not always 8000, so this must not be
# hardcoded. Shell-form CMD (not the `["...", "..."]` exec form) is
# required for $PORT to actually be expanded; the exec form passes it to
# uvicorn literally as the string "$PORT".
#
# `exec` matters here beyond style: without it, /bin/sh runs as PID 1 and
# uvicorn as its child, so `docker stop`'s SIGTERM goes to the shell, not
# to uvicorn — and a plain `/bin/sh` isn't guaranteed to forward it. That
# would mean the app's graceful-shutdown path (main.py's lifespan
# try/finally, which closes the Alpaca stream connection on exit — see
# the decision log, commit 7a, on why an unclosed connection is a real
# problem given Alpaca allows only one per account) never runs on a
# Railway redeploy; the container would just hang until Docker's SIGKILL
# timeout. `exec` replaces the shell process with uvicorn itself, so
# uvicorn *is* PID 1 and receives SIGTERM directly.
EXPOSE 8000
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
