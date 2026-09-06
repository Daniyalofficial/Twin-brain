"""Drift guards for the on-device brain.

The extension must keep working with no backend and no internet: capture is
remembered in IndexedDB, answers come from the local retrieval engine, and the
web is only consulted with explicit permission. These tests fail if that wiring
is ever disconnected again.

(The retrieval maths itself is unit-tested under tests/js/ with `node --test`.)
"""
from __future__ import annotations

import unittest

from tests.base import ROOT

EXT = ROOT / "extension"


def read(relative: str) -> str:
    return (EXT / relative).read_text(encoding="utf-8")


class LocalFirstWiringTests(unittest.TestCase):

    def setUp(self):
        self.background = read("background.js")
        self.store = read("lib/store.js")
        self.defaults = read("lib/defaults.js")
        self.popup = read("popup/popup.js")

    def test_service_worker_imports_the_on_device_brain(self):
        self.assertIn("import * as brain from './lib/brain/brain.js'", self.background)

    def test_capture_is_remembered_locally_before_the_backend_mirror(self):
        self.assertIn("rememberLocally", self.background)
        self.assertIn("brain.ingestPage", self.background)
        # no_ai / no-content pages must never enter the on-device brain either
        self.assertIn("if (body.text && mode === 'full') await rememberLocally(payload);",
                      self.background)

    def test_tb_query_is_answered_on_device(self):
        self.assertIn("case 'tb-query': {", self.background)
        self.assertIn("brain.answer(message.query", self.background)
        self.assertNotIn("return await proxied(() => api.query(", self.background)

    def test_pages_stats_suggestions_digest_are_local_first(self):
        for fragment in ("case 'tb-pages': {", "case 'tb-stats': {",
                         "case 'tb-suggestions': {", "case 'tb-digest': {",
                         "brain.pagesNow()", "brain.brainStats()"):
            self.assertIn(fragment, self.background)

    def test_forget_erases_from_the_local_brain(self):
        self.assertIn("brain.forgetPage(", self.background)
        self.assertIn("brainForgetDomain(", self.background)

    def test_daily_self_training_alarm_exists(self):
        self.assertIn("const DAILY_ALARM = 'tb-daily';", self.background)
        self.assertIn("brain.selfLearn(await getSettings())", self.background)
        self.assertIn("chrome.alarms.create(DAILY_ALARM", self.background)

    def test_indexeddb_has_the_brain_stores_at_version_2(self):
        self.assertIn("const DB_VERSION = 2;", self.store)
        for store_name in ("const CHUNKS = 'chunks'", "const INTERESTS = 'interests'",
                           "const CONVS = 'convs'", "const AUDIT = 'audit'"):
            self.assertIn(store_name, self.store)
        for fn in ("export async function putChunks", "export async function getAllChunks",
                   "export async function deleteChunksByPage", "export async function addAudit"):
            self.assertIn(fn, self.store)


class PermissionGatedWebTests(unittest.TestCase):

    def setUp(self):
        self.background = read("background.js")
        self.defaults = read("lib/defaults.js")
        self.popup = read("popup/popup.js")
        self.brain = read("lib/brain/brain.js")

    def test_defaults_ask_before_touching_the_internet(self):
        self.assertIn("webPermission: 'ask'", self.defaults)
        self.assertIn("notificationDailyBudget: 5", self.defaults)
        self.assertIn("webSearchDailyBudget: 40", self.defaults)

    def test_brain_returns_needs_permission_instead_of_searching(self):
        self.assertIn("mode: 'needs_permission'", self.brain)
        self.assertIn("needsPermission = true", self.brain)
        # never-search must be honoured even when the user asked for the web
        self.assertIn("permission === 'never'", self.brain)

    def test_every_outbound_search_is_budgeted_and_audited(self):
        self.assertIn("webBudget(settings)", self.brain)
        self.assertIn("store.addAudit", self.brain)
        self.assertIn("bumpWebBudget", self.brain)

    def test_popup_renders_the_permission_card(self):
        self.assertIn("perm-card", self.popup)
        self.assertIn("Allow once", self.popup)
        self.assertIn("Always allow web", self.popup)
        self.assertIn("Not now", self.popup)
        self.assertIn("data.mode === 'needs_permission'", self.popup)

    def test_web_permission_message_handler_exists(self):
        self.assertIn("case 'tb-web-permission': {", self.background)


class ExplainerContractTests(unittest.TestCase):
    """The teacher voice must cite, simplify and never invent."""

    def setUp(self):
        self.explain = read("lib/brain/explain.js")
        self.text = read("lib/brain/text.js")

    def test_explanation_has_the_promised_sections(self):
        for section in ("opener", "simple", "points", "words", "connect",
                        "webNotes", "citations", "further", "followups", "honesty"):
            self.assertIn(section, self.explain)

    def test_ungrounded_answers_stay_honest(self):
        self.assertIn("HONEST_LINES", self.explain)
        self.assertIn("pretend otherwise", self.explain)
        self.assertIn("make things up", self.explain)

    def test_web_citations_are_badged_separately_from_memory(self):
        self.assertIn("kind: 'web'", self.explain)
        self.assertIn("kind: 'memory'", self.explain)

    def test_plain_teacher_dictionary_and_simplifier_exist(self):
        self.assertIn("export const PLAIN", self.text)
        self.assertIn("export function simplify", self.text)


if __name__ == "__main__":
    unittest.main()


