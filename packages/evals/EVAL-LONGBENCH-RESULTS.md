# LongBench v2 Results

Subset: Budge eval - LongBench v2 hard short/medium subset (48 fit-cap cases)
Configured questions: 48
Observed questions: 48
Action model: openai/gpt-5.4-mini
Date: 2026-04-16

## Run Health

| Metric | Value |
| --- | --- |
| Configured questions | 48 |
| Observed unique questions | 48 |
| Per-question rows | 144 |
| Reportable duration | 687.6s |
| Export contains per-question rows | yes |

| Provider | Rows | Pass | Fail | Error | Avg tokens | Avg latency |
| --- | --- | --- | --- | --- | --- | --- |
| budge | 48 | 14 | 33 | 1 | 39135 | 10.2s |
| rag (bm25) | 48 | 14 | 33 | 1 | 10466 | 1.1s |
| full-dump | 48 | 14 | 33 | 1 | 119120 | 2.6s |

## Overall

| Metric | Budge | RAG (BM25) | Full-Dump |
| --- | --- | --- | --- |
| Accuracy | 14/48 (29.2%) | 14/48 (29.2%) | 14/48 (29.2%) |
| Errors | 1 | 1 | 1 |
| Avg tokens | 39135 | 10466 | 119120 |
| Avg latency | 10.2s | 1.1s | 2.6s |
| Avg prep | 9.4s | 0.0s | 0.0s |
| Avg action | 0.8s | 1.1s | 2.6s |

## Accuracy By Domain

| Slice | Budge | RAG (BM25) | Full-Dump |
| --- | --- | --- | --- |
| Code Repository Understanding | 0/3 (0.0%) | 2/3 (66.7%) | 0/3 (0.0%) |
| Long In-context Learning | 1/4 (25.0%) | 2/4 (50.0%) | 0/4 (0.0%) |
| Long Structured Data Understanding | 0/5 (0.0%) | 1/5 (20.0%) | 1/5 (20.0%) |
| Long-dialogue History Understanding | 2/6 (33.3%) | 2/6 (33.3%) | 2/6 (33.3%) |
| Multi-Document QA | 7/13 (53.8%) | 3/13 (23.1%) | 6/13 (46.2%) |
| Single-Document QA | 4/17 (23.5%) | 4/17 (23.5%) | 5/17 (29.4%) |

## Accuracy By Difficulty

| Slice | Budge | RAG (BM25) | Full-Dump |
| --- | --- | --- | --- |
| hard | 14/48 (29.2%) | 14/48 (29.2%) | 14/48 (29.2%) |

## Accuracy By Task Type

| Slice | Budge | RAG (BM25) | Full-Dump |
| --- | --- | --- | --- |
| icl-translation | 1/4 (25.0%) | 2/4 (50.0%) | 0/4 (0.0%) |
| multi-hop-qa | 8/14 (57.1%) | 5/14 (35.7%) | 8/14 (57.1%) |
| single-hop-qa | 2/9 (22.2%) | 2/9 (22.2%) | 3/9 (33.3%) |
| structured-code-reasoning | 0/8 (0.0%) | 3/8 (37.5%) | 1/8 (12.5%) |
| summarization-interpretive | 3/13 (23.1%) | 2/13 (15.4%) | 2/13 (15.4%) |

## Budge: Orchestrator vs Action Agent

| Metric | Orchestrator (direct) | Action Agent (handoff) |
| --- | --- | --- |
| Measured rows | 48/48 | 48/48 |
| Accuracy | 14/48 (29.2%) | 14/48 (29.2%) |
| Invalid / missing | 1/48 (2.1%) | 1/48 (2.1%) |
| Agreement | 46/48 (95.8%) | 46/48 (95.8%) |
| Net vs direct | - | +0 (+0.0 pp) |

| Diagnostic | Value |
| --- | --- |
| Rows | 48/48 |
| Both correct | 14/48 (29.2%) |
| Direct-only wins | 0/48 (0.0%) |
| Handoff-only wins | 0/48 (0.0%) |
| Both wrong, same answer | 32/48 (66.7%) |
| Both wrong, different answers | 1/48 (2.1%) |
| Missing direct or handoff | 1/48 (2.1%) |
| Library-risk signal | +0 |

