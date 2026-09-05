"""Token auth, CSRF, CORS and the open paths a dashboard may rely on."""
from __future__ import annotations

from tests.base import TwinBrainTestCase, auth_headers

from server import security


class SecurityTests(TwinBrainTestCase):

    def test_api_requires_token(self):
        response = self.client.get("/api/pages")
        self.assertEqual(response.status_code, 401)

    def test_wrong_token_rejected(self):
        response = self.client.get("/api/pages", headers={
            "Authorization": "Bearer not-the-token", "X-Requested-With": "TwinBrain"})
        self.assertEqual(response.status_code, 401)

    def test_health_is_open_but_not_leaky(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["ok"])
        self.assertNotIn("auth_token", body.get("settings", {}))

    def test_cross_origin_write_without_custom_header_is_blocked(self):
        token = security.get_token()
        response = self.client.post("/api/capture",
                                    json={"url": "https://evil.example/x", "title": "x",
                                          "text": "drive-by " * 30},
                                    headers={"Authorization": f"Bearer {token}",
                                             "Origin": "https://evil.example"})
        self.assertEqual(response.status_code, 401,
                         "a cross-site POST without the custom header must fail")

    def test_extension_origin_is_allowed(self):
        token = security.get_token()
        response = self.client.post("/api/capture",
                                    json={"url": "https://example.com/ext", "title": "ext",
                                          "text": "extension capture payload. " * 12},
                                    headers={"Authorization": f"Bearer {token}",
                                             "X-Requested-With": "TwinBrain",
                                             "Origin": "chrome-extension://abcdef"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("chrome-extension://abcdef",
                      response.headers.get("Access-Control-Allow-Origin", ""))

    def test_token_query_param_works_for_links(self):
        token = security.get_token()
        response = self.client.get(f"/api/export?token={token}")
        self.assertEqual(response.status_code, 200)

    def test_unknown_write_keys_are_rejected_not_crashed(self):
        response = self.api("post", "/api/settings",
                            json={"nonsense_key": 1, "top_k": 6})
        body = response.get_json()
        self.assertIn("nonsense_key", body["rejected"])
        self.assertEqual(body["applied"]["top_k"], 6)

    def test_wipe_requires_confirmation_phrase(self):
        response = self.api("post", "/api/wipe", json={"confirm": "please"})
        self.assertEqual(response.status_code, 409)
        response = self.api("post", "/api/wipe", json={"confirm": "DELETE ALL"})
        self.assertEqual(response.status_code, 200)

    def test_dashboard_pages_set_the_pairing_cookie(self):
        # this cookie is what lets a same-origin browser auto-pair at /api/token;
        # without it the dashboard loads but every authenticated call 401s
        for path in ("/", "/index.html", "/pair"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            cookies = response.headers.getlist("Set-Cookie")
            self.assertTrue(any(security.COOKIE_NAME in c for c in cookies),
                            f"{path} must set the pairing cookie")

    def test_health_says_when_unauthenticated(self):
        # the dashboard relies on this flag: 200 alone must never mean "logged in"
        self.client.delete_cookie(security.COOKIE_NAME)   # drop any paired session
        body = self.client.get("/api/health").get_json()
        self.assertFalse(body["authenticated"])

    def test_auth_headers_helper_matches_server_expectations(self):
        self.assertEqual(auth_headers()["X-Requested-With"], security.CUSTOM_HEADER_VALUE)
