"""Execute the real npm workflow shell against a synthetic registry CLI."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")


class PublishWorkflowTest(unittest.TestCase):
    def setUp(self):
        workflow = (ROOT / ".github/workflows/publish.yml").read_text()
        matches = list(re.finditer(r"(?m)^      - name: ([^\r\n]+)\r?\n", workflow))
        self.names = [match.group(1) for match in matches]
        self.steps = {}
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(workflow)
            self.steps[match.group(1)] = workflow[match.end():end]
        self.assert_before("Preflight npm version", "Log in to ClawHub")
        self.assert_before("Preflight npm version", "Publish to ClawHub")

    def assert_before(self, first, second):
        self.assertLess(self.names.index(first), self.names.index(second))

    def run_script(self, step_name):
        lines = self.steps[step_name].splitlines()
        for index, line in enumerate(lines):
            if line == "        run: |":
                script = []
                for line in lines[index + 1:]:
                    if line.strip() and len(line) - len(line.lstrip()) < 10:
                        break
                    script.append(line[10:] if line.strip() else "")
                return "\n".join(script)
        raise AssertionError(f"Step {step_name!r} has no multiline run script")

    def run_case(self, scenario):
        preflight = self.run_script("Preflight npm version")
        publish = self.run_script("Publish to npm")
        fake = r'''
npm() {
  printf '%s\n' "$1" >> calls.txt
  if [[ "$1" == view ]]; then
    case "$SCENARIO" in
      exists) printf '"1.1.0"'; return 0 ;;
      auth) printf '{"error":{"code":"E401"}}'; return 1 ;;
      network) printf '{"error":{"code":"ENETUNREACH"}}'; return 1 ;;
      malformed) printf 'not-json'; return 1 ;;
      *) printf '{"error":{"code":"E404"}}'; return 1 ;;
    esac
  fi
  [[ "$SCENARIO" != publish_failure ]]
}
'''
        with tempfile.TemporaryDirectory(prefix="xmemo-publish-test-") as directory:
            path = Path(directory)
            (path / "package.json").write_text(json.dumps({"name": "@xmemo/openclaw-memory", "version": "1.1.0"}))
            env = {**os.environ, "SCENARIO": scenario}
            preflight_result = subprocess.run([BASH, "-c", fake + preflight], cwd=path,
                                              env=env, capture_output=True, text=True)
            if preflight_result.returncode == 0:
                publish_result = subprocess.run([BASH, "-c", fake + publish], cwd=path,
                                                env=env, capture_output=True, text=True)
            else:
                publish_result = preflight_result
            calls = (path / "calls.txt").read_text().splitlines()
            return publish_result.returncode, calls

    def test_absent_version_publishes_once(self):
        self.assertEqual(self.run_case("absent"), (0, ["view", "publish"]))

    def test_publish_failure_is_not_swallowed(self):
        code, calls = self.run_case("publish_failure")
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, ["view", "publish"])

    def test_existing_or_unverifiable_versions_never_publish(self):
        for scenario in ("exists", "auth", "network", "malformed"):
            with self.subTest(scenario=scenario):
                code, calls = self.run_case(scenario)
                self.assertNotEqual(code, 0)
                self.assertEqual(calls, ["view"])


if __name__ == "__main__":
    unittest.main()
