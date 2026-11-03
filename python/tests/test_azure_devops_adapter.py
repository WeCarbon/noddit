"""adapters/azure_devops_sync.py against fake Azure DevOps responses."""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "adapters" / "azure_devops_sync.py"
_spec = importlib.util.spec_from_file_location("azure_devops_sync", _PATH)
ado = importlib.util.module_from_spec(_spec)
sys.modules["azure_devops_sync"] = ado
_spec.loader.exec_module(ado)

BOM = b"\xef\xbb\xbf"
HTML = BOM + b"<!DOCTYPE html><html><title>Identity has not been materialized</title></html>"

ITEMS = [
    {"id": 12, "fields": {"System.Id": 12, "System.Title": "Export drops a column", "System.State": "To Do",
                          "System.Tags": "feedback; checkout; region-eu; ref-0123"}},
    {"id": 7, "fields": {"System.Id": 7, "System.Title": "Login loops on Safari", "System.State": "Doing",
                         "System.Tags": "feedback; mobile; region-us"}},
]


def fake_ado(items):
    calls = []

    def post(url, token, body):
        calls.append((url, body))
        if "/wit/wiql" in url:
            return {"workItems": [{"id": i["id"], "url": "x"} for i in items]}
        wanted = set(body["ids"])
        return {"count": len(wanted), "value": [i for i in items if i["id"] in wanted]}

    return post, calls


def args(tmp_path, *extra):
    return ado.parse_args(["--org", "contoso", "--project", "web", "--type", "Issue", "--area", "web",
                           "--tag", "feedback", "--name", "ado-feedback", "--project-dir", str(tmp_path), *extra])


class FakeNod:
    def __init__(self, code=0):
        self.calls = []
        self.code = code

    def __call__(self, cmd, project_dir, stdin=None):
        self.calls.append((cmd, stdin))
        return subprocess.CompletedProcess(cmd, self.code, stdout="ado-feedback: +2", stderr="boom" if self.code else "")

    def synced(self):
        return [stdin for cmd, stdin in self.calls if cmd[:2] == ["source", "sync"]]


def test_normal_snapshot_is_sorted_reference_only_and_deterministic(tmp_path):
    q = ado.Query("contoso", "web", "Issue", "web", ["feedback"], ["region-*", "mobile"])
    post, calls = fake_ado(ITEMS)
    first = ado.payload(ado.to_lines(q, ado.fetch_work_items(q, "t", post)))
    post2, _ = fake_ado(list(reversed(ITEMS)))
    assert ado.payload(ado.to_lines(q, ado.fetch_work_items(q, "t", post2))) == first

    lines = [json.loads(x) for x in first.splitlines()]
    assert [x["id"] for x in lines] == ["7", "12"]
    assert all(set(x) <= {"id", "title", "url", "state", "from"} for x in lines)
    assert lines[0] == {"id": "7", "title": "Login loops on Safari", "state": "Doing", "from": "mobile region-us",
                        "url": "https://dev.azure.com/contoso/web/_workitems/edit/7"}
    assert lines[1]["from"] == "region-eu"

    batch_bodies = [body for url, body in calls if "workitemsbatch" in url]
    assert batch_bodies and all(b["fields"] == ["System.Id", "System.Title", "System.State", "System.Tags"] for b in batch_bodies)


def test_wiql_carries_every_filter_and_escapes_quotes():
    wiql = ado.build_wiql("Issue", "web", ["feedback", "it's"])
    assert "[System.WorkItemType] = 'Issue'" in wiql
    assert "[System.AreaPath] UNDER 'web'" in wiql
    assert "[System.Tags] CONTAINS 'feedback'" in wiql
    assert "[System.Tags] CONTAINS 'it''s'" in wiql
    assert ado.build_wiql(None, None, []).endswith("WHERE [System.TeamProject] = @project ORDER BY [System.Id]")


def test_empty_result_syncs_an_empty_snapshot(tmp_path):
    post, calls = fake_ado([])
    nod = FakeNod()
    assert ado.sync_once(args(tmp_path), token_fn=lambda _d: "t", post=post, run_nod=nod) == 0
    assert nod.synced() == [""]
    assert not [u for u, _ in calls if "workitemsbatch" in u]


def test_more_than_200_ids_go_in_batches_of_200():
    many = [{"id": i, "fields": {"System.Title": f"t{i}", "System.Tags": "feedback"}} for i in range(1, 452)]
    q = ado.Query("contoso", "web")
    post, calls = fake_ado(many)
    lines = ado.to_lines(q, ado.fetch_work_items(q, "t", post))
    assert len(lines) == 451
    assert [len(body["ids"]) for url, body in calls if "workitemsbatch" in url] == [200, 200, 51]


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_bom_is_stripped(monkeypatch):
    monkeypatch.setattr(ado.urllib.request, "urlopen", lambda req, timeout: _Resp(BOM + b'{"workItems": []}'))
    assert ado.http_post("https://dev.azure.com/contoso/web/_apis/wit/wiql", "t", {}) == {"workItems": []}


def test_html_page_is_a_wrong_tenant_error_whether_200_or_403(monkeypatch):
    monkeypatch.setattr(ado.urllib.request, "urlopen", lambda req, timeout: _Resp(HTML))
    with pytest.raises(ado.WrongTenantError, match="wrong tenant"):
        ado.http_post("https://dev.azure.com/x", "t", {})

    def forbidden(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(HTML))

    monkeypatch.setattr(ado.urllib.request, "urlopen", forbidden)
    with pytest.raises(ado.WrongTenantError):
        ado.http_post("https://dev.azure.com/x", "t", {})


def test_wrong_tenant_syncs_nothing_so_known_items_are_never_marked_gone(tmp_path, capsys):
    def post(url, token, body):
        return ado.decode_response(HTML)

    nod = FakeNod()
    assert ado.sync_once(args(tmp_path), token_fn=lambda _d: "t", post=post, run_nod=nod) == 1
    assert nod.calls == []
    assert "nothing synced" in capsys.readouterr().err


def test_a_json_answer_without_workitems_is_an_error_not_zero_items(tmp_path):
    nod = FakeNod()
    post = lambda url, token, body: {"message": "TF400813: not authorized"}  # noqa: E731
    assert ado.sync_once(args(tmp_path), token_fn=lambda _d: "t", post=post, run_nod=nod) == 1
    assert nod.calls == []


def test_a_successful_run_registers_then_syncs_without_secrets(tmp_path):
    post, _ = fake_ado(ITEMS)
    nod = FakeNod()
    assert ado.sync_once(args(tmp_path, "--azure-config-dir", "~/.azure-contoso"), token_fn=lambda _d: "secret-token",
                         post=post, run_nod=nod) == 0
    register, sync = nod.calls
    assert register[0][:3] == ["source", "register", "ado-feedback"]
    assert "--stale-after" not in register[0], "an omitted flag must not overwrite what the owner set"
    assert sync[0] == ["source", "sync", "ado-feedback"]
    assert [json.loads(x)["id"] for x in sync[1].splitlines()] == ["7", "12"]
    assert all("secret-token" not in " ".join(c) + (s or "") for c, s in nod.calls)


def test_a_failed_nod_sync_is_a_non_zero_exit(tmp_path):
    post, _ = fake_ado(ITEMS)
    assert ado.sync_once(args(tmp_path), token_fn=lambda _d: "t", post=post, run_nod=FakeNod(code=1)) == 1
