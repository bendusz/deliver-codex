# Native operations

`assets/operations.json` is the installed operation map. Invoke an operation as
`$deliver <operation> [arguments]` or describe the same request in ordinary language. These are
skill routes, not registered slash commands. Free-form text passed to the `deliver` launcher is a
prompt, not another command registry. Low-level `scripts/deliver.mjs` and `scripts/pm.mjs` commands
remain implementation tools and have their own help output.

For a named operation:

1. Find its exact name or alias in the map.
2. Read only its `reference`, plus applicable project instructions and the operation's named inputs.
3. Respect `mutation.mode`, `mutation.paths` and `mutation.external`. `read-only` means no writes,
   Git mutations or external messages.
4. Return the declared output. A listed path is authority only for that operation and approved scope;
   it is not a wildcard grant to overwrite existing work.

An operation mapped to a current general reference may gain a narrower reference in a later release.
Do not invent a missing path or imply that future runtime support already exists. When an operation
transitions to another phase, load that phase's reference only after its Enter rule holds.

Project templates live under `assets/templates/`. Resolve every path relative to the installed skill
directory. Never use a remembered plugin cache path or a Claude-specific root variable.
