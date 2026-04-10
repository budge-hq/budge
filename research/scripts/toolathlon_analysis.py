#!/usr/bin/env python3

import argparse
import csv
import json
import math
import statistics
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

HF_BASE = (
    "https://huggingface.co/datasets/hkust-nlp/Toolathlon-Trajectories/resolve/main"
)

MODELS = [
    "claude-4-sonnet-0514",
    "claude-4.5-haiku-1001",
    "claude-4.5-opus",
    "claude-4.5-sonnet-0929",
    "deepseek-3.2-thinking",
    "deepseek-v3.2-exp",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-pro-preview",
    "glm-4.6",
    "gpt-5-high",
    "gpt-5-mini",
    "gpt-5.1",
    "gpt-5",
    "grok-4-fast",
    "grok-4",
    "grok-code-fast-1",
    "kimi-k2-0905",
    "minimax-m2",
    "o3",
    "o4-mini",
    "qwen-3-coder",
]

RUNS = [1, 2, 3]


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


def safe_json_loads(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, (int, float, bool)):
        return raw
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return None
        return json.loads(stripped)
    return json.loads(raw)


def parse_modelname_run(modelname_run: str) -> tuple[str, int]:
    model, run_raw = modelname_run.rsplit("_", 1)
    return model, int(run_raw)


def download_file(url: str, dest: Path) -> bool:
    try:
        with urllib.request.urlopen(url) as response:
            data = response.read()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return True
    except urllib.error.HTTPError as err:
        if err.code == 404:
            print(f"[warn] Missing file (404): {url}")
            return False
        raise


def download_all(cache_dir: Path, models: list[str], runs: list[int]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    for model in models:
        for run in runs:
            filename = f"{model}_{run}.jsonl"
            path = cache_dir / filename
            if path.exists() and path.stat().st_size > 0:
                print(f"[cache] {filename}")
                continue
            print(f"[download] {filename}")
            url = f"{HF_BASE}/{filename}"
            download_file(url, path)


def load_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def normalize_record(record: dict[str, Any]) -> dict[str, Any] | None:
    key_stats = safe_json_loads(record.get("key_stats"))
    messages = safe_json_loads(record.get("messages"))
    if not isinstance(key_stats, dict) or not isinstance(messages, list):
        return None

    task_status = safe_json_loads(record.get("task_status")) or {}
    agent_cost = safe_json_loads(record.get("agent_cost")) or {}
    if not isinstance(task_status, dict):
        task_status = {}
    if not isinstance(agent_cost, dict):
        agent_cost = {}
    model, run = parse_modelname_run(record["modelname_run"])

    total_turns = int(key_stats.get("total_turns", 0) or 0)
    total_messages = int(key_stats.get("total_messages", 0) or 0)
    final_messages = len(messages)
    input_tokens = int(agent_cost.get("total_input_tokens", 0) or 0)
    output_tokens = int(agent_cost.get("total_output_tokens", 0) or 0)

    return {
        "model": model,
        "run": run,
        "task_name": record.get("task_name"),
        "success": bool(task_status.get("evaluation") is True),
        "total_turns": total_turns,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "tool_calls": int(key_stats.get("tool_calls", 0) or 0),
        "truncations": int(key_stats.get("truncations", 0) or 0),
        "total_messages": total_messages,
        "final_messages": final_messages,
        "retention_ratio": (
            float(final_messages / total_messages) if total_messages > 0 else None
        ),
        "avg_tokens_per_turn": (
            float(input_tokens / total_turns) if total_turns > 0 else None
        ),
        "cost_usd": float(agent_cost.get("total_cost", 0.0) or 0.0),
        "messages": messages,
    }


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in fieldnames})


def role_content_chars(msg: dict[str, Any]) -> int:
    content = msg.get("content")
    if content is None:
        return 0
    return len(str(content))


def classify_tool_message(content: str) -> str:
    c = content.lower()
    if "[file]" in c or "[dir]" in c:
        return "file_listing"
    if "pdf total pages" in c or ("invoice" in c and "pdf" in c):
        return "pdf_read"
    if "query executed successfully" in c:
        return "db_query_result"
    if "error executing bigquery" in c or ("bigquery" in c and "error" in c):
        return "db_error"
    if "error" in c:
        return "error"
    if "<!doctype html" in c or "<html" in c:
        return "web_fetch"
    if "," in content and "\n" in content and "student_id" in c:
        return "csv_data"
    return "other"


