# MCP packages

[Model Context Protocol](https://modelcontextprotocol.io/) servers that talk to this repo’s **Insight QA dashboard** and related tooling.

| Folder | Description |
|--------|-------------|
| **`NTGR-Insight_QA/`** | Primary MCP — server name **`NTGR-Insight_QA`**, stdio entry `index.js`. Proxies HTTP to a running `node dashboard/server.js`. Full tool list and Cursor setup: **`NTGR-Insight_QA/README.md`**. |
| **`custom-mongodb/`** | Optional local **`mongodb`** driver bundle for scripts that `require('mongodb')` without a global install — see folder README. |

Start the dashboard **before** connecting an MCP client so tools that call `/api/...` succeed.
