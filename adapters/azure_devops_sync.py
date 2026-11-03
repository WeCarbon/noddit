#!/usr/bin/env python3
"""`nod source` adapter for Azure DevOps work items.

Syncs references only — id, title, url, state and (optionally) a few tags as
`from` — never a description or comment: System.Description is not even
requested. Read-only: one WIQL query, then workitemsbatch reads of at most
200 ids each.

Identity comes from the caller's az CLI login (`az account get-access-token`
for the Azure DevOps resource). nod never sees or stores the token, and no PAT
is needed. With several Azure identities on one machine, point this adapter at
the right one with --azure-config-dir (or AZURE_CONFIG_DIR in its environment).

Usage (run from the project whose decisions/ should receive the items):

    python3 adapters/azure_devops_sync.py --org contoso --project web \\
        --type Issue --area web --tag feedback --name ado-feedback --once

Without --once it polls every --interval seconds until stopped. To have the
plugin-started `nod monitor` run it while a session is open, register the
--once form as the source's sync command (see adapters/README.md).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"  # the fixed app id of Azure DevOps
API = "api-version=7.1"
BATCH = 200  # workitemsbatch rejects more ids than this per call
FIELDS = ["System.Id", "System.Title", "System.State", "System.Tags"]

Post = Callable[[str, str, dict], dict]


class AdoError(RuntimeError):
    pass


class WrongTenantError(AdoError):
    pass


def _quote_wiql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_wiql(work_item_type: str | None, area: str | None, tags: list[str]) -> str:
    clauses = ["[System.TeamProject] = @project"]
    if work_item_type:
        clauses.append(f"[System.WorkItemType] = {_quote_wiql(work_item_type)}")
    if area:
        clauses.append(f"[System.AreaPath] UNDER {_quote_wiql(area)}")
    clauses += [f"[System.Tags] CONTAINS {_quote_wiql(tag)}" for tag in tags]
    return "SELECT [System.Id] FROM WorkItems WHERE " + " AND ".join(clauses) + " ORDER BY [System.Id]"


def decode_response(raw: bytes) -> dict:
    # Azure DevOps prefixes its JSON with a UTF-8 BOM.
    text = raw.decode("utf-8-sig", errors="replace")
    if text.lstrip().startswith("<"):
        # A sign-in or "identity has not been materialized" page: the token
        # belongs to an identity this organization does not know.
        raise WrongTenantError(
            "Azure DevOps answered with an HTML page, not JSON: the az login in use is not a member of this "
            "organization (wrong tenant?). Check `az account show` under the AZURE_CONFIG_DIR this adapter uses."
        )
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise AdoError(f"Azure DevOps answered something that is not JSON: {exc}") from exc


def http_post(url: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - https://dev.azure.com only
            return decode_response(resp.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b""
        data = decode_response(raw) if raw else {}  # an HTML body raises WrongTenantError here
        message = data.get("message") if isinstance(data, dict) else None
        raise AdoError(f"Azure DevOps HTTP {exc.code}: {message or exc.reason}") from exc


def az_token(azure_config_dir: str | None = None) -> str:
    az = shutil.which("az")
    if not az:
        raise AdoError("az CLI not found on PATH")
    env = dict(os.environ)
    if azure_config_dir:
        env["AZURE_CONFIG_DIR"] = os.path.expanduser(azure_config_dir)
    out = subprocess.run(
        [az, "account", "get-access-token", "--resource", ADO_RESOURCE, "--query", "accessToken", "-o", "tsv"],
        env=env, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise AdoError(f"az account get-access-token failed: {out.stderr.strip() or out.returncode}")
    return out.stdout.strip()


class Query:
    def __init__(self, org: str, project: str, work_item_type: str | None = None, area: str | None = None,
                 tags: list[str] | None = None, from_tags: list[str] | None = None):
        self.org = org
        self.project = project
        self.wiql = build_wiql(work_item_type, area, tags or [])
        self.from_tags = from_tags or []

    @property
    def base(self) -> str:
        return f"https://dev.azure.com/{urllib.parse.quote(self.org)}/{urllib.parse.quote(self.project)}"

    def item_url(self, wid: str) -> str:
        return f"{self.base}/_workitems/edit/{wid}"


def fetch_work_items(query: Query, token: str, post: Post = http_post) -> list[dict]:
    found = post(f"{query.base}/_apis/wit/wiql?{API}", token, {"query": query.wiql})
    if "workItems" not in found:
        raise AdoError(f"WIQL answer has no workItems: {str(found)[:200]}")
    ids = [w["id"] for w in found["workItems"]]
    items: list[dict] = []
    for start in range(0, len(ids), BATCH):
        data = post(f"{query.base}/_apis/wit/workitemsbatch?{API}", token, {"ids": ids[start:start + BATCH], "fields": FIELDS})
        items.extend(data.get("value", []))
    return items


def to_lines(query: Query, work_items: list[dict]) -> list[dict]:
    """Sorted by id, so the same ADO state always produces the same bytes."""
    out = []
    for w in work_items:
        f = w.get("fields", {})
        wid = str(w.get("id") or f.get("System.Id"))
        tags = [t.strip() for t in (f.get("System.Tags") or "").split(";") if t.strip()]
        origin = " ".join(t for t in tags if any(fnmatch.fnmatchcase(t, p) for p in query.from_tags))
        line = {
            "id": wid,
            "title": (f.get("System.Title") or "").strip()[:200],
            "url": query.item_url(wid),
            "state": f.get("System.State") or "",
        }
        if origin:
            line["from"] = origin
        out.append(line)
    return sorted(out, key=lambda x: int(x["id"]))


def payload(lines: list[dict]) -> str:
    return "".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in lines)


def nod(args: list[str], project_dir: Path, stdin: str | None = None) -> subprocess.CompletedProcess:
    exe = shutil.which("nod") or "nod"
    return subprocess.run([exe, *args], cwd=project_dir, input=stdin, text=True, capture_output=True)


def ensure_registered(args: argparse.Namespace, run_nod=nod) -> None:
    cmd = ["source", "register", args.name, "--kind", "azure-devops", "--adapter", adapter_command(args)]
    if args.title:
        cmd += ["--title", args.title]
    if args.stale_after:
        cmd += ["--stale-after", args.stale_after]
    result = run_nod(cmd, args.project_dir)
    if result.returncode != 0:
        raise AdoError(f"nod source register failed: {result.stderr.strip()}")


def adapter_command(args: argparse.Namespace) -> str:
    """What `nod source list` shows as the adapter — never a credential."""
    parts = ["python3", "adapters/azure_devops_sync.py", "--org", args.org, "--project", args.ado_project]
    for flag, value in (("--type", args.type), ("--area", args.area)):
        if value:
            parts += [flag, value]
    for tag in args.tag:
        parts += ["--tag", tag]
    parts += ["--name", args.name]
    return " ".join(shlex.quote(p) for p in parts)


def sync_once(args: argparse.Namespace, token_fn=az_token, post: Post = http_post, run_nod=nod) -> int:
    query = Query(args.org, args.ado_project, args.type, args.area, args.tag, args.from_tag)
    try:
        lines = to_lines(query, fetch_work_items(query, token_fn(args.azure_config_dir), post))
    except Exception as exc:  # noqa: BLE001 - a failed poll syncs nothing, so no item is marked gone
        print(f"[{args.name}] fetch failed, nothing synced: {exc}", file=sys.stderr)
        return 1
    try:
        ensure_registered(args, run_nod)
    except AdoError as exc:
        print(f"[{args.name}] {exc}", file=sys.stderr)
        return 1
    result = run_nod(["source", "sync", args.name], args.project_dir, payload(lines))
    if result.returncode != 0:
        print(f"[{args.name}] nod source sync failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"[{args.name}] {len(lines)} work item(s): {result.stdout.strip()}")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync Azure DevOps work items into a nod source (references only).")
    p.add_argument("--org", required=True, help="Azure DevOps organization, e.g. contoso")
    p.add_argument("--project", dest="ado_project", required=True, help="Azure DevOps project, e.g. web")
    p.add_argument("--type", help="work item type, e.g. Issue or Bug")
    p.add_argument("--area", help=r"area path; items under it match, e.g. web or web\Checkout")
    p.add_argument("--tag", action="append", default=[], help="a tag every item must carry (repeatable)")
    p.add_argument("--from-tag", action="append", default=[],
                   help="glob of tags shown as the item's `from`, e.g. 'region-*' (repeatable)")
    p.add_argument("--name", default="ado", help="the nod source name (default: ado)")
    p.add_argument("--title", help="the source's human title in nod")
    p.add_argument("--stale-after", help="nod's stale threshold for this source, e.g. 30m")
    p.add_argument("--azure-config-dir", default=None, help="AZURE_CONFIG_DIR for the az login to use")
    p.add_argument("--project-dir", type=Path, default=Path.cwd(), help="where decisions/ lives (default: cwd)")
    p.add_argument("--once", action="store_true", help="sync one snapshot and exit (non-zero on failure)")
    p.add_argument("--interval", type=int, default=600, help="seconds between polls without --once")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.once:
        return sync_once(args)
    while True:
        sync_once(args)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