def phase0(records: list[dict[str, Any]]) -> None:
    print("\n=== Phase 0: Truncation Audit ===")
    total = len(records)
    with_trunc = sum(1 for r in records if r["truncations"] > 0)
    print(f"Total valid sessions: {total}")
    print(f"Sessions with truncations > 0: {with_trunc}")

    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        by_model[r["model"]].append(r)

    print("\nPer-model maxima:")
    for model in sorted(by_model.keys()):
        rs = by_model[model]
        max_tokens = max(r["input_tokens"] for r in rs)
        max_turns = max(r["total_turns"] for r in rs)
        trunc_any = any(r["truncations"] > 0 for r in rs)
        print(
            f"- {model:24s} max_tokens={max_tokens:>10,} max_turns={max_turns:>3d} truncations_any={trunc_any}"
        )


def phase1(records: list[dict[str, Any]], output_dir: Path) -> None:
    rows = [
        {
            "model": r["model"],
            "run": r["run"],
            "task_name": r["task_name"],
            "success": r["success"],
            "total_turns": r["total_turns"],
            "input_tokens": r["input_tokens"],
            "output_tokens": r["output_tokens"],
            "tool_calls": r["tool_calls"],
            "truncations": r["truncations"],
            "total_messages": r["total_messages"],
            "final_messages": r["final_messages"],
            "retention_ratio": r["retention_ratio"],
            "avg_tokens_per_turn": r["avg_tokens_per_turn"],
            "cost_usd": r["cost_usd"],
        }
        for r in records
    ]
    write_csv(
        output_dir / "session_stats.csv",
        rows,
        [
            "model",
            "run",
            "task_name",
            "success",
            "total_turns",
            "input_tokens",
            "output_tokens",
            "tool_calls",
            "truncations",
            "total_messages",
            "final_messages",
            "retention_ratio",
            "avg_tokens_per_turn",
            "cost_usd",
        ],
    )

    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        by_model[r["model"]].append(r)

    print("\n=== Phase 1: Session Stats Summary ===")
    for model in sorted(by_model.keys()):
        rs = by_model[model]
        turns = [r["total_turns"] for r in rs]
        tokens = [r["input_tokens"] for r in rs]
        retention = [
            r["retention_ratio"] for r in rs if r["retention_ratio"] is not None
        ]
        success_rate = sum(1 for r in rs if r["success"]) / len(rs)
        avg_cost = statistics.mean(r["cost_usd"] for r in rs)
        print(
            f"- {model:24s} n={len(rs):3d} turns_med={percentile(turns, 0.5):6.1f} turns_p90={percentile(turns, 0.9):6.1f} "
            f"tokens_med={percentile(tokens, 0.5):>10,.0f} tokens_p90={percentile(tokens, 0.9):>10,.0f} "
            f"ret_mean={statistics.mean(retention) if retention else float('nan'):5.2f} success={success_rate:5.2%} avg_cost=${avg_cost:.3f}"
        )

    print("\nPer-run success variance check:")
    per_model_run_rates: dict[str, dict[int, float]] = defaultdict(dict)
    for model in sorted(by_model.keys()):
        for run in sorted(set(r["run"] for r in by_model[model])):
            rs = [r for r in by_model[model] if r["run"] == run]
            per_model_run_rates[model][run] = sum(1 for r in rs if r["success"]) / len(
                rs
            )

    for model in sorted(per_model_run_rates.keys()):
        rates = list(per_model_run_rates[model].values())
        stddev = statistics.pstdev(rates) if rates else 0.0
        flag = " HIGH_VARIANCE" if stddev > 0.1 else ""
        joined = ", ".join(
            f"r{run}={rate:.2%}"
            for run, rate in sorted(per_model_run_rates[model].items())
        )
        print(f"- {model:24s} {joined} stddev={stddev:.3f}{flag}")


