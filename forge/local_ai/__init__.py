"""Free generation on the user's own GPU: hardware check, model catalog, a managed runtime and a worker process.

Nothing here imports torch. The heavy libraries live in their own virtual environment under the local AI folder
(`runtime.py` installs it with uv), and `worker_main.py` runs inside it. Tessera talks to that worker over pipes.
"""