## Budge: Orchestrator vs Action Agent By Task Type

| Task Type | Rows | Direct acc | Handoff acc | Agreement | Direct-only wins | Handoff-only wins | Invalid direct | Invalid handoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| icl-translation | 4 | 1/4 (25.0%) | 1/4 (25.0%) | 4/4 (100.0%) | 0 | 0 | 0 | 0 |
| multi-hop-qa | 14 | 8/14 (57.1%) | 8/14 (57.1%) | 13/14 (92.9%) | 0 | 0 | 0 | 0 |
| single-hop-qa | 9 | 2/9 (22.2%) | 2/9 (22.2%) | 9/9 (100.0%) | 0 | 0 | 0 | 0 |
| structured-code-reasoning | 8 | 0/8 (0.0%) | 0/8 (0.0%) | 7/8 (87.5%) | 0 | 0 | 1 | 1 |
| summarization-interpretive | 13 | 3/13 (23.1%) | 3/13 (23.1%) | 13/13 (100.0%) | 0 | 0 | 0 | 0 |

## Budge: Orchestrator vs Action Agent By Finish Reason

| Finish Reason | Rows | Direct acc | Handoff acc | Agreement | Direct-only wins | Handoff-only wins | Invalid direct | Invalid handoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| finish | 22 | 7/22 (31.8%) | 7/22 (31.8%) | 22/22 (100.0%) | 0 | 0 | 0 | 0 |
| no_finish | 25 | 7/25 (28.0%) | 7/25 (28.0%) | 24/25 (96.0%) | 0 | 0 | 0 | 0 |
| unknown | 1 | 0/1 (0.0%) | 0/1 (0.0%) | 0/1 (0.0%) | 0 | 0 | 1 | 1 |

## Budge: Disagreement Examples

### Direct-Only Wins

None.

### Handoff-Only Wins

None.

## Budge Finish Reasons By Task Type

| Task Type | Total | finish | no_finish | unknown |
| --- | --- | --- | --- | --- |
| icl-translation | 4 | 3/4 (75.0%) | 1/4 (25.0%) | 0/4 (0.0%) |
| multi-hop-qa | 14 | 7/14 (50.0%) | 7/14 (50.0%) | 0/14 (0.0%) |
| single-hop-qa | 9 | 5/9 (55.6%) | 4/9 (44.4%) | 0/9 (0.0%) |
| structured-code-reasoning | 8 | 2/8 (25.0%) | 5/8 (62.5%) | 1/8 (12.5%) |
| summarization-interpretive | 13 | 5/13 (38.5%) | 8/13 (61.5%) | 0/13 (0.0%) |

## Per-Question Details

