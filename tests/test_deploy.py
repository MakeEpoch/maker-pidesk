"""Exercise deployment routing with local command doubles; never opens SSH."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'calls.jsonl'
        self.release = self.root / 'release.tar.gz'
        self.release.write_bytes(b'test release')
        self.env_file = self.root / 'deployment.env'
        self.env_file.write_text(
            'PIDESK_DEPLOY_HOST=pi@fixture.local\n'
            'PIDESK_DEPLOY_PORT=2222\n'
            'PIDESK_DEPLOY_PASSWORD=fixture-password\n'
            'PIDESK_DEPLOY_KNOWN_HOSTS=\n'
        )
        self.env = os.environ.copy()
        self.env.update(PATH=str(self.bin)+os.pathsep+self.env['PATH'],
                        PIDESK_DEPLOY_ENV_FILE=str(self.env_file),
                        DEPLOY_TEST_LOG=str(self.log), DEPLOY_TEST_RELEASE=str(self.release))
        for key in ('PIDESK_DEPLOY_HOST', 'PIDESK_DEPLOY_PASSWORD', 'PIDESK_DEPLOY_SUDO_PASSWORD', 'SSHPASS'):
            self.env.pop(key, None)
        stub = '''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ['DEPLOY_TEST_LOG'],'a') as f:
    f.write(json.dumps({'tool':name,'args':sys.argv[1:]})+'\\n')
if name=='sshpass':
    assert sys.argv[1]=='-e'
    assert os.environ.get('SSHPASS')=='fixture-password'
    os.execvp(sys.argv[2],sys.argv[2:])
elif name=='python3':
    print(os.environ['DEPLOY_TEST_RELEASE'])
elif name=='ssh':
    command=sys.argv[-1]
    if command.startswith('mktemp '): print('/tmp/pidesk-deploy.fixture123')
    elif 'sudo -S' in command:
        assert sys.stdin.readline().rstrip('\\n')=='fixture-password'
        if os.environ.get('DEPLOY_TEST_FAIL_INSTALL'): sys.exit(7)
'''
        for name in ('ssh', 'scp', 'sshpass', 'python3'):
            path = self.bin / name
            path.write_text(stub)
            path.chmod(0o700)

    def run_deploy(self, target=''):
        return subprocess.run(['bash', str(ROOT/'ops/scripts/deploy.sh'), target],
                              cwd=ROOT, env=self.env, capture_output=True, text=True, timeout=5)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_local_environment_drives_target_port_and_password_without_leaking(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        ssh = [c for c in calls if c['tool']=='ssh']
        self.assertEqual(len(ssh), 3)
        self.assertTrue(all('pi@fixture.local' in c['args'] for c in ssh))
        self.assertTrue(all('-p' in c['args'] and '2222' in c['args'] for c in ssh))
        self.assertIn('sudo -S', ssh[1]['args'][-1])
        scp = next(c for c in calls if c['tool']=='scp')
        self.assertIn('-P', scp['args'])
        self.assertNotIn('fixture-password', json.dumps(calls)+result.stdout+result.stderr)

    def test_explicit_other_target_does_not_receive_saved_credentials(self):
        result = self.run_deploy('other@other.local')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertFalse(any(c['tool']=='sshpass' for c in calls))
        ssh = [c for c in calls if c['tool']=='ssh']
        self.assertTrue(all('other@other.local' in c['args'] for c in ssh))
        self.assertIn('sudo bash', ssh[1]['args'][-1])
        self.assertNotIn('sudo -S', ssh[1]['args'][-1])

    def test_bad_target_and_port_stop_before_packaging_or_connecting(self):
        result = self.run_deploy('bad;hostname')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])
        with self.env_file.open('a') as f:
            f.write('PIDESK_DEPLOY_PORT=65536\n')
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_failed_install_is_not_followed_by_success_or_staging_cleanup(self):
        self.env['DEPLOY_TEST_FAIL_INSTALL'] = '1'
        result = self.run_deploy()
        self.assertEqual(result.returncode, 7)
        ssh = [c for c in self.calls() if c['tool']=='ssh']
        self.assertEqual(len(ssh), 2)
        self.assertFalse(any('rm -rf' in c['args'][-1] for c in ssh))


if __name__ == '__main__':
    unittest.main()
