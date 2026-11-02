import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from pidesk.app import State
from pidesk.layouts import EMPTY_LAYOUT, valid_layout
from pidesk.storage import DEFAULT


class LayoutTests(unittest.TestCase):
    def test_bad_layouts_rejected_as_a_whole_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            path.write_text(json.dumps(DEFAULT))
            state = State(copy.deepcopy(DEFAULT), path, Path(directory) / 'weather.json')
            original = path.read_bytes()
            bad_items = [
                {'unit': 'f'}, {'x': True}, {'x': -1}, {'x': 480}, {'width': 0}, {'font': 97},
                {'visible': 'yes'}, {'locked': 1}, {'z': 101}, {'group': '<script>'},
                {'color': 'url(secret)'}, {'align': 'start'}, {'overflow': 'visible'},
                {'x': 470, 'width': 20}, {'y': 310, 'height': 20}, {'unknown': 1},
            ]
            for item in bad_items:
                layout = copy.deepcopy(EMPTY_LAYOUT)
                layout['landscape']['clock'] = item
                with self.subTest(item=item):
                    self.assertFalse(valid_layout(layout))
                    with self.assertRaises(ValueError):
                        state.update_controls({'rotation': 90, 'screen_layout': layout})
                    self.assertEqual(path.read_bytes(), original)
            for value in (None, [], {}, {**EMPTY_LAYOUT, 'version': True}, {**EMPTY_LAYOUT, 'extra': 1}):
                self.assertFalse(valid_layout(value))

    def test_layout_survives_reload_and_triggers_render_without_losing_private_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = copy.deepcopy(DEFAULT)
            config['private_setting'] = 'retain'
            path = root / 'settings.json'
            path.write_text(json.dumps(config))
            state = State(config, path, root / 'weather.json')
            signature = state.render_signature()
            layout = copy.deepcopy(EMPTY_LAYOUT)
            layout['landscape']['clock'] = {'x': 220, 'y': 40, 'font': 48, 'visible': True, 'group': 'none'}
            layout['portrait']['clock'] = {'x': 30, 'y': 200, 'locked': True}
            state.update_controls({'rotation': 270, 'screen_layout': layout})
            restored = State(json.loads(path.read_text()), path, root / 'weather.json')
            self.assertEqual(restored.controls()['screen_layout'], layout)
            self.assertNotEqual(restored.render_signature(), signature)
            self.assertEqual(restored.config['private_setting'], 'retain')
            self.assertEqual(restored.rotation(), 270)

    def test_js_defaults_have_exactly_the_server_allowlisted_ids_and_valid_bounds(self):
        from pidesk.layouts import ELEMENT_IDS
        import shutil
        if not shutil.which('node'):
            self.skipTest('Node unavailable')
        script = "const L=require('./app/web/layout.js');console.log(JSON.stringify({version:1,landscape:L.defaults('landscape','agents'),portrait:L.defaults('portrait','agents')}));"
        root = Path(__file__).resolve().parents[1]
        layout = json.loads(subprocess.check_output(['node', '-e', script], cwd=root))
        self.assertEqual(set(layout['landscape']), ELEMENT_IDS)
        self.assertTrue(valid_layout(layout))


if __name__ == '__main__':
    unittest.main()