def phase2(records: list[dict[str, Any]], output_dir: Path) -> None:
    rows: list[dict[str, Any]] = []
    for r in records:
        messages = r["messages"]
        role_chars = Counter()
        tool_msg_sizes: list[int] = []
        for msg in messages:
            role = msg.get("role", "unknown")
            chars = role_content_chars(msg)
            role_chars[role] += chars
            if role == "tool":
                tool_msg_sizes.append(chars)

        total_chars = sum(role_chars.values())

        quart = len(messages) // 4
        early = messages[:quart] if quart > 0 else []
        late = messages[-quart:] if quart > 0 else []

        def tool_chars(msgs: list[dict[str, Any]]) -> int:
            return sum(role_content_chars(m) for m in msgs if m.get("role") == "tool")

        early_tool = tool_chars(early)
        late_tool = tool_chars(late)

        rows.append(
            {
                "model": r["model"],
                "run": r["run"],
                "task_name": r["task_name"],
                "total_chars": total_chars,
                "tool_chars": role_chars.get("tool", 0),
                "assistant_chars": role_chars.get("assistant", 0),
                "user_chars": role_chars.get("user", 0),
                "tool_pct": (
                    role_chars.get("tool", 0) / total_chars if total_chars > 0 else None
                ),
                "assistant_pct": (
                    role_chars.get("assistant", 0) / total_chars
                    if total_chars > 0
                    else None
                ),
                "user_pct": (
                    role_chars.get("user", 0) / total_chars if total_chars > 0 else None
                ),
                "early_tool_chars": early_tool,
                "late_tool_chars": late_tool,
                "early_late_ratio": (early_tool / late_tool if late_tool > 0 else None),
                "largest_tool_result_chars": max(tool_msg_sizes)
                if tool_msg_sizes
                else 0,
                "n_tool_messages": len(tool_msg_sizes),
            }
        )

    write_csv(
        output_dir / "composition.csv",
        rows,
        [
            "model",
            "run",
            "task_name",
            "total_chars",
            "tool_chars",
            "assistant_chars",
            "user_chars",
            "tool_pct",
            "assistant_pct",
            "user_pct",
            "early_tool_chars",
            "late_tool_chars",
            "early_late_ratio",
            "largest_tool_result_chars",
            "n_tool_messages",
        ],
    )

    tool_pct_values = [r["tool_pct"] for r in rows if r["tool_pct"] is not None]
    early_gt_late = sum(
        1
        for r in rows
        if r["early_late_ratio"] is not None and r["early_late_ratio"] > 1.0
    )
    early_late_values = [
        r["early_late_ratio"] for r in rows if r["early_late_ratio"] is not None
    ]
    largest_values = [r["largest_tool_result_chars"] for r in rows]

    print("\n=== Phase 2: Context Composition Summary ===")
    print(
        f"- tool_pct median={percentile(tool_pct_values, 0.5):.2%} p90={percentile(tool_pct_values, 0.9):.2%}"
    )
    print(
        "- note: Claude assistant messages may be None; they are counted as 0 chars, which inflates tool share"
    )
    print(
        f"- early_late_ratio median={percentile(early_late_values, 0.5):.2f} sessions_early_gt_late={early_gt_late}/{len(early_late_values)}"
    )
    print(
        f"- largest_tool_result_chars median={percentile(largest_values, 0.5):,.0f} p90={percentile(largest_values, 0.9):,.0f} max={max(largest_values):,}"
    )


