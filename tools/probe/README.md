# Forge API probe

A dependency-free script that sends read-only GET requests to a running Forge Neo instance and records
what the API returns. The results decide a few client defaults (how modules are passed, the name of the
shift option, whether the thumbnail route exists).

## Run

Start Forge Neo with `--api`, then from the repository root:

```
node tools/probe/probe.mjs http://127.0.0.1:7860
```

Replace the address with the one your Forge instance listens on. Node 18 or newer is required.

The script prints a short summary and writes the full result to `tools/probe/probe-report.json`.
A failed request is recorded in the report and does not stop the others.

## Send the report

Send `tools/probe/probe-report.json` back to the maintainer. The file contains model and LoRA file names
from your machine, so skim it first if that matters to you. It is git-ignored and never committed.
