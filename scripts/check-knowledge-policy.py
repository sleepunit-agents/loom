"""Report structural editorial-policy violations on active knowledge pages."""
import argparse
import re
import sqlite3
from contextlib import closing
from pathlib import Path

DOMAIN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*")


def findings(db):
    rows = db.execute("""
        SELECT p.slug, p.domain, p.sla_class, p.sourcing,
               EXISTS (SELECT 1 FROM citations c WHERE c.page_id=p.id
                       AND c.source_kind IN ('web', 'repo', 'loom_memory')
                       AND trim(coalesce(c.source_locator, '')) <> '')
        FROM pages p WHERE p.status='active' ORDER BY p.slug
    """)
    for slug, domain, sla, tier, has_evidence in rows:
        if not DOMAIN.fullmatch(domain or ''):
            yield slug, 'invalid-domain-path'
        if sla not in ('software', 'device', 'default'):
            yield slug, 'unknown-freshness-class'
        if tier not in ('provisional', 'sourced', 'internal'):
            yield slug, 'unknown-sourcing-tier'
        if tier == 'internal' and not (domain or '').startswith('ours/'):
            yield slug, 'internal-tier-outside-ours'
        if tier in ('sourced', 'internal') and not has_evidence:
            yield slug, 'missing-evidence-locator'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    args = parser.parse_args()
    uri = args.database.resolve().as_uri() + '?mode=ro'
    try:
        with closing(sqlite3.connect(uri, uri=True)) as db:
            issues = list(findings(db))
    except sqlite3.Error as exc:
        parser.exit(2, f'Cannot inspect knowledge store: {exc}\n')
    for slug, rule in issues:
        print(f'{slug}\t{rule}')
    return int(bool(issues))


if __name__ == '__main__':
    raise SystemExit(main())