def last_assistant_content(messages: list[dict[str, Any]]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            content = msg.get("content")
            return "" if content is None else str(content)
    return ""


def build_failure_case(
    prefix: str,
    task: str,
    winner: dict[str, Any],
    loser: dict[str, Any],
    out_dir: Path,
) -> None:
    # Approximation: dropped_n is used to slice winner messages from the front.
    # This is valid for tool-result loss pattern analysis under FIFO truncation,
    # but assistant messages are model-specific and are not semantically aligned.
    dropped_n = max(loser["total_messages"] - loser["final_messages"], 0)
    winner_msgs = winner["messages"]
    loser_msgs = loser["messages"]
    dropped_msgs = winner_msgs[: min(dropped_n, len(winner_msgs))]

    dropped_summary = {
        "tool_count": 0,
        "assistant_count": 0,
        "user_count": 0,
        "total_chars": 0,
        "label_distribution": Counter(),
    }

    dropped_rows = []
    for i, msg in enumerate(dropped_msgs):
        role = msg.get("role", "unknown")
        content = "" if msg.get("content") is None else str(msg.get("content"))
        chars = len(content)
        label = classify_tool_message(content) if role == "tool" else "non_tool"

        dropped_summary["total_chars"] += chars
        if role == "tool":
            dropped_summary["tool_count"] += 1
            dropped_summary["label_distribution"][label] += 1
        elif role == "assistant":
            dropped_summary["assistant_count"] += 1
        elif role == "user":
            dropped_summary["user_count"] += 1

        dropped_rows.append(
            {
                "index": i,
                "role": role,
                "chars": chars,
                "label": label,
                "preview": content[:140],
            }
        )

    dropped_summary["label_distribution"] = dict(dropped_summary["label_distribution"])

    payload = {
        "task": task,
        "winner_model": winner["model"],
        "loser_model": loser["model"],
        "winner_success": winner["success"],
        "loser_success": loser["success"],
        "winner_input_tokens": winner["input_tokens"],
        "loser_input_tokens": loser["input_tokens"],
        "winner_turns": winner["total_turns"],
        "loser_turns": loser["total_turns"],
        "loser_dropped_messages": dropped_n,
        "loser_retention_ratio": loser["retention_ratio"],
        "approximation_note": (
            "Dropped-message slice is used as a proxy for tool-result loss under FIFO truncation. "
            "Assistant message content differs by model and is not compared semantically."
        ),
        "dropped_messages": dropped_rows,
        "dropped_summary": dropped_summary,
        "winner_final_response": last_assistant_content(winner_msgs),
        "loser_final_response": last_assistant_content(loser_msgs),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{prefix}_{task}.json"
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def phase3(records: list[dict[str, Any]], output_dir: Path) -> None:
    run1 = [r for r in records if r["run"] == 1]
    idx: dict[tuple[str, str], dict[str, Any]] = {
        (r["model"], r["task_name"]): r for r in run1
    }

    o3_tasks = {task for model, task in idx.keys() if model == "o3"}
    haiku_tasks = {
        task for model, task in idx.keys() if model == "claude-4.5-haiku-1001"
    }
    shared = sorted(o3_tasks & haiku_tasks)

    matrix_rows: list[dict[str, Any]] = []
    o3_only: list[dict[str, Any]] = []
    haiku_only: list[dict[str, Any]] = []

    counts = Counter()
    for task in shared:
        o3 = idx[("o3", task)]
        haiku = idx[("claude-4.5-haiku-1001", task)]

        if o3["success"] and haiku["success"]:
            outcome = "both"
        elif o3["success"] and not haiku["success"]:
            outcome = "o3_only"
        elif not o3["success"] and haiku["success"]:
            outcome = "haiku_only"
        else:
            outcome = "neither"
        counts[outcome] += 1

        dropped = max(haiku["total_messages"] - haiku["final_messages"], 0)
        row = {
            "task_name": task,
            "o3_success": o3["success"],
            "haiku_success": haiku["success"],
            "outcome_category": outcome,
            "o3_turns": o3["total_turns"],
            "haiku_turns": haiku["total_turns"],
            "o3_input_tokens": o3["input_tokens"],
            "haiku_input_tokens": haiku["input_tokens"],
            "o3_final_messages": o3["final_messages"],
            "haiku_final_messages": haiku["final_messages"],
            "haiku_total_messages": haiku["total_messages"],
            "haiku_dropped_messages": dropped,
            "haiku_retention_ratio": haiku["retention_ratio"],
        }
        matrix_rows.append(row)

        if outcome == "o3_only":
            o3_only.append(row)
        if outcome == "haiku_only":
            haiku_only.append(row)

    write_csv(
        output_dir / "outcome_matrix.csv",
        matrix_rows,
        [
            "task_name",
            "o3_success",
            "haiku_success",
            "outcome_category",
            "o3_turns",
            "haiku_turns",
            "o3_input_tokens",
            "haiku_input_tokens",
            "o3_final_messages",
            "haiku_final_messages",
            "haiku_total_messages",
            "haiku_dropped_messages",
            "haiku_retention_ratio",
        ],
    )

    failure_dir = output_dir / "failure_cases"
    for row in sorted(o3_only, key=lambda r: r["haiku_dropped_messages"], reverse=True)[
        :4
    ]:
        task = row["task_name"]
        build_failure_case(
            "o3_only",
            task,
            winner=idx[("o3", task)],
            loser=idx[("claude-4.5-haiku-1001", task)],
            out_dir=failure_dir,
        )

    for row in sorted(haiku_only, key=lambda r: r["haiku_input_tokens"], reverse=True)[
        :4
    ]:
        task = row["task_name"]
        build_failure_case(
            "haiku_only",
            task,
            winner=idx[("claude-4.5-haiku-1001", task)],
            loser=idx[("o3", task)],
            out_dir=failure_dir,
        )

    print("\n=== Phase 3: Natural Experiment (run 1, o3 vs haiku) ===")
    print(
        f"- shared_tasks={len(shared)} both={counts['both']} neither={counts['neither']} o3_only={counts['o3_only']} haiku_only={counts['haiku_only']}"
    )
    if haiku_only:
        o3_tokens = [r["o3_input_tokens"] for r in haiku_only]
        h_tokens = [r["haiku_input_tokens"] for r in haiku_only]
        o3_turns = [r["o3_turns"] for r in haiku_only]
        h_turns = [r["haiku_turns"] for r in haiku_only]
        print(
            f"- haiku_only averages: o3_tokens={statistics.mean(o3_tokens):,.0f} haiku_tokens={statistics.mean(h_tokens):,.0f} "
            f"o3_turns={statistics.mean(o3_turns):.1f} haiku_turns={statistics.mean(h_turns):.1f}"
        )


def write_method_file(output_dir: Path) -> None:
    method = """# METHOD

## Scope

- Dataset: `hkust-nlp/Toolathlon-Trajectories`
- Analysis script: `research/scripts/toolathlon_analysis.py`
- Cross-model deep-dive: run `_1` only (`o3` vs `claude-4.5-haiku-1001`)

## Parsing and normalization rules

- `modelname_run` is parsed via the final underscore only:
  - `model, run = modelname_run.rsplit("_", 1)`
- Records with null `key_stats` or null `messages` are skipped.
- Missing model/run files (404) are logged and skipped (no crash).

## Metrics by phase

- **Phase 0 / 1 / 3 token metrics** use `agent_cost.total_input_tokens` and `agent_cost.total_output_tokens`.
- **Phase 2 composition metrics** use character counts from `messages` content.
  - `assistant` messages with `content = null` are counted as zero characters.

## Approximation caveat for cross-model dropped-message analysis

- For failure cases, dropped-message proxy is computed by slicing the winner's front context (`winner_messages[:dropped_n]`) where `dropped_n = loser_total_messages - loser_final_messages`.
- This approximation is intended for **tool-result loss pattern analysis under FIFO truncation**.
- Assistant messages are model-specific and are **not** semantically comparable across models.

## Claims we can make

- Relative retention behavior across models (`final_messages / total_messages`).
- Source-type dominance in final context windows (tool vs assistant vs user volume).
- Early-vs-late tool-result mass in final context windows.
- Cross-model outcome patterns on identical tasks (o3-only, haiku-only, both, neither).
- Presence/absence of explicit agent-invoked context management (`truncations`).
- Zero agent-invoked context management events in analyzed sessions, even when sessions reach millions of input tokens.

## Claims we cannot make

- Exact per-turn context growth curves from this dataset schema.
- Exact causal attribution of failures to specific dropped assistant messages.
- Exact per-turn compaction timestamps (only aggregate session stats are available).

## Reproducibility

Run:

```bash
python3 research/scripts/toolathlon_analysis.py
```

Outputs are written to `research/output/toolathlon/` by default.
"""
    (output_dir / "METHOD.md").write_text(method, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("/tmp/toolathlon"),
        help="Local cache directory for downloaded JSONL files.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("research/output/toolathlon"),
        help="Directory for generated analysis outputs.",
    )
    parser.add_argument(
        "--models",
        type=str,
        default=",".join(MODELS),
        help="Comma-separated model list to include.",
    )
    parser.add_argument(
        "--runs",
        type=str,
        default="1,2,3",
        help="Comma-separated run numbers to include.",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip download step and read from cache only.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    runs = [int(r.strip()) for r in args.runs.split(",") if r.strip()]

    if not args.skip_download:
        download_all(args.cache_dir, models, runs)

    records: list[dict[str, Any]] = []
    for model in models:
        for run in runs:
            path = args.cache_dir / f"{model}_{run}.jsonl"
            if not path.exists():
                print(f"[warn] missing cached file: {path}")
                continue
            raw_records = load_records(path)
            for raw in raw_records:
                normalized = normalize_record(raw)
                if normalized is not None:
                    records.append(normalized)

    if not records:
        raise SystemExit("No valid records loaded.")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    phase0(records)
    phase1(records, args.output_dir)
    phase2(records, args.output_dir)
    phase3(records, args.output_dir)
    write_method_file(args.output_dir)

    print("\nOutputs written to:", args.output_dir)


if __name__ == "__main__":
    main()
