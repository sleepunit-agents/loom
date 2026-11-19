import io
import json
from pathlib import Path
import runpy
import unittest

project = runpy.run_path(str(Path(__file__).with_name('project-lane-machine-fact.py')))['project']
NOW = 2_000_000_000


def rows(*records):
    return io.BytesIO(b''.join(json.dumps(record).encode() + b'\n' for record in records))


class MachineFacts(unittest.TestCase):
    def test_tuning_survives_window_without_disclosing_cause(self):
        common = dict(kind='verdict', source='disk', verdict='false-alarm')
        evidence = rows(dict(common, ts=NOW-6*86400, cause='Low   Space'),
                        dict(common, ts=NOW-60, cause='low space'),
                        dict(kind='triage-joined', source='disk', ts=NOW-5))
        result = project('alert-ledger', evidence, NOW)
        self.assertEqual(result['tuneSources'], ['disk'])
        self.assertEqual(len(result['entries']), 2)
        self.assertNotIn('space', str(result).lower())

    def test_complete_cleanup(self):
        result = project('cleanup-receipt', rows(
            dict(at=NOW-10,event='start',count=5,apply=True),
            dict(at=NOW-9,action='removed',head='f'*40,path='private',branch='private'),
            dict(at=NOW-8,event='finish',count=4,apply=True)), NOW)
        self.assertEqual([r['count'] for r in result['runs']], [5,4])
        self.assertEqual(result['removedHeads'], ['f'*40])
        self.assertNotIn('private', str(result))

    def test_journal_bound_and_source(self):
        record = {'_SYSTEMD_USER_UNIT':'art-worktree-cleanup.service','PRIORITY':'3',
                  '__REALTIME_TIMESTAMP':str(NOW*1000000),'MESSAGE':'private'}
        result = project('cleanup-week-journal', rows(*[record]*101), NOW)
        self.assertEqual(result['total'], 101)
        self.assertEqual(len(result['recent']), 100)
        self.assertNotIn('private', str(result))
        with self.assertRaises(ValueError):
            project('cleanup-week-journal', rows(dict(record,_SYSTEMD_USER_UNIT='other')), NOW)

    def test_login_projects_only_deadline(self):
        login = {'claudeAiOauth':{'accessToken':'opaque','refreshTokenExpiresAt':NOW*1000}}
        result = project('login-expiry', rows(login), NOW)
        self.assertEqual(result, {'observedAt': NOW, 'refreshExpiresAt':NOW})

    def test_mirror_identity_and_counts(self):
        result = project('mirror-freshness',io.BytesIO(b'tracked max: t-1  live max: t-25  drift: 24\n'), NOW)
        self.assertEqual(result['liveMax']-result['trackedMax'], 24)
        with self.assertRaises(ValueError):
            project('mirror-unit-state', io.BytesIO(b'Id=other.service\n'), NOW)


if __name__ == '__main__':
    unittest.main()
