"""Keep the browser extension honest about what the server promises.

The extension ships its own copy of the privacy defaults (it must filter
*before* anything is captured, even offline), so the two lists must not drift.
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from tests.base import ROOT

EXT = ROOT / "extension"


def read(relative: str) -> str:
    return (EXT / relative).read_text(encoding="utf-8")


class ManifestTests(unittest.TestCase):

    def setUp(self):
        self.manifest = json.loads(read("manifest.json"))

    def test_manifest_v3_and_module_worker(self):
        self.assertEqual(self.manifest["manifest_version"], 3)
        worker = self.manifest["background"]["service_worker"]
        self.assertTrue(self.manifest["background"].get("type", "module") == "module")
        self.assertTrue((EXT / worker).exists())

    def test_permissions_are_the_ones_the_design_needs(self):
        perms = set(self.manifest["permissions"])
        for needed in ("storage", "unlimitedStorage", "tabs", "scripting",
                       "contextMenus", "alarms", "notifications"):
            self.assertIn(needed, perms)
        # deliberately NOT requested: history, downloads, debugger, bookmarks
        for forbidden in ("history", "debugger", "bookmarks", "topSites"):
            self.assertNotIn(forbidden, perms)

    def test_every_referenced_file_exists(self):
        referenced = []
        referenced.append(self.manifest["background"]["service_worker"])
        for page in ("options_page", "options_ui"):
            entry = self.manifest.get(page)
            if isinstance(entry, dict):
                referenced.append(entry.get("page"))
            elif isinstance(entry, str):
                referenced.append(entry)
        for icon_set in self.manifest.get("icons", {}).values():
            referenced.append(icon_set)
        for action in ("default_icon",):
            icons = self.manifest.get("action", {}).get(action, {})
            referenced.extend(icons.values())
        for path in referenced:
            if not path:
                continue
            self.assertTrue((EXT / path).exists(), f"missing {path}")

    def test_commands_defined(self):
        commands = self.manifest.get("commands", {})
        self.assertIn("toggle-pause", commands)
        self.assertIn("ask-about-page", commands)
        self.assertIn("forget-page", commands)


class PrivacyListSyncTests(unittest.TestCase):

    def test_default_blocklist_matches_the_server(self):
        from server import db
        js = read("lib/defaults.js")
        block = js.split("export const DEFAULT_BLOCKLIST = {", 1)[1].split("};", 1)[0]
        domains = set(re.findall(r"'([a-z0-9.\-]+)'\s*:\s*'", block))
        server_domains = set(db.DEFAULT_BLOCKLIST)
        self.assertEqual(domains, server_domains,
                         "extension blocklist drifted from server/db.py")

    def test_domain_modes_are_the_same_three(self):
        js = read("lib/defaults.js")
        for mode in ("full", "no_ai", "off"):
            self.assertIn(f"'{mode}'" if f"'{mode}'" in js else f"{mode}:", js)

    def test_content_scripts_are_classic_not_modules(self):
        # injected via chrome.scripting.executeScript({files}) -> no import/export
        for path in ("content/extractor.js", "content/observer.js"):
            source = read(path)
            self.assertNotIn("import ", source, f"{path} must be a classic script")
            self.assertNotIn("export ", source, f"{path} must be a classic script")

    def test_worker_and_pages_are_modules(self):
        for path in ("background.js", "popup/popup.js", "options/options.js"):
            source = read(path)
            self.assertTrue(("import " in source) or ("chrome." in source), path)

    def test_exclusion_gate_runs_before_injection(self):
        source = read("background.js")
        gate = source.find("shouldObserve")
        inject = source.find("chrome.scripting.executeScript")
        self.assertGreater(gate, -1)
        self.assertGreater(inject, -1)
        self.assertLess(gate, inject,
                        "the privacy gate must be evaluated before any injection")

    def test_incognito_is_never_captured(self):
        source = read("background.js")
        self.assertIn("incognito", source)
        self.assertRegex(source, r"incognito[^;]{0,120}(return|false)")


if __name__ == "__main__":
    unittest.main()
