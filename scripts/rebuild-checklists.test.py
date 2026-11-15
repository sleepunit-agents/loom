"""Exercise the generator in-process on disposable copies; never spawn a child."""
import contextlib
import io
import json
import runpy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

class ChecklistGeneration(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='loom-checklists-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for directory, pattern in [('docs/how-it-works/site', '*.html'), ('docs/rebuild-checklists', '*.json')]:
            target = self.root / directory
            target.mkdir(parents=True)
            for source in (ROOT / directory).glob(pattern):
                shutil.copyfile(source, target / source.name)
        self.script = self.root / 'scripts/rebuild-checklists.py'
        self.script.parent.mkdir()
        shutil.copyfile(ROOT / 'scripts/rebuild-checklists.py', self.script)
        self.task = self.root / 'docs/rebuild-checklists/tasks.json'
        self.original = self.task.read_bytes()

    def run_generator(self, *args):
        with patch.object(sys, 'argv', [str(self.script), *args]), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(self.script), run_name='__main__')

    def test_check_preserves_all_current_files(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.run_generator('--check')
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_check_rejects_drift_without_repairing_it(self):
        changed = json.loads(self.original)
        row = next(row for row in changed['promises'] if row.get('probe'))
        row['promise'] = 'Text absent from the approved page'
        corrupted = (json.dumps(changed, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
        self.assertNotEqual(corrupted, self.original)
        self.task.write_bytes(corrupted)
        with self.assertRaises(SystemExit) as failure:
            self.run_generator('--check')
        self.assertNotEqual(failure.exception.code, 0)
        self.assertIn('tasks.json', str(failure.exception))
        self.assertEqual(self.task.read_bytes(), corrupted)

    def test_check_rejects_a_missing_copy_without_creating_it(self):
        self.task.unlink()
        with self.assertRaises(SystemExit):
            self.run_generator('--check')
        self.assertFalse(self.task.exists())

    def test_normal_generation_repairs_metadata_and_keeps_bound_probes(self):
        changed = json.loads(self.original)
        changed['title'] = 'Incorrect generated title'
        self.task.write_text(json.dumps(changed))
        self.run_generator()
        self.assertEqual(self.task.read_bytes(), self.original)

if __name__ == '__main__':
    unittest.main()
