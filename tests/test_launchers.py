"""The one-click launchers must stay usable on a clean Windows / Linux box.

run.bat in particular is fragile: cmd.exe parses batch files in the ANSI
codepage and mis-parses LF-only line endings inside parenthesised blocks, so
the file must stay CRLF + pure ASCII, and it must never close the window on an
error (the user has to see what went wrong).
"""
from __future__ import annotations

import os
import stat
import unittest

from tests.base import ROOT

BAT = ROOT / "run.bat"
SH = ROOT / "run.sh"


class LauncherTests(unittest.TestCase):

    def test_run_bat_exists_and_is_crlf_ascii(self):
        self.assertTrue(BAT.exists(), "run.bat is the Windows entry point")
        raw = BAT.read_bytes()
        self.assertTrue(raw.isascii(),
                        "run.bat must be pure ASCII (cmd parses it in the ANSI codepage)")
        self.assertIn(b"\r\n", raw)
        lone_lf = raw.replace(b"\r\n", b"").count(b"\n")
        self.assertEqual(lone_lf, 0, "every line in run.bat must end with CRLF")

    def test_run_bat_is_defensive(self):
        text = BAT.read_text(encoding="ascii")
        for needed in ("server.app", "requirements.txt", "pause",
                       ":try_venv", "no_python", "cd /d"):
            self.assertIn(needed, text, f"run.bat lost its {needed} safeguard")
        # tries the py launcher first (plain `python` is often a Store stub)
        lines = [line.strip() for line in text.splitlines()]
        py_launcher = next(i for i, l in enumerate(lines) if l.endswith("call :try_venv py -3"))
        bare_python = next(i for i, l in enumerate(lines) if l.endswith("call :try_venv python"))
        self.assertLess(py_launcher, bare_python,
                        "the py launcher must be attempted before bare python")
        # never closes the window on an error without showing the user why
        for position, line in enumerate(lines):
            if line.startswith("exit /b 1"):
                self.assertTrue(lines[position - 1].startswith(("pause", "rem")),
                                f"errors must be visible before the window closes: {line}")

    def test_run_sh_exists_and_is_executable(self):
        self.assertTrue(SH.exists())
        mode = os.stat(SH).st_mode
        self.assertTrue(mode & stat.S_IXUSR, "run.sh must keep its executable bit")
        text = SH.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("#!/usr/bin/env bash"))
        self.assertIn("server.app", text)
        self.assertIn("requirements.txt", text)

    def test_requirements_stay_minimal(self):
        req = (ROOT / "requirements.txt").read_text()
        active = [line.strip() for line in req.splitlines()
                  if line.strip() and not line.strip().startswith("#")]
        self.assertIn("flask>=3.0", active)
        # nothing here may require a compiler or a GPU on a fresh machine
        for forbidden in ("torch", "tensorflow", "sentence-transformers", "rich"):
            self.assertNotIn(forbidden, " ".join(active).lower(),
                             f"{forbidden} must stay an optional comment")


if __name__ == "__main__":
    unittest.main()