| ID | Task Type | Provider | Direct | Predicted | Correct | Finish | Pass | Tokens | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 66eb873c5a08c7b9b35dd849 | multi-hop-qa | budge | B | B | B | no_finish | yes | 48577 | 12.7s |
| 66eb873c5a08c7b9b35dd849 | multi-hop-qa | full-dump | ? | B | B | unknown | yes | 111785 | 2.0s |
| 66eb873c5a08c7b9b35dd849 | multi-hop-qa | rag (bm25) | ? | B | B | unknown | yes | 15976 | 0.8s |
| 66ebc3165a08c7b9b35deb38 | summarization-interpretive | budge | C | C | A | no_finish | no | 20089 | 12.8s |
| 66ebc3165a08c7b9b35deb38 | summarization-interpretive | full-dump | ? | C | A | unknown | no | 68149 | 1.6s |
| 66ebc3165a08c7b9b35deb38 | summarization-interpretive | rag (bm25) | ? | C | A | unknown | no | 10351 | 1.0s |
| 66ebd22e5a08c7b9b35e0126 | summarization-interpretive | budge | B | B | B | finish | yes | 14526 | 9.6s |
| 66ebd22e5a08c7b9b35e0126 | summarization-interpretive | full-dump | ? | B | B | unknown | yes | 17451 | 0.9s |
| 66ebd22e5a08c7b9b35e0126 | summarization-interpretive | rag (bm25) | ? | B | B | unknown | yes | 9312 | 0.7s |
| 66ebd2975a08c7b9b35e01e3 | summarization-interpretive | budge | C | C | C | no_finish | yes | 32365 | 12.4s |
| 66ebd2975a08c7b9b35e01e3 | summarization-interpretive | full-dump | ? | C | C | unknown | yes | 64078 | 2.0s |
| 66ebd2975a08c7b9b35e01e3 | summarization-interpretive | rag (bm25) | ? | C | C | unknown | yes | 10371 | 1.6s |
| 66ebd3ba5a08c7b9b35e0446 | structured-code-reasoning | budge | C | C | A | no_finish | no | 14901 | 7.9s |
| 66ebd3ba5a08c7b9b35e0446 | structured-code-reasoning | full-dump | ? | C | A | unknown | no | 114528 | 2.0s |
| 66ebd3ba5a08c7b9b35e0446 | structured-code-reasoning | rag (bm25) | ? | A | A | unknown | yes | 10961 | 1.1s |
| 66ebdfb65a08c7b9b35e140a | summarization-interpretive | budge | C | C | C | no_finish | yes | 43233 | 10.2s |
| 66ebdfb65a08c7b9b35e140a | summarization-interpretive | full-dump | ? | B | C | unknown | no | 96227 | 2.8s |
| 66ebdfb65a08c7b9b35e140a | summarization-interpretive | rag (bm25) | ? | A | C | unknown | no | 10164 | 0.8s |
| 66ec1aef821e116aacb1aa1a | multi-hop-qa | budge | C | C | C | no_finish | yes | 26292 | 11.4s |
| 66ec1aef821e116aacb1aa1a | multi-hop-qa | full-dump | ? | C | C | unknown | yes | 59953 | 1.2s |
| 66ec1aef821e116aacb1aa1a | multi-hop-qa | rag (bm25) | ? | A | C | unknown | no | 10551 | 0.8s |
| 66ec1eb9821e116aacb1af36 | summarization-interpretive | budge | B | B | C | finish | no | 17444 | 9.8s |
| 66ec1eb9821e116aacb1af36 | summarization-interpretive | full-dump | ? | B | C | unknown | no | 128808 | 2.0s |
| 66ec1eb9821e116aacb1af36 | summarization-interpretive | rag (bm25) | ? | B | C | unknown | no | 11099 | 1.2s |
| 66ec2374821e116aacb1b423 | summarization-interpretive | budge | C | C | B | no_finish | no | 15952 | 8.0s |
| 66ec2374821e116aacb1b423 | summarization-interpretive | full-dump | ? | C | B | unknown | no | 138060 | 3.2s |
| 66ec2374821e116aacb1b423 | summarization-interpretive | rag (bm25) | ? | C | B | unknown | no | 10127 | 0.9s |
| 66ec2df6821e116aacb1bb7b | icl-translation | budge | B | B | C | finish | no | 19717 | 8.3s |
| 66ec2df6821e116aacb1bb7b | icl-translation | full-dump | ? | B | C | unknown | no | 100416 | 2.0s |
| 66ec2df6821e116aacb1bb7b | icl-translation | rag (bm25) | ? | B | C | unknown | no | 9611 | 1.1s |
| 66ecfe1e821e116aacb1e41c | multi-hop-qa | budge | B | B | C | no_finish | no | 13782 | 8.3s |
| 66ecfe1e821e116aacb1e41c | multi-hop-qa | full-dump | ? | C | C | unknown | yes | 67151 | 2.2s |
| 66ecfe1e821e116aacb1e41c | multi-hop-qa | rag (bm25) | ? | C | C | unknown | yes | 9730 | 0.8s |
| 66ed168b821e116aacb1ea8c | multi-hop-qa | budge | C | C | C | finish | yes | 16309 | 7.6s |
| 66ed168b821e116aacb1ea8c | multi-hop-qa | full-dump | ? | C | C | unknown | yes | 131680 | 2.8s |
| 66ed168b821e116aacb1ea8c | multi-hop-qa | rag (bm25) | ? | C | C | unknown | yes | 9555 | 1.0s |
| 66ed4274821e116aacb1f8f1 | multi-hop-qa | budge | D | D | D | no_finish | yes | 37382 | 9.8s |
| 66ed4274821e116aacb1f8f1 | multi-hop-qa | full-dump | ? | B | D | unknown | no | 114129 | 3.1s |
| 66ed4274821e116aacb1f8f1 | multi-hop-qa | rag (bm25) | ? | D | D | unknown | yes | 10836 | 1.0s |
| 66ed875e821e116aacb2023e | multi-hop-qa | budge | A | A | A | no_finish | yes | 31596 | 8.7s |
| 66ed875e821e116aacb2023e | multi-hop-qa | full-dump | ? | C | A | unknown | no | 61148 | 1.5s |
| 66ed875e821e116aacb2023e | multi-hop-qa | rag (bm25) | ? | B | A | unknown | no | 10441 | 0.8s |
| 66efaf70821e116aacb234bd | summarization-interpretive | budge | C | C | D | no_finish | no | 22856 | 7.9s |
| 66efaf70821e116aacb234bd | summarization-interpretive | full-dump | ? | C | D | unknown | no | 73451 | 1.4s |
| 66efaf70821e116aacb234bd | summarization-interpretive | rag (bm25) | ? | C | D | unknown | no | 9645 | 1.2s |
| 66f016e6821e116aacb25497 | multi-hop-qa | budge | D | D | D | finish | yes | 23159 | 11.1s |
| 66f016e6821e116aacb25497 | multi-hop-qa | full-dump | ? | D | D | unknown | yes | 107117 | 2.2s |
| 66f016e6821e116aacb25497 | multi-hop-qa | rag (bm25) | ? | B | D | unknown | no | 9702 | 1.0s |
| 66f25a2f821e116aacb28b2f | summarization-interpretive | budge | B | B | D | no_finish | no | 24765 | 8.9s |
| 66f25a2f821e116aacb28b2f | summarization-interpretive | full-dump | ? | A | D | unknown | no | 198918 | 4.1s |
| 66f25a2f821e116aacb28b2f | summarization-interpretive | rag (bm25) | ? | A | D | unknown | no | 10561 | 0.9s |
| 66f26c5f821e116aacb2907c | multi-hop-qa | budge | C | C | A | no_finish | no | 23245 | 8.2s |
| 66f26c5f821e116aacb2907c | multi-hop-qa | full-dump | ? | C | A | unknown | no | 105619 | 2.6s |
| 66f26c5f821e116aacb2907c | multi-hop-qa | rag (bm25) | ? | C | A | unknown | no | 9883 | 0.8s |
| 66f2a414821e116aacb2a3af | structured-code-reasoning | budge | C | C | B | finish | no | 9296 | 5.6s |
| 66f2a414821e116aacb2a3af | structured-code-reasoning | full-dump | ? | ? | B | unknown | no | 222209 | 1.5s |
| 66f2a414821e116aacb2a3af | structured-code-reasoning | rag (bm25) | ? | C | B | unknown | no | 10484 | 0.9s |
| 66f2a80d821e116aacb2a760 | icl-translation | budge | B | B | A | finish | no | 27672 | 7.5s |
| 66f2a80d821e116aacb2a760 | icl-translation | full-dump | ? | ? | A | unknown | no | 337816 | 2.2s |
| 66f2a80d821e116aacb2a760 | icl-translation | rag (bm25) | ? | A | A | unknown | yes | 12463 | 0.8s |
| 66f2abc5821e116aacb2aab7 | structured-code-reasoning | budge | A | A | C | no_finish | no | 22298 | 7.3s |
| 66f2abc5821e116aacb2aab7 | structured-code-reasoning | full-dump | ? | ? | C | unknown | no | 235814 | 1.4s |
| 66f2abc5821e116aacb2aab7 | structured-code-reasoning | rag (bm25) | ? | A | C | unknown | no | 10270 | 0.9s |
| 66f2b11c821e116aacb2aeb6 | summarization-interpretive | budge | B | B | A | no_finish | no | 21665 | 8.5s |
| 66f2b11c821e116aacb2aeb6 | summarization-interpretive | full-dump | ? | C | A | unknown | no | 93334 | 2.1s |
| 66f2b11c821e116aacb2aeb6 | summarization-interpretive | rag (bm25) | ? | B | A | unknown | no | 10618 | 0.8s |
| 66f2e874821e116aacb2c0af | structured-code-reasoning | budge | D | D | C | no_finish | no | 56360 | 13.4s |
| 66f2e874821e116aacb2c0af | structured-code-reasoning | full-dump | ? | A | C | unknown | no | 176432 | 6.1s |
| 66f2e874821e116aacb2c0af | structured-code-reasoning | rag (bm25) | ? | C | C | unknown | yes | 9169 | 1.2s |
| 66f3c081821e116aacb2e9fa | multi-hop-qa | budge | D | D | D | finish | yes | 36377 | 8.3s |
| 66f3c081821e116aacb2e9fa | multi-hop-qa | full-dump | ? | D | D | unknown | yes | 222479 | 4.6s |
| 66f3c081821e116aacb2e9fa | multi-hop-qa | rag (bm25) | ? | D | D | unknown | yes | 10001 | 1.0s |
| 66f3c219821e116aacb2eb4e | structured-code-reasoning | budge | ? | ? | C | unknown | no | 0 | 0.0s |
| 66f3c219821e116aacb2eb4e | structured-code-reasoning | full-dump | ? | ? | C | unknown | no | 0 | 0.0s |
| 66f3c219821e116aacb2eb4e | structured-code-reasoning | rag (bm25) | ? | ? | C | unknown | no | 0 | 0.0s |
| 66f3c806821e116aacb2ed77 | multi-hop-qa | budge | A | A | C | finish | no | 68825 | 16.1s |
| 66f3c806821e116aacb2ed77 | multi-hop-qa | full-dump | ? | C | C | unknown | yes | 66343 | 2.5s |
| 66f3c806821e116aacb2ed77 | multi-hop-qa | rag (bm25) | ? | A | C | unknown | no | 10292 | 1.5s |
| 66f3dd59821e116aacb2f6ba | multi-hop-qa | budge | B | D | C | no_finish | no | 45127 | 14.7s |
| 66f3dd59821e116aacb2f6ba | multi-hop-qa | full-dump | ? | C | C | unknown | yes | 194808 | 4.2s |
| 66f3dd59821e116aacb2f6ba | multi-hop-qa | rag (bm25) | ? | D | C | unknown | no | 10243 | 1.2s |
| 66f3e473821e116aacb2fa73 | summarization-interpretive | budge | C | C | B | finish | no | 17634 | 8.2s |
| 66f3e473821e116aacb2fa73 | summarization-interpretive | full-dump | ? | C | B | unknown | no | 44622 | 5.2s |
| 66f3e473821e116aacb2fa73 | summarization-interpretive | rag (bm25) | ? | C | B | unknown | no | 9865 | 1.0s |
| 66f3fb15821e116aacb303dc | multi-hop-qa | budge | D | D | D | finish | yes | 46938 | 12.4s |
| 66f3fb15821e116aacb303dc | multi-hop-qa | full-dump | ? | A | D | unknown | no | 79664 | 1.8s |
| 66f3fb15821e116aacb303dc | multi-hop-qa | rag (bm25) | ? | A | D | unknown | no | 9870 | 1.2s |
| 66f568dc821e116aacb33995 | summarization-interpretive | budge | A | A | B | finish | no | 33876 | 14.7s |
| 66f568dc821e116aacb33995 | summarization-interpretive | full-dump | ? | D | B | unknown | no | 121745 | 2.2s |
| 66f568dc821e116aacb33995 | summarization-interpretive | rag (bm25) | ? | A | B | unknown | no | 10003 | 1.2s |
| 66f6b623bb02136c067c2646 | summarization-interpretive | budge | B | B | A | finish | no | 17446 | 10.8s |
| 66f6b623bb02136c067c2646 | summarization-interpretive | full-dump | ? | C | A | unknown | no | 53032 | 1.1s |
| 66f6b623bb02136c067c2646 | summarization-interpretive | rag (bm25) | ? | C | A | unknown | no | 11466 | 2.4s |
| 66f957e2bb02136c067c51c8 | summarization-interpretive | budge | B | B | D | no_finish | no | 55310 | 12.4s |
| 66f957e2bb02136c067c51c8 | summarization-interpretive | full-dump | ? | C | D | unknown | no | 124048 | 2.1s |
| 66f957e2bb02136c067c51c8 | summarization-interpretive | rag (bm25) | ? | B | D | unknown | no | 10807 | 1.2s |
| 670aac92bb02136c067d218a | single-hop-qa | budge | B | B | D | finish | no | 15340 | 8.0s |
| 670aac92bb02136c067d218a | single-hop-qa | full-dump | ? | C | D | unknown | no | 138306 | 3.1s |
| 670aac92bb02136c067d218a | single-hop-qa | rag (bm25) | ? | C | D | unknown | no | 10188 | 0.8s |
| 670bf6ddbb02136c067d2379 | single-hop-qa | budge | B | B | C | finish | no | 129580 | 14.2s |
| 670bf6ddbb02136c067d2379 | single-hop-qa | full-dump | ? | A | C | unknown | no | 179690 | 3.4s |
| 670bf6ddbb02136c067d2379 | single-hop-qa | rag (bm25) | ? | A | C | unknown | no | 10752 | 1.0s |
| 670c090bbb02136c067d2404 | single-hop-qa | budge | A | A | C | no_finish | no | 68377 | 14.8s |
| 670c090bbb02136c067d2404 | single-hop-qa | full-dump | ? | C | C | unknown | yes | 105914 | 3.1s |
| 670c090bbb02136c067d2404 | single-hop-qa | rag (bm25) | ? | A | C | unknown | no | 9826 | 1.7s |
| 6713066fbb02136c067d3214 | single-hop-qa | budge | B | B | D | no_finish | no | 74050 | 19.8s |
| 6713066fbb02136c067d3214 | single-hop-qa | full-dump | ? | B | D | unknown | no | 23227 | 1.1s |
| 6713066fbb02136c067d3214 | single-hop-qa | rag (bm25) | ? | B | D | unknown | no | 13292 | 2.4s |
| 67189156bb02136c067d3b8d | single-hop-qa | budge | B | B | B | no_finish | yes | 47897 | 10.2s |
| 67189156bb02136c067d3b8d | single-hop-qa | full-dump | ? | D | B | unknown | no | 116614 | 1.9s |
| 67189156bb02136c067d3b8d | single-hop-qa | rag (bm25) | ? | B | B | unknown | yes | 9293 | 1.1s |
| 6718a43fbb02136c067d3ca8 | single-hop-qa | budge | B | B | B | finish | yes | 63263 | 13.0s |
| 6718a43fbb02136c067d3ca8 | single-hop-qa | full-dump | ? | B | B | unknown | yes | 117162 | 2.4s |
| 6718a43fbb02136c067d3ca8 | single-hop-qa | rag (bm25) | ? | B | B | unknown | yes | 9532 | 1.0s |
| 6719185cbb02136c067d40ab | single-hop-qa | budge | A | A | B | no_finish | no | 14789 | 8.2s |
| 6719185cbb02136c067d40ab | single-hop-qa | full-dump | ? | B | B | unknown | yes | 118019 | 2.5s |
| 6719185cbb02136c067d40ab | single-hop-qa | rag (bm25) | ? | A | B | unknown | no | 9408 | 0.9s |
| 6719b96abb02136c067d4358 | single-hop-qa | budge | C | C | B | finish | no | 35686 | 6.9s |
| 6719b96abb02136c067d4358 | single-hop-qa | full-dump | ? | D | B | unknown | no | 34056 | 4.4s |
| 6719b96abb02136c067d4358 | single-hop-qa | rag (bm25) | ? | D | B | unknown | no | 11946 | 0.9s |
| 6719b9f1bb02136c067d4389 | single-hop-qa | budge | D | D | A | finish | no | 22631 | 7.3s |
| 6719b9f1bb02136c067d4389 | single-hop-qa | full-dump | ? | D | A | unknown | no | 23418 | 4.7s |
| 6719b9f1bb02136c067d4389 | single-hop-qa | rag (bm25) | ? | D | A | unknown | no | 13344 | 1.1s |
| 6723a0a7bb02136c067d7040 | multi-hop-qa | budge | B | B | A | finish | no | 46875 | 10.9s |
| 6723a0a7bb02136c067d7040 | multi-hop-qa | full-dump | ? | B | A | unknown | no | 125757 | 2.4s |
| 6723a0a7bb02136c067d7040 | multi-hop-qa | rag (bm25) | ? | B | A | unknown | no | 10867 | 1.0s |
| 6723a63bbb02136c067d71a1 | multi-hop-qa | budge | B | B | D | finish | no | 60714 | 12.8s |
| 6723a63bbb02136c067d71a1 | multi-hop-qa | full-dump | ? | C | D | unknown | no | 168985 | 3.3s |
| 6723a63bbb02136c067d71a1 | multi-hop-qa | rag (bm25) | ? | B | D | unknown | no | 11162 | 0.8s |
| 6724c4aabb02136c067d78a6 | structured-code-reasoning | budge | C | C | B | no_finish | no | 34113 | 9.8s |
| 6724c4aabb02136c067d78a6 | structured-code-reasoning | full-dump | ? | C | B | unknown | no | 130348 | 2.1s |
| 6724c4aabb02136c067d78a6 | structured-code-reasoning | rag (bm25) | ? | A | B | unknown | no | 12417 | 0.9s |
| 6724c5febb02136c067d78e7 | structured-code-reasoning | budge | B | B | A | no_finish | no | 291016 | 17.1s |
| 6724c5febb02136c067d78e7 | structured-code-reasoning | full-dump | ? | ? | A | unknown | no | 261504 | 1.8s |
| 6724c5febb02136c067d78e7 | structured-code-reasoning | rag (bm25) | ? | B | A | unknown | no | 12813 | 1.1s |
| 6725d7a9bb02136c067d822d | icl-translation | budge | A | A | A | finish | yes | 17521 | 7.4s |
| 6725d7a9bb02136c067d822d | icl-translation | full-dump | ? | C | A | unknown | no | 146530 | 4.9s |
| 6725d7a9bb02136c067d822d | icl-translation | rag (bm25) | ? | B | A | unknown | no | 10578 | 0.9s |
| 6725d8dbbb02136c067d8309 | icl-translation | budge | B | B | C | no_finish | no | 2490 | 6.7s |
| 6725d8dbbb02136c067d8309 | icl-translation | full-dump | ? | A | C | unknown | no | 146568 | 2.6s |
| 6725d8dbbb02136c067d8309 | icl-translation | rag (bm25) | ? | C | C | unknown | yes | 10354 | 1.5s |
| 67285f8ebb02136c067d905d | structured-code-reasoning | budge | B | B | C | finish | no | 49103 | 8.1s |
| 67285f8ebb02136c067d905d | structured-code-reasoning | full-dump | ? | C | C | unknown | yes | 150645 | 2.5s |
| 67285f8ebb02136c067d905d | structured-code-reasoning | rag (bm25) | ? | C | C | unknown | yes | 12189 | 0.9s |

## Notes

- Accuracy is exact-match on the predicted answer letter.
- Budge comparison uses `directAnswer` from the orchestrator and `handoffAnswer` from the action agent output.
- If direct accuracy materially exceeds handoff accuracy, the library handoff is likely dropping signal; if both are similarly low, exploration or model choice is the more likely bottleneck.
- Run Health falls back to provider aggregates when a promptfoo export omits per-question rows.
