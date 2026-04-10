#!/usr/bin/env python3

import argparse
import csv
import json
import math
import statistics
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

ROWS_API = "https://datasets-server.huggingface.co/rows"

DATASET_CONTEXTS = [
    {
        "dataset": "badlogicgames/pi-mono",
        "project": "badlogic/pi-mono",
        "developer_context": "badlogicgames",
    },
    {
        "dataset": "thomasmustier/pi-for-excel-sessions",
        "project": "tmustier/pi-for-excel",
        "developer_context": "thomasmustier",
    },
    {
        "dataset": "LarsEckart/approvaltests-java-sessions",
        "project": "approvals/ApprovalTests.Java",
        "developer_context": "LarsEckart",
    },
    {
        "dataset": "thomasmustier/pi-nes-sessions",
        "project": "tmustier/pi-nes",
        "developer_context": "thomasmustier",
    },
]


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


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


def safe_json(value: Any) -> Any:
    if isinstance(value, (dict, list, int, float, bool)) or value is None:
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        return json.loads(stripped)
    return value


def to_iso(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return None
    return None


def as_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def dataset_cache_name(dataset: str) -> str:
    return dataset.replace("/", "__") + ".jsonl"


def cache_file_for(dataset: str, cache_dir: Path, max_rows: int | None) -> Path:
    base = dataset_cache_name(dataset)
    if max_rows is None:
        return cache_dir / base
    stem = base.removesuffix(".jsonl")
    return cache_dir / f"{stem}__maxrows_{max_rows}.jsonl"


def fetch_rows_page(
    dataset: str, offset: int, length: int, timeout: int
) -> dict[str, Any]:
    params = urllib.parse.urlencode(
        {
            "dataset": dataset,
            "config": "default",
            "split": "train",
            "offset": offset,
            "length": length,
        }
    )
    url = f"{ROWS_API}?{params}"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def download_dataset_rows(
    dataset: str,
    cache_dir: Path,
    page_size: int,
    timeout: int,
    max_rows: int | None,
) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_file_for(dataset, cache_dir, max_rows)
    if cache_file.exists() and cache_file.stat().st_size > 0:
        print(f"[cache] {dataset}")
        return cache_file

    print(f"[download] {dataset}")
    rows_written = 0
    offset = 0
    total: int | None = None

    with cache_file.open("w", encoding="utf-8") as out:
        while True:
            if max_rows is not None and rows_written >= max_rows:
                break

            length = page_size
            if max_rows is not None:
                length = min(length, max_rows - rows_written)
                if length <= 0:
                    break

            page = fetch_rows_page(dataset, offset, length, timeout)
            if total is None and isinstance(page.get("num_rows_total"), int):
                total = int(page["num_rows_total"])

            rows = page.get("rows")
            if not isinstance(rows, list) or len(rows) == 0:
                break

            for row_wrap in rows:
                if not is_object(row_wrap):
                    continue
                row = row_wrap.get("row")
                if not is_object(row):
                    continue
                out.write(json.dumps(row, ensure_ascii=True) + "\n")
                rows_written += 1

            offset += len(rows)
            if total is not None and offset >= total:
                break

    print(f"  wrote {rows_written} rows")
    return cache_file


def load_cached_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if is_object(row):
                rows.append(row)
    return rows


def get_message_role(entry: dict[str, Any]) -> str | None:
    message = entry.get("message")
    if not is_object(message):
        return None
    role = message.get("role")
    return role if isinstance(role, str) else None


def get_message_timestamp(entry: dict[str, Any]) -> str | None:
    message = entry.get("message")
    if not is_object(message):
        return to_iso(entry.get("timestamp"))
    return to_iso(message.get("timestamp")) or to_iso(entry.get("timestamp"))


def get_tool_call_count(entry: dict[str, Any]) -> int:
    message = entry.get("message")
    if not is_object(message):
        return 0
    content = message.get("content")
    if not isinstance(content, list):
        return 0
    count = 0
    for block in content:
        if is_object(block) and block.get("type") == "toolCall":
            count += 1
    return count


def get_assistant_usage(entry: dict[str, Any]) -> dict[str, float | None]:
    message = entry.get("message")
    if not is_object(message):
        return {
            "inputTokens": None,
            "outputTokens": None,
            "cacheReadTokens": None,
            "cacheWriteTokens": None,
            "costTotal": None,
        }

    usage = message.get("usage")
    usage_obj = usage if is_object(usage) else {}
    cost = usage_obj.get("cost") if is_object(usage_obj.get("cost")) else {}
    return {
        "inputTokens": as_number(usage_obj.get("input")),
        "outputTokens": as_number(usage_obj.get("output")),
        "cacheReadTokens": as_number(usage_obj.get("cacheRead")),
        "cacheWriteTokens": as_number(usage_obj.get("cacheWrite")),
        "costTotal": as_number(cost.get("total")),
    }


def parse_trace_to_turns(
    dataset: str,
    harness: str,
    file_name: str,
    session_id: str,
    traces: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    entries = [e for e in traces if is_object(e) and isinstance(e.get("type"), str)]
    entries_by_id: dict[str, dict[str, Any]] = {}
    for entry in entries:
        entry_id = entry.get("id")
        if isinstance(entry_id, str) and entry_id:
            entries_by_id[entry_id] = entry

    path_cache: dict[str, list[str]] = {}

    def build_path(entry_id: str) -> list[str]:
        if entry_id in path_cache:
            return path_cache[entry_id]
        visited: set[str] = set()
        current_id: str | None = entry_id
        path: list[str] = []
        while current_id:
            if current_id in visited:
                break
            visited.add(current_id)
            current = entries_by_id.get(current_id)
            if not current:
                break
            path.append(current_id)
            parent = current.get("parentId")
            current_id = parent if isinstance(parent, str) else None
        path.reverse()
        path_cache[entry_id] = path
        return path

    compaction_entries = [e for e in entries if e.get("type") == "compaction"]
    session_has_compaction = len(compaction_entries) > 0
    session_compaction_count = len(compaction_entries)

    turns: list[dict[str, Any]] = []
    turn_index = 0

    for entry in entries:
        if entry.get("type") != "message":
            continue
        if get_message_role(entry) != "assistant":
            continue
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            continue

        turn_index += 1
        path_ids = build_path(entry_id)
        path_entries = [entries_by_id[i] for i in path_ids if i in entries_by_id]

        completed_at = get_message_timestamp(entry)
        started_at: str | None = None
        for candidate in reversed(path_entries):
            if candidate.get("id") == entry_id:
                continue
            if candidate.get("type") != "message":
                continue
            role = get_message_role(candidate)
            if role and role != "assistant":
                started_at = get_message_timestamp(candidate)
                break

        if started_at is None:
            for candidate in reversed(path_entries):
                if candidate.get("id") == entry_id:
                    continue
                ts = to_iso(candidate.get("timestamp"))
                if ts:
                    started_at = ts
                    break

        usage = get_assistant_usage(entry)
        path_has_compaction = any(p.get("type") == "compaction" for p in path_entries)

        compaction_ts_on_path = [
            to_iso(p.get("timestamp"))
            for p in path_entries
            if p.get("type") == "compaction"
        ]
        compaction_ts_on_path = [ts for ts in compaction_ts_on_path if ts is not None]
        last_compaction_ts_before_turn = None
        if completed_at and compaction_ts_on_path:
            for ts in sorted(compaction_ts_on_path):
                if ts <= completed_at:
                    last_compaction_ts_before_turn = ts
        elif compaction_ts_on_path:
            last_compaction_ts_before_turn = sorted(compaction_ts_on_path)[-1]

        effective_tokens = None
        if usage["inputTokens"] is not None and usage["cacheReadTokens"] is not None:
            effective_tokens = usage["inputTokens"] + usage["cacheReadTokens"]

        turns.append(
            {
                "dataset": dataset,
                "harness": harness,
                "fileName": file_name,
                "sessionId": session_id,
                "turnIndex": turn_index,
                "branchPath": "/".join(path_ids),
                "startedAt": started_at,
                "completedAt": completed_at,
                "inputTokens": usage["inputTokens"],
                "outputTokens": usage["outputTokens"],
                "cacheReadTokens": usage["cacheReadTokens"],
                "cacheWriteTokens": usage["cacheWriteTokens"],
                "effectiveTokens": effective_tokens,
                "costTotal": usage["costTotal"],
                "toolCallCount": get_tool_call_count(entry),
                "sessionHasCompaction": session_has_compaction,
                "pathHasCompaction": path_has_compaction,
                "sessionCompactionCount": session_compaction_count,
                "lastCompactionTsBeforeTurn": last_compaction_ts_before_turn,
            }
        )

    session_meta = {
        "dataset": dataset,
        "harness": harness,
        "fileName": file_name,
        "sessionId": session_id,
        "sessionHasCompaction": session_has_compaction,
        "sessionCompactionCount": session_compaction_count,
    }
    return turns, session_meta


def detect_compaction_events(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not turns:
        return []
    events: list[dict[str, Any]] = []

    for i in range(1, len(turns)):
        prev = turns[i - 1]
        curr = turns[i]

        reason = None
        prev_comp_ts = prev.get("lastCompactionTsBeforeTurn")
        curr_comp_ts = curr.get("lastCompactionTsBeforeTurn")

        if curr_comp_ts and curr_comp_ts != prev_comp_ts:
            reason = "explicit_compaction_timestamp"
        elif curr.get("pathHasCompaction") and not prev.get("pathHasCompaction"):
            reason = "explicit_compaction_path"

        prev_eff = prev.get("effectiveTokens")
        curr_eff = curr.get("effectiveTokens")
        prev_cache = prev.get("cacheReadTokens")
        curr_cache = curr.get("cacheReadTokens")
        curr_input = curr.get("inputTokens")

        if reason is None:
            if (
                isinstance(prev_eff, (int, float))
                and isinstance(curr_eff, (int, float))
                and prev_eff > 0
                and curr_eff < prev_eff * 0.9
                and isinstance(curr_input, (int, float))
                and curr_input > 5000
            ):
                reason = "token_drop"

        if reason is None:
            if (
                isinstance(prev_cache, (int, float))
                and isinstance(curr_cache, (int, float))
                and prev_cache > 10000
                and curr_cache == 0
                and isinstance(curr_input, (int, float))
                and curr_input > 20000
            ):
                reason = "fresh_reload"

        if reason is None:
            continue

        reduction_abs = None
        reduction_pct = None
        if isinstance(prev_eff, (int, float)) and isinstance(curr_eff, (int, float)):
            reduction_abs = prev_eff - curr_eff
            if prev_eff > 0:
                reduction_pct = (prev_eff - curr_eff) / prev_eff

        regrow_turns = None
        if isinstance(prev_eff, (int, float)) and prev_eff > 0:
            for j in range(i + 1, len(turns)):
                eff_j = turns[j].get("effectiveTokens")
                if isinstance(eff_j, (int, float)) and eff_j >= prev_eff:
                    regrow_turns = turns[j]["turnIndex"] - curr["turnIndex"]
                    break

        events.append(
            {
                "dataset": curr["dataset"],
                "sessionId": curr["sessionId"],
                "fileName": curr["fileName"],
                "turnIndex": curr["turnIndex"],
                "eventType": reason,
                "preEffectiveTokens": prev_eff,
                "postEffectiveTokens": curr_eff,
                "reductionAbs": reduction_abs,
                "reductionPct": reduction_pct,
                "preCacheReadTokens": prev_cache,
                "postCacheReadTokens": curr_cache,
                "preInputTokens": prev.get("inputTokens"),
                "postInputTokens": curr_input,
                "regrowTurns": regrow_turns,
            }
        )

    return events


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in fieldnames})


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")


def build_session_stats(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for turn in turns:
        grouped[(turn["dataset"], turn["sessionId"])].append(turn)

    rows: list[dict[str, Any]] = []
    for (dataset, session_id), ts in grouped.items():
        ts_sorted = sorted(ts, key=lambda t: t["turnIndex"])
        effective = [
            t["effectiveTokens"] for t in ts_sorted if t["effectiveTokens"] is not None
        ]
        peak_eff = max(effective) if effective else None
        med_eff = statistics.median(effective) if effective else None

        peak_cache_ratio = None
        if peak_eff is not None:
            peak_turn = next(
                (
                    t
                    for t in ts_sorted
                    if isinstance(t.get("effectiveTokens"), (int, float))
                    and t["effectiveTokens"] == peak_eff
                ),
                None,
            )
            if peak_turn:
                cr = peak_turn.get("cacheReadTokens")
                if isinstance(cr, (int, float)) and peak_eff > 0:
                    peak_cache_ratio = cr / peak_eff

        total_cost = sum(
            t["costTotal"]
            for t in ts_sorted
            if isinstance(t.get("costTotal"), (int, float))
        )
        total_tools = sum(int(t.get("toolCallCount", 0) or 0) for t in ts_sorted)
        null_usage_turns = sum(
            1
            for t in ts_sorted
            if t.get("inputTokens") is None
            and t.get("outputTokens") is None
            and t.get("cacheReadTokens") is None
            and t.get("cacheWriteTokens") is None
        )

        rows.append(
            {
                "dataset": dataset,
                "sessionId": session_id,
                "fileName": ts_sorted[0]["fileName"],
                "harness": ts_sorted[0]["harness"],
                "turns": len(ts_sorted),
                "peakEffectiveTokens": peak_eff,
                "medianEffectiveTokens": med_eff,
                "peakCacheReadRatio": peak_cache_ratio,
                "totalCost": total_cost,
                "totalToolCalls": total_tools,
                "avgToolCallsPerTurn": (total_tools / len(ts_sorted))
                if ts_sorted
                else None,
                "sessionHasCompaction": bool(ts_sorted[0]["sessionHasCompaction"]),
                "sessionCompactionCount": int(ts_sorted[0]["sessionCompactionCount"]),
                "uniqueBranchCount": len({t["branchPath"] for t in ts_sorted}),
                "nullUsageTurns": null_usage_turns,
            }
        )
    return rows


def write_method_file(output_dir: Path) -> None:
    method = """# METHOD

## Scope

- Analysis script: `research/scripts/pi_analysis.py`
- Corpus source: four Hugging Face Pi session datasets, parsed into a unified turn-level corpus.

## Developer/Project contexts

This corpus is intentionally cross-context and includes four different developer/project contexts:

1. `badlogicgames/pi-mono` -> project `badlogic/pi-mono`
2. `thomasmustier/pi-for-excel-sessions` -> project `tmustier/pi-for-excel`
3. `LarsEckart/approvaltests-java-sessions` -> project `approvals/ApprovalTests.Java`
4. `thomasmustier/pi-nes-sessions` -> project `tmustier/pi-nes`

Note: one publisher appears in two project contexts; analysis treats each dataset as a distinct developer/project context.

For analysis framing, this is treated as four different developers with four different projects.

## Parsing rules

- Input records are fetched from the HF datasets rows API (`config=default`, `split=train`).
- Each session row includes `traces` (tree-structured session entries by `id`/`parentId`).
- Turn rows are emitted for assistant messages with valid IDs.
- `branchPath` is reconstructed by following parent links to root.
- Token usage fields are read from `message.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `cost.total`).

## Compaction semantics

No legacy compatibility flags are used.

- `sessionHasCompaction`: session contains at least one explicit `type == "compaction"` entry.
- `pathHasCompaction`: current turn's branch path contains a compaction entry.
- `sessionCompactionCount`: number of explicit compaction entries in session.

Compaction boundary events are detected using explicit path/timestamp signals and token-shape heuristics.

## Claims we can make

- Turn/session context growth shape from per-turn token usage.
- Compaction prevalence and boundary behavior across corpus.
- Compression effectiveness and regrowth behavior after boundaries.
- Cross-project differences in context growth and compaction patterns.

## Claims we cannot make

- Perfect causal attribution of quality outcomes from this trace-only corpus.
- Exact source-type semantics when tools are custom and only represented in free-form content.

## Reproducibility

Run:

```bash
python3 research/scripts/pi_analysis.py
```

Default outputs are written to `research/output/pi/`.
"""
    (output_dir / "METHOD.md").write_text(method, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("/tmp/pi-corpus"),
        help="Cache directory for downloaded dataset rows.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("research/output/pi"),
        help="Output directory for analysis artifacts.",
    )
    parser.add_argument(
        "--datasets",
        type=str,
        default=",".join(ctx["dataset"] for ctx in DATASET_CONTEXTS),
        help="Comma-separated HF dataset IDs.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=50,
        help="Rows API page size.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=90,
        help="HTTP timeout in seconds.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Optional per-dataset row cap for smoke tests.",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Use cached rows only.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    datasets = [d.strip() for d in args.datasets.split(",") if d.strip()]

    cache_files: dict[str, Path] = {}
    for dataset in datasets:
        if args.skip_download:
            cache_path = cache_file_for(dataset, args.cache_dir, args.max_rows)
            if not cache_path.exists():
                print(f"[warn] missing cache for {dataset}: {cache_path}")
                continue
            cache_files[dataset] = cache_path
            continue

        cache_files[dataset] = download_dataset_rows(
            dataset=dataset,
            cache_dir=args.cache_dir,
            page_size=args.page_size,
            timeout=args.timeout,
            max_rows=args.max_rows,
        )

    all_turns: list[dict[str, Any]] = []

    for dataset, cache_path in cache_files.items():
        rows = load_cached_rows(cache_path)
        print(f"[parse] {dataset}: {len(rows)} sessions")
        for row in rows:
            traces_raw = safe_json(row.get("traces"))
            traces = traces_raw if isinstance(traces_raw, list) else []
            trace_entries = [t for t in traces if is_object(t)]
            turns, _session_meta = parse_trace_to_turns(
                dataset=dataset,
                harness=str(row.get("harness") or ""),
                file_name=str(row.get("file_name") or ""),
                session_id=str(row.get("session_id") or ""),
                traces=trace_entries,
            )
            all_turns.extend(turns)

    if not all_turns:
        raise SystemExit("No turn rows produced.")

    args.output_dir.mkdir(parents=True, exist_ok=True)

    write_jsonl(args.output_dir / "pi_full_turns.jsonl", all_turns)

    turn_csv_fields = [
        "dataset",
        "harness",
        "fileName",
        "sessionId",
        "turnIndex",
        "branchPath",
        "startedAt",
        "completedAt",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "effectiveTokens",
        "costTotal",
        "toolCallCount",
        "sessionHasCompaction",
        "pathHasCompaction",
        "sessionCompactionCount",
        "lastCompactionTsBeforeTurn",
    ]
    write_csv(args.output_dir / "pi_turn_stats.csv", all_turns, turn_csv_fields)

    session_rows = build_session_stats(all_turns)
    write_csv(
        args.output_dir / "pi_session_stats.csv",
        session_rows,
        [
            "dataset",
            "harness",
            "fileName",
            "sessionId",
            "turns",
            "peakEffectiveTokens",
            "medianEffectiveTokens",
            "peakCacheReadRatio",
            "totalCost",
            "totalToolCalls",
            "avgToolCallsPerTurn",
            "sessionHasCompaction",
            "sessionCompactionCount",
            "uniqueBranchCount",
            "nullUsageTurns",
        ],
    )

    grouped_turns: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for turn in all_turns:
        grouped_turns[(turn["dataset"], turn["sessionId"])].append(turn)

    compaction_events: list[dict[str, Any]] = []
    for (_, _), turns in grouped_turns.items():
        turns_sorted = sorted(turns, key=lambda t: t["turnIndex"])
        compaction_events.extend(detect_compaction_events(turns_sorted))

    write_csv(
        args.output_dir / "pi_compaction_events.csv",
        compaction_events,
        [
            "dataset",
            "sessionId",
            "fileName",
            "turnIndex",
            "eventType",
            "preEffectiveTokens",
            "postEffectiveTokens",
            "reductionAbs",
            "reductionPct",
            "preCacheReadTokens",
            "postCacheReadTokens",
            "preInputTokens",
            "postInputTokens",
            "regrowTurns",
        ],
    )

    write_method_file(args.output_dir)

    print("\n=== PI Corpus Summary ===")
    print(f"- total_turns={len(all_turns):,}")
    print(f"- total_sessions={len(session_rows):,}")
    by_dataset_sessions = defaultdict(int)
    by_dataset_turns = defaultdict(int)
    for s in session_rows:
        by_dataset_sessions[s["dataset"]] += 1
    for t in all_turns:
        by_dataset_turns[t["dataset"]] += 1
    for dataset in sorted(by_dataset_sessions.keys()):
        print(
            f"- {dataset}: sessions={by_dataset_sessions[dataset]:,} turns={by_dataset_turns[dataset]:,}"
        )

    peak_values = [
        s["peakEffectiveTokens"]
        for s in session_rows
        if s["peakEffectiveTokens"] is not None
    ]
    if peak_values:
        print(
            f"- peak_effective_tokens median={percentile(peak_values, 0.5):,.0f} p90={percentile(peak_values, 0.9):,.0f} max={max(peak_values):,.0f}"
        )

    print(f"- detected_compaction_events={len(compaction_events):,}")
    print(f"\nOutputs written to: {args.output_dir}")


if __name__ == "__main__":
    main()
