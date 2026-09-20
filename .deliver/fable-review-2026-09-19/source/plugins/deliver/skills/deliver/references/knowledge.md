# Optional project knowledge

No wiki is required by Quick or Managed. Prefer a small pointer index to current specs,
decisions, research and verification evidence. Keep decisions in their authoritative document
or an existing ADR system. An index must not become a second specification.

Offer a wiki when repeated cross-session questions justify it, or when the user requests one.
Use `deliver-librarian` for a bounded ingest, query or lint operation. The role owns only the
explicitly authorized knowledge directory. Research writes need their own authorized scope.
Do not automatically ingest every story or import all historical artifacts.

- Ingest: read selected sources, add only durable facts or decisions, cite source path and
  section/revision, and supersede stale pages without rewriting the source.
- Query: inspect the index, load only relevant pages, cite their authoritative sources and
  distinguish established facts from inference. Conflicts require checking the sources.
- Lint: report missing links, uncited claims, contradictory current decisions, and superseded
  references. Do not fix anything during a lint request.

Never put credentials in committed knowledge. External research and provider calls need the
host's ordinary permissions. If Poteto or official SpecDD skills are available, use only the
relevant skill; neither plugin is a dependency of this distribution.
