#!/usr/bin/env python3
"""Read-only, reproducible third independent notification replay.

Capture: python3 scripts/third-signal-backtest.py --data-dir data --output reports/third-signal-2026-10-25
Replay:  python3 scripts/third-signal-backtest.py --input reports/third-signal-2026-10-25.inputs.json.gz --output /tmp/third-replay
Checks:  python3 scripts/third-signal-backtest.py --self-test

This script imports no trading client and sends no network requests. Production
SQLite connections use mode=ro + query_only. It exports only allowlisted public
token/event/price fields, never raw auth, session, or account records. Each DB is
read in a WAL read transaction; separate DBs are not an atomic global snapshot.
Only report files are written. Price extrema are observations, never trade P&L.
"""
from __future__ import annotations

import argparse
import bisect
import collections
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import statistics
import sys
import unittest

UTC = dt.timezone.utc
SIX_HOURS = 21600.0
SOURCES = ("debot", "ave")


def iso(t):
    return dt.datetime.fromtimestamp(t, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now():
    return iso(dt.datetime.now(UTC).timestamp())


def timestamp(v):
    if not isinstance(v, str):
        return None
    try:
        t = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
        return t.timestamp() if t.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def positive(v):
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return None
    try:
        f = float(v)
        return f if math.isfinite(f) and f > 0 else None
    except (ValueError, OverflowError):
        return None


def obj(raw):
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def capture(data_dir):
    snapshot = {"version": 1, "startedAt": now(), "databases": [], "events": [], "marketPoints": [], "archivePoints": []}

    def db(name):
        path = data_dir / (name + ".sqlite")
        conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        meta = {"database": path.name, "readStartedAt": now(), "rows": {}}
        snapshot["databases"].append(meta)
        return conn, meta

    for source in SOURCES:
        conn, meta = db(source + "-signals")
        try:
            count = 0
            for row in conn.execute("SELECT id,chain,address,occurred_at,observed_at,payload FROM " + source + "_signals"):
                if not row["id"].startswith(source + ":signal:"):
                    continue  # Changed research revisions are never new platform events.
                p = obj(row["payload"])
                supplied = p.get("signal", {}).get("token", {})
                if supplied != {"chain": row["chain"], "address": row["address"]}:
                    continue
                event = {"source": source, "eventId": row["id"], "chain": row["chain"], "address": row["address"],
                         "occurredAt": row["occurred_at"], "receivedAt": row["observed_at"],
                         "origin": source + "_signals", "payloadKnownAt": row["observed_at"],
                         "providerId": p.get("id"), "name": p.get("name") or p.get("symbol")}
                # Retain explicit original event snapshots only. No current cap,
                # current supply, historical peak, or provider history_count.
                cap = positive(p.get("alertMarketCapUsd"))
                price = positive(p.get("alertPriceUsd") if source == "debot" else p.get("currentPriceUsd"))
                if cap is not None:
                    event["marketCapUsd"] = cap
                    event["marketCapField"] = "payload.alertMarketCapUsd <- " + ("Ave raw.mc" if source == "ave" else "DeBot token_trading_stat.mkt_cap")
                if price is not None:
                    event["priceUsd"] = price
                    event["priceField"] = "payload.alertPriceUsd" if source == "debot" else "payload.currentPriceUsd"
                snapshot["events"].append(event)
                count += 1
            meta["rows"][source + "_signals"] = count
            if source == "debot":
                count = 0
                for row in conn.execute("SELECT chain,address,event_id,vendor_event_id,occurred_at,observed_at FROM debot_notification_events"):
                    snapshot["events"].append({"source": source, "eventId": row["event_id"], "chain": row["chain"],
                                              "address": row["address"], "occurredAt": row["occurred_at"],
                                              "receivedAt": row["observed_at"], "providerId": row["vendor_event_id"],
                                              "origin": "debot_notification_events"})
                    count += 1
                meta["rows"]["debot_notification_events"] = count
            meta["retentionWatermarks"] = [dict(r) for r in conn.execute("SELECT source,pruned_through FROM review_retention_watermarks")]
        finally:
            conn.close()
            meta["readFinishedAt"] = now()

    conn, meta = db("source-corroboration")
    try:
        count = 0
        for row in conn.execute("SELECT source,event_id,chain,address,occurred_at,first_observed_at,recorded_at,name,conflict_at FROM source_notifications WHERE source IN ('debot','ave')"):
            snapshot["events"].append({"source": row["source"], "eventId": row["event_id"], "chain": row["chain"],
                                      "address": row["address"], "occurredAt": row["occurred_at"], "receivedAt": row["first_observed_at"],
                                      "recordedAt": row["recorded_at"], "name": row["name"], "conflictAt": row["conflict_at"],
                                      "origin": "source_notifications"})
            count += 1
        meta["rows"]["source_notifications_debot_ave"] = count
    finally:
        conn.close()
        meta["readFinishedAt"] = now()

    conn, meta = db("meme-observations")
    try:
        count = 0
        for row in conn.execute("SELECT chain,address,observed_at,market,json_extract(assessment,'$.assessedAt') known_at FROM meme_snapshots WHERE market IS NOT NULL"):
            p = obj(row["market"])
            if p.get("token") != {"chain": row["chain"], "address": row["address"]} or p.get("observedAt") != row["observed_at"]:
                continue
            price = positive(p.get("priceUsd"))
            if price is None:
                continue
            snapshot["marketPoints"].append({"chain": row["chain"], "address": row["address"], "at": row["observed_at"],
                                              "knownAt": row["known_at"], "priceUsd": price, "source": p.get("source"),
                                              "poolAddress": p.get("poolAddress")})
            count += 1
        meta["rows"]["meme_snapshots_price"] = count
    finally:
        conn.close()
        meta["readFinishedAt"] = now()

    conn, meta = db("scans")
    try:
        for table in ("scan_summaries", "signal_followups", "strategy_comparisons"):
            count = points = 0
            for row in conn.execute("SELECT chain,address,record FROM " + table):
                record = obj(row["record"])
                if record.get("chain") != row["chain"] or record.get("address") != row["address"]:
                    continue
                performance = record.get("performance", {})
                if not isinstance(performance, dict):
                    continue
                # Explicit timestamped extrema are actual observations. Aggregate
                # maxGainPct is intentionally ignored: its baseline is different.
                candidates = list(performance.get("points", []))
                for prefix in ("baseline", "latest", "peak"):
                    candidates.append({"at": performance.get(prefix + "At"), "priceUsd": performance.get(prefix + "PriceUsd")})
                for point in candidates:
                    if not isinstance(point, dict) or timestamp(point.get("at")) is None or positive(point.get("priceUsd")) is None:
                        continue
                    snapshot["archivePoints"].append({"chain": row["chain"], "address": row["address"], "at": point["at"],
                                                       "priceUsd": positive(point["priceUsd"]), "origin": table})
                    points += 1
                count += 1
            meta["rows"][table] = count
            meta["rows"][table + "_price_points"] = points
        meta["retentionWatermarks"] = [dict(r) for r in conn.execute("SELECT source,pruned_through FROM review_retention_watermarks")]
    finally:
        conn.close()
        meta["readFinishedAt"] = now()
    snapshot["finishedAt"] = now()
    return snapshot


def deduplicate_events(raw, as_of):
    grouped = collections.defaultdict(list)
    diagnostics = collections.Counter()
    for event in raw:
        source, event_id = event.get("source"), event.get("eventId", "")
        received = timestamp(event.get("receivedAt"))
        if source not in SOURCES or not event_id.startswith(source + ":signal:") or received is None or received > as_of:
            diagnostics["invalid_or_out_of_range"] += 1
            continue
        grouped[(source, event_id)].append(event)
    events = []
    for _, copies in grouped.items():
        identities = {(v.get("chain"), v.get("address")) for v in copies}
        times = {v.get("occurredAt") for v in copies}
        if len(identities) != 1 or len(times) != 1 or any(v.get("conflictAt") for v in copies):
            diagnostics["identity_or_event_time_conflicts"] += 1
            continue
        copies.sort(key=lambda v: (timestamp(v["receivedAt"]), v["origin"]))
        event = dict(copies[0])
        event["origins"] = sorted({v["origin"] for v in copies})
        event["receivedMs"] = timestamp(event["receivedAt"])
        event["name"] = next((v.get("name") for v in copies if v.get("name")), None)
        # A later-imported payload must not add information to earlier receipt.
        for v in copies:
            known = timestamp(v.get("payloadKnownAt"))
            if known is not None and known <= event["receivedMs"]:
                for field in ("marketCapUsd", "marketCapField", "historicalCap", "priceUsd", "priceField", "payloadKnownAt", "providerId"):
                    if field in v:
                        event[field] = v[field]
        if timestamp(event.get("payloadKnownAt")) is None or timestamp(event["payloadKnownAt"]) > event["receivedMs"]:
            for field in ("marketCapUsd", "marketCapField", "priceUsd", "priceField", "payloadKnownAt"):
                event.pop(field, None)
        events.append(event)
        diagnostics["duplicate_records_removed"] += len(copies) - 1
    events.sort(key=lambda v: (v["receivedMs"], v["source"], v["eventId"]))
    return events, dict(diagnostics)


def sessions_for(events):
    groups = collections.defaultdict(list)
    for event in events:
        groups[(event["source"], event["chain"], event["address"])].append(event)
    sessions = []
    for (source, chain, address), group in groups.items():
        current = None
        for event in sorted(group, key=lambda v: (v["receivedMs"], v["eventId"])):
            if current is None or event["receivedMs"] - current["lastReceivedMs"] >= SIX_HOURS:
                current = {"source": source, "chain": chain, "address": address, "events": [], "firstReceivedAt": event["receivedAt"]}
                sessions.append(current)
            current["events"].append(event)
            current["lastReceivedMs"] = event["receivedMs"]
            current["lastReceivedAt"] = event["receivedAt"]
            current["expiresAt"] = iso(event["receivedMs"] + SIX_HOURS)
    return sessions


def build_price_indexes(snapshot, events, as_of):
    raw = collections.defaultdict(lambda: collections.defaultdict(list))
    known = collections.defaultdict(list)
    for point in snapshot.get("marketPoints", []):
        at, knowledge, price = timestamp(point.get("at")), timestamp(point.get("knownAt")), positive(point.get("priceUsd"))
        if at is None or at > as_of or price is None:
            continue
        key = (point["chain"], point["address"])
        raw[key][at].append(price)
        if knowledge is not None and at <= knowledge <= as_of:
            known[key].append({**point, "atMs": at, "knownMs": knowledge, "kind": "market_snapshot_known_before_signal"})
    for point in snapshot.get("archivePoints", []):
        at, price = timestamp(point.get("at")), positive(point.get("priceUsd"))
        if at is not None and at <= as_of and price is not None:
            raw[(point["chain"], point["address"])][at].append(price)
    for event in events:
        at, price = timestamp(event.get("occurredAt")), positive(event.get("priceUsd"))
        knowledge = timestamp(event.get("payloadKnownAt"))
        if at is None or knowledge is None or price is None or at > knowledge or knowledge - at > 120:
            continue
        if event["source"] == "ave":
            at = knowledge  # currentPriceUsd is a response observation, not an old alarm price.
        raw[(event["chain"], event["address"])][at].append(price)
        known[(event["chain"], event["address"])].append({"atMs": at, "knownMs": knowledge, "priceUsd": price,
            "source": event["source"], "kind": "earlier_provider_event_price", "eventId": event["eventId"]})
    prices = {}
    conflicts = 0
    for key, timed in raw.items():
        usable = []
        for at, values in timed.items():
            if max(values) / min(values) > 1.05:
                conflicts += 1
                continue
            usable.append((at, statistics.median(set(values))))
        usable.sort()
        prices[key] = ([v[0] for v in usable], usable)
    for values in known.values():
        values.sort(key=lambda v: v["knownMs"])
    return prices, known, conflicts


def entry_price(event, known, max_age):
    received = event["receivedMs"]
    direct = positive(event.get("priceUsd"))
    occurred = timestamp(event.get("occurredAt"))
    if direct is not None and timestamp(event.get("payloadKnownAt")) == received and occurred is not None and 0 <= received - occurred <= max_age:
        return {"priceUsd": direct, "at": event["occurredAt"] if event["source"] == "debot" else event["receivedAt"],
                "knownAt": event["payloadKnownAt"], "kind": "third_event_price", "source": event["source"],
                "ageSec": received - occurred if event["source"] == "debot" else 0}
    candidates = [p for p in known.get((event["chain"], event["address"]), [])
                  if p["knownMs"] <= received and 0 <= received - p["atMs"] <= max_age]
    if not candidates:
        return None
    chosen = max(candidates, key=lambda p: (p["atMs"], p["knownMs"]))
    same_time = [p["priceUsd"] for p in candidates if p["atMs"] == chosen["atMs"]]
    if max(same_time) / min(same_time) > 1.05:
        return None
    return {"priceUsd": chosen["priceUsd"], "at": iso(chosen["atMs"]), "knownAt": iso(chosen["knownMs"]),
            "kind": chosen["kind"], "source": chosen.get("source"), "ageSec": received - chosen["atMs"]}


def outcome(row, prices, horizon_hours, as_of):
    entry = row.get("entryPrice")
    start = timestamp(row["thirdReceivedAt"])
    end = min(start + horizon_hours * 3600, as_of)
    result = {"horizonHours": horizon_hours, "windowEndsAt": iso(end), "mature": start + horizon_hours * 3600 <= as_of,
              "entryPriceAvailable": entry is not None, "postEntrySamples": 0, "sampledDoubleHit": None}
    if entry is None:
        result["missingReason"] = "NO_PRICE_KNOWN_AT_THIRD_NOTIFICATION"
        return result
    times, points = prices.get((row["chain"], row["address"]), ([], []))
    observed = points[bisect.bisect_right(times, start):bisect.bisect_right(times, end)]
    result["postEntrySamples"] = len(observed)
    if not observed:
        result["missingReason"] = "NO_POST_ENTRY_RETAINED_PRICE"
        return result
    base = entry["priceUsd"]
    peak, peak_at = base, start
    low, low_at = base, start
    running_peak, drawdown = base, 0.0
    first_double = None
    for at, price in observed:
        if price > peak:
            peak, peak_at = price, at
        if price < low:
            low, low_at = price, at
        running_peak = max(running_peak, price)
        drawdown = max(drawdown, (1 - price / running_peak) * 100)
        if first_double is None and price >= 2 * base:
            first_double = iso(at)
    stamps = [start] + [p[0] for p in observed] + [end]
    result.update({"sampledDoubleHit": first_double is not None, "firstDoubleAt": first_double,
                   "maxGainPct": (peak / base - 1) * 100, "peakPriceUsd": peak, "peakAt": iso(peak_at),
                   "minGainPct": (low / base - 1) * 100, "lowAt": iso(low_at), "maxDrawdownPct": drawdown,
                   "lastGainPct": (observed[-1][1] / base - 1) * 100, "lastPriceUsd": observed[-1][1],
                   "firstPostPriceAt": iso(observed[0][0]), "lastPostPriceAt": iso(observed[-1][0]),
                   "firstPostDelaySec": observed[0][0] - start,
                   "maxSampleGapSecIncludingEdges": max(b - a for a, b in zip(stamps, stamps[1:])),
                   "sampleSpanCoveragePct": (observed[-1][0] - observed[0][0]) / (end - start) * 100 if end > start else 0})
    return result


def price_summary(rows):
    covered = [r for r in rows if r["priceOutcome"]["sampledDoubleHit"] is not None]
    mature = [r for r in covered if r["priceOutcome"]["mature"]]
    hits = [r for r in covered if r["priceOutcome"]["sampledDoubleHit"]]
    mature_hits = [r for r in mature if r["priceOutcome"]["sampledDoubleHit"]]
    dense = [r for r in mature if r["priceOutcome"].get("maxSampleGapSecIncludingEdges", math.inf) <= 600]
    return {"candidates": len(rows), "entryPriceAvailable": sum(r.get("entryPrice") is not None for r in rows),
            "entryAndPostPriceCovered": len(covered), "priceCoveragePct": len(covered) / len(rows) * 100 if rows else None,
            "sampledDoubleHits": len(hits), "sampledDoubleHitRatePct": len(hits) / len(covered) * 100 if covered else None,
            "matureCovered": len(mature), "matureSampledDoubleHits": len(mature_hits),
            "matureSampledDoubleHitRatePct": len(mature_hits) / len(mature) * 100 if mature else None,
            "matureWithMaxGapAtMost10Min": len(dense),
            "denseMatureSampledDoubleHits": sum(r["priceOutcome"]["sampledDoubleHit"] for r in dense),
            "medianMaxGainPct": statistics.median(r["priceOutcome"]["maxGainPct"] for r in covered) if covered else None,
            "medianMaxDrawdownPct": statistics.median(r["priceOutcome"]["maxDrawdownPct"] for r in covered) if covered else None,
            "capitalNetWinRatePct": None}


def replay(snapshot, max_price_age_sec=120, horizon_hours=24):
    as_of = timestamp(snapshot["finishedAt"])
    events, diagnostics = deduplicate_events(snapshot["events"], as_of)
    sessions = sessions_for(events)
    prices, known, conflicts = build_price_indexes(snapshot, events, as_of)
    ranges = {source: {"firstReceivedAt": min((v["receivedAt"] for v in events if v["source"] == source), default=None),
                       "lastReceivedAt": max((v["receivedAt"] for v in events if v["source"] == source), default=None)} for source in SOURCES}
    rows = []
    for session in sessions:
        if len(session["events"]) < 3:
            continue
        third = session["events"][2]
        same_time = [v for v in session["events"] if v["receivedAt"] == third["receivedAt"]]
        ambiguous = len(same_time) > 1
        cap = positive(third.get("marketCapUsd")) if not ambiguous else None
        source_start = timestamp(ranges[session["source"]]["firstReceivedAt"])
        row = {"source": session["source"], "chain": session["chain"], "address": session["address"], "name": third.get("name"),
               "sessionFirstReceivedAt": session["firstReceivedAt"], "sessionLastReceivedAt": session["lastReceivedAt"],
               "sessionExpiresAt": session["expiresAt"], "sessionIndependentEvents": len(session["events"]),
               "firstEventId": session["events"][0]["eventId"], "thirdEventId": third["eventId"],
               "thirdReceivedAt": third["receivedAt"], "thirdOccurredAt": third["occurredAt"],
               "thirdOrderAmbiguous": ambiguous, "sameReceiptTimeEvents": len(same_time),
               "firstSixHourDatasetBoundary": timestamp(session["firstReceivedAt"]) < source_start + SIX_HOURS,
               "thirdMarketCapUsd": cap, "marketCapField": third.get("marketCapField") if cap is not None else None,
               "historicalCapEvidence": third.get("historicalCap") if cap is not None else None,
               "marketCapStatus": "missing" if cap is None else "at_most_100000" if cap <= 100000 else "above_100000",
               "marketCapMissingReason": ("THIRD_EVENT_ORDER_WITHIN_RECEIPT_BATCH_UNKNOWN" if ambiguous else "THIRD_EVENT_MARKET_CAP_NOT_RETAINED") if cap is None else None,
               "entryPrice": None if ambiguous else entry_price(third, known, max_price_age_sec),
               "globalClaim": False, "suppressedAsDuplicate": False}
        row["priceOutcome"] = outcome(row, prices, horizon_hours, as_of)
        rows.append(row)
    rows.sort(key=lambda r: (r["thirdReceivedAt"], r["source"], r["thirdEventId"]))
    # Separate source sessions nominate; a shared lifetime chain+CA claim allows
    # only the earliest evidenced qualifying event in the retained history.
    claims = {}
    unknown_before = collections.Counter()
    for row in rows:
        key = (row["chain"], row["address"])
        row["earlierThirdEventsWithUnknownCap"] = unknown_before[key]
        if row["marketCapStatus"] == "missing":
            unknown_before[key] += 1
        if row["marketCapStatus"] != "at_most_100000":
            continue
        if key in claims:
            row["suppressedAsDuplicate"] = True
            row["claimedEarlierBy"] = {"source": claims[key]["source"], "eventId": claims[key]["thirdEventId"], "at": claims[key]["thirdReceivedAt"]}
        else:
            row["globalClaim"] = True
            claims[key] = row
    summary = {}
    for source in SOURCES:
        source_rows = [r for r in rows if r["source"] == source]
        claimed = [r for r in source_rows if r["globalClaim"]]
        summary[source] = {**ranges[source], "independentEvents": sum(e["source"] == source for e in events),
            "sixHourIdleSessions": sum(s["source"] == source for s in sessions), "sessionsReachingThird": len(source_rows),
            "thirdMarketCapAtMost100000": sum(r["marketCapStatus"] == "at_most_100000" for r in source_rows),
            "thirdMarketCapAbove100000": sum(r["marketCapStatus"] == "above_100000" for r in source_rows),
            "thirdMarketCapMissing": sum(r["marketCapStatus"] == "missing" for r in source_rows),
            "thirdReceiptOrderAmbiguous": sum(r["thirdOrderAmbiguous"] for r in source_rows),
            "thirdSessionsInFirstSixHourDatasetBoundary": sum(r["firstSixHourDatasetBoundary"] for r in source_rows),
            "globallyUniqueFirstClaims": len(claimed), "eligibleRepeatsSuppressed": sum(r["suppressedAsDuplicate"] for r in source_rows),
            "uniqueClaimsWithEarlierUnknownCapThird": sum(r["earlierThirdEventsWithUnknownCap"] > 0 for r in claimed),
            "uniqueClaimPriceOutcome": price_summary(claimed)}
    return {"schemaVersion": 1, "asOf": snapshot["finishedAt"],
            "rules": {"countKey": ["source", "chain", "address"], "notificationOrdinal": 3,
                      "session": "idle TTL: new independent event resets expiry to receivedAt + 6h; gap >=6h starts at 1",
                      "marketCapThresholdUsd": 100000, "marketCapComparison": "<=",
                      "globalClaimKey": ["chain", "address"], "globalClaim": "first retained eligible third event; forever suppress later eligible events from all sources",
                      "capBasis": "third immutable event payload only; missing is unknown, not fail",
                      "priceAsOfMaxAgeSec": max_price_age_sec, "outcomeHorizonHours": horizon_hours,
                      "horizonIsNotExitRule": True}, "capture": {k: snapshot[k] for k in ("startedAt", "finishedAt", "databases") if k in snapshot},
            "diagnostics": {**diagnostics, "conflictingSameTimestampPriceGroupsDropped": conflicts,
                            "retainedMarketPricePoints": len(snapshot.get("marketPoints", [])), "retainedArchivePricePoints": len(snapshot.get("archivePoints", []))},
            "bySource": summary, "global": {"uniqueFirstClaims": len(claims), "priceOutcome": price_summary(list(claims.values()))},
            "limitations": ["Production databases captured separately with read-only WAL snapshots; not a cross-database atomic snapshot.",
                "Retention and collection gaps mean counts describe retained local events, not full provider history; left-boundary sessions may lack earlier events.",
                "DeBot payloads do not retain event market cap. No current price/cap/supply or future first sample is used to manufacture historical eligibility.",
                "Source records can survive provider payload pruning; their event counts remain usable but missing event cap stays unknown.",
                "A global first claim is only first among known eligible retained events; earlier missing-cap events may have qualified in complete history.",
                "Same-receipt-time batches do not establish internal arrival order; ambiguous third events are not classified as eligible.",
                "Provider signal/spot prices are reference observations, not executable quotes or fills; fees, slippage, tax, MEV and liquidity are not modeled.",
                "Only exact source event ids count. delivery_count, vendorHistoryCount, history_count, changed research revisions and replay deliveries never increment counts.",
                "Post-entry observations are irregular and may be downsampled; observed doubling is a lower bound on price touching the threshold, not a capital win rate.",
                "Archive points do not retain per-point receipt/venue evidence, so they are used only as timestamped subsequent price observations, never entry eligibility/baseline.",
                "24h is a reporting horizon only, not a liquidation rule; immature and sparse observations are reported separately."],
            "thirdNotifications": rows}


def with_historical_caps(snapshot, backfill):
    """Separate, explicitly counterfactual reconstruction; never alters inputs."""
    facts = {}
    for fact in backfill.get("facts", []):
        at, fetched, stat = timestamp(fact.get("occurredAt")), timestamp(fact.get("fetchedAt")), timestamp(fact.get("statAt"))
        if fact.get("valid") is not True or positive(fact.get("marketCapUsd")) is None or at is None or fetched is None or stat is None:
            continue
        if not 0 <= at - stat <= 120 or fetched < at:
            continue
        facts[fact["eventId"]] = fact
    overlay = {**snapshot, "events": []}
    applied = set()
    for original in snapshot["events"]:
        event = dict(original)
        fact = facts.get(event.get("eventId"))
        if fact and event.get("source") == "debot" and all(event.get(k) == fact.get(k) for k in ("chain", "address", "occurredAt")):
            # Only attach to an existing immutable event payload. The old
            # payloadKnownAt applies to its old fields; cap evidence separately
            # states today's fetchedAt and can never be described as then known.
            if event.get("payloadKnownAt") and event.get("providerId") == fact.get("providerId"):
                event["marketCapUsd"] = fact["marketCapUsd"]
                event["marketCapField"] = fact["capField"]
                event["historicalCap"] = {"fetchedAt": fact["fetchedAt"], "statAt": fact["statAt"],
                    "classification": "historically_reconstructed_not_available_at_original_decision"}
                applied.add(event["eventId"])
        overlay["events"].append(event)
    return overlay, len(applied)


def write_reports(report, prefix):
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    fields = ["source", "chain", "address", "name", "sessionFirstReceivedAt", "sessionLastReceivedAt", "sessionExpiresAt",
              "sessionIndependentEvents", "thirdEventId", "thirdReceivedAt", "thirdOccurredAt", "thirdOrderAmbiguous",
              "firstSixHourDatasetBoundary", "thirdMarketCapUsd", "marketCapStatus", "marketCapMissingReason", "globalClaim", "suppressedAsDuplicate",
              "earlierThirdEventsWithUnknownCap", "historicalCapFetchedAt", "historicalCapStatAt",
              "entryPriceUsd", "entryPriceAt", "entryKnownAt", "entryKind", "entryPriceSource", "priceAgeSec",
              "mature", "postEntrySamples", "sampledDoubleHit", "firstDoubleAt", "maxGainPct", "maxDrawdownPct", "minGainPct", "lastGainPct",
              "maxSampleGapSecIncludingEdges", "sampleSpanCoveragePct", "missingReason"]
    with prefix.with_suffix(".csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in report["thirdNotifications"]:
            flat = {k: row.get(k) for k in fields}
            entry = row.get("entryPrice") or {}
            historical = row.get("historicalCapEvidence") or {}
            flat.update({"historicalCapFetchedAt": historical.get("fetchedAt"), "historicalCapStatAt": historical.get("statAt")})
            flat.update({"entryPriceUsd": entry.get("priceUsd"), "entryPriceAt": entry.get("at"), "entryKnownAt": entry.get("knownAt"),
                         "entryKind": entry.get("kind"), "entryPriceSource": entry.get("source"), "priceAgeSec": entry.get("ageSec")})
            flat.update({k: row["priceOutcome"].get(k) for k in fields if k in row["priceOutcome"]})
            # Token names are untrusted text; prevent spreadsheet formula execution.
            writer.writerow({k: "'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v
                             for k, v in flat.items()})


class ReplayTests(unittest.TestCase):
    def event(self, minute, n, source="ave", ca="ca", cap=50000, price=1):
        at = iso(1800000000 + minute * 60)
        return {"source": source, "eventId": source + ":signal:" + str(n), "chain": "solana", "address": ca,
                "receivedAt": at, "occurredAt": at, "payloadKnownAt": at, "origin": source + "_signals",
                "marketCapUsd": cap, "priceUsd": price}

    def snapshot(self, events, points=None):
        return {"finishedAt": iso(1800000000 + 100 * 3600), "events": events, "marketPoints": points or [], "archivePoints": []}

    def test_idle_ttl_0h_5h_10h_and_boundary(self):
        events = [self.event(m, n) for n, m in enumerate([0, 300, 600, 960, 961, 962])]
        report = replay(self.snapshot(events))
        self.assertEqual(report["bySource"]["ave"]["sixHourIdleSessions"], 2)
        self.assertEqual(report["bySource"]["ave"]["sessionsReachingThird"], 2)
        self.assertEqual(report["global"]["uniqueFirstClaims"], 1)
        self.assertEqual(report["bySource"]["ave"]["eligibleRepeatsSuppressed"], 1)

    def test_duplicate_records_and_provider_counts_never_increment(self):
        e = self.event(0, 1)
        duplicate = {**e, "delivery_count": 100, "vendorHistoryCount": 999, "history_count": 999}
        report = replay(self.snapshot([e, duplicate, self.event(1, 2)]))
        self.assertEqual(report["bySource"]["ave"]["independentEvents"], 2)
        self.assertEqual(report["bySource"]["ave"]["sessionsReachingThird"], 0)

    def test_separate_source_counters_shared_permanent_claim(self):
        events = [self.event(n, n, source) for source in SOURCES for n in [0, 1, 2]]
        events[-1]["receivedAt"] = iso(1800000000 + 130)
        events[-1]["payloadKnownAt"] = events[-1]["receivedAt"]
        report = replay(self.snapshot(events))
        self.assertEqual(report["bySource"]["debot"]["globallyUniqueFirstClaims"], 1)
        self.assertEqual(report["bySource"]["ave"]["eligibleRepeatsSuppressed"], 1)
        self.assertEqual(report["global"]["uniqueFirstClaims"], 1)

    def test_exact_third_cap_and_no_fourth_chance(self):
        events = [self.event(n, n, cap=100001 if n == 2 else 50000) for n in range(4)]
        report = replay(self.snapshot(events))
        self.assertEqual(report["bySource"]["ave"]["thirdMarketCapAbove100000"], 1)
        self.assertEqual(report["global"]["uniqueFirstClaims"], 0)
        events[2]["marketCapUsd"] = 100000
        self.assertEqual(replay(self.snapshot(events))["global"]["uniqueFirstClaims"], 1)

    def test_missing_cap_and_later_payload_are_not_backfilled(self):
        events = [self.event(n, n) for n in range(3)]
        events[2].pop("marketCapUsd")
        later = {**events[2], "marketCapUsd": 1000, "payloadKnownAt": iso(1800000200), "receivedAt": iso(1800000200)}
        report = replay(self.snapshot(events + [later]))
        self.assertEqual(report["bySource"]["ave"]["thirdMarketCapMissing"], 1)
        self.assertEqual(report["global"]["uniqueFirstClaims"], 0)

    def test_future_first_price_never_becomes_entry(self):
        events = [self.event(n, n, price=None) for n in range(3)]
        point = {"chain": "solana", "address": "ca", "at": iso(1800000121), "knownAt": iso(1800000122), "priceUsd": 1}
        r = replay(self.snapshot(events, [point]))["thirdNotifications"][0]
        self.assertIsNone(r["entryPrice"])
        self.assertIsNone(r["priceOutcome"]["sampledDoubleHit"])

    def test_only_post_third_price_counts_and_drawdown(self):
        events = [self.event(n, n) for n in range(3)]
        points = [{"chain": "solana", "address": "ca", "at": iso(1800000000 + sec), "knownAt": iso(1800000000 + sec), "priceUsd": p}
                  for sec, p in [(119, 100), (121, 1.5), (122, 2), (123, .5)]]
        outcome = replay(self.snapshot(events, points))["thirdNotifications"][0]["priceOutcome"]
        self.assertTrue(outcome["sampledDoubleHit"])
        self.assertEqual(outcome["maxGainPct"], 100)
        self.assertEqual(outcome["maxDrawdownPct"], 75)

    def test_same_receipt_batch_is_not_arbitrarily_eligible(self):
        events = [self.event(0, n) for n in range(3)]
        report = replay(self.snapshot(events))
        self.assertEqual(report["bySource"]["ave"]["thirdReceiptOrderAmbiguous"], 1)
        self.assertEqual(report["global"]["uniqueFirstClaims"], 0)

    def test_historical_cap_remains_a_separate_counterfactual_layer(self):
        events = [self.event(n, n, source="debot", cap=None) for n in range(3)]
        events[2]["providerId"] = "original-id"
        snapshot = self.snapshot(events)
        fact = {**events[2], "providerId": "original-id", "valid": True, "marketCapUsd": 40000,
                "fetchedAt": snapshot["finishedAt"], "statAt": events[2]["occurredAt"], "capField": "token_trading_stat.mkt_cap"}
        overlay, applied = with_historical_caps(snapshot, {"facts": [fact]})
        self.assertEqual(applied, 1)
        self.assertEqual(replay(snapshot)["global"]["uniqueFirstClaims"], 0)
        reconstructed = replay(overlay)
        self.assertEqual(reconstructed["global"]["uniqueFirstClaims"], 1)
        self.assertEqual(reconstructed["thirdNotifications"][0]["historicalCapEvidence"]["fetchedAt"], snapshot["finishedAt"])
        fact["statAt"] = iso(timestamp(fact["occurredAt"]) + 1)
        self.assertEqual(with_historical_caps(snapshot, {"facts": [fact]})[1], 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--input", type=Path, help="Replay immutable sanitized input snapshot; does not access production DBs")
    parser.add_argument("--historical-caps", type=Path, help="Explicit supplemental counterfactual layer; NEVER mixes with strict available-at-entry report")
    parser.add_argument("--output", type=Path, default=Path("reports/third-signal-" + dt.datetime.now(UTC).date().isoformat()))
    parser.add_argument("--max-price-age-sec", type=int, default=120)
    parser.add_argument("--horizon-hours", type=int, default=24)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReplayTests)
        sys.exit(0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1)
    if args.max_price_age_sec < 0 or args.max_price_age_sec > 120 or args.horizon_hours < 1 or args.horizon_hours > 168:
        parser.error("price age must be 0..120 seconds and reporting horizon 1..168 hours")
    if args.input:
        raw = args.input.read_bytes()
        snapshot = json.loads(gzip.decompress(raw))
        input_path = args.input
    else:
        snapshot = capture(args.data_dir)
        raw = gzip.compress(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(), mtime=0)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        input_path = Path(str(args.output) + ".inputs.json.gz")
        input_path.write_bytes(raw)
    historical = None
    if args.historical_caps:
        if not args.input:
            parser.error("--historical-caps requires an existing --input snapshot")
        backfill_bytes = args.historical_caps.read_bytes()
        backfill = json.loads(backfill_bytes)
        if backfill.get("inputs", {}).get("inputSha256") != hashlib.sha256(raw).hexdigest():
            parser.error("historical cap file belongs to a different input snapshot")
        snapshot, applied = with_historical_caps(snapshot, backfill)
        historical = {"path": str(args.historical_caps), "sha256": hashlib.sha256(backfill_bytes).hexdigest(),
                      "eventsWithReconstructedCap": applied, "fetchedFrom": backfill.get("startedAt"), "fetchedUntil": backfill.get("finishedAt")}
    report = replay(snapshot, args.max_price_age_sec, args.horizon_hours)
    report["mode"] = "historical_reconstruction_not_available_at_original_decision" if historical else "strict_original_available_at_receipt"
    if historical:
        report["historicalCapSupplement"] = historical
        report["rules"]["capBasis"] = "original third event cap OR exact matched DeBot event stat fetched later; counterfactual historical reconstruction"
        report["limitations"].insert(0, "Historical DeBot cap was fetched today and was NOT retained/available at original decision time. This supplemental rule replay cannot demonstrate prior bot capability.")
    report["reproduction"] = {"inputSnapshot": str(input_path), "inputSha256": hashlib.sha256(raw).hexdigest(),
                              "command": "python3 scripts/third-signal-backtest.py --input " + str(input_path) +
                              (" --historical-caps " + str(args.historical_caps) if args.historical_caps else "") +
                              (" --max-price-age-sec " + str(args.max_price_age_sec) if args.max_price_age_sec != 120 else "") +
                              (" --horizon-hours " + str(args.horizon_hours) if args.horizon_hours != 24 else "") + " --output /tmp/third-signal-replay"}
    write_reports(report, args.output)
    print(json.dumps({"reports": [str(args.output.with_suffix(".json")), str(args.output.with_suffix(".csv"))],
                      "snapshot": str(input_path), "asOf": report["asOf"], "bySource": report["bySource"], "global": report["global"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
