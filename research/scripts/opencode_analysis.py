#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sqlite3
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

DB_PATH = Path.home() / ".local/share/opencode/opencode.db"
OUTPUT_DIR = Path("research/output/opencode")

SEARCH_LIKE_BASH_RE = re.compile(
    r"\b(ls|find|grep|rg|git\s+show|cat|head|tail|sed|awk|wc)\b"
)
READ_PATH_RE = re.compile(r"<path>([^<]+)</path>")


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def approx_tokens(chars: int) -> int:
    return int(math.ceil(chars / 4)) if chars > 0 else 0


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    if len(values) == 1:
        return values[0]
    values_sorted = sorted(values)
    idx = (len(values_sorted) - 1) * p
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return values_sorted[lo]
    frac = idx - lo
    return values_sorted[lo] * (1 - frac) + values_sorted[hi] * frac


def parse_json(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list, int, float, bool)):
        return raw
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return None
        return json.loads(stripped)
    raise TypeError(f"Unsupported JSON payload: {type(raw)!r}")


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fieldnames})


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")


def parse_tool_output(part: dict[str, Any]) -> str:
    state = part.get("state") or {}
    status = state.get("status")
    if status == "completed":
        return str(state.get("output") or "")
    if status == "error":
        metadata = state.get("metadata") or {}
        interrupted_output = metadata.get("output")
        if isinstance(interrupted_output, str) and interrupted_output:
            return interrupted_output
        return str(state.get("error") or "")
    if status == "pending":
        return str(state.get("raw") or "")
    if status == "running":
        return str(
            (state.get("metadata") or {}).get("title") or state.get("title") or ""
        )
    return ""


def part_payload_chars(part: dict[str, Any]) -> int:
    part_type = part.get("type")
    if part_type == "text":
        return len(str(part.get("text") or ""))
    if part_type == "reasoning":
        return len(str(part.get("text") or ""))
    if part_type == "tool":
        return len(parse_tool_output(part))
    return 0


def part_payload_hash(part: dict[str, Any]) -> str:
    return content_hash(parse_tool_output(part))


def parse_int(value: Any, default: int | None = None) -> int | None:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass(slots=True)
class ReadInterval:
    path: str
    start: int
    end: int | None


@dataclass(slots=True)
class ToolOccurrence:
    part_id: str
    message_id: str
    message_index: int
    tool: str
    signature: str
    payload_hash: str
    payload_chars: int
    interval: ReadInterval | None = None
    paths: set[str] = field(default_factory=set)
    required_paths: int = 0


@dataclass(slots=True)
class SessionData:
    session_id: str
    title: str
    directory: str
    worktree: str
    slug: str
    time_created: int
    time_updated: int
    has_compaction: bool
    messages: list[dict[str, Any]]


def interval_contains(later: ReadInterval, earlier: ReadInterval) -> bool:
    if later.path != earlier.path:
        return False
    if later.start > earlier.start:
        return False
    if later.end is None:
        return True
    if earlier.end is None:
        return False
    return later.end >= earlier.end


def read_interval_from_part(part: dict[str, Any]) -> ReadInterval | None:
    state = part.get("state") or {}
    input_obj = state.get("input") or {}
    path = input_obj.get("filePath")
    if not isinstance(path, str) or not path:
        return None
    start = parse_int(input_obj.get("offset"), 1) or 1
    limit = parse_int(input_obj.get("limit"), None)
    end = None if limit is None else start + max(limit, 0) - 1
    return ReadInterval(path=path, start=start, end=end)


def extract_paths_from_output(tool: str, payload: str) -> set[str]:
    paths: set[str] = set()
    if not payload:
        return paths

    if tool == "glob":
        for line in payload.splitlines():
            candidate = line.strip()
            if candidate.startswith("/"):
                paths.add(candidate.rstrip("/"))
        return paths

    if tool == "grep":
        for line in payload.splitlines():
            line = line.strip()
            if not line.startswith("/"):
                continue
            path, _, _rest = line.partition(":")
            if path:
                paths.add(path)
        return paths

    if tool == "bash":
        for match in READ_PATH_RE.findall(payload):
            if match.startswith("/"):
                paths.add(match)
        for line in payload.splitlines():
            line = line.strip()
            if line.startswith("/"):
                path, _, _rest = line.partition(":")
                if path:
                    paths.add(path)
        return paths

    return paths


def search_required_paths(path_count: int) -> int:
    if path_count <= 0:
        return 0
    if path_count <= 3:
        return path_count
    if path_count <= 10:
        return 3
    return 5


def tool_signature(part: dict[str, Any]) -> str:
    tool = str(part.get("tool") or "")
    state = part.get("state") or {}
    input_obj = state.get("input") or {}
    if tool == "read":
        key = {
            "tool": tool,
            "filePath": input_obj.get("filePath"),
            "offset": input_obj.get("offset", 1),
            "limit": input_obj.get("limit"),
        }
        return stable_json(key)
    if tool == "grep":
        key = {
            "tool": tool,
            "pattern": input_obj.get("pattern"),
            "include": input_obj.get("include"),
            "path": input_obj.get("path"),
        }
        return stable_json(key)
    if tool == "glob":
        key = {
            "tool": tool,
            "pattern": input_obj.get("pattern"),
            "path": input_obj.get("path"),
        }
        return stable_json(key)
    if tool == "bash":
        return stable_json({"tool": tool, "command": input_obj.get("command")})
    if tool == "webfetch":
        return stable_json({"tool": tool, "url": input_obj.get("url")})
    return stable_json({"tool": tool, "input": input_obj})


def message_has_substantive_part(parts: list[dict[str, Any]]) -> bool:
    for part in parts:
        if part.get("type") not in {"step-start", "reasoning"}:
            return True
    return False


