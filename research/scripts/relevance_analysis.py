#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import glob as glob_module
import json
import math
import os
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT_GLOB = str(Path.home() / ".budge/relevance/*.jsonl")
DEFAULT_OUTPUT_DIR = REPO_ROOT / "research/output/relevance"
PLOTTING_PACKAGES = {"altair", "bokeh", "matplotlib", "plotly", "seaborn", "vega"}
PATCH_TOOL_NAMES = {"apply_patch", "patch", "edit", "write"}
PRIMARY_RESULT_SOURCES = ("output", "metadata", "title")
DEFAULT_SHORT_PROMPT_CHARS = 20
PROMPT_SNIPPET_MAX_CHARS = 100


@dataclass(slots=True)
class Record:
    session_id: str
    turn_index: int
    tool: str
    score: float
    result_source: str | None
    prompt_snippet: str | None
    prompt_enriched: bool | None
    timestamp_raw: str | None
    timestamp: datetime | None
    file_path: str | None
    normalized_file_path: str | None
    source_file: Path
    line_number: int
    sequence: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze Budge relevance logs.")
    parser.add_argument(
        "--input-glob",
        default=DEFAULT_INPUT_GLOB,
        help=f"JSONL glob to analyze (default: {DEFAULT_INPUT_GLOB})",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--short-prompt-chars",
        type=int,
        default=DEFAULT_SHORT_PROMPT_CHARS,
        help=(
            "Treat non-enriched prompts shorter than this length as low-signal "
            f"(default: {DEFAULT_SHORT_PROMPT_CHARS}, max: {PROMPT_SNIPPET_MAX_CHARS})"
        ),
    )
    args = parser.parse_args()
    if (
        args.short_prompt_chars < 0
        or args.short_prompt_chars > PROMPT_SNIPPET_MAX_CHARS
    ):
        parser.error(
            "--short-prompt-chars must be between 0 and "
            f"{PROMPT_SNIPPET_MAX_CHARS} because promptSnippet is capped at "
            f"{PROMPT_SNIPPET_MAX_CHARS} chars in the source logs."
        )
    return args


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def parse_result_source(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def parse_prompt_snippet(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def result_source_bucket(value: str | None) -> str:
    if value in PRIMARY_RESULT_SOURCES:
        return value
    return "unknown"


def is_patch_tool(tool: str) -> bool:
    return tool in PATCH_TOOL_NAMES


def normalize_file_path(value: str | None) -> str | None:
    if value is None:
        return None
    expanded = os.path.expanduser(value)
    path = Path(expanded)
    if not path.is_absolute():
        return os.path.normpath(expanded)
    try:
        return str(path.resolve(strict=False))
    except OSError:
        return os.path.normpath(str(path))


def same_file_path(left: str | None, right: str | None) -> bool:
    if left is None or right is None:
        return False
    return left == right


def parse_record(
    raw: dict[str, Any], source_file: Path, line_number: int, sequence: int
) -> Record:
    session_id = raw.get("sessionId")
    tool = raw.get("tool")

    if not isinstance(session_id, str) or not session_id:
        raise ValueError("missing sessionId")
    if not isinstance(tool, str) or not tool:
        raise ValueError("missing tool")

    try:
        turn_index = int(raw.get("turnIndex"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid turnIndex") from exc

    try:
        score = float(raw.get("score"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid score") from exc

    file_path = raw.get("filePath")
    if not isinstance(file_path, str) or not file_path:
        file_path = None

    timestamp_raw = raw.get("timestamp")
    if not isinstance(timestamp_raw, str) or not timestamp_raw:
        timestamp_raw = None

    return Record(
        session_id=session_id,
        turn_index=turn_index,
        tool=tool,
        score=score,
        result_source=parse_result_source(raw.get("resultSource")),
        prompt_snippet=parse_prompt_snippet(raw.get("promptSnippet")),
        prompt_enriched=parse_bool(raw.get("promptEnriched")),
        timestamp_raw=timestamp_raw,
        timestamp=parse_timestamp(timestamp_raw),
        file_path=file_path,
        normalized_file_path=normalize_file_path(file_path),
        source_file=source_file,
        line_number=line_number,
        sequence=sequence,
    )


def load_records(input_glob: str) -> tuple[list[Path], list[Record], dict[str, int]]:
    expanded_glob = os.path.expanduser(input_glob)
    matched_files = sorted(Path(path) for path in glob_module.glob(expanded_glob))

    stats = {
        "filesMatched": len(matched_files),
        "nonBlankLines": 0,
        "blankLines": 0,
        "jsonErrors": 0,
        "invalidRecords": 0,
    }
    records: list[Record] = []
    sequence = 0

    for path in matched_files:
        if not path.is_file():
            continue
        with path.open("r", encoding="utf-8") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line:
                    stats["blankLines"] += 1
                    continue
                stats["nonBlankLines"] += 1
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    stats["jsonErrors"] += 1
                    continue
                if not isinstance(payload, dict):
                    stats["invalidRecords"] += 1
                    continue
                try:
                    record = parse_record(payload, path, line_number, sequence)
                except ValueError:
                    stats["invalidRecords"] += 1
                    continue
                records.append(record)
                sequence += 1

    return matched_files, records, stats


def build_timelines(records: list[Record]) -> dict[str, list[Record]]:
    timelines: dict[str, list[Record]] = defaultdict(list)
    for record in records:
        timelines[record.session_id].append(record)
    for session_id, session_records in timelines.items():
        session_records.sort(
            key=lambda record: (
                record.turn_index,
                record.timestamp_raw or "",
                record.sequence,
            )
        )
        timelines[session_id] = session_records
    return dict(sorted(timelines.items()))


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = (len(ordered) - 1) * p
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    fraction = index - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def summarize_scores(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {
            "count": 0,
            "min": None,
            "p25": None,
            "median": None,
            "p75": None,
            "max": None,
            "mean": None,
        }
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "min": ordered[0],
        "p25": percentile(ordered, 0.25),
        "median": percentile(ordered, 0.5),
        "p75": percentile(ordered, 0.75),
        "max": ordered[-1],
        "mean": statistics.fmean(ordered),
    }


def summarize_records(records: list[Record]) -> dict[str, float | int | None]:
    return summarize_scores([record.score for record in records])


def bucket_label(score: float) -> str:
    if score <= 0.1:
        return "0.0-0.1"
    if score <= 0.2:
        return "0.1-0.2"
    if score <= 0.3:
        return "0.2-0.3"
    if score <= 0.4:
        return "0.3-0.4"
    if score <= 0.5:
        return "0.4-0.5"
    if score <= 0.6:
        return "0.5-0.6"
    if score <= 0.7:
        return "0.6-0.7"
    if score <= 0.8:
        return "0.7-0.8"
    if score <= 0.9:
        return "0.8-0.9"
    return "0.9-1.0"


def build_bucket_rows(records: list[Record]) -> list[dict[str, Any]]:
    labels = [
        "0.0-0.1",
        "0.1-0.2",
        "0.2-0.3",
        "0.3-0.4",
        "0.4-0.5",
        "0.5-0.6",
        "0.6-0.7",
        "0.7-0.8",
        "0.8-0.9",
        "0.9-1.0",
    ]
    counts = {label: 0 for label in labels}
    for record in records:
        counts[bucket_label(record.score)] += 1
    total = len(records)
    return [
        {
            "bucket": label,
            "count": counts[label],
            "pct": counts[label] / total if total else 0.0,
        }
        for label in labels
    ]


def distance_bucket(distance: int) -> str:
    if distance <= 0:
        return "0"
    if distance == 1:
        return "1"
    if distance <= 3:
        return "2-3"
    if distance <= 7:
        return "4-7"
    return "8+"


def seconds_between(earlier: Record, later: Record) -> float | None:
    if earlier.timestamp is None or later.timestamp is None:
        return None
    return (later.timestamp - earlier.timestamp).total_seconds()


def is_short_plain_prompt(record: Record, short_prompt_chars: int) -> bool:
    return (
        record.prompt_enriched is False
        and record.prompt_snippet is not None
        and len(record.prompt_snippet) < short_prompt_chars
    )


def build_read_patch_pairs(
    timelines: dict[str, list[Record]],
    short_prompt_chars: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    pairs: list[dict[str, Any]] = []
    coverage = {
        "readRows": 0,
        "readRowsWithFilePath": 0,
        "readRowsExcludedShortPrompt": 0,
        "patchRows": 0,
        "patchRowsWithFilePath": 0,
        "patchRowsMissingFilePath": 0,
        "readsWithAnyLaterPatch": 0,
        "readsWithSameFilePatchBeforeFiltering": 0,
        "sameFilePatchCandidatesExcludedShortPrompt": 0,
        "readsWithSameFilePatch": 0,
        "pairs": 0,
    }

    for session_id, records in timelines.items():
        for index, record in enumerate(records):
            if record.tool == "read":
                coverage["readRows"] += 1
                if record.file_path:
                    coverage["readRowsWithFilePath"] += 1
                if is_short_plain_prompt(record, short_prompt_chars):
                    coverage["readRowsExcludedShortPrompt"] += 1
            elif is_patch_tool(record.tool):
                coverage["patchRows"] += 1
                if record.file_path:
                    coverage["patchRowsWithFilePath"] += 1
                else:
                    coverage["patchRowsMissingFilePath"] += 1

            if record.tool != "read" or not record.normalized_file_path:
                continue
            if is_short_plain_prompt(record, short_prompt_chars):
                continue

            later_patches = [
                later for later in records[index + 1 :] if is_patch_tool(later.tool)
            ]
            if later_patches:
                coverage["readsWithAnyLaterPatch"] += 1

            same_file_patches = [
                later
                for later in later_patches
                if same_file_path(
                    later.normalized_file_path, record.normalized_file_path
                )
            ]
            if same_file_patches:
                coverage["readsWithSameFilePatchBeforeFiltering"] += 1

            next_same_file_patch = next(
                (
                    later
                    for later in same_file_patches
                    if not is_short_plain_prompt(later, short_prompt_chars)
                ),
                None,
            )
            if same_file_patches and next_same_file_patch is None:
                coverage["sameFilePatchCandidatesExcludedShortPrompt"] += 1

            if next_same_file_patch is not None:
                later = next_same_file_patch
                pairs.append(
                    {
                        "sessionId": session_id,
                        "filePath": record.file_path,
                        "patchTool": later.tool,
                        "readTurnIndex": record.turn_index,
                        "patchTurnIndex": later.turn_index,
                        "turnDistance": later.turn_index - record.turn_index,
                        "turnDistanceBucket": distance_bucket(
                            later.turn_index - record.turn_index
                        ),
                        "readTimestamp": record.timestamp_raw or "",
                        "patchTimestamp": later.timestamp_raw or "",
                        "timeDistanceSeconds": seconds_between(record, later),
                        "readScore": record.score,
                        "patchScore": later.score,
                        "scoreDelta": later.score - record.score,
                        "readPromptEnriched": record.prompt_enriched,
                        "patchPromptEnriched": later.prompt_enriched,
                    }
                )
                coverage["readsWithSameFilePatch"] += 1

    coverage["pairs"] = len(pairs)
    return pairs, coverage


def build_reread_pairs(
    timelines: dict[str, list[Record]],
    short_prompt_chars: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    pairs: list[dict[str, Any]] = []
    coverage = {
        "readRows": 0,
        "readRowsWithFilePath": 0,
        "readRowsExcludedShortPrompt": 0,
        "readsWithAnyLaterRead": 0,
        "readsWithSameFileRereadBeforeFiltering": 0,
        "sameFileRereadCandidatesExcludedShortPrompt": 0,
        "readsWithSameFileReread": 0,
        "pairs": 0,
    }

    for session_id, records in timelines.items():
        for index, record in enumerate(records):
            if record.tool != "read":
                continue
            coverage["readRows"] += 1
            if record.file_path:
                coverage["readRowsWithFilePath"] += 1
            else:
                continue
            if is_short_plain_prompt(record, short_prompt_chars):
                coverage["readRowsExcludedShortPrompt"] += 1
                continue

            later_reads = [
                later for later in records[index + 1 :] if later.tool == "read"
            ]
            if later_reads:
                coverage["readsWithAnyLaterRead"] += 1

            same_file_rereads = [
                later
                for later in later_reads
                if same_file_path(
                    later.normalized_file_path, record.normalized_file_path
                )
            ]
            if same_file_rereads:
                coverage["readsWithSameFileRereadBeforeFiltering"] += 1

            next_same_file_reread = next(
                (
                    later
                    for later in same_file_rereads
                    if not is_short_plain_prompt(later, short_prompt_chars)
                ),
                None,
            )
            if same_file_rereads and next_same_file_reread is None:
                coverage["sameFileRereadCandidatesExcludedShortPrompt"] += 1

            if next_same_file_reread is not None:
                later = next_same_file_reread
                pairs.append(
                    {
                        "sessionId": session_id,
                        "filePath": record.file_path,
                        "earlierReadTurnIndex": record.turn_index,
                        "laterReadTurnIndex": later.turn_index,
                        "turnDistance": later.turn_index - record.turn_index,
                        "turnDistanceBucket": distance_bucket(
                            later.turn_index - record.turn_index
                        ),
                        "earlierReadTimestamp": record.timestamp_raw or "",
                        "laterReadTimestamp": later.timestamp_raw or "",
                        "timeDistanceSeconds": seconds_between(record, later),
                        "earlierReadScore": record.score,
                        "laterReadScore": later.score,
                        "scoreDelta": later.score - record.score,
                        "earlierPromptEnriched": record.prompt_enriched,
                        "laterPromptEnriched": later.prompt_enriched,
                    }
                )
                coverage["readsWithSameFileReread"] += 1

    coverage["pairs"] = len(pairs)
    return pairs, coverage


def aggregate_pair_rows(
    rows: list[dict[str, Any]],
    earlier_key: str,
    later_key: str,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["turnDistanceBucket"])].append(row)

    bucket_order = ["0", "1", "2-3", "4-7", "8+"]
    summary_rows: list[dict[str, Any]] = []
    for bucket in bucket_order:
        bucket_rows = grouped.get(bucket, [])
        if not bucket_rows:
            continue
        earlier_scores = [float(row[earlier_key]) for row in bucket_rows]
        later_scores = [float(row[later_key]) for row in bucket_rows]
        deltas = [float(row["scoreDelta"]) for row in bucket_rows]
        summary_rows.append(
            {
                "turnDistanceBucket": bucket,
                "pairs": len(bucket_rows),
                "meanEarlierScore": statistics.fmean(earlier_scores),
                "meanLaterScore": statistics.fmean(later_scores),
                "medianScoreDelta": percentile(deltas, 0.5),
            }
        )
    return summary_rows


def detect_plotting_stack() -> list[str]:
    manifests = [
        REPO_ROOT / "package.json",
        *sorted((REPO_ROOT / "packages").glob("*/package.json")),
        *sorted((REPO_ROOT / "examples").glob("*/package.json")),
        REPO_ROOT / "pyproject.toml",
        REPO_ROOT / "requirements.txt",
        REPO_ROOT / "research/requirements.txt",
    ]
    found: set[str] = set()

    for manifest in manifests:
        if not manifest.exists() or not manifest.is_file():
            continue
        suffix = manifest.suffix.lower()
        if suffix == ".json":
            try:
                payload = json.loads(manifest.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            for section in ("dependencies", "devDependencies", "peerDependencies"):
                deps = payload.get(section) or {}
                if not isinstance(deps, dict):
                    continue
                for name in deps:
                    lower_name = str(name).lower()
                    if lower_name in PLOTTING_PACKAGES:
                        found.add(lower_name)
        else:
            text = manifest.read_text(encoding="utf-8", errors="ignore").lower()
            for package in PLOTTING_PACKAGES:
                if package in text:
                    found.add(package)

    return sorted(found)


def maybe_write_charts(
    output_dir: Path,
    records: list[Record],
    read_patch_pairs: list[dict[str, Any]],
    reread_pairs: list[dict[str, Any]],
    plotting_stack: list[str],
) -> tuple[list[str], str]:
    if "matplotlib" not in plotting_stack:
        return [], "No supported plotting stack detected in repo manifests."

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return (
            [],
            "Repo manifests mention matplotlib, but it is not available in the current environment.",
        )

    chart_paths: list[str] = []

    scores = [record.score for record in records]
    if scores:
        figure, axis = plt.subplots(figsize=(7, 4))
        axis.hist(scores, bins=[index / 10 for index in range(11)], edgecolor="black")
        axis.set_title("Overall Relevance Score Distribution")
        axis.set_xlabel("Score")
        axis.set_ylabel("Count")
        histogram_path = output_dir / "score_histogram.png"
        figure.tight_layout()
        figure.savefig(histogram_path, dpi=150)
        plt.close(figure)
        chart_paths.append(histogram_path.name)

    if read_patch_pairs:
        figure, axis = plt.subplots(figsize=(7, 4))
        axis.scatter(
            [int(row["turnDistance"]) for row in read_patch_pairs],
            [float(row["readScore"]) for row in read_patch_pairs],
            alpha=0.8,
        )
        axis.set_title("Earlier Read Score vs Patch Distance")
        axis.set_xlabel("Turn distance")
        axis.set_ylabel("Earlier read score")
        patch_path = output_dir / "read_patch_decay.png"
        figure.tight_layout()
        figure.savefig(patch_path, dpi=150)
        plt.close(figure)
        chart_paths.append(patch_path.name)

    if reread_pairs:
        figure, axis = plt.subplots(figsize=(7, 4))
        axis.scatter(
            [int(row["turnDistance"]) for row in reread_pairs],
            [float(row["laterReadScore"]) for row in reread_pairs],
            alpha=0.8,
        )
        axis.set_title("Read -> Re-read Scores by Turn Distance")
        axis.set_xlabel("Turn distance")
        axis.set_ylabel("Later read score")
        reread_path = output_dir / "read_reread_scores.png"
        figure.tight_layout()
        figure.savefig(reread_path, dpi=150)
        plt.close(figure)
        chart_paths.append(reread_path.name)

    if chart_paths:
        return chart_paths, f"Generated {len(chart_paths)} chart(s) with matplotlib."
    return [], "Matplotlib was available, but there was not enough data to draw charts."


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in fieldnames})


def fmt_int(value: int | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:,}"


def fmt_float(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.3f}"


def fmt_pct(numerator: int, denominator: int) -> str:
    if denominator <= 0:
        return "n/a"
    return f"{(numerator / denominator) * 100:.1f}%"


def fmt_pct_value(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.1f}%"


def fmt_timestamp(value: datetime | None) -> str:
    if value is None:
        return "n/a"
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_No rows._"
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def build_candidate_heuristics(
    records: list[Record],
    short_prompt_chars: int,
    read_patch_pairs: list[dict[str, Any]],
    patch_coverage: dict[str, int],
    reread_pairs: list[dict[str, Any]],
) -> list[str]:
    short_plain_records = [
        record
        for record in records
        if is_short_plain_prompt(record, short_prompt_chars)
    ]
    plain_other_records = [
        record
        for record in records
        if record.prompt_enriched is False
        and record.prompt_snippet is not None
        and not is_short_plain_prompt(record, short_prompt_chars)
    ]
    plain_missing_snippet_count = sum(
        1
        for record in records
        if record.prompt_enriched is False and record.prompt_snippet is None
    )

    heuristics = [
        "Shadow-demote short non-enriched prompts before using them as pruning evidence. "
        f"Current `promptEnriched=false` rows with `promptSnippet` < {short_prompt_chars} chars: {len(short_plain_records)}; "
        f"median score {fmt_float(percentile([record.score for record in short_plain_records], 0.5))}; "
        f"`plain-other` median score {fmt_float(percentile([record.score for record in plain_other_records], 0.5))}; "
        f"`plain-missing-snippet` rows excluded from that baseline: {plain_missing_snippet_count}.",
    ]

    if read_patch_pairs:
        read_scores = [float(row["readScore"]) for row in read_patch_pairs]
        patch_scores = [float(row["patchScore"]) for row in read_patch_pairs]
        deltas = [float(row["scoreDelta"]) for row in read_patch_pairs]
        heuristics.append(
            "Invalidate or sharply demote earlier `read` results for a file after a same-file patch-like mutation event. "
            f"Matched read->patch pairs: {len(read_patch_pairs)}; median read score {fmt_float(percentile(read_scores, 0.5))}, "
            f"median patch score {fmt_float(percentile(patch_scores, 0.5))}, median delta {fmt_float(percentile(deltas, 0.5))}."
        )
    else:
        heuristics.append(
            "Prepare a same-file mutation invalidation rule, but keep it in shadow mode until more matched `read -> patch` coverage accumulates. "
            f"Current patch filePath coverage is {fmt_pct(patch_coverage['patchRowsWithFilePath'], patch_coverage['patchRows'])}."
        )

    if reread_pairs:
        later_scores = [float(row["laterReadScore"]) for row in reread_pairs]
        deltas = [float(row["scoreDelta"]) for row in reread_pairs]
        heuristics.append(
            "When the same file is re-read and the later read remains high-scoring, keep only the newest read in the active window and shadow-drop older same-file reads. "
            f"Matched read->re-read pairs: {len(reread_pairs)}; median later-read score {fmt_float(percentile(later_scores, 0.5))}, "
            f"median later-minus-earlier delta {fmt_float(percentile(deltas, 0.5))}."
        )
    else:
        heuristics.append(
            "Add a latest-read-wins candidate heuristic to the backlog, but do not enable it yet. The current sample produced no same-file `read -> re-read` pairs, so there is no direct evidence for or against it."
        )

    return heuristics


def write_report(
    output_path: Path,
    input_glob: str,
    matched_files: list[Path],
    records: list[Record],
    short_prompt_chars: int,
    load_stats: dict[str, int],
    timelines: dict[str, list[Record]],
    overall_summary: dict[str, float | int | None],
    bucket_rows: list[dict[str, Any]],
    tool_rows: list[dict[str, Any]],
    enrichment_rows: list[dict[str, Any]],
    plain_prompt_rows: list[dict[str, Any]],
    file_path_rows: list[dict[str, Any]],
    result_source_rows: list[dict[str, Any]],
    read_patch_pairs: list[dict[str, Any]],
    read_patch_coverage: dict[str, int],
    read_patch_summary: list[dict[str, Any]],
    reread_pairs: list[dict[str, Any]],
    reread_coverage: dict[str, int],
    reread_summary: list[dict[str, Any]],
    observed_patch_tools: list[str],
    plotting_stack: list[str],
    chart_paths: list[str],
    chart_note: str,
    heuristics: list[str],
) -> None:
    session_rows = []
    for session_id, session_records in sorted(
        timelines.items(), key=lambda item: (-len(item[1]), item[0])
    ):
        timestamps = [
            record.timestamp
            for record in session_records
            if record.timestamp is not None
        ]
        session_rows.append(
            [
                session_id,
                fmt_int(len(session_records)),
                fmt_int(len({record.turn_index for record in session_records})),
                fmt_int(len({record.tool for record in session_records})),
                fmt_timestamp(min(timestamps) if timestamps else None),
                fmt_timestamp(max(timestamps) if timestamps else None),
            ]
        )

    enriched_present = any(
        row["cohort"] == "enriched=true" and row["count"] for row in enrichment_rows
    )
    plain_present = any(
        row["cohort"] == "enriched=false" and row["count"] for row in enrichment_rows
    )
    total_records = len(records)
    output_result_source_count = sum(
        1 for record in records if record.result_source == "output"
    )
    metadata_result_source_count = sum(
        1 for record in records if record.result_source == "metadata"
    )
    title_result_source_count = sum(
        1 for record in records if record.result_source == "title"
    )
    prompt_enriched_true_count = sum(
        1 for record in records if record.prompt_enriched is True
    )
    short_plain_prompt_count = sum(
        1 for record in records if is_short_plain_prompt(record, short_prompt_chars)
    )
    read_records = [record for record in records if record.tool == "read"]
    read_records_with_file_path = sum(1 for record in read_records if record.file_path)
    records_with_file_path = sum(1 for record in records if record.file_path)

    lines = [
        "# Relevance Analysis Report",
        "",
        f"Generated: {fmt_timestamp(datetime.now(UTC))}",
        f"Input glob: `{os.path.expanduser(input_glob)}`",
        f"Output directory: `{output_path.parent}`",
        "",
        "## Summary",
        "",
        markdown_table(
            ["Metric", "Value"],
            [
                ["Matched files", fmt_int(len(matched_files))],
                ["Total records parsed", fmt_int(total_records)],
                ["Sessions", fmt_int(len(timelines))],
                ["JSON parse errors", fmt_int(load_stats["jsonErrors"])],
                ["Invalid records", fmt_int(load_stats["invalidRecords"])],
                [
                    "resultSource=output",
                    fmt_pct(output_result_source_count, total_records),
                ],
                [
                    "resultSource=metadata",
                    fmt_pct(metadata_result_source_count, total_records),
                ],
                [
                    "resultSource=title",
                    fmt_pct(title_result_source_count, total_records),
                ],
                [
                    "promptEnriched=true",
                    fmt_pct(prompt_enriched_true_count, total_records),
                ],
                [
                    f"promptEnriched=false and promptSnippet<{short_prompt_chars}",
                    fmt_pct(short_plain_prompt_count, total_records),
                ],
                [
                    "Read rows with filePath",
                    fmt_pct(read_records_with_file_path, len(read_records)),
                ],
                [
                    "All rows with filePath",
                    fmt_pct(records_with_file_path, total_records),
                ],
                [
                    "Prompt enrichment cohorts",
                    f"true={fmt_int(sum(1 for record in records if record.prompt_enriched is True))}, false={fmt_int(sum(1 for record in records if record.prompt_enriched is False))}, unknown={fmt_int(sum(1 for record in records if record.prompt_enriched is None))}",
                ],
                ["Charts", ", ".join(chart_paths) if chart_paths else chart_note],
            ],
        ),
        "",
        "## Sessions",
        "",
        markdown_table(
            ["Session", "Rows", "Turns", "Tools", "First timestamp", "Last timestamp"],
            session_rows,
        ),
        "",
        "## Overall Score Distribution",
        "",
        markdown_table(
            ["Count", "Min", "P25", "Median", "P75", "Max", "Mean"],
            [
                [
                    fmt_int(int(overall_summary["count"] or 0)),
                    fmt_float(overall_summary["min"]),
                    fmt_float(overall_summary["p25"]),
                    fmt_float(overall_summary["median"]),
                    fmt_float(overall_summary["p75"]),
                    fmt_float(overall_summary["max"]),
                    fmt_float(overall_summary["mean"]),
                ]
            ],
        ),
        "",
        markdown_table(
            ["Score bucket", "Count", "Pct"],
            [
                [
                    row["bucket"],
                    fmt_int(int(row["count"])),
                    fmt_pct_value(float(row["pct"])),
                ]
                for row in bucket_rows
            ],
        ),
        "",
        "## By Tool",
        "",
        markdown_table(
            ["Tool", "Count", "Min", "P25", "Median", "P75", "Max", "Mean"],
            [
                [
                    str(row["tool"]),
                    fmt_int(int(row["count"])),
                    fmt_float(row["min"]),
                    fmt_float(row["p25"]),
                    fmt_float(row["median"]),
                    fmt_float(row["p75"]),
                    fmt_float(row["max"]),
                    fmt_float(row["mean"]),
                ]
                for row in tool_rows
            ],
        ),
        "",
        "## Enriched vs Non-Enriched",
        "",
        markdown_table(
            ["Cohort", "Count", "Min", "P25", "Median", "P75", "Max", "Mean"],
            [
                [
                    str(row["cohort"]),
                    fmt_int(int(row["count"])),
                    fmt_float(row["min"]),
                    fmt_float(row["p25"]),
                    fmt_float(row["median"]),
                    fmt_float(row["p75"]),
                    fmt_float(row["max"]),
                    fmt_float(row["mean"]),
                ]
                for row in enrichment_rows
            ],
        ),
        "",
        (
            "Observed both enriched and non-enriched cohorts."
            if enriched_present and plain_present
            else "Current sample does not contain both enriched and non-enriched cohorts, so this comparison is descriptive only."
        ),
        "",
        "## Non-Enriched Prompt Split",
        "",
        f"Short plain prompt means `promptEnriched=false` and `promptSnippet` length < {short_prompt_chars} characters.",
        f"`promptSnippet` is capped at {PROMPT_SNIPPET_MAX_CHARS} characters in the source logs, so thresholds above that are intentionally rejected by the CLI.",
        "",
        markdown_table(
            ["Cohort", "Count", "Min", "P25", "Median", "P75", "Max", "Mean"],
            [
                [
                    str(row["cohort"]),
                    fmt_int(int(row["count"])),
                    fmt_float(row["min"]),
                    fmt_float(row["p25"]),
                    fmt_float(row["median"]),
                    fmt_float(row["p75"]),
                    fmt_float(row["max"]),
                    fmt_float(row["mean"]),
                ]
                for row in plain_prompt_rows
            ],
        ),
        "",
        "## filePath Coverage",
        "",
        markdown_table(
            ["Tool", "Rows", "Rows with filePath", "Coverage"],
            [
                [
                    str(row["tool"]),
                    fmt_int(int(row["rows"])),
                    fmt_int(int(row["rowsWithFilePath"])),
                    fmt_pct(int(row["rowsWithFilePath"]), int(row["rows"])),
                ]
                for row in file_path_rows
            ],
        ),
        "",
        "## resultSource Coverage",
        "",
        markdown_table(
            ["Tool", "Rows", "Output", "Metadata", "Title", "Unknown"],
            [
                [
                    str(row["tool"]),
                    fmt_int(int(row["rows"])),
                    f"{fmt_int(int(row['output']))} ({fmt_pct(int(row['output']), int(row['rows']))})",
                    f"{fmt_int(int(row['metadata']))} ({fmt_pct(int(row['metadata']), int(row['rows']))})",
                    f"{fmt_int(int(row['title']))} ({fmt_pct(int(row['title']), int(row['rows']))})",
                    f"{fmt_int(int(row['unknown']))} ({fmt_pct(int(row['unknown']), int(row['rows']))})",
                ]
                for row in result_source_rows
            ],
        ),
        "",
        "## Validation Notes",
        "",
        "These slices are event-to-event proxies. The current log schema records the score of each tool result at the moment it was emitted, not a later-turn rescore of earlier results. For `read -> patch`, the report compares an earlier read score with a later same-file patch score. For `read -> re-read`, the report compares an earlier read score with a later same-file read score as a revisit proxy.",
        f"Primary validation pairs exclude low-signal rows where `promptEnriched=false` and `promptSnippet` length < {short_prompt_chars}.",
        "Same-file matching uses normalized-path equality only. Mixed absolute/relative variants such as `src/x.ts` and `/repo/src/x.ts` are intentionally not matched because the logs do not include session cwd, and guessing would create false positives in monorepos.",
        "Plugin backlog: log session cwd or repo root alongside filePath so mixed-path variants can be reconciled safely in a future pass.",
        f"Patch-like tools considered for the first slice: {', '.join(observed_patch_tools) if observed_patch_tools else 'none observed in this sample'}.",
        "",
        "## Validation: read -> patch same file",
        "",
        markdown_table(
            ["Metric", "Value"],
            [
                ["Read rows", fmt_int(read_patch_coverage["readRows"])],
                [
                    "Read rows with filePath",
                    fmt_int(read_patch_coverage["readRowsWithFilePath"]),
                ],
                [
                    "Read rows excluded as short plain prompts",
                    fmt_int(read_patch_coverage["readRowsExcludedShortPrompt"]),
                ],
                ["Patch rows", fmt_int(read_patch_coverage["patchRows"])],
                [
                    "Patch rows with filePath",
                    fmt_int(read_patch_coverage["patchRowsWithFilePath"]),
                ],
                [
                    "Patch rows missing filePath",
                    fmt_int(read_patch_coverage["patchRowsMissingFilePath"]),
                ],
                [
                    "Reads with any later patch",
                    fmt_int(read_patch_coverage["readsWithAnyLaterPatch"]),
                ],
                [
                    "Reads with same-file patch before filtering",
                    fmt_int(
                        read_patch_coverage["readsWithSameFilePatchBeforeFiltering"]
                    ),
                ],
                [
                    "Same-file patch candidates excluded as short plain prompts",
                    fmt_int(
                        read_patch_coverage[
                            "sameFilePatchCandidatesExcludedShortPrompt"
                        ]
                    ),
                ],
                [
                    "Reads with same-file patch",
                    fmt_int(read_patch_coverage["readsWithSameFilePatch"]),
                ],
                ["Matched pairs", fmt_int(read_patch_coverage["pairs"])],
            ],
        ),
        "",
        markdown_table(
            [
                "Turn distance",
                "Pairs",
                "Mean read score",
                "Mean patch score",
                "Median delta",
            ],
            [
                [
                    str(row["turnDistanceBucket"]),
                    fmt_int(int(row["pairs"])),
                    fmt_float(row["meanEarlierScore"]),
                    fmt_float(row["meanLaterScore"]),
                    fmt_float(row["medianScoreDelta"]),
                ]
                for row in read_patch_summary
            ],
        ),
        "",
        (
            "No matched same-file `read -> patch` pairs were found in the current sample."
            if not read_patch_pairs
            else f"Exported detailed pairs to `{output_path.parent / 'read_patch_decay.csv'}`."
        ),
        "",
        "## Validation: read -> re-read same file",
        "",
        markdown_table(
            ["Metric", "Value"],
            [
                ["Read rows", fmt_int(reread_coverage["readRows"])],
                [
                    "Read rows with filePath",
                    fmt_int(reread_coverage["readRowsWithFilePath"]),
                ],
                [
                    "Read rows excluded as short plain prompts",
                    fmt_int(reread_coverage["readRowsExcludedShortPrompt"]),
                ],
                [
                    "Reads with any later read",
                    fmt_int(reread_coverage["readsWithAnyLaterRead"]),
                ],
                [
                    "Reads with same-file re-read before filtering",
                    fmt_int(reread_coverage["readsWithSameFileRereadBeforeFiltering"]),
                ],
                [
                    "Same-file re-read candidates excluded as short plain prompts",
                    fmt_int(
                        reread_coverage["sameFileRereadCandidatesExcludedShortPrompt"]
                    ),
                ],
                [
                    "Reads with same-file re-read",
                    fmt_int(reread_coverage["readsWithSameFileReread"]),
                ],
                ["Matched pairs", fmt_int(reread_coverage["pairs"])],
            ],
        ),
        "",
        markdown_table(
            [
                "Turn distance",
                "Pairs",
                "Mean earlier score",
                "Mean later score",
                "Median delta",
            ],
            [
                [
                    str(row["turnDistanceBucket"]),
                    fmt_int(int(row["pairs"])),
                    fmt_float(row["meanEarlierScore"]),
                    fmt_float(row["meanLaterScore"]),
                    fmt_float(row["medianScoreDelta"]),
                ]
                for row in reread_summary
            ],
        ),
        "",
        (
            "No matched same-file `read -> re-read` pairs were found in the current sample."
            if not reread_pairs
            else f"Exported detailed pairs to `{output_path.parent / 'read_reread_same_file.csv'}`."
        ),
        "",
        "## Candidate Pruning Heuristics",
        "",
        "These are candidates only. They are not implemented here.",
        "",
        *[f"- {heuristic}" for heuristic in heuristics],
        "",
        "## Inputs",
        "",
        markdown_table(
            ["Matched file"],
            [[str(path)] for path in matched_files],
        ),
        "",
        f"Repo plotting stack detected: {', '.join(plotting_stack) if plotting_stack else 'none'}.",
        "",
    ]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser()
    matched_files, records, load_stats = load_records(args.input_glob)

    if not matched_files:
        raise SystemExit(f"No files matched: {os.path.expanduser(args.input_glob)}")
    if not records:
        raise SystemExit("No valid records parsed from the matched files.")

    timelines = build_timelines(records)
    overall_summary = summarize_records(records)
    bucket_rows = build_bucket_rows(records)

    tool_groups: dict[str, list[Record]] = defaultdict(list)
    enrichment_groups: dict[str, list[Record]] = defaultdict(list)
    plain_prompt_groups: dict[str, list[Record]] = defaultdict(list)
    file_path_counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {"rows": 0, "rowsWithFilePath": 0}
    )
    result_source_counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "rows": 0,
            "output": 0,
            "metadata": 0,
            "title": 0,
            "unknown": 0,
        }
    )

    for record in records:
        tool_groups[record.tool].append(record)
        if record.prompt_enriched is True:
            enrichment_groups["enriched=true"].append(record)
        elif record.prompt_enriched is False:
            enrichment_groups["enriched=false"].append(record)
            if record.prompt_snippet is None:
                plain_prompt_groups["plain-missing-snippet"].append(record)
            elif is_short_plain_prompt(record, args.short_prompt_chars):
                plain_prompt_groups["plain-short"].append(record)
            else:
                plain_prompt_groups["plain-other"].append(record)
        else:
            enrichment_groups["enriched=unknown"].append(record)
        file_path_counts[record.tool]["rows"] += 1
        if record.file_path:
            file_path_counts[record.tool]["rowsWithFilePath"] += 1
        result_source_counts[record.tool]["rows"] += 1
        result_source_counts[record.tool][
            result_source_bucket(record.result_source)
        ] += 1

    tool_rows = []
    for tool, tool_records in sorted(
        tool_groups.items(), key=lambda item: (-len(item[1]), item[0])
    ):
        summary = summarize_records(tool_records)
        tool_rows.append({"tool": tool, **summary})

    enrichment_rows = []
    for cohort in ("enriched=true", "enriched=false", "enriched=unknown"):
        summary = summarize_records(enrichment_groups.get(cohort, []))
        enrichment_rows.append({"cohort": cohort, **summary})

    plain_prompt_rows = []
    for cohort in ("plain-short", "plain-other", "plain-missing-snippet"):
        summary = summarize_records(plain_prompt_groups.get(cohort, []))
        plain_prompt_rows.append({"cohort": cohort, **summary})

    file_path_rows = []
    for tool, counts in sorted(
        file_path_counts.items(), key=lambda item: (-item[1]["rows"], item[0])
    ):
        file_path_rows.append({"tool": tool, **counts})

    result_source_rows = []
    for tool, counts in sorted(
        result_source_counts.items(), key=lambda item: (-item[1]["rows"], item[0])
    ):
        result_source_rows.append({"tool": tool, **counts})

    read_patch_pairs, read_patch_coverage = build_read_patch_pairs(
        timelines, args.short_prompt_chars
    )
    reread_pairs, reread_coverage = build_reread_pairs(
        timelines, args.short_prompt_chars
    )
    read_patch_summary = aggregate_pair_rows(
        read_patch_pairs, "readScore", "patchScore"
    )
    reread_summary = aggregate_pair_rows(
        reread_pairs, "earlierReadScore", "laterReadScore"
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(
        output_dir / "read_patch_decay.csv",
        read_patch_pairs,
        [
            "sessionId",
            "filePath",
            "patchTool",
            "readTurnIndex",
            "patchTurnIndex",
            "turnDistance",
            "turnDistanceBucket",
            "readTimestamp",
            "patchTimestamp",
            "timeDistanceSeconds",
            "readScore",
            "patchScore",
            "scoreDelta",
            "readPromptEnriched",
            "patchPromptEnriched",
        ],
    )
    write_csv(
        output_dir / "read_reread_same_file.csv",
        reread_pairs,
        [
            "sessionId",
            "filePath",
            "earlierReadTurnIndex",
            "laterReadTurnIndex",
            "turnDistance",
            "turnDistanceBucket",
            "earlierReadTimestamp",
            "laterReadTimestamp",
            "timeDistanceSeconds",
            "earlierReadScore",
            "laterReadScore",
            "scoreDelta",
            "earlierPromptEnriched",
            "laterPromptEnriched",
        ],
    )

    plotting_stack = detect_plotting_stack()
    observed_patch_tools = sorted(
        {record.tool for record in records if is_patch_tool(record.tool)}
    )
    chart_paths, chart_note = maybe_write_charts(
        output_dir,
        records,
        read_patch_pairs,
        reread_pairs,
        plotting_stack,
    )

    heuristics = build_candidate_heuristics(
        records,
        args.short_prompt_chars,
        read_patch_pairs,
        read_patch_coverage,
        reread_pairs,
    )

    write_report(
        output_dir / "REPORT.md",
        args.input_glob,
        matched_files,
        records,
        args.short_prompt_chars,
        load_stats,
        timelines,
        overall_summary,
        bucket_rows,
        tool_rows,
        enrichment_rows,
        plain_prompt_rows,
        file_path_rows,
        result_source_rows,
        read_patch_pairs,
        read_patch_coverage,
        read_patch_summary,
        reread_pairs,
        reread_coverage,
        reread_summary,
        observed_patch_tools,
        plotting_stack,
        chart_paths,
        chart_note,
        heuristics,
    )

    print(f"Wrote {output_dir / 'REPORT.md'}")
    print(f"Wrote {output_dir / 'read_patch_decay.csv'}")
    print(f"Wrote {output_dir / 'read_reread_same_file.csv'}")
    if chart_paths:
        for chart_path in chart_paths:
            print(f"Wrote {output_dir / chart_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
