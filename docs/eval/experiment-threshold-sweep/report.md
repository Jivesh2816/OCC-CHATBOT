# BM25 cut-off sweep

Run 2026-09-30T23:25:07.719Z. Production cut-offs: FAQ 5, passage 6. Rule (fixed before running): max dev context hit with dev in-scope false-match rate ≤ 10%.

| FAQ min | Passage min | Dev context hit (n=191) | Dev false-match rate (n=14) |
|---|---|---|---|
| 5 | 6 | 72.3% | 42.9% |
| 5 | 5.5 | 73.3% | 42.9% |
| 5 | 5 | 74.9% | 50.0% |
| 5 | 4.5 | 75.4% | 50.0% |
| 5 | 4 | 77.0% | 50.0% |
| 4.5 | 6 | 73.3% | 50.0% |
| 4.5 | 5.5 | 74.3% | 50.0% |
| 4.5 | 5 | 75.9% | 57.1% |
| 4.5 | 4.5 | 76.4% | 57.1% |
| 4.5 | 4 | 78.0% | 57.1% |
| 4 | 6 | 75.4% | 50.0% |
| 4 | 5.5 | 76.4% | 50.0% |
| 4 | 5 | 78.0% | 57.1% |
| 4 | 4.5 | 78.5% | 57.1% |
| 4 | 4 | 80.1% | 57.1% |
| 3.5 | 6 | 77.0% | 57.1% |
| 3.5 | 5.5 | 78.0% | 57.1% |
| 3.5 | 5 | 79.6% | 57.1% |
| 3.5 | 4.5 | 80.1% | 57.1% |
| 3.5 | 4 | 81.7% | 57.1% |
| 3 | 6 | 78.0% | 57.1% |
| 3 | 5.5 | 79.1% | 57.1% |
| 3 | 5 | 80.6% | 57.1% |
| 3 | 4.5 | 81.2% | 57.1% |
| 3 | 4 | 82.7% | 57.1% |
| 2.5 | 6 | 78.0% | 64.3% |
| 2.5 | 5.5 | 79.1% | 64.3% |
| 2.5 | 5 | 80.6% | 64.3% |
| 2.5 | 4.5 | 81.2% | 64.3% |
| 2.5 | 4 | 82.7% | 64.3% |

**No pair meets the rule, the current cut-offs included, so they stay as they are.** Lowering them raises context hit on dev but also the share of unanswerable questions that get unrelated context.

| | Dev context hit | Dev false matches | Fresh context hit | Fresh false matches |
|---|---|---|---|---|
| Current (5, 6) | 72.3% | 42.9% (noans-co-detector, noans-min-winter-temp, noans-rent-tax-credit, noans-library-exam-hours, noans-cat-on-bus, noans-joint-bank-account) | 64.7% (n=17) | 40.0% of 10 (fresh-noans-trillium, fresh-noans-bike-rack-bus, fresh-noans-campfire, fresh-noans-parking-ticket-dispute) |
| Loosest tried (2.5, 4) | 82.7% | 64.3% (academic-coop-registration, noans-snow-shovelling, noans-co-detector, noans-min-winter-temp, noans-rent-tax-credit, noans-library-exam-hours, noans-printing, noans-cat-on-bus, noans-joint-bank-account) | 76.5% (n=17) | 70.0% of 10 (fresh-noans-lawn-mowing, fresh-noans-sidewalk-fine, fresh-noans-trillium, fresh-noans-bike-rack-bus, fresh-noans-campfire, fresh-noans-dogs-on-ion, fresh-noans-parking-ticket-dispute) |