def build_model_messages(
    messages: list[dict[str, Any]],
    pruned_part_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    pruned = pruned_part_ids or set()
    result: list[dict[str, Any]] = []

    for message in messages:
        info = message["info"]
        role = info.get("role")
        parts = [part for part in message["parts"] if part["id"] not in pruned]
        if not parts:
            continue

        if role == "user":
            content: list[dict[str, Any]] = []
            for part in parts:
                part_type = part.get("type")
                if part_type == "text" and not part.get("ignored"):
                    content.append(
                        {"type": "text", "text": str(part.get("text") or "")}
                    )
                elif part_type == "file":
                    mime = str(part.get("mime") or "")
                    if mime not in {"text/plain", "application/x-directory"}:
                        file_part = {
                            "type": "file",
                            "mediaType": mime,
                            "data": part.get("url"),
                        }
                        filename = part.get("filename")
                        if filename is not None:
                            file_part["filename"] = filename
                        content.append(file_part)
                elif part_type == "compaction":
                    content.append({"type": "text", "text": "What did we do so far?"})
                elif part_type == "subtask":
                    content.append(
                        {
                            "type": "text",
                            "text": "The following tool was executed by the user",
                        }
                    )
            if content:
                result.append({"role": "user", "content": content})
            continue

        if role != "assistant":
            continue

        error = info.get("error") or {}
        error_name = error.get("name")
        if error and not (
            error_name == "MessageAbortedError" and message_has_substantive_part(parts)
        ):
            continue

        block_text: list[dict[str, Any]] = []
        block_tool_results: list[dict[str, Any]] = []

        def flush() -> None:
            nonlocal block_text, block_tool_results
            if block_text:
                result.append({"role": "assistant", "content": block_text})
            if block_tool_results:
                result.append({"role": "tool", "content": block_tool_results})
            block_text = []
            block_tool_results = []

        for part in parts:
            part_type = part.get("type")
            if part_type == "step-start":
                flush()
                continue
            if part_type == "text":
                block_text.append({"type": "text", "text": str(part.get("text") or "")})
                continue
            if part_type == "reasoning":
                block_text.append(
                    {"type": "reasoning", "text": str(part.get("text") or "")}
                )
                continue
            if part_type != "tool":
                continue

            state = part.get("state") or {}
            status = state.get("status")
            tool_name = str(part.get("tool") or "")
            tool_call_id = str(part.get("callID") or "")
            provider_executed = bool(
                (part.get("metadata") or {}).get("providerExecuted")
            )
            tool_call = {
                "type": "tool-call",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "input": state.get("input")
                if status != "pending"
                else state.get("input"),
                "providerExecuted": provider_executed,
            }
            block_text.append(tool_call)

            if status == "completed":
                output_text = str(state.get("output") or "")
                compacted = ((state.get("time") or {}).get("compacted")) is not None
                if compacted:
                    output_text = "[Old tool result content cleared]"
                result_part = {
                    "type": "tool-result",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "output": {"type": "text", "value": output_text},
                }
                if provider_executed:
                    block_text.append(result_part)
                else:
                    block_tool_results.append(result_part)
                continue

            if status == "error":
                metadata = state.get("metadata") or {}
                interrupted_output = metadata.get("output")
                if isinstance(interrupted_output, str) and interrupted_output:
                    result_part = {
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "output": {"type": "text", "value": interrupted_output},
                    }
                else:
                    result_part = {
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "output": {
                            "type": "error-json" if provider_executed else "error-text",
                            "value": str(state.get("error") or ""),
                        },
                    }
                if provider_executed:
                    block_text.append(result_part)
                else:
                    block_tool_results.append(result_part)
                continue

            interrupted = {
                "type": "tool-result",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "output": {
                    "type": "error-json" if provider_executed else "error-text",
                    "value": "[Tool execution was interrupted]",
                },
            }
            if provider_executed:
                block_text.append(interrupted)
            else:
                block_tool_results.append(interrupted)

        flush()

    return result


def tool_name_from_content_part(
    part: dict[str, Any], approval_tool_names: dict[str, str]
) -> str | None:
    part_type = part.get("type")
    if part_type in {"tool-call", "tool-result"}:
        return str(part.get("toolName") or "")
    if part_type in {"tool-approval-request", "tool-approval-response"}:
        approval_id = str(part.get("approvalId") or "")
        return approval_tool_names.get(approval_id)
    return None


def normalize_tool_call_rules(tool_calls: Any) -> list[dict[str, Any]]:
    if tool_calls == "none":
        return []
    if tool_calls == "all":
        return [{"type": "all"}]
    if tool_calls == "before-last-message":
        return [{"type": "before-last-message"}]
    if isinstance(tool_calls, str):
        return [{"type": tool_calls}]
    if isinstance(tool_calls, list):
        return tool_calls
    return []


def keep_last_message_count(rule_type: str) -> int | None:
    if rule_type == "all":
        return None
    if rule_type == "before-last-message":
        return 1
    if rule_type.startswith("before-last-") and rule_type.endswith("-messages"):
        middle = rule_type[len("before-last-") : -len("-messages")]
        return int(middle)
    return None


def prune_messages_ai_sdk(
    messages: list[dict[str, Any]],
    *,
    reasoning: str = "none",
    tool_calls: Any = (),
    empty_messages: str = "remove",
) -> list[dict[str, Any]]:
    messages = json.loads(json.dumps(messages))

    if reasoning in {"all", "before-last-message"}:
        last_index = len(messages) - 1
        next_messages: list[dict[str, Any]] = []
        for index, message in enumerate(messages):
            if (
                message.get("role") != "assistant"
                or isinstance(message.get("content"), str)
                or (reasoning == "before-last-message" and index == last_index)
            ):
                next_messages.append(message)
                continue

            message["content"] = [
                part
                for part in message.get("content", [])
                if part.get("type") != "reasoning"
            ]
            next_messages.append(message)
        messages = next_messages

    for tool_rule in normalize_tool_call_rules(tool_calls):
        keep_last = keep_last_message_count(str(tool_rule.get("type") or ""))
        tools_filter = tool_rule.get("tools")
        kept_tool_call_ids: set[str] = set()
        kept_approval_ids: set[str] = set()

        if keep_last is not None and keep_last > 0:
            for message in messages[-keep_last:]:
                if message.get("role") not in {"assistant", "tool"}:
                    continue
                content = message.get("content")
                if isinstance(content, str):
                    continue
                for part in content:
                    part_type = part.get("type")
                    if part_type in {"tool-call", "tool-result"}:
                        kept_tool_call_ids.add(str(part.get("toolCallId") or ""))
                    elif part_type in {
                        "tool-approval-request",
                        "tool-approval-response",
                    }:
                        kept_approval_ids.add(str(part.get("approvalId") or ""))

        next_messages = []
        total_messages = len(messages)
        for message_index, message in enumerate(messages):
            if message.get("role") not in {"assistant", "tool"}:
                next_messages.append(message)
                continue

            content = message.get("content")
            if isinstance(content, str):
                next_messages.append(message)
                continue

            if keep_last and message_index >= total_messages - keep_last:
                next_messages.append(message)
                continue

            tool_call_id_to_name: dict[str, str] = {}
            approval_id_to_name: dict[str, str] = {}
            filtered: list[dict[str, Any]] = []
            for part in content:
                part_type = part.get("type")
                if part_type not in {
                    "tool-call",
                    "tool-result",
                    "tool-approval-request",
                    "tool-approval-response",
                }:
                    filtered.append(part)
                    continue

                if part_type == "tool-call":
                    tool_call_id_to_name[str(part.get("toolCallId") or "")] = str(
                        part.get("toolName") or ""
                    )
                elif part_type == "tool-approval-request":
                    tool_call_id = str(part.get("toolCallId") or "")
                    approval_id_to_name[str(part.get("approvalId") or "")] = (
                        tool_call_id_to_name.get(
                            tool_call_id,
                            "",
                        )
                    )

                if (
                    part_type in {"tool-call", "tool-result"}
                    and str(part.get("toolCallId") or "") in kept_tool_call_ids
                ):
                    filtered.append(part)
                    continue
                if (
                    part_type in {"tool-approval-request", "tool-approval-response"}
                    and str(part.get("approvalId") or "") in kept_approval_ids
                ):
                    filtered.append(part)
                    continue

                if tools_filter is not None:
                    tool_name = (
                        tool_name_from_content_part(part, approval_id_to_name) or ""
                    )
                    if tool_name not in tools_filter:
                        filtered.append(part)
                        continue

            message["content"] = filtered
            next_messages.append(message)
        messages = next_messages

    if empty_messages == "remove":
        filtered_messages = []
        for message in messages:
            content = message.get("content")
            if isinstance(content, str):
                if content:
                    filtered_messages.append(message)
                continue
            if len(content) > 0:
                filtered_messages.append(message)
        messages = filtered_messages

    return messages


def messages_chars(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content)
            continue
        for part in content:
            part_type = part.get("type")
            if part_type in {"text", "reasoning"}:
                total += len(str(part.get("text") or ""))
            elif part_type == "file":
                total += len(str(part.get("mediaType") or ""))
                total += len(str(part.get("filename") or ""))
                total += len(str(part.get("data") or ""))
            elif part_type == "tool-call":
                total += len(str(part.get("toolName") or ""))
                total += len(str(part.get("toolCallId") or ""))
                total += len(stable_json(part.get("input")))
            elif part_type == "tool-result":
                total += len(str(part.get("toolName") or ""))
                total += len(str(part.get("toolCallId") or ""))
                total += len(stable_json(part.get("output")))
            elif part_type in {"tool-approval-request", "tool-approval-response"}:
                total += len(stable_json(part))
            else:
                total += len(stable_json(part))
    return total


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_session_features(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    base_rows = conn.execute(
        """
        with message_stats as (
          select session_id, count(*) as message_count
          from message
          group by session_id
        ),
        part_stats as (
          select
            session_id,
            count(*) as part_count,
            sum(case when json_extract(data, '$.type') = 'tool' then 1 else 0 end) as tool_part_count,
            sum(case when json_extract(data, '$.type') = 'reasoning' then 1 else 0 end) as reasoning_part_count,
            max(case when json_extract(data, '$.type') = 'compaction' then 1 else 0 end) as has_compaction,
            sum(case when json_extract(data, '$.type') = 'text' then length(coalesce(json_extract(data, '$.text'), ''))
                     when json_extract(data, '$.type') = 'reasoning' then length(coalesce(json_extract(data, '$.text'), ''))
                     when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.state.status') = 'completed' then length(coalesce(json_extract(data, '$.state.output'), ''))
                     when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.state.status') = 'error' then length(coalesce(json_extract(data, '$.state.error'), ''))
                     else 0 end) as total_chars,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'read' then length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')) else 0 end) as read_chars,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'bash' then length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')) else 0 end) as bash_chars,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'grep' then length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')) else 0 end) as grep_chars,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'glob' then length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')) else 0 end) as glob_chars,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'webfetch' then length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')) else 0 end) as webfetch_chars,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'read' then 1 else 0 end) as read_calls,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'bash' then 1 else 0 end) as bash_calls,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'grep' then 1 else 0 end) as grep_calls,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'glob' then 1 else 0 end) as glob_calls,
            sum(case when json_extract(data, '$.type') = 'tool' and json_extract(data, '$.tool') = 'webfetch' then 1 else 0 end) as webfetch_calls
          from part
          group by session_id
        )
        select
          s.id as session_id,
          s.title,
          s.slug,
          s.directory,
          s.time_created,
          s.time_updated,
          p.worktree,
          coalesce(ms.message_count, 0) as message_count,
          coalesce(ps.part_count, 0) as part_count,
          coalesce(ps.tool_part_count, 0) as tool_part_count,
          coalesce(ps.reasoning_part_count, 0) as reasoning_part_count,
          coalesce(ps.has_compaction, 0) as has_compaction,
          coalesce(ps.total_chars, 0) as total_chars,
          coalesce(ps.read_chars, 0) as read_chars,
          coalesce(ps.bash_chars, 0) as bash_chars,
          coalesce(ps.grep_chars, 0) as grep_chars,
          coalesce(ps.glob_chars, 0) as glob_chars,
          coalesce(ps.webfetch_chars, 0) as webfetch_chars,
          coalesce(ps.read_calls, 0) as read_calls,
          coalesce(ps.bash_calls, 0) as bash_calls,
          coalesce(ps.grep_calls, 0) as grep_calls,
          coalesce(ps.glob_calls, 0) as glob_calls,
          coalesce(ps.webfetch_calls, 0) as webfetch_calls
        from session s
        join project p on p.id = s.project_id
        left join message_stats ms on ms.session_id = s.id
        left join part_stats ps on ps.session_id = s.id
        order by s.time_created asc
        """
    ).fetchall()

    duplicate_read_rows = conn.execute(
        """
        select session_id, sum(call_count - 1) as duplicate_read_calls
        from (
          select
            session_id,
            json_extract(data, '$.state.input.filePath') as file_path,
            coalesce(json_extract(data, '$.state.input.offset'), 1) as offset,
            coalesce(json_extract(data, '$.state.input.limit'), -1) as limit_value,
            count(*) as call_count
          from part
          where json_extract(data, '$.type') = 'tool'
            and json_extract(data, '$.tool') = 'read'
            and json_extract(data, '$.state.input.filePath') is not null
          group by session_id, file_path, offset, limit_value
          having count(*) > 1
        )
        group by session_id
        """
    ).fetchall()

    duplicate_grep_rows = conn.execute(
        """
        select session_id, sum(call_count - 1) as duplicate_grep_calls
        from (
          select
            session_id,
            coalesce(json_extract(data, '$.state.input.pattern'), '') as pattern,
            coalesce(json_extract(data, '$.state.input.path'), '') as path_value,
            coalesce(json_extract(data, '$.state.input.include'), '') as include_value,
            count(*) as call_count
          from part
          where json_extract(data, '$.type') = 'tool'
            and json_extract(data, '$.tool') = 'grep'
          group by session_id, pattern, path_value, include_value
          having count(*) > 1
        )
        group by session_id
        """
    ).fetchall()

    duplicate_bash_rows = conn.execute(
        """
        select session_id, sum(call_count - 1) as duplicate_bash_calls
        from (
          select
            session_id,
            coalesce(json_extract(data, '$.state.input.command'), '') as command,
            count(*) as call_count
          from part
          where json_extract(data, '$.type') = 'tool'
            and json_extract(data, '$.tool') = 'bash'
          group by session_id, command
          having count(*) > 1
        )
        group by session_id
        """
    ).fetchall()

    duplicates: dict[str, dict[str, int]] = defaultdict(dict)
    for row in duplicate_read_rows:
        duplicates[row["session_id"]]["duplicate_read_calls"] = int(
            row["duplicate_read_calls"] or 0
        )
    for row in duplicate_grep_rows:
        duplicates[row["session_id"]]["duplicate_grep_calls"] = int(
            row["duplicate_grep_calls"] or 0
        )
    for row in duplicate_bash_rows:
        duplicates[row["session_id"]]["duplicate_bash_calls"] = int(
            row["duplicate_bash_calls"] or 0
        )

    features: list[dict[str, Any]] = []
    for row in base_rows:
        item = dict(row)
        item.update(duplicates.get(item["session_id"], {}))
        item.setdefault("duplicate_read_calls", 0)
        item.setdefault("duplicate_grep_calls", 0)
        item.setdefault("duplicate_bash_calls", 0)
        features.append(item)

    score_fields = [
        ("total_chars", 2.2),
        ("read_chars", 2.0),
        ("bash_chars", 1.5),
        ("grep_chars", 1.4),
        ("webfetch_chars", 1.2),
        ("glob_chars", 0.8),
        ("duplicate_read_calls", 1.6),
        ("duplicate_grep_calls", 1.0),
        ("duplicate_bash_calls", 0.8),
        ("read_calls", 0.8),
        ("message_count", 0.6),
    ]

    for field_name, weight in score_fields:
        ordered = sorted(features, key=lambda item: item[field_name])
        denominator = max(len(ordered) - 1, 1)
        rank_by_id = {
            item["session_id"]: index / denominator
            for index, item in enumerate(ordered)
        }
        for item in features:
            item[f"{field_name}_rank"] = rank_by_id[item["session_id"]]
            item.setdefault("opportunity_score", 0.0)
            item["opportunity_score"] += rank_by_id[item["session_id"]] * weight
    for item in features:
        if item["has_compaction"]:
            item["opportunity_score"] += 1.5

    features.sort(
        key=lambda item: (item["opportunity_score"], item["total_chars"]), reverse=True
    )
    return features


def choose_cohort(
    features: list[dict[str, Any]], cohort_size: int
) -> list[dict[str, Any]]:
    compacted = [item for item in features if item["has_compaction"]]
    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    for item in compacted:
        if item["session_id"] in selected_ids:
            continue
        selected.append(item)
        selected_ids.add(item["session_id"])
        if len(selected) >= cohort_size:
            return selected[:cohort_size]
    for item in features:
        if item["session_id"] in selected_ids:
            continue
        selected.append(item)
        selected_ids.add(item["session_id"])
        if len(selected) >= cohort_size:
            break
    return selected


def load_session(conn: sqlite3.Connection, session_id: str) -> SessionData:
    session_row = conn.execute(
        """
        select
          s.id,
          s.title,
          s.slug,
          s.directory,
          s.time_created,
          s.time_updated,
          p.worktree
        from session s
        join project p on p.id = s.project_id
        where s.id = ?
        """,
        (session_id,),
    ).fetchone()
    if session_row is None:
        raise ValueError(f"Missing session: {session_id}")

    message_rows = conn.execute(
        """
        select id, time_created, data
        from message
        where session_id = ?
        order by time_created asc, id asc
        """,
        (session_id,),
    ).fetchall()
    part_rows = conn.execute(
        """
        select id, message_id, data
        from part
        where session_id = ?
        order by message_id asc, id asc
        """,
        (session_id,),
    ).fetchall()

    parts_by_message: dict[str, list[dict[str, Any]]] = defaultdict(list)
    has_compaction = False
    for row in part_rows:
        data = parse_json(row["data"]) or {}
        part = {
            **data,
            "id": row["id"],
            "messageID": row["message_id"],
            "sessionID": session_id,
        }
        if part.get("type") == "compaction":
            has_compaction = True
        parts_by_message[row["message_id"]].append(part)

    messages: list[dict[str, Any]] = []
    for row in message_rows:
        info = parse_json(row["data"]) or {}
        messages.append(
            {
                "info": {
                    **info,
                    "id": row["id"],
                    "sessionID": session_id,
                },
                "parts": parts_by_message.get(row["id"], []),
                "time_created": int(row["time_created"]),
            }
        )

    return SessionData(
        session_id=session_id,
        title=str(session_row["title"] or ""),
        directory=str(session_row["directory"] or ""),
        worktree=str(session_row["worktree"] or ""),
        slug=str(session_row["slug"] or ""),
        time_created=int(session_row["time_created"]),
        time_updated=int(session_row["time_updated"]),
        has_compaction=has_compaction,
        messages=messages,
    )


def mark_stale(
    part: dict[str, Any],
    reason: str,
    stale_part_ids: set[str],
    stale_events: dict[str, dict[str, Any]],
    stale_turn: int,
    session_id: str,
) -> None:
    part_id = part["id"]
    if part_id in stale_part_ids:
        return
    stale_part_ids.add(part_id)
    stale_events[part_id] = {
        "sessionId": session_id,
        "partId": part_id,
        "messageId": part["messageID"],
        "staleAtMessageIndex": stale_turn,
        "messageIndex": None,
        "reason": reason,
        "partType": part.get("type"),
        "tool": part.get("tool"),
        "payloadChars": part_payload_chars(part),
        "payloadHash": part_payload_hash(part) if part.get("type") == "tool" else "",
    }


def compute_future_upper_bound(messages: list[dict[str, Any]]) -> dict[str, int]:
    read_occurrences_by_path: dict[str, list[ToolOccurrence]] = defaultdict(list)
    search_occurrences: list[ToolOccurrence] = []
    bash_occurrences_by_signature: dict[str, list[ToolOccurrence]] = defaultdict(list)
    webfetch_occurrences_by_signature: dict[str, list[ToolOccurrence]] = defaultdict(
        list
    )
    search_occurrences_by_signature: dict[tuple[str, str], list[ToolOccurrence]] = (
        defaultdict(list)
    )
    patch_turns_by_file: dict[str, list[int]] = defaultdict(list)
    usage_turns_by_file: dict[str, list[int]] = defaultdict(list)

    for message_index, message in enumerate(messages):
        for part in message["parts"]:
            if part.get("type") == "patch":
                for file_path in part.get("files") or []:
                    if isinstance(file_path, str):
                        patch_turns_by_file[file_path].append(message_index)
                        usage_turns_by_file[file_path].append(message_index)
                continue

            if part.get("type") != "tool":
                continue

            tool = str(part.get("tool") or "")
            signature = tool_signature(part)
            payload = parse_tool_output(part)
            occurrence = ToolOccurrence(
                part_id=part["id"],
                message_id=part["messageID"],
                message_index=message_index,
                tool=tool,
                signature=signature,
                payload_hash=content_hash(payload),
                payload_chars=len(payload),
                interval=read_interval_from_part(part),
                paths=extract_paths_from_output(tool, payload),
                required_paths=0,
            )

            if tool == "read" and occurrence.interval is not None:
                read_occurrences_by_path[occurrence.interval.path].append(occurrence)
                usage_turns_by_file[occurrence.interval.path].append(message_index)
                continue
            if tool in {"grep", "glob"}:
                occurrence.required_paths = search_required_paths(len(occurrence.paths))
                search_occurrences.append(occurrence)
                search_occurrences_by_signature[(tool, signature)].append(occurrence)
                continue
            if tool == "bash":
                bash_occurrences_by_signature[signature].append(occurrence)
                if SEARCH_LIKE_BASH_RE.search(
                    str((part.get("state") or {}).get("input", {}).get("command") or "")
                ):
                    occurrence.required_paths = search_required_paths(
                        len(occurrence.paths)
                    )
                    search_occurrences.append(occurrence)
                continue
            if tool == "webfetch":
                webfetch_occurrences_by_signature[signature].append(occurrence)

    future_turns: dict[str, int] = {}

    for path, occurrences in read_occurrences_by_path.items():
        turns = patch_turns_by_file.get(path, [])
        for index, occurrence in enumerate(occurrences):
            candidate_turns: list[int] = []

            patch_idx = bisect_right(turns, occurrence.message_index)
            if patch_idx < len(turns):
                candidate_turns.append(turns[patch_idx])

            for later in occurrences[index + 1 :]:
                if (
                    later.payload_hash == occurrence.payload_hash
                    and later.interval == occurrence.interval
                ):
                    candidate_turns.append(later.message_index)
                    break
                if (
                    later.interval is not None
                    and occurrence.interval is not None
                    and interval_contains(
                        later.interval,
                        occurrence.interval,
                    )
                ):
                    candidate_turns.append(later.message_index)
                    break
                if later.interval == occurrence.interval:
                    candidate_turns.append(later.message_index)
                    break

            if candidate_turns:
                future_turns[occurrence.part_id] = min(candidate_turns)

    for occurrences in search_occurrences_by_signature.values():
        for index, occurrence in enumerate(occurrences[:-1]):
            next_turn = occurrences[index + 1].message_index
            existing = future_turns.get(occurrence.part_id)
            if existing is None or next_turn < existing:
                future_turns[occurrence.part_id] = next_turn

    for occurrence in search_occurrences:
        if not occurrence.paths or occurrence.required_paths <= 0:
            continue
        future_uses: list[int] = []
        for path in sorted(occurrence.paths):
            turns = usage_turns_by_file.get(path, [])
            turn_idx = bisect_right(turns, occurrence.message_index)
            if turn_idx < len(turns):
                future_uses.append(turns[turn_idx])
        if len(future_uses) >= occurrence.required_paths:
            chosen = sorted(future_uses)[: occurrence.required_paths]
            stale_turn = max(chosen)
            existing = future_turns.get(occurrence.part_id)
            if existing is None or stale_turn < existing:
                future_turns[occurrence.part_id] = stale_turn

    for occurrences in bash_occurrences_by_signature.values():
        for index, occurrence in enumerate(occurrences[:-1]):
            next_turn = occurrences[index + 1].message_index
            existing = future_turns.get(occurrence.part_id)
            if existing is None or next_turn < existing:
                future_turns[occurrence.part_id] = next_turn

    for occurrences in webfetch_occurrences_by_signature.values():
        for index, occurrence in enumerate(occurrences[:-1]):
            next_turn = occurrences[index + 1].message_index
            existing = future_turns.get(occurrence.part_id)
            if existing is None or next_turn < existing:
                future_turns[occurrence.part_id] = next_turn

    return future_turns


def analyze_session(
    session: SessionData,
    *,
    baseline_configs: dict[str, dict[str, Any]],
    checkpoint_mode: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    turn_rows: list[dict[str, Any]] = []
    stale_events: dict[str, dict[str, Any]] = {}
    stale_part_ids: set[str] = set()

    active_reads_by_path: dict[str, list[tuple[dict[str, Any], ToolOccurrence]]] = (
        defaultdict(list)
    )
    active_searches: list[tuple[dict[str, Any], ToolOccurrence, set[str]]] = []
    search_history_by_signature: dict[
        tuple[str, str], list[tuple[dict[str, Any], ToolOccurrence]]
    ] = defaultdict(list)
    bash_history_by_signature: dict[
        str, list[tuple[dict[str, Any], ToolOccurrence]]
    ] = defaultdict(list)
    webfetch_history_by_signature: dict[
        str, list[tuple[dict[str, Any], ToolOccurrence]]
    ] = defaultdict(list)

    future_turns = compute_future_upper_bound(session.messages)

    for message_index, message in enumerate(session.messages):
        for part in message["parts"]:
            part["messageIndex"] = message_index

            if part.get("type") == "patch":
                for file_path in part.get("files") or []:
                    if not isinstance(file_path, str):
                        continue
                    for previous_part, _occurrence in active_reads_by_path.get(
                        file_path, []
                    ):
                        mark_stale(
                            previous_part,
                            "file_changed_after_read",
                            stale_part_ids,
                            stale_events,
                            message_index,
                            session.session_id,
                        )
                    for search_part, occurrence, matched_paths in active_searches:
                        if file_path in occurrence.paths:
                            matched_paths.add(file_path)
                            if len(matched_paths) >= occurrence.required_paths > 0:
                                mark_stale(
                                    search_part,
                                    "consumed_search_frontier",
                                    stale_part_ids,
                                    stale_events,
                                    message_index,
                                    session.session_id,
                                )
                continue

            if part.get("type") != "tool":
                continue

            tool = str(part.get("tool") or "")
            signature = tool_signature(part)
            payload = parse_tool_output(part)
            occurrence = ToolOccurrence(
                part_id=part["id"],
                message_id=part["messageID"],
                message_index=message_index,
                tool=tool,
                signature=signature,
                payload_hash=content_hash(payload),
                payload_chars=len(payload),
                interval=read_interval_from_part(part),
                paths=extract_paths_from_output(tool, payload),
                required_paths=0,
            )

            if tool == "read" and occurrence.interval is not None:
                path = occurrence.interval.path
                for previous_part, previous in active_reads_by_path.get(path, []):
                    if (
                        previous.payload_hash == occurrence.payload_hash
                        and previous.interval == occurrence.interval
                    ):
                        mark_stale(
                            previous_part,
                            "duplicate_read",
                            stale_part_ids,
                            stale_events,
                            message_index,
                            session.session_id,
                        )
                    elif previous.interval is not None and interval_contains(
                        occurrence.interval,
                        previous.interval,
                    ):
                        mark_stale(
                            previous_part,
                            "superseded_read_by_superset",
                            stale_part_ids,
                            stale_events,
                            message_index,
                            session.session_id,
                        )
                    elif previous.interval == occurrence.interval:
                        mark_stale(
                            previous_part,
                            "reread_same_slice",
                            stale_part_ids,
                            stale_events,
                            message_index,
                            session.session_id,
                        )

                active_reads_by_path[path].append((part, occurrence))
                for search_part, search_occurrence, matched_paths in active_searches:
                    if path in search_occurrence.paths:
                        matched_paths.add(path)
                        if len(matched_paths) >= search_occurrence.required_paths > 0:
                            mark_stale(
                                search_part,
                                "consumed_search_frontier",
                                stale_part_ids,
                                stale_events,
                                message_index,
                                session.session_id,
                            )
                continue

            if tool in {"grep", "glob"}:
                occurrence.required_paths = search_required_paths(len(occurrence.paths))
                key = (tool, signature)
                for previous_part, previous in search_history_by_signature.get(key, []):
                    reason = (
                        f"duplicate_{tool}"
                        if previous.payload_hash == occurrence.payload_hash
                        else f"rerun_{tool}"
                    )
                    mark_stale(
                        previous_part,
                        reason,
                        stale_part_ids,
                        stale_events,
                        message_index,
                        session.session_id,
                    )
                search_history_by_signature[key].append((part, occurrence))
                active_searches.append((part, occurrence, set()))
                continue

            if tool == "bash":
                for previous_part, previous in bash_history_by_signature.get(
                    signature, []
                ):
                    reason = (
                        "duplicate_bash"
                        if previous.payload_hash == occurrence.payload_hash
                        else "rerun_bash"
                    )
                    mark_stale(
                        previous_part,
                        reason,
                        stale_part_ids,
                        stale_events,
                        message_index,
                        session.session_id,
                    )
                bash_history_by_signature[signature].append((part, occurrence))
                command = str(
                    (part.get("state") or {}).get("input", {}).get("command") or ""
                )
                if SEARCH_LIKE_BASH_RE.search(command):
                    occurrence.required_paths = search_required_paths(
                        len(occurrence.paths)
                    )
                    active_searches.append((part, occurrence, set()))
                continue

            if tool == "webfetch":
                for previous_part, previous in webfetch_history_by_signature.get(
                    signature, []
                ):
                    reason = (
                        "duplicate_webfetch"
                        if previous.payload_hash == occurrence.payload_hash
                        else "rerun_webfetch"
                    )
                    mark_stale(
                        previous_part,
                        reason,
                        stale_part_ids,
                        stale_events,
                        message_index,
                        session.session_id,
                    )
                webfetch_history_by_signature[signature].append((part, occurrence))

        is_user_checkpoint = message["info"].get("role") == "user"
        is_final_checkpoint = message_index == len(session.messages) - 1
        is_checkpoint = (
            True
            if checkpoint_mode == "all"
            else is_user_checkpoint or is_final_checkpoint
        )
        if not is_checkpoint:
            continue

        prefix = session.messages[: message_index + 1]
        raw_messages = build_model_messages(prefix)
        semantic_messages = build_model_messages(prefix, stale_part_ids)
        future_pruned_ids = {
            part_id
            for part_id, stale_turn in future_turns.items()
            if stale_turn <= message_index
        }
        future_messages = build_model_messages(prefix, future_pruned_ids)

        lane_chars = {
            "raw": messages_chars(raw_messages),
            "semantic": messages_chars(semantic_messages),
            "futureAware": messages_chars(future_messages),
        }
        lane_tokens = {key: approx_tokens(value) for key, value in lane_chars.items()}
        baseline_outputs: dict[str, list[dict[str, Any]]] = {}
        for name, config in baseline_configs.items():
            baseline_outputs[name] = prune_messages_ai_sdk(raw_messages, **config)
            lane_chars[name] = messages_chars(baseline_outputs[name])
            lane_tokens[name] = approx_tokens(lane_chars[name])

        semantic_plus_baseline = prune_messages_ai_sdk(
            semantic_messages,
            **baseline_configs["aiSdkBaseline"],
        )
        future_plus_baseline = prune_messages_ai_sdk(
            future_messages,
            **baseline_configs["aiSdkBaseline"],
        )
        lane_chars["semanticPlusAiSdkBaseline"] = messages_chars(semantic_plus_baseline)
        lane_tokens["semanticPlusAiSdkBaseline"] = approx_tokens(
            lane_chars["semanticPlusAiSdkBaseline"]
        )
        lane_chars["futureAwarePlusAiSdkBaseline"] = messages_chars(
            future_plus_baseline
        )
        lane_tokens["futureAwarePlusAiSdkBaseline"] = approx_tokens(
            lane_chars["futureAwarePlusAiSdkBaseline"]
        )

        stale_payload_chars = 0
        stale_payload_tool_chars = 0
        stale_tool_parts = 0
        for earlier_message in prefix:
            for part in earlier_message["parts"]:
                if part["id"] not in stale_part_ids:
                    continue
                chars = part_payload_chars(part)
                stale_payload_chars += chars
                if part.get("type") == "tool":
                    stale_payload_tool_chars += chars
                    stale_tool_parts += 1

        turn_rows.append(
            {
                "sessionId": session.session_id,
                "title": session.title,
                "worktree": session.worktree,
                "directory": session.directory,
                "hasCompaction": session.has_compaction,
                "checkpointType": (
                    "user"
                    if is_user_checkpoint
                    else ("final" if is_final_checkpoint else "all")
                ),
                "messageIndex": message_index,
                "messageId": message["info"]["id"],
                "role": message["info"].get("role"),
                "rawChars": lane_chars["raw"],
                "rawApproxTokens": lane_tokens["raw"],
                "aiSdkBaselineChars": lane_chars["aiSdkBaseline"],
                "aiSdkBaselineApproxTokens": lane_tokens["aiSdkBaseline"],
                "aiSdkAggressiveChars": lane_chars["aiSdkAggressive"],
                "aiSdkAggressiveApproxTokens": lane_tokens["aiSdkAggressive"],
                "aiSdkAllToolCallsChars": lane_chars["aiSdkAllToolCalls"],
                "aiSdkAllToolCallsApproxTokens": lane_tokens["aiSdkAllToolCalls"],
                "semanticChars": lane_chars["semantic"],
                "semanticApproxTokens": lane_tokens["semantic"],
                "futureAwareChars": lane_chars["futureAware"],
                "futureAwareApproxTokens": lane_tokens["futureAware"],
                "semanticPlusAiSdkBaselineChars": lane_chars[
                    "semanticPlusAiSdkBaseline"
                ],
                "semanticPlusAiSdkBaselineApproxTokens": lane_tokens[
                    "semanticPlusAiSdkBaseline"
                ],
                "futureAwarePlusAiSdkBaselineChars": lane_chars[
                    "futureAwarePlusAiSdkBaseline"
                ],
                "futureAwarePlusAiSdkBaselineApproxTokens": lane_tokens[
                    "futureAwarePlusAiSdkBaseline"
                ],
                "semanticSavingsChars": lane_chars["raw"] - lane_chars["semantic"],
                "semanticGainVsAiSdkBaselineChars": lane_chars["aiSdkBaseline"]
                - lane_chars["semantic"],
                "semanticAdditiveGainVsAiSdkBaselineChars": lane_chars["aiSdkBaseline"]
                - lane_chars["semanticPlusAiSdkBaseline"],
                "futureAwareGainVsAiSdkBaselineChars": lane_chars["aiSdkBaseline"]
                - lane_chars["futureAware"],
                "futureAwareAdditiveGainVsAiSdkBaselineChars": lane_chars[
                    "aiSdkBaseline"
                ]
                - lane_chars["futureAwarePlusAiSdkBaseline"],
                "aiSdkBaselineSavingsChars": lane_chars["raw"]
                - lane_chars["aiSdkBaseline"],
                "aiSdkAggressiveSavingsChars": lane_chars["raw"]
                - lane_chars["aiSdkAggressive"],
                "aiSdkAllToolCallsSavingsChars": lane_chars["raw"]
                - lane_chars["aiSdkAllToolCalls"],
                "futureAwareSavingsChars": lane_chars["raw"]
                - lane_chars["futureAware"],
                "activeSemanticStaleParts": len(stale_part_ids),
                "activeSemanticStaleToolParts": stale_tool_parts,
                "activeSemanticStalePayloadChars": stale_payload_chars,
                "activeSemanticStaleToolPayloadChars": stale_payload_tool_chars,
                "activeFutureAwarePrunedParts": len(future_pruned_ids),
            }
        )

    event_rows: list[dict[str, Any]] = []
    for part_id, event in stale_events.items():
        _ = part_id
        event_rows.append(event)
    event_rows.sort(key=lambda row: (row["staleAtMessageIndex"], row["partId"]))
    return turn_rows, event_rows


def build_session_stats(
    cohort_rows: list[dict[str, Any]],
    turn_rows: list[dict[str, Any]],
    event_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    cohort_by_session = {row["session_id"]: row for row in cohort_rows}
    turns_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in turn_rows:
        turns_by_session[row["sessionId"]].append(row)

    events_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in event_rows:
        events_by_session[row["sessionId"]].append(row)

    session_rows: list[dict[str, Any]] = []
    for session_id, rows in turns_by_session.items():
        rows_sorted = sorted(rows, key=lambda row: row["messageIndex"])
        final = rows_sorted[-1]
        feature = cohort_by_session[session_id]
        gains = [row["semanticGainVsAiSdkBaselineChars"] for row in rows_sorted]
        additive_gains = [
            row["semanticAdditiveGainVsAiSdkBaselineChars"] for row in rows_sorted
        ]
        stale_chars = [row["activeSemanticStalePayloadChars"] for row in rows_sorted]
        session_rows.append(
            {
                "sessionId": session_id,
                "title": final["title"],
                "worktree": final["worktree"],
                "directory": final["directory"],
                "messageCount": feature["message_count"],
                "partCount": feature["part_count"],
                "totalChars": feature["total_chars"],
                "opportunityScore": feature["opportunity_score"],
                "hasCompaction": feature["has_compaction"],
                "duplicateReadCalls": feature["duplicate_read_calls"],
                "duplicateGrepCalls": feature["duplicate_grep_calls"],
                "duplicateBashCalls": feature["duplicate_bash_calls"],
                "finalRawChars": final["rawChars"],
                "finalAiSdkBaselineChars": final["aiSdkBaselineChars"],
                "finalAiSdkAggressiveChars": final["aiSdkAggressiveChars"],
                "finalAiSdkAllToolCallsChars": final["aiSdkAllToolCallsChars"],
                "finalSemanticChars": final["semanticChars"],
                "finalFutureAwareChars": final["futureAwareChars"],
                "finalSemanticPlusAiSdkBaselineChars": final[
                    "semanticPlusAiSdkBaselineChars"
                ],
                "finalFutureAwarePlusAiSdkBaselineChars": final[
                    "futureAwarePlusAiSdkBaselineChars"
                ],
                "finalSemanticSavingsChars": final["semanticSavingsChars"],
                "finalSemanticGainVsAiSdkBaselineChars": final[
                    "semanticGainVsAiSdkBaselineChars"
                ],
                "finalSemanticAdditiveGainVsAiSdkBaselineChars": final[
                    "semanticAdditiveGainVsAiSdkBaselineChars"
                ],
                "finalFutureAwareGainVsAiSdkBaselineChars": final[
                    "futureAwareGainVsAiSdkBaselineChars"
                ],
                "finalFutureAwareAdditiveGainVsAiSdkBaselineChars": final[
                    "futureAwareAdditiveGainVsAiSdkBaselineChars"
                ],
                "peakSemanticGainVsAiSdkBaselineChars": max(gains),
                "medianSemanticGainVsAiSdkBaselineChars": percentile(gains, 0.5),
                "peakSemanticAdditiveGainVsAiSdkBaselineChars": max(additive_gains),
                "medianSemanticAdditiveGainVsAiSdkBaselineChars": percentile(
                    additive_gains, 0.5
                ),
                "peakActiveSemanticStalePayloadChars": max(stale_chars),
                "finalActiveSemanticStalePayloadChars": final[
                    "activeSemanticStalePayloadChars"
                ],
                "finalActiveSemanticStaleParts": final["activeSemanticStaleParts"],
                "semanticEventCount": len(events_by_session.get(session_id, [])),
            }
        )

    session_rows.sort(
        key=lambda row: row["finalSemanticAdditiveGainVsAiSdkBaselineChars"],
        reverse=True,
    )
    return session_rows


def build_pruning_reason_stats(
    event_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in event_rows:
        key = (str(row.get("tool") or ""), str(row.get("reason") or ""))
        current = grouped.get(key)
        if current is None:
            current = {
                "tool": key[0],
                "reason": key[1],
                "eventCount": 0,
                "payloadChars": 0,
            }
            grouped[key] = current
        current["eventCount"] += 1
        current["payloadChars"] += int(row.get("payloadChars") or 0)
    rows = list(grouped.values())
    rows.sort(key=lambda row: (row["payloadChars"], row["eventCount"]), reverse=True)
    return rows


def write_method_file(output_dir: Path, cohort_size: int, db_path: Path) -> None:
    method = f"""# METHOD

## Scope

- Source: local OpenCode SQLite database
- Database: `{db_path}`
- Analysis script: `research/scripts/opencode_analysis.py`
- Default cohort size: `{cohort_size}`
- Default checkpoint mode: `user`

## Reconstruction rules

- Sessions are reconstructed from `session`, `message`, `part`, and `todo`.
- Messages are ordered by `message.time_created`, then `message.id`.
- Parts are ordered by `part.message_id`, then `part.id`.
- The replay view approximates OpenCode's `MessageV2.toModelMessages()` plus AI SDK's `convertToModelMessages()` so `pruneMessages()` can be used as a baseline on a model-facing transcript.

## AI SDK baselines

- `aiSdkBaseline`: `reasoning='before-last-message'`, `toolCalls='before-last-2-messages'`, `emptyMessages='remove'`
- `aiSdkAggressive`: `reasoning='all'`, `toolCalls='before-last-message'`, `emptyMessages='remove'`
- `aiSdkAllToolCalls`: `reasoning='all'`, `toolCalls='all'`, `emptyMessages='remove'`

## Semantic pruning rules in this script

- Mark exact duplicate `read` results stale when the same file slice is reread with the same payload.
- Mark older `read` results stale when a later read of the same file contains the earlier slice.
- Mark older `read` results stale when a later `patch` touches the same file.
- Mark `grep` / `glob` search frontiers stale when they are rerun or when enough later reads/patches consume listed file paths.
- Mark `bash` and `webfetch` outputs stale on duplicate or rerun signatures.
- `bash` outputs are also treated as search frontiers when the command looks exploratory (`ls`, `grep`, `rg`, `git show`, etc.) and the output exposes later-consumed file paths.

## Future-aware upper bound

- `futureAware` is not a perfect oracle.
- It is a future-aware upper bound for the implemented heuristics: duplicate/rerun detection, later superseding reads, later file patches, and future consumption of search frontiers.

## Metrics

- Lane sizes are measured as character counts of model-message content parts (`text`, `reasoning`, `tool-call`, `tool-result`, `file`) after replay reconstruction.
- `ApproxTokens` is a coarse `chars / 4` proxy and should be treated as directional only.

## Claims we can make

- How much standard AI SDK recency/kind pruning removes on these OpenCode sessions.
- How much additional opportunity remains for semantic pruning using deterministic heuristics.
- Which tool classes dominate the residual opportunity after AI SDK pruning.

## Claims we cannot make

- Exact provider token counts for reconstructed context.
- Exact per-token streaming replay.
- Perfect semantic necessity of every message part.

## Reproducibility

Run:

```bash
python3 research/scripts/opencode_analysis.py
```

Outputs are written to `research/output/opencode/` by default.
"""
    (output_dir / "METHOD.md").write_text(method, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db-path",
        type=Path,
        default=DB_PATH,
        help="Path to the local OpenCode SQLite database.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Directory for generated analysis outputs.",
    )
    parser.add_argument(
        "--cohort-size",
        type=int,
        default=40,
        help="Number of sessions to include in the max-opportunity cohort.",
    )
    parser.add_argument(
        "--analyze-all",
        action="store_true",
        help="Analyze all sessions instead of the scored cohort.",
    )
    parser.add_argument(
        "--checkpoint-mode",
        choices=["user", "all"],
        default="user",
        help="Measure replay size at user/final checkpoints or every message boundary.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.db_path.exists():
        raise SystemExit(f"Missing OpenCode database: {args.db_path}")

    baseline_configs = {
        "aiSdkBaseline": {
            "reasoning": "before-last-message",
            "tool_calls": "before-last-2-messages",
            "empty_messages": "remove",
        },
        "aiSdkAggressive": {
            "reasoning": "all",
            "tool_calls": "before-last-message",
            "empty_messages": "remove",
        },
        "aiSdkAllToolCalls": {
            "reasoning": "all",
            "tool_calls": "all",
            "empty_messages": "remove",
        },
    }

    with connect(args.db_path) as conn:
        features = fetch_session_features(conn)
        selected = (
            features if args.analyze_all else choose_cohort(features, args.cohort_size)
        )
        selected_ids = [row["session_id"] for row in selected]

        print(f"[sessions] total={len(features):,} selected={len(selected_ids):,}")
        if not args.analyze_all:
            compacted = sum(1 for row in selected if row["has_compaction"])
            print(
                f"[cohort] compacted={compacted:,} top_score={selected[0]['opportunity_score']:.3f}"
            )

        args.output_dir.mkdir(parents=True, exist_ok=True)
        write_csv(
            args.output_dir / "cohort_manifest.csv",
            selected,
            [
                "session_id",
                "title",
                "slug",
                "directory",
                "worktree",
                "time_created",
                "time_updated",
                "message_count",
                "part_count",
                "tool_part_count",
                "reasoning_part_count",
                "has_compaction",
                "total_chars",
                "read_chars",
                "bash_chars",
                "grep_chars",
                "glob_chars",
                "webfetch_chars",
                "read_calls",
                "bash_calls",
                "grep_calls",
                "glob_calls",
                "webfetch_calls",
                "duplicate_read_calls",
                "duplicate_grep_calls",
                "duplicate_bash_calls",
                "opportunity_score",
            ],
        )

        turn_rows: list[dict[str, Any]] = []
        pruning_events: list[dict[str, Any]] = []
        session_rows_for_jsonl: list[dict[str, Any]] = []

        for index, session_id in enumerate(selected_ids, start=1):
            session = load_session(conn, session_id)
            print(
                f"[analyze] {index:>3}/{len(selected_ids):<3} {session_id} messages={len(session.messages):,} compacted={session.has_compaction}"
            )
            session_turns, session_events = analyze_session(
                session,
                baseline_configs=baseline_configs,
                checkpoint_mode=args.checkpoint_mode,
            )
            turn_rows.extend(session_turns)
            pruning_events.extend(session_events)
            session_rows_for_jsonl.append(
                {
                    "sessionId": session.session_id,
                    "title": session.title,
                    "worktree": session.worktree,
                    "directory": session.directory,
                    "hasCompaction": session.has_compaction,
                    "messageCount": len(session.messages),
                }
            )

    if not turn_rows:
        raise SystemExit("No turn rows produced.")

    session_stats = build_session_stats(selected, turn_rows, pruning_events)
    pruning_reason_stats = build_pruning_reason_stats(pruning_events)

    write_jsonl(args.output_dir / "sessions.jsonl", session_rows_for_jsonl)
    write_csv(
        args.output_dir / "turn_stats.csv",
        turn_rows,
        [
            "sessionId",
            "title",
            "worktree",
            "directory",
            "hasCompaction",
            "checkpointType",
            "messageIndex",
            "messageId",
            "role",
            "rawChars",
            "rawApproxTokens",
            "aiSdkBaselineChars",
            "aiSdkBaselineApproxTokens",
            "aiSdkAggressiveChars",
            "aiSdkAggressiveApproxTokens",
            "aiSdkAllToolCallsChars",
            "aiSdkAllToolCallsApproxTokens",
            "semanticChars",
            "semanticApproxTokens",
            "futureAwareChars",
            "futureAwareApproxTokens",
            "semanticPlusAiSdkBaselineChars",
            "semanticPlusAiSdkBaselineApproxTokens",
            "futureAwarePlusAiSdkBaselineChars",
            "futureAwarePlusAiSdkBaselineApproxTokens",
            "semanticSavingsChars",
            "semanticGainVsAiSdkBaselineChars",
            "semanticAdditiveGainVsAiSdkBaselineChars",
            "futureAwareGainVsAiSdkBaselineChars",
            "futureAwareAdditiveGainVsAiSdkBaselineChars",
            "aiSdkBaselineSavingsChars",
            "aiSdkAggressiveSavingsChars",
            "aiSdkAllToolCallsSavingsChars",
            "futureAwareSavingsChars",
            "activeSemanticStaleParts",
            "activeSemanticStaleToolParts",
            "activeSemanticStalePayloadChars",
            "activeSemanticStaleToolPayloadChars",
            "activeFutureAwarePrunedParts",
        ],
    )
    write_csv(
        args.output_dir / "session_stats.csv",
        session_stats,
        [
            "sessionId",
            "title",
            "worktree",
            "directory",
            "messageCount",
            "partCount",
            "totalChars",
            "opportunityScore",
            "hasCompaction",
            "duplicateReadCalls",
            "duplicateGrepCalls",
            "duplicateBashCalls",
            "finalRawChars",
            "finalAiSdkBaselineChars",
            "finalAiSdkAggressiveChars",
            "finalAiSdkAllToolCallsChars",
            "finalSemanticChars",
            "finalFutureAwareChars",
            "finalSemanticPlusAiSdkBaselineChars",
            "finalFutureAwarePlusAiSdkBaselineChars",
            "finalSemanticSavingsChars",
            "finalSemanticGainVsAiSdkBaselineChars",
            "finalSemanticAdditiveGainVsAiSdkBaselineChars",
            "finalFutureAwareGainVsAiSdkBaselineChars",
            "finalFutureAwareAdditiveGainVsAiSdkBaselineChars",
            "peakSemanticGainVsAiSdkBaselineChars",
            "medianSemanticGainVsAiSdkBaselineChars",
            "peakSemanticAdditiveGainVsAiSdkBaselineChars",
            "medianSemanticAdditiveGainVsAiSdkBaselineChars",
            "peakActiveSemanticStalePayloadChars",
            "finalActiveSemanticStalePayloadChars",
            "finalActiveSemanticStaleParts",
            "semanticEventCount",
        ],
    )
    write_csv(
        args.output_dir / "pruning_events.csv",
        pruning_events,
        [
            "sessionId",
            "partId",
            "messageId",
            "staleAtMessageIndex",
            "messageIndex",
            "reason",
            "partType",
            "tool",
            "payloadChars",
            "payloadHash",
        ],
    )
    write_csv(
        args.output_dir / "pruning_reason_stats.csv",
        pruning_reason_stats,
        ["tool", "reason", "eventCount", "payloadChars"],
    )
    write_method_file(args.output_dir, args.cohort_size, args.db_path)

    print("\n=== OpenCode Cohort Summary ===")
    print(f"- sessions={len(session_stats):,}")
    print(f"- turn_rows={len(turn_rows):,}")
    print(f"- pruning_events={len(pruning_events):,}")

    final_additive_gains = [
        row["finalSemanticAdditiveGainVsAiSdkBaselineChars"] for row in session_stats
    ]
    if final_additive_gains:
        print(
            "- semantic_additive_gain_vs_ai_sdk_baseline_chars "
            f"median={percentile(final_additive_gains, 0.5):,.0f} "
            f"p90={percentile(final_additive_gains, 0.9):,.0f} "
            f"max={max(final_additive_gains):,.0f}"
        )

    top_reasons = pruning_reason_stats[:8]
    if top_reasons:
        print("- top_pruning_reasons:")
        for row in top_reasons:
            tool_prefix = f"{row['tool']}:" if row["tool"] else ""
            print(
                f"  - {tool_prefix}{row['reason']} events={row['eventCount']:,} payload_chars={row['payloadChars']:,}"
            )

    print(f"\nOutputs written to: {args.output_dir}")


if __name__ == "__main__":
    main()