class RealtimeFriendTests(unittest.TestCase):
    """The real-time friend layer must stay wired end to end."""

    def setUp(self):
        self.background = read("background.js")
        self.popup = read("popup/popup.js")
        self.brain = read("lib/brain/brain.js")
        self.defaults = read("lib/defaults.js")
        self.understand = read("lib/brain/understand.js")
        self.persona = read("lib/brain/persona.js")
        self.direct = read("lib/brain/direct.js")

    def test_understanding_layer_exists(self):
        for fragment in ("export function parseQuery", "export function extractFacts",
                         "export function questionType", "export function parseTimeRange"):
            self.assertIn(fragment, self.understand)

    def test_persona_layer_exists(self):
        for fragment in ("export function displayName", "export function greeting",
                         "export function questionBack", "export function weaveFacts",
                         "export function hedgeLine"):
            self.assertIn(fragment, self.persona)

    def test_direct_answers_exist(self):
        self.assertIn("export function directAnswer", self.direct)
        for case in ("case 'when'", "case 'count'", "case 'which_source'",
                     "case 'verify'", "case 'recap'", "case 'compare'"):
            self.assertIn(case, self.direct)

    def test_brain_uses_the_realtime_layers(self):
        for fragment in ("parseQuery(query, { history", "directAnswer(parsed",
                         "loadFacts", "saveFacts", "mode: 'clarify'",
                         "hooks.progress", "questionBack(facts"):
            self.assertIn(fragment, self.brain)

    def test_background_streams_thinking_to_the_popup(self):
        self.assertIn("progress: (text)", self.background)
        self.assertIn("tb-thought", self.background)

    def test_popup_streams_answers_like_a_chat(self):
        for fragment in ("renderAnswerLive", "typeInto", "tb-thought",
                         "activeThinking", "streamToken", "friend-question",
                         "Straight answer"):
            self.assertIn(fragment, self.popup)

    def test_user_name_setting_exists(self):
        self.assertIn("userName: ''", self.defaults)
        self.assertIn('id="set-userName"', read("options/options.html"))
        self.assertIn("'userName'", read("options/options.js"))


class TwinCoreTests(unittest.TestCase):
    """Real-model slot, emotions, policies, growth and multi-hop research."""

    def setUp(self):
        self.background = read("background.js")
        self.popup = read("popup/popup.js")
        self.brain = read("lib/brain/brain.js")
        self.defaults = read("lib/defaults.js")
        self.neural = read("lib/brain/neural.js")
        self.policy = read("lib/brain/policy.js")
        self.emotion = read("lib/brain/emotion.js")
        self.growth = read("lib/brain/growth.js")
        self.research = read("lib/brain/research.js")
        self.options_html = read("options/options.html")

    def test_neural_provider_framework(self):
        for fragment in ("export async function detectProvider", "export async function* streamChat",
                         "export function parseOllamaChunk", "export function parseSSELine",
                         "export function pickModel", "'twinbrain'"):
            self.assertIn(fragment, self.neural)

    def test_policy_guardrails(self):
        for fragment in ("export function screenInput", "CRISIS_RESPONSE", "export function redact",
                         "export function screenLinks", "export function memoryAllowedFor",
                         "findahelpline"):
            self.assertIn(fragment, self.policy)

    def test_emotion_engine(self):
        for fragment in ("export function detectEmotion", "export function storyArc",
                         "export function tonePlan", "INTENSIFIERS", "NEGATORS"):
            self.assertIn(fragment, self.emotion)

    def test_growth_and_modelfile_export(self):
        for fragment in ("export function buildGrowthPack", "export function makeStudyPlan",
                         "export function buildModelfile", "export function rollingSummary",
                         "ollama create"):
            self.assertIn(fragment, self.growth)

    def test_multi_hop_research(self):
        for fragment in ("export async function researchLoop", "export function coverageScore",
                         "export function refinedQuery", "budgetRemaining"):
            self.assertIn(fragment, self.research)

    def test_brain_wires_the_twin_core(self):
        for fragment in ("screenInput(parsed.raw)", "detectEmotion(parsed.raw)",
                         "getProvider(settings)", "buildNeuralMessages", "hooks.token",
                         "researchLoop(effective", "maybeStudyPlan", "getGrowthPack(true)",
                         "storyResponse", "streamChat(provider"):
            self.assertIn(fragment, self.brain)

    def test_background_streams_real_model_tokens(self):
        for fragment in ("token: (text) => broadcast('tb-token', { text })",
                         "case 'tb-neural-status'", "case 'tb-modelfile'",
                         "case 'tb-growth'"):
            self.assertIn(fragment, self.background)

    def test_popup_renders_live_neural_stream(self):
        for fragment in ("tb-token", "activeStreamBox", "neural-stream", "providerLabel",
                         "activeReqId"):
            self.assertIn(fragment, self.popup)

    def test_defaults_are_local_first_and_private(self):
        self.assertIn("neuralEnabled: true", self.defaults)
        self.assertIn("sendMemoryToCloud: false", self.defaults)
        self.assertIn("researchHops: 3", self.defaults)
        self.assertIn("ollamaUrl: 'http://127.0.0.1:11434'", self.defaults)

    def test_options_expose_the_neural_engine(self):
        for fragment in ('id="set-neuralBackend"', 'id="set-ollamaUrl"', 'id="set-sendMemoryToCloud"',
                         'id="btn-modelfile"', 'id="btn-neural-test"', 'id="set-researchHops"'):
            self.assertIn(fragment, self.options_html)
