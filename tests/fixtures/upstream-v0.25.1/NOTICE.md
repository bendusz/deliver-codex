# Upstream compatibility fixtures

The hook reader and templates in this directory are copied without changes from
https://github.com/bendusz/deliver at revision
`3aa3f3a0a6baed15e9a8a99ef15405b79efd37aa`, Deliver 0.25.1.
Copyright (c) 2026 bendusz. GPL-3.0-or-later, as provided in the upstream LICENSE.

`provenance.json` records each source path and SHA-256 content hash. The reader has
no package dependencies; it imports only the listed Node.js built-in modules.
These files are test oracles, not production runtime code. Do not edit them to make
a compatibility test pass. Pin a separate fixture directory for a newer upstream.
